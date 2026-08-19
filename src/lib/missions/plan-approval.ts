// Batch 11 — the plan approval gate (Layer 1, human in the loop).
//
// This is the EARLIER of the two gates and it is not Batch 7's. Batch 7/10
// (approval.ts) approves finished output: builders have run, every task sits on
// its own `golem/task/<id>` branch, and approving merges them. This one runs
// before any of that — the Planner has drafted a task graph, nothing has been
// dispatched, no lease is held and no CLI process exists. Approving here is
// what allows the Scheduler to start at all.
//
// The two do not share code and must not: their subjects are different (a
// drafted graph vs. a set of commits), their rejections are different (release
// the repo vs. keep or drop branches), and the only thing they have in common
// is the word "approve".
//
// What the gate adds over Batch 9's two-step front door: Batch 9 already split
// planning from dispatch, so a human already had to press dispatch. What it
// could not show was WHO would run each task — assigned_agent stays null until
// the Scheduler picks inside scheduleTasks, so the choice was made after the
// last point a human could see it. This computes that choice up front, without
// writing anything, and lets it be overridden before it becomes real.

import {
  assignTaskAgent,
  getMission,
  listEvents,
  listTasks,
  recordEvent,
  updateMissionStatus,
  MissionStoreError,
} from './store'
import { dispatchableAgents, pickAgent } from './scheduler'
import { PLANNER_USAGE_EVENT } from './budget'
import type { Agent, Mission, MissionStatus, Task } from './types'

/** SQLSTATE for a CHECK constraint violation — the unapplied-migration signal. */
const PG_CHECK_VIOLATION = '23514'

export const PLAN_GATE_MIGRATION = 'supabase/migrations/20260819010000_batch11_plan_approval.sql'

/** The status a drafted-but-unapproved mission wants to hold. */
export const PLAN_GATE_STATUS: MissionStatus = 'awaiting_plan_approval'

/**
 * Where a drafted mission sits when PLAN_GATE_MIGRATION has not been applied.
 *
 * Not a compromise chosen for convenience — it is the status the mission is
 * already in when the Planner finishes, and it satisfies both properties the
 * gate depends on: it is in ACTIVE_MISSION_STATUSES, so the repo stays held and
 * no second mission can start; and it is not 'running', which is the only
 * status /api/missions/[id]/dispatch will act on. So the gate holds whether or
 * not the migration has run, and the difference is only what the UI can call it.
 *
 * One property the fallback does NOT have: with the migration applied, the gate
 * status is written after the last task row, so "at the gate" cannot be true
 * mid-plan. On the fallback, isAtPlanGate keys off 'planning' plus a non-empty
 * task list, and the Planner writes its tasks one row at a time — so a
 * concurrent owner request landing inside that loop could approve a partially
 * written graph. The window is a few inserts wide and needs a second request to
 * hit it; applying the migration removes it rather than narrowing it.
 */
export const PLAN_GATE_FALLBACK_STATUS: MissionStatus = 'planning'

export class PlanApprovalError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'PlanApprovalError'
    this.status = status
  }
}

function isCheckViolation(err: unknown): boolean {
  const detail = err instanceof MissionStoreError ? err.detail : err
  const code = (detail as { code?: string } | null)?.code
  if (code === PG_CHECK_VIOLATION) return true
  // Supabase does not always surface `code` on a constraint rejection; the
  // constraint name is in the message either way.
  return /missions_status_check|violates check constraint/i.test(
    err instanceof Error ? err.message : '',
  )
}

/**
 * A mission is at this gate when it holds the real status, or when it is still
 * 'planning' but already has tasks.
 *
 * The second half is what makes the pre-migration fallback readable: 'planning'
 * on its own means the Planner is mid-call, and 'planning' with a task graph
 * written means the Planner finished and the status write was refused. Tasks
 * are the only thing that separates them.
 */
export function isAtPlanGate(status: MissionStatus, taskCount: number): boolean {
  if (status === PLAN_GATE_STATUS) return true
  return status === PLAN_GATE_FALLBACK_STATUS && taskCount > 0
}

/**
 * Park a freshly planned mission at the gate.
 *
 * Returns which status it actually holds, so the caller can say so rather than
 * claiming a state the database refused to store.
 */
