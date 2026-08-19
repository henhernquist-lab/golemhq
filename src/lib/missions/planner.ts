// Batch 3 — the Mission Planner (Layer 1).
//
// Turns a plain-English goal into a task graph in Batch 1's tables. It does not
// execute anything and does not choose which builder runs a task: assigned_agent
// is left null for the Scheduler in Batch 4. The Planner's output is a task
// graph, not an execution plan.
//
// Every model call is gated by the hard spend cap in budget.ts, checked before
// the call rather than after.

import { generateText } from 'ai'
import { getChatModel, parseJsonLoose, DEFAULT_MODEL_ID, getModelMeta } from '@/lib/nim'
import {
  BUDGET_EXCEEDED_EVENT,
  checkBudget,
  costOf,
  recordPlannerUsage,
  type BudgetVerdict,
} from './budget'
import {
  createTask,
  getMission,
  listTasks,
  recordEvent,
  updateMissionStatus,
  MissionStoreError,
} from './store'
import { gatherRepoContext } from './repo-context'
import type { Mission, Task, TaskPriority } from './types'

/** A bad decomposition must not write an unbounded task list. */
export const MAX_TASKS = 20
/** Bounds one call's overshoot past the cap; see checkBudget's note. */
const MAX_OUTPUT_TOKENS = 4000
const PLANNER_TIMEOUT_MS = 90_000

export class PlannerError extends Error {
  readonly detail?: unknown
  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'PlannerError'
    this.detail = detail
  }
}

/** Thrown instead of calling the model when a cap is already breached. */
export class BudgetExceededError extends PlannerError {
  readonly verdict: BudgetVerdict
  constructor(verdict: BudgetVerdict) {
    super(`planner halted: ${verdict.reason}`)
    this.name = 'BudgetExceededError'
    this.verdict = verdict
  }
}

interface PlannedTask {
  id: string
  title: string
  description: string
  priority: TaskPriority
  dependsOn: string[]
}

const SYSTEM_PROMPT = `You decompose a software engineering goal into an ordered task list.

Reply with ONLY a JSON object, no prose and no code fence:
{"tasks":[{"id":"t1","title":"...","description":"...","priority":"high|medium|low","dependsOn":["t2"]}]}

Rules:
- At most ${MAX_TASKS} tasks. Prefer the smallest set that actually completes the goal.
- "id" is a short local handle used only for wiring dependsOn. Reference earlier ids only.
- "dependsOn" lists tasks that must COMPLETE before this one starts. Use [] when independent.
- Do not invent dependencies to force a sequence; parallelisable work should stay parallel.
- "description" is the instruction a coding agent will receive verbatim with no other context.
  Make it self-contained and concrete.
- No task may depend on itself, and the graph must be acyclic.`

function userPrompt(mission: Mission, repoContext: string): string {
  const context = repoContext
    ? `\n\nRepo context (read from the checkout — plan against THIS stack, do not assume another):\n${repoContext}`
    : ''
  return `Repository: ${mission.repo}${context}\n\nGoal:\n${mission.goal}`
}

const VALID_PRIORITY = new Set<TaskPriority>(['low', 'medium', 'high'])

/**
 * Validate a decomposition before any of it reaches the database.
 *
 * Returns the reason it is unusable, or null when it is fine. Cycles are
 * rejected here rather than at insert time: depends_on is a plain uuid[] with
 * no FK, so Postgres would happily store a cycle and the Scheduler would
 * deadlock on it later, far from the cause.
 */
