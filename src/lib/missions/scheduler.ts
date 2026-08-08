// Batch 4 — the Scheduler / Dispatcher (Layer 1).
//
// The Planner leaves every task with assigned_agent null. This picks which
// builder runs each ready task, in dependency order, and hands off to the
// Batch 2 adapter to actually execute. It does not validate results (Batch 5),
// run anything in parallel or take file leases (Batch 6), or retry failures.
//
// Sequential on purpose. Two builders editing the same checkout at once is a
// lost-update race, and the only thing that would make it safe — the leases
// table's enforcement — does not exist yet. The table is there; nothing
// acquires or checks it.

import { runBuilderTask } from './adapter'
import type { McpServerName } from './mcp'
import { backend } from '@/lib/terminal/headless-run'
import {
  getDetections,
  getMission,
  listTasks,
  listAgents,
  listResults,
  recordEvent,
  updateTaskStatus,
} from './store'
import type { Agent, Task, TaskStatus } from './types'

export class SchedulerError extends Error {
  readonly detail?: unknown
  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'SchedulerError'
    this.detail = detail
  }
}

/** Statuses that count as "this dependency is satisfied". */
const DEFAULT_SATISFIED_BY: TaskStatus[] = ['complete']

export interface ScheduleOptions {
  /**
   * Which dependency statuses unblock a dependent task. Defaults to
   * ['complete'] alone.
   *
   * Worth understanding before changing: this scheduler parks successful tasks
   * at 'validating', and nothing moves them to 'complete' until the Batch 5
   * validators exist. So with the default, exactly one wave of
   * dependency-free tasks runs and everything downstream stays blocked — which
   * is correct, because "the builder said it worked" is not the same as "it
   * works". Passing ['complete','validating'] opts into running unvalidated
   * work, which is what you want for an end-to-end demo and not what you want
   * against a real repo.
   */
  satisfiedBy?: TaskStatus[]
  /** Stop after this many tasks in one call. Guards a runaway mission. */
  maxTasks?: number
  /** Checkout the builders run against. */
  cwd?: string
  /** Per-task wall-clock cap, passed to the adapter. */
  timeoutMs?: number
  /** Assign but do not execute. Useful for inspecting choices. */
  dryRun?: boolean
  /**
   * MCP servers to offer every builder this run. Agents whose CLI cannot take
   * a per-run config run without them — see mcp.ts for why that is a property
   * of the CLI and not something the scheduler can work around.
   */
  mcpServers?: McpServerName[]
}

export interface ScheduledTask {
  task: Task
  agent: Agent
  /** Why this agent — the matched strengths, or the fallback reason. */
  rationale: string
  executed: boolean
  success: boolean | null
  finalStatus: TaskStatus
  exitCode: number | null
  durationMs: number | null
  error: string | null
}

export interface ScheduleResult {
  missionId: string
  scheduled: ScheduledTask[]
  /** Ready tasks left unrun because maxTasks was hit. */
  deferred: number
  /** Pending tasks whose dependencies are not satisfied yet. */
  blocked: number
  /** Enabled layer-2 agents that were actually dispatchable on this host. */
  candidates: Agent[]
  warning: string | null
}

// ─── Eligibility ───────────────────────────────────────────────────────

function isReady(task: Task, byId: Map<string, Task>, satisfiedBy: Set<TaskStatus>): boolean {
  if (task.status !== 'pending') return false
  return task.dependsOn.every((depId) => {
    const dep = byId.get(depId)
    // A dependency pointing outside this mission cannot be shown satisfied, so
    // it blocks. The Planner's validation prevents this; a hand-edited row
    // could still produce it, and blocking is the safe reading.
    return dep ? satisfiedBy.has(dep.status) : false
  })
}

// ─── Agent selection ───────────────────────────────────────────────────

const WORD = /[a-z0-9]+/g

/**
 * Score an agent against a task by overlap between its declared strengths and
 * the task's own words.
 *
 * Deliberately crude. A real router would use the model, which costs tokens on
 * every task and is a Layer 1 spend the budget would have to cover; this is
 * free, deterministic and good enough to stop a scaffolding task going to the
 * slowest agent. Reliability breaks ties so a zero-overlap task still lands on
 * the most trustworthy builder rather than an arbitrary one.
 */
function scoreAgent(agent: Agent, taskWords: Set<string>): { score: number; matched: string[] } {
  const matched: string[] = []
  for (const strength of agent.strengths) {
    const parts = strength.toLowerCase().match(WORD) ?? []
    if (parts.length > 0 && parts.every((p) => taskWords.has(p))) matched.push(strength)
  }
  return { score: matched.length, matched }
}

function pickAgent(task: Task, candidates: Agent[]): { agent: Agent; rationale: string } {
  const words = new Set(`${task.title} ${task.description}`.toLowerCase().match(WORD) ?? [])

  let best: { agent: Agent; score: number; matched: string[] } | null = null
  for (const agent of candidates) {
    const { score, matched } = scoreAgent(agent, words)
    const better =
      !best ||
      score > best.score ||
      (score === best.score && (agent.reliabilityPct ?? 0) > (best.agent.reliabilityPct ?? 0))
    if (better) best = { agent, score, matched }
  }
  if (!best) throw new SchedulerError('pickAgent: no candidate agents')

  return {
    agent: best.agent,
    rationale:
      best.score > 0
        ? `matched strengths: ${best.matched.join(', ')}`
        : `no strength match — highest reliability (${best.agent.reliabilityPct ?? 'unrated'}%)`,
  }
}