export async function enterPlanGate(
  missionId: string,
  detail: Record<string, unknown> = {},
): Promise<{ mission: Mission; status: MissionStatus; migrationApplied: boolean }> {
  try {
    const mission = await updateMissionStatus(missionId, PLAN_GATE_STATUS, detail)
    return { mission, status: PLAN_GATE_STATUS, migrationApplied: true }
  } catch (err) {
    if (!isCheckViolation(err)) throw err

    // Left where it already is. The Planner entered on 'planning' and never
    // moved it, so there is nothing to roll back — only something to record,
    // because a mission sitting at 'planning' with a finished plan is otherwise
    // indistinguishable from one whose Planner hung.
    await recordEvent(missionId, 'plan.gate_degraded', {
      wanted: PLAN_GATE_STATUS,
      holding: PLAN_GATE_FALLBACK_STATUS,
      migration: PLAN_GATE_MIGRATION,
      reason: 'missions.status CHECK rejects the new value — migration not applied',
      ...detail,
    })
    const mission = await getMission(missionId)
    if (!mission) throw new PlanApprovalError(`mission ${missionId} not found`, 404)
    return { mission, status: mission.status, migrationApplied: false }
  }
}

export interface PlannedAssignment {
  taskId: string
  title: string
  description: string
  priority: Task['priority']
  dependsOn: string[]
  /** The builder that would run this task, as things stand. */
  agent: { id: string; name: string; cliCommand: string | null } | null
  /** Why that builder — the Scheduler's own rationale, or the human's override. */
  rationale: string
  /** True when a human chose this at the gate rather than the Scheduler. */
  overridden: boolean
}

export interface PlanPreview {
  mission: Mission
  atGate: boolean
  status: MissionStatus
  migrationApplied: boolean
  assignments: PlannedAssignment[]
  /** Builders that may be chosen for any task — the dispatchable set, nothing else. */
  candidates: { id: string; name: string; cliCommand: string | null }[]
  /**
   * What the Planner actually spent drafting this, summed from planner.usage.
   *
   * This is the ONLY real cost figure available before dispatch and it is a
   * planning cost, not a build cost. Nothing in the pipeline predicts what the
   * builders will spend: they are CLI processes billed against their own
   * vendor accounts, and this repo records their cost nowhere. A per-task
   * estimate here would have to be invented, so there isn't one.
   */
  plannerSpend: { costUsd: number; totalTokens: number; calls: number }
  warning: string | null
}

/** Everything the gate needs to render, computed without writing anything. */
export async function previewPlan(missionId: string): Promise<PlanPreview> {
  const mission = await getMission(missionId)
  if (!mission) throw new PlanApprovalError(`mission ${missionId} not found`, 404)

  const [tasks, events] = await Promise.all([listTasks(missionId), listEvents(missionId, 500)])

  // Deliberately not scheduleTasks({ dryRun: true }): that path writes. It moves
  // every admitted task to 'assigned' and takes real leases through the
  // Coordinator before releasing them, which is exactly the footprint a mission
  // waiting for approval is supposed to have none of.
  let candidates: Agent[] = []
  let warning: string | null = null
  try {
    const dispatchable = await dispatchableAgents()
    candidates = dispatchable.agents
    warning = dispatchable.warning
  } catch (err) {
    // No dispatchable builder is a real condition to show, not a 500: the plan
    // is still worth reading and rejecting.
    warning = err instanceof Error ? err.message : 'no dispatchable builders'
  }

  const assignments: PlannedAssignment[] = tasks.map((task) => {
    if (task.assignedAgent) {
      const approved = candidates.find((a) => a.id === task.assignedAgent)
      return {
        taskId: task.id,
        title: task.title,
        description: task.description,
        priority: task.priority,
        dependsOn: task.dependsOn,
        agent: approved
          ? { id: approved.id, name: approved.name, cliCommand: approved.cliCommand }
          : null,
        rationale: approved
          ? 'chosen at the plan gate'
          : `chosen at the plan gate, but ${task.assignedAgent} is not dispatchable here`,
        overridden: true,
      }
    }
    if (candidates.length === 0) {
      return {
        taskId: task.id,
        title: task.title,
        description: task.description,
        priority: task.priority,
        dependsOn: task.dependsOn,
        agent: null,
        rationale: 'no dispatchable builder on this host',
        overridden: false,
      }
    }
    // The Scheduler's own function, not a copy of its rules — a preview that
    // reimplemented the scoring would drift from what actually runs, and the
    // drift would only ever be discovered by a dispatch disagreeing with the
    // screen that authorised it.
    const { agent, rationale } = pickAgent(task, candidates)
    return {
      taskId: task.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      dependsOn: task.dependsOn,
      agent: { id: agent.id, name: agent.name, cliCommand: agent.cliCommand },
      rationale,
      overridden: false,
    }
  })

  const usage = events.filter((e) => e.type === PLANNER_USAGE_EVENT)
  const plannerSpend = usage.reduce(
    (acc, e) => {
      const p = e.payload as { costUsd?: number; totalTokens?: number }
      return {
        costUsd: acc.costUsd + (Number(p.costUsd) || 0),
        totalTokens: acc.totalTokens + (Number(p.totalTokens) || 0),
        calls: acc.calls + 1,
      }
    },
    { costUsd: 0, totalTokens: 0, calls: 0 },
  )

  return {
    mission,
    atGate: isAtPlanGate(mission.status, tasks.length),
    status: mission.status,
    migrationApplied: mission.status === PLAN_GATE_STATUS,
    assignments,
    candidates: candidates.map((a) => ({ id: a.id, name: a.name, cliCommand: a.cliCommand })),
    plannerSpend,
    warning,
  }
}