function validatePlan(tasks: unknown): { tasks: PlannedTask[] } | { error: string } {
  if (!Array.isArray(tasks)) return { error: 'response had no "tasks" array' }
  if (tasks.length === 0) return { error: 'decomposition produced zero tasks' }
  if (tasks.length > MAX_TASKS) {
    return { error: `decomposition produced ${tasks.length} tasks, over the ${MAX_TASKS} cap` }
  }

  const seen = new Set<string>()
  const parsed: PlannedTask[] = []
  for (const [index, raw] of tasks.entries()) {
    const t = raw as Partial<PlannedTask>
    const id = typeof t.id === 'string' && t.id.trim() ? t.id.trim() : `t${index + 1}`
    if (seen.has(id)) return { error: `duplicate task id "${id}"` }
    if (typeof t.title !== 'string' || !t.title.trim()) return { error: `task "${id}" has no title` }
    seen.add(id)
    parsed.push({
      id,
      title: t.title.trim().slice(0, 300),
      description: typeof t.description === 'string' ? t.description.trim() : '',
      priority: VALID_PRIORITY.has(t.priority as TaskPriority) ? (t.priority as TaskPriority) : 'medium',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d): d is string => typeof d === 'string') : [],
    })
  }

  // Drop references to ids that were never defined rather than failing the
  // whole plan — a hallucinated handle is common and locally recoverable.
  const known = new Set(parsed.map((t) => t.id))
  for (const t of parsed) t.dependsOn = t.dependsOn.filter((d) => d !== t.id && known.has(d))

  // Cycle check (DFS with a colour map).
  const byId = new Map(parsed.map((t) => [t.id, t]))
  const state = new Map<string, 'open' | 'done'>()
  const walk = (id: string): boolean => {
    const mark = state.get(id)
    if (mark === 'done') return false
    if (mark === 'open') return true
    state.set(id, 'open')
    for (const next of byId.get(id)?.dependsOn ?? []) if (walk(next)) return true
    state.set(id, 'done')
    return false
  }
  for (const t of parsed) if (walk(t.id)) return { error: `dependency cycle involving "${t.id}"` }

  return { tasks: parsed }
}

/** Topological order, so a task's dependencies already have real uuids. */
function inDependencyOrder(tasks: PlannedTask[]): PlannedTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const out: PlannedTask[] = []
  const done = new Set<string>()
  const visit = (t: PlannedTask) => {
    if (done.has(t.id)) return
    done.add(t.id)
    for (const d of t.dependsOn) {
      const dep = byId.get(d)
      if (dep) visit(dep)
    }
    out.push(t)
  }
  for (const t of tasks) visit(t)
  return out
}

export interface PlanMissionResult {
  mission: Mission
  tasks: Task[]
  modelId: string
  attempts: number
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number }
  /** Grounding the model actually received. */
  repoContext: { manifestFile: string | null; chars: number; truncated: boolean; warning: string | null }
}

export interface PlanMissionOptions {
  /** Defaults to the same model the rest of Golem chat uses. */
  modelId?: string
  /**
   * Checkout to read repo context from. Defaults to the terminal backend's own
   * working directory, which is the repo in the Codespace. On the Sprite the
   * checkout location is not implied by mission.repo, so pass it explicitly
   * there or planning falls back to no context.
   */
  cwd?: string
  /**
   * Run instead of the default `updateMissionStatus(id, 'running')` once the
   * graph is written.
   *
   * Batch 11's gate parks the mission somewhere that is not dispatchable rather
   * than letting it land on 'running'. Done here, inside the same function that
   * wrote the tasks, because the alternative — the caller moving it afterwards
   * — leaves a window where a fully planned mission is already dispatchable and
   * nothing has approved it. The default keeps every existing caller
   * (scripts/verify-*.mjs among them) on exactly the Batch 3 behaviour.
   */
  finalize?: (missionId: string, taskCount: number) => Promise<Mission>
}

/**
 * Decompose a mission's goal into tasks and write them.
 *
 * Halts before spending anything when a cap is already breached: writes a
 * `budget_exceeded` event, moves the mission to `failed`, and throws. It does
 * not retry, downgrade the model, or partially plan — a silent degrade is
 * exactly what a hard cap is supposed to prevent.
 *
 * `failed` is used rather than a new status: Batch 1's set has no 'blocked',
 * and a halted mission is terminal until a human raises the cap and starts a
 * new one. Adding a status would mean migrating the CHECK constraint and the
 * partial unique index that keys off the active set, for no behavioural gain —
 * the budget_exceeded event carries the reason.
 */