/**
 * Enabled layer-2 agents that can actually run here.
 *
 * `enabled` alone is not enough. Codex sat enabled for two batches while being
 * installed nowhere, and dispatching to it would surface as a shell "command
 * not found" inside a task_results blob, far from the cause. Detection records
 * cli_path per host, so an agent confirmed absent on THIS host is excluded even
 * when enabled.
 *
 * Agents never detected anywhere are kept rather than excluded: never-checked
 * is not the same as known-absent, and excluding them would make the scheduler
 * silently depend on someone having run detection first.
 */
async function dispatchableAgents(): Promise<{ agents: Agent[]; warning: string | null }> {
  const enabled = await listAgents(2, true)
  if (enabled.length === 0) throw new SchedulerError('no enabled layer-2 agents to dispatch to')

  const host = backend().kind
  // Detection columns arrive in a later migration than the roster, so treat an
  // unreadable ledger as "nothing checked yet" rather than refusing to run.
  let detections = new Map<string, { cliPath: string | null; detectedAt: string | null; detectedHost: string | null }>()
  try {
    detections = await getDetections()
  } catch {
    /* migration not applied — no host data to filter on */
  }
  const excluded: string[] = []
  const agents = enabled.filter((agent) => {
    const row = detections.get(agent.id)
    // Checked on this host and found absent → not dispatchable.
    if (row && row.detectedHost === host && row.detectedAt && !row.cliPath) {
      excluded.push(agent.name)
      return false
    }
    return true
  })

  if (agents.length === 0) {
    throw new SchedulerError(
      `every enabled layer-2 agent is confirmed absent on "${host}": ${excluded.join(', ')}`,
    )
  }
  return {
    agents,
    warning: excluded.length
      ? `excluded ${excluded.length} enabled but absent on "${host}": ${excluded.join(', ')}`
      : null,
  }
}

// ─── The loop ──────────────────────────────────────────────────────────

/**
 * Assign and run every ready task in this mission, one at a time.
 *
 * Failures are left failed. No auto-retry: a builder that failed once will
 * usually fail the same way twice, and burning the budget to prove it is worse
 * than surfacing it.
 */
export async function scheduleTasks(
  missionId: string,
  options: ScheduleOptions = {},
): Promise<ScheduleResult> {
  const satisfiedBy = new Set(options.satisfiedBy ?? DEFAULT_SATISFIED_BY)
  const maxTasks = options.maxTasks ?? 10

  const mission = await getMission(missionId)
  if (!mission) throw new SchedulerError(`scheduleTasks: mission ${missionId} not found`)
  if (mission.status !== 'running') {
    throw new SchedulerError(`scheduleTasks: mission is "${mission.status}", expected "running"`)
  }

  const { agents: candidates, warning } = await dispatchableAgents()

  const scheduled: ScheduledTask[] = []
  let deferred = 0

  // Re-read tasks each pass: a completed task can unblock its dependents, so
  // eligibility has to be recomputed rather than snapshotted up front.
  for (;;) {
    const tasks = await listTasks(missionId)
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const ready = tasks.filter((t) => isReady(t, byId, satisfiedBy))
    if (ready.length === 0) break

    if (scheduled.length >= maxTasks) {
      deferred = ready.length
      break
    }

    // Highest priority first, then creation order — which the Planner already
    // wrote in topological order, so ties resolve to dependency order.
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 }
    ready.sort((a, b) => (order[a.priority] - order[b.priority]) || a.createdAt.localeCompare(b.createdAt))
    const task = ready[0]

    const { agent, rationale } = pickAgent(task, candidates)
    await updateTaskStatus(task.id, 'assigned', { assignedAgent: agent.id, rationale, by: 'scheduler' })

    if (options.dryRun) {
      scheduled.push({
        task, agent, rationale, executed: false, success: null,
        finalStatus: 'assigned', exitCode: null, durationMs: null, error: null,
      })
      // Without execution nothing will ever become ready, so stop after one
      // pass rather than spinning on the same task forever.
      deferred = ready.length - 1
      break
    }

    let success = false
    let exitCode: number | null = null
    let durationMs: number | null = null
    let error: string | null = null
    try {
      const run = await runBuilderTask(task.id, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        mcpServers: options.mcpServers,
      })
      success = run.result.success
      exitCode = run.exitCode
      durationMs = run.durationMs
      error = run.result.error
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    // The adapter records the result but deliberately does not move the task —
    // that call is the caller's, and this is the caller.
    const finalStatus: TaskStatus = success ? 'validating' : 'failed'
    await updateTaskStatus(task.id, finalStatus, {
      by: 'scheduler',
      agent: agent.name,
      exitCode,
      ...(error ? { error } : {}),
    })

    if (!success) {
      await recordEvent(
        missionId,
        'scheduler.task_failed',
        { agent: agent.name, cli: agent.cliCommand, exitCode, error, durationMs, retried: false },
        task.id,
      )
    }

    scheduled.push({
      task, agent, rationale, executed: true, success,
      finalStatus, exitCode, durationMs, error,
    })
  }

  const finalTasks = await listTasks(missionId)
  const finalById = new Map(finalTasks.map((t) => [t.id, t]))
  const blocked = finalTasks.filter((t) => t.status === 'pending' && !isReady(t, finalById, satisfiedBy)).length

  await recordEvent(missionId, 'scheduler.run', {
    dispatched: scheduled.length,
    succeeded: scheduled.filter((s) => s.success).length,
    failed: scheduled.filter((s) => s.executed && !s.success).length,
    deferred,
    blocked,
    dryRun: !!options.dryRun,
  })

  return { missionId, scheduled, deferred, blocked, candidates, warning }
}

/** Latest recorded result for a task, or null. */
export async function latestResult(taskId: string) {
  const results = await listResults(taskId)
  return results[0] ?? null
}