export interface ApprovePlanInput {
  /** Per-task builder overrides. Tasks left out keep the Scheduler's pick. */
  assignments?: { taskId: string; agentId: string }[]
}

export interface ApprovePlanResult {
  mission: Mission
  /** Only the tasks whose builder was pinned by this approval. */
  assigned: { taskId: string; agentId: string; agentName: string }[]
}

/**
 * Approve a drafted plan and release it for dispatch.
 *
 * Writes the approved overrides onto the tasks and moves the mission to
 * 'running', which is the only status the dispatch route acts on. It does NOT
 * dispatch: that route already exists, already refuses on Vercel, and already
 * returns 202 because a wave outlives a request. Calling it from here would be
 * a second dispatch path with none of that.
 */
export async function approvePlan(
  missionId: string,
  input: ApprovePlanInput = {},
): Promise<ApprovePlanResult> {
  const mission = await getMission(missionId)
  if (!mission) throw new PlanApprovalError(`mission ${missionId} not found`, 404)

  const tasks = await listTasks(missionId)
  if (tasks.length === 0) {
    throw new PlanApprovalError('this mission has no drafted plan to approve', 409)
  }
  if (!isAtPlanGate(mission.status, tasks.length)) {
    throw new PlanApprovalError(
      `mission is "${mission.status}" — only a drafted plan awaiting approval can be approved`,
      409,
    )
  }

  const assigned: ApprovePlanResult['assigned'] = []
  const overrides = input.assignments ?? []

  if (overrides.length > 0) {
    const byTask = new Map(tasks.map((t) => [t.id, t]))
    // The dispatchable set is the authority on what may be chosen — the same
    // set the Scheduler will pick from minutes later. Offering anything wider
    // is the bug Batch 9.5 fixed on the roster's model selector: a control that
    // lets you choose something that cannot run, and then silently does
    // something else. Layer 1 and Layer 3 agents are excluded by construction
    // here, because dispatchableAgents only ever returns layer 2.
    const { agents: candidates } = await dispatchableAgents()
    const byAgent = new Map(candidates.map((a) => [a.id, a]))

    for (const override of overrides) {
      const task = byTask.get(override.taskId)
      if (!task) {
        throw new PlanApprovalError(`task ${override.taskId} is not part of this mission`, 400)
      }
      const agent = byAgent.get(override.agentId)
      if (!agent) {
        throw new PlanApprovalError(
          `${override.agentId} is not a builder this host can dispatch to`,
          400,
        )
      }
      await assignTaskAgent(task.id, agent.id)
      assigned.push({ taskId: task.id, agentId: agent.id, agentName: agent.name })
    }
  }

  await recordEvent(missionId, 'plan.approved', {
    taskCount: tasks.length,
    reassigned: assigned.length,
    assignments: assigned,
    by: 'owner',
  })

  const running = await updateMissionStatus(missionId, 'running', {
    reason: 'plan approved',
    reassigned: assigned.length,
  })

  return { mission: running, assigned }
}