export async function planMission(
  missionId: string,
  options: PlanMissionOptions = {},
): Promise<PlanMissionResult> {
  const mission = await getMission(missionId)
  if (!mission) throw new PlannerError(`planMission: mission ${missionId} not found`)
  if (mission.status !== 'planning') {
    throw new PlannerError(`planMission: mission is "${mission.status}", expected "planning"`)
  }
  const existing = await listTasks(missionId)
  if (existing.length > 0) {
    throw new PlannerError(`planMission: mission already has ${existing.length} tasks`)
  }

  // ── The cap, before the spend ──────────────────────────────────────
  const verdict = await checkBudget(missionId)
  if (!verdict.allowed) {
    await recordEvent(missionId, BUDGET_EXCEEDED_EVENT, {
      breached: verdict.breached,
      reason: verdict.reason,
      limits: verdict.limits,
      missionSpend: verdict.mission,
      dailySpend: verdict.daily,
      haltedBefore: 'planner.decompose',
    })
    await updateMissionStatus(missionId, 'failed', { reason: verdict.reason })
    throw new BudgetExceededError(verdict)
  }

  const modelId = options.modelId ?? DEFAULT_MODEL_ID
  if (!getModelMeta(modelId)) throw new PlannerError(`planMission: unknown model "${modelId}"`)

  // Grounding, gathered after the cap check so a halted mission never pays for
  // it. Never throws — planning with no context beats not planning at all — so
  // a failure is recorded and the run continues unground.
  const repoContext = await gatherRepoContext({ cwd: options.cwd })
  await recordEvent(missionId, 'planner.context', {
    manifestFile: repoContext.manifestFile,
    chars: repoContext.chars,
    truncated: repoContext.truncated,
    warning: repoContext.warning,
  })

  let attempts = 0
  let plan: PlannedTask[] | null = null
  let lastError = ''
  const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 }

  // One retry, and only for a malformed decomposition. Each attempt is metered
  // and each re-checks the cap, so a retry cannot walk past the budget.
  while (attempts < 2 && !plan) {
    attempts++
    if (attempts > 1) {
      const recheck = await checkBudget(missionId)
      if (!recheck.allowed) {
        await recordEvent(missionId, BUDGET_EXCEEDED_EVENT, {
          breached: recheck.breached,
          reason: recheck.reason,
          haltedBefore: 'planner.retry',
        })
        await updateMissionStatus(missionId, 'failed', { reason: recheck.reason })
        throw new BudgetExceededError(recheck)
      }
    }

    const startedAt = Date.now()
    let text: string
    let promptTokens = 0
    let completionTokens = 0
    try {
      const result = await generateText({
        model: getChatModel(modelId),
        system: SYSTEM_PROMPT,
        prompt:
          attempts === 1
            ? userPrompt(mission, repoContext.text)
            : `${userPrompt(mission, repoContext.text)}\n\nYour previous reply was rejected: ${lastError}\nReply with valid JSON only.`,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(PLANNER_TIMEOUT_MS),
      })
      text = result.text
      promptTokens = result.usage?.inputTokens ?? 0
      completionTokens = result.usage?.outputTokens ?? 0
    } catch (err) {
      throw new PlannerError(
        `planMission: model call failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }

    // Metered before the response is judged: a malformed reply still cost money.
    const costUsd = costOf(modelId, promptTokens, completionTokens)
    await recordPlannerUsage(missionId, {
      modelId,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd,
      latencyMs: Date.now() - startedAt,
    })
    totals.promptTokens += promptTokens
    totals.completionTokens += completionTokens
    totals.totalTokens += promptTokens + completionTokens
    totals.costUsd += costUsd

    const parsed = parseJsonLoose<{ tasks?: unknown }>(text)
    if (!parsed) {
      lastError = 'reply was not JSON'
      continue
    }
    const validated = validatePlan(parsed.tasks)
    if ('error' in validated) {
      lastError = validated.error
      continue
    }
    plan = validated.tasks
  }

  if (!plan) {
    await recordEvent(missionId, 'planner.rejected', { reason: lastError, attempts })
    await updateMissionStatus(missionId, 'failed', { reason: `planning failed: ${lastError}` })
    throw new PlannerError(`planMission: unusable decomposition after ${attempts} attempts — ${lastError}`)
  }

  // ── Write the graph ────────────────────────────────────────────────
  // assigned_agent stays null: choosing a builder is Batch 4's job.
  const idMap = new Map<string, string>()
  const created: Task[] = []
  for (const planned of inDependencyOrder(plan)) {
    const task = await createTask(missionId, {
      title: planned.title,
      description: planned.description,
      priority: planned.priority,
      dependsOn: planned.dependsOn.map((d) => idMap.get(d)).filter((d): d is string => !!d),
    })
    idMap.set(planned.id, task.id)
    created.push(task)
  }

  await recordEvent(missionId, 'planner.completed', {
    taskCount: created.length,
    modelId,
    attempts,
    ...totals,
  })

  const settled = options.finalize
    ? await options.finalize(missionId, created.length)
    : await updateMissionStatus(missionId, 'running', { plannedTasks: created.length })
  return {
    mission: settled,
    tasks: created,
    modelId,
    attempts,
    usage: totals,
    repoContext: {
      manifestFile: repoContext.manifestFile,
      chars: repoContext.chars,
      truncated: repoContext.truncated,
      warning: repoContext.warning,
    },
  }
}

export { MissionStoreError }
