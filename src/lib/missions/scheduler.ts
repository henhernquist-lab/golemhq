// Batch 4 — the Scheduler / Dispatcher (Layer 1).
//
// The Planner leaves every task with assigned_agent null. This picks which
// builder runs each ready task, in dependency order, hands off to the Batch 2
// adapter to execute it, and then puts the result in front of the Batch 5
// validators before anything downstream is allowed to start. It does not run
// anything in parallel or take file leases (Batch 6), or retry failures.
//
// Batch 6 added the concurrency layer: the Coordinator picks a safe set of
// ready tasks, this dispatches them together, and file leases keep two
// builders off the same paths. Validation gating is untouched — a task still
// parks at 'validating' and only the Layer 3 validators move it on.
//
// Concurrency is OFF by default and that is not conservatism, it is a real
// constraint: see allowSharedCheckout below. Leases stop two builders writing
// the same FILE; they do nothing about the fact that every builder currently
// runs in the same checkout and the adapter attributes work by diffing that
// checkout before and after the run.

import { runBuilderTask } from './adapter'
import { coordinateWave } from './coordinator'
import { heartbeatLeases, releaseLeases } from './leases'
import type { McpServerName } from './mcp'
import { validateTask, type ValidationReport } from './validator'
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
   * Worth understanding before changing: a successful run parks a task at
   * 'validating', and only the Batch 5 validators move it on from there. So
   * with the default, a dependent runs when its dependency's code has actually
   * been type-checked and linted — not merely when a builder claimed success.
   * Passing ['complete','validating'] opts back into running unvalidated work,
   * which is a demo setting, not a setting for a real repo.
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
  /**
   * Run the Layer 3 validators on a task the builder succeeded at.
   *
   * On by default: leaving it off means tasks pile up at 'validating' and
   * nothing downstream ever unblocks, which is the dead end this exists to
   * close. Off is for isolating builder behaviour from validator behaviour.
   */
  validate?: boolean
  /** Per-check wall-clock cap inside the validator. */
  validateTimeoutMs?: number
  /**
   * How many builders may run at once. Defaults to 1 — the Batch 4 behaviour.
   *
   * Anything above 1 needs isolated checkouts. See allowSharedCheckout.
   */
  maxConcurrent?: number
  /**
   * Checkout to run each task in, keyed by task id. When this returns a path,
   * that task's builder runs there instead of options.cwd, which is what makes
   * concurrency actually safe rather than merely lease-checked.
   */
  worktreeFor?: (taskId: string) => string | undefined
  /**
   * Run concurrently in ONE shared checkout anyway.
   *
   * Required, and named to be hard to pass by accident, because file leases do
   * not make this safe. Two builders in one checkout share a git index and a
   * HEAD, and the adapter decides what a task changed by snapshotting the
   * worktree before and after the run — so with a second builder writing
   * concurrently, task A is credited with task B's files, and the
   * "wroteNothing" guard that catches hollow successes reads the other task's
   * work as its own. Leases prevent the lost update; they cannot prevent the
   * misattribution. Set this only when you accept that.
   */
  allowSharedCheckout?: boolean
  /** Path globs per task, when tasks.expected_paths is not populated. */
  declarationOverride?: Map<string, string[] | null>
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
  /** Validator verdict, when the builder succeeded and validation ran. */
  validation: ValidationReport | null
}

export interface ScheduleResult {
  missionId: string
  scheduled: ScheduledTask[]
  /** Ready tasks left unrun because maxTasks was hit. */
  deferred: number
  /** Pending tasks whose dependencies are not satisfied yet. */
  blocked: number
  /** Ready tasks parked this run because another task held their paths. */
  conflicted: number
  /** Leases released because their holder stopped heartbeating. */
  reaped: number
  /** Highest number of builders that were actually in flight at one moment. */
  peakConcurrency: number
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
/**
 * Run one task to completion: builder, then validators.
 *
 * Pulled out of the loop so a wave can run several of these at once. The
 * lease is released in `finally` — on success, on failure, and on a throw —
 * because a lease that outlives its task blocks every future task that touches
 * those paths, and nothing else in a serverless request will clean it up.
 */
async function runOne(
  task: Task,
  agent: Agent,
  rationale: string,
  options: ScheduleOptions,
): Promise<ScheduledTask> {
  const cwd = options.worktreeFor?.(task.id) ?? options.cwd

  // Long builds outlive the default lease TTL. Beating keeps the lease alive
  // while the task is demonstrably still running, so the reaper can safely
  // treat silence as death rather than guessing at a timeout.
  const beat = setInterval(() => {
    void heartbeatLeases(task.id).catch(() => {})
  }, 60_000)

  let success = false
  let exitCode: number | null = null
  let durationMs: number | null = null
  let error: string | null = null
  let validation: ValidationReport | null = null
  let finalStatus: TaskStatus = 'failed'

  try {
    try {
      const run = await runBuilderTask(task.id, {
        cwd,
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
    finalStatus = success ? 'validating' : 'failed'
    await updateTaskStatus(task.id, finalStatus, {
      by: 'scheduler',
      agent: agent.name,
      exitCode,
      ...(error ? { error } : {}),
    })

    // The builder's verdict got the task to 'validating'. Only the validators
    // decide what happens next, and their decision is what unblocks
    // dependents — the loop re-reads statuses on the next pass.
    if (success && options.validate !== false) {
      try {
        validation = await validateTask(task.id, { cwd, timeoutMs: options.validateTimeoutMs })
        finalStatus = validation.finalStatus
        if (!validation.passed) {
          success = false
          error = validation.checks
            .filter((c) => c.status === 'failed')
            .map((c) => `${c.name}: ${c.reason ?? 'failed'}`)
            .join('; ')
        }
      } catch (err) {
        // A validator that cannot run has not approved anything. Failing the
        // task is the only safe reading — the alternative is a task that
        // advances because the check crashed.
        success = false
        error = `validator error: ${err instanceof Error ? err.message : String(err)}`
        await updateTaskStatus(task.id, 'failed', { by: 'scheduler', error })
        finalStatus = 'failed'
      }
    }
  } finally {
    clearInterval(beat)
    await releaseLeases(task.id).catch(() => {})
  }

  if (!success) {
    await recordEvent(
      task.missionId,
      'scheduler.task_failed',
      { agent: agent.name, cli: agent.cliCommand, exitCode, error, durationMs, retried: false },
      task.id,
    )
  }

  return { task, agent, rationale, executed: true, success, finalStatus, exitCode, durationMs, error, validation }
}

/**
 * Assign and run every ready task in this mission.
 *
 * Waves, not one-at-a-time: each pass asks the Coordinator for a set of ready
 * tasks whose declared paths do not collide, runs them together, and re-reads
 * the graph. Failures are left failed. No auto-retry: a builder that failed
 * once will usually fail the same way twice, and burning the budget to prove
 * it is worse than surfacing it.
 */
export async function scheduleTasks(
  missionId: string,
  options: ScheduleOptions = {},
): Promise<ScheduleResult> {
  const satisfiedBy = new Set(options.satisfiedBy ?? DEFAULT_SATISFIED_BY)
  const maxTasks = options.maxTasks ?? 10
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 1)

  // Refused rather than silently downgraded. A caller that asked for
  // concurrency and got sequential execution would conclude the feature works
  // and never find out why their wall-clock never improved; a caller that gets
  // concurrency in one checkout would get corrupted attribution instead. Both
  // are worse than being told.
  if (maxConcurrent > 1 && !options.worktreeFor && !options.allowSharedCheckout) {
    throw new SchedulerError(
      `maxConcurrent=${maxConcurrent} needs isolated checkouts: pass worktreeFor to give each task its own ` +
        `git worktree, or allowSharedCheckout:true to accept that the adapter will misattribute changed files ` +
        `between concurrent tasks sharing one checkout.`,
    )
  }

  const mission = await getMission(missionId)
  if (!mission) throw new SchedulerError(`scheduleTasks: mission ${missionId} not found`)
  if (mission.status !== 'running') {
    throw new SchedulerError(`scheduleTasks: mission is "${mission.status}", expected "running"`)
  }

  const { agents: candidates, warning } = await dispatchableAgents()

  const scheduled: ScheduledTask[] = []
  let deferred = 0
  let conflicted = 0
  let reaped = 0
  let peakConcurrency = 0

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
    // wrote in topological order, so ties resolve to dependency order. This
    // ordering is also what keeps the Coordinator deadlock-free: the head of
    // the list is always admitted, so a wave is never empty while work is
    // ready and nothing else is running.
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 }
    ready.sort((a, b) => (order[a.priority] - order[b.priority]) || a.createdAt.localeCompare(b.createdAt))

    const room = Math.min(maxConcurrent, maxTasks - scheduled.length)
    const plan = await coordinateWave(missionId, mission.repo, ready, {
      maxConcurrent: room,
      declarationOverride: options.declarationOverride,
    })
    reaped += plan.reaped.length
    conflicted = plan.held.filter((h) => h.reason === 'conflict').length

    if (plan.admitted.length === 0) {
      // Every ready task is queued behind a lease held by something this call
      // is not running — a task still in flight from another request, or one
      // whose lease has not expired yet. Stopping is correct; spinning here
      // would burn the request on a wait that only another process can end.
      await recordEvent(missionId, 'scheduler.wave_starved', {
        ready: ready.length,
        heldByConflict: conflicted,
      })
      deferred = ready.length
      break
    }

    // Assign before dispatching so the roster view shows the whole wave as
    // claimed rather than one task at a time.
    const wave: { task: Task; agent: Agent; rationale: string }[] = []
    for (const { task } of plan.admitted) {
      const { agent, rationale } = pickAgent(task, candidates)
      await updateTaskStatus(task.id, 'assigned', { assignedAgent: agent.id, rationale, by: 'scheduler' })
      wave.push({ task, agent, rationale })
    }

    if (options.dryRun) {
      for (const { task, agent, rationale } of wave) {
        scheduled.push({
          task, agent, rationale, executed: false, success: null,
          finalStatus: 'assigned', exitCode: null, durationMs: null, error: null,
          validation: null,
        })
      }
      // Nothing executed means nothing will ever become ready, so stop after
      // one pass rather than spinning on the same tasks forever. The leases
      // this wave took are not held against a run that will not happen.
      for (const { task } of wave) await releaseLeases(task.id).catch(() => {})
      deferred = ready.length - wave.length
      break
    }

    peakConcurrency = Math.max(peakConcurrency, wave.length)
    await recordEvent(missionId, 'scheduler.wave_dispatched', {
      concurrency: wave.length,
      tasks: wave.map((w) => ({ taskId: w.task.id, title: w.task.title, agent: w.agent.name })),
    })

    // allSettled, not all: one builder throwing must not abandon the others
    // mid-run, which would leak their leases until the reaper caught up.
    const results = await Promise.allSettled(
      wave.map(({ task, agent, rationale }) => runOne(task, agent, rationale, options)),
    )

    for (let i = 0; i < results.length; i++) {
      const settled = results[i]
      if (settled.status === 'fulfilled') {
        scheduled.push(settled.value)
        continue
      }
      // runOne releases its own lease in a finally, so this is a genuinely
      // unexpected throw; record it as a failed task rather than losing it.
      const { task, agent, rationale } = wave[i]
      const error = settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
      await releaseLeases(task.id).catch(() => {})
      await updateTaskStatus(task.id, 'failed', { by: 'scheduler', error }).catch(() => {})
      scheduled.push({
        task, agent, rationale, executed: true, success: false,
        finalStatus: 'failed', exitCode: null, durationMs: null, error, validation: null,
      })
    }
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
    conflicted,
    reaped,
    peakConcurrency,
    maxConcurrent,
    dryRun: !!options.dryRun,
  })

  return { missionId, scheduled, deferred, blocked, conflicted, reaped, peakConcurrency, candidates, warning }
}

/** Latest recorded result for a task, or null. */
export async function latestResult(taskId: string) {
  const results = await listResults(taskId)
  return results[0] ?? null
}
