// Shared mission types — the DB row shapes and the enums the orchestration
// layers, routes and UI agree on. Kept in sync with
// supabase/migrations/20260806030000_mission_spine.sql.
//
// Naming: the blueprint calls layer 2 "builders", but one table holds all
// three layers, so it is `agents` here and everywhere downstream.

// ── Agents ────────────────────────────────────────────────────────────

/** 1 = orchestrator, 2 = builder (CLI-driven), 3 = validator. */
export type AgentLayer = 1 | 2 | 3

export const AGENT_LAYERS: AgentLayer[] = [1, 2, 3]

export const AGENT_LAYER_LABELS: Record<AgentLayer, string> = {
  1: 'Orchestrator',
  2: 'Builder',
  3: 'Validator',
}

export interface Agent {
  id: string
  name: string
  layer: AgentLayer
  /** Required for layer 2; null for orchestrators and validators. */
  cliCommand: string | null
  strengths: string[]
  speedRating: number | null
  costRating: number | null
  reliabilityPct: number | null
  contextWindow: number | null
  enabled: boolean
  /** Org-chart placement; null means this agent is a root/orphan node. */
  parentId: string | null
  createdAt: string
}

// ── Missions ──────────────────────────────────────────────────────────

export type MissionStatus =
  | 'planning'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * Statuses that count as "in flight". The one-active-mission-per-repo
 * guardrail keys off exactly this set, and so does the partial unique index in
 * the migration — keep the two in step.
 */
export const ACTIVE_MISSION_STATUSES: MissionStatus[] = [
  'planning',
  'running',
  'awaiting_approval',
]

export const TERMINAL_MISSION_STATUSES: MissionStatus[] = ['completed', 'failed', 'cancelled']

export interface Mission {
  id: string
  repo: string
  goal: string
  status: MissionStatus
  createdBy: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

// ── Tasks ─────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'validating'
  | 'complete'
  | 'failed'
  | 'blocked'

export type TaskPriority = 'low' | 'medium' | 'high'

export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['complete', 'failed']

export interface Task {
  id: string
  missionId: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  assignedAgent: string | null
  /** Task ids this one waits on. */
  dependsOn: string[]
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  /**
   * Path globs this task expects to write, for Coordinator overlap analysis.
   *
   * null is "undeclared" and is NOT the same as []. Undeclared means the
   * Coordinator has no basis to let it run alongside anything, so it takes the
   * whole repo; an explicit empty list means it genuinely writes nothing.
   * Always null when the Batch 6 migration has not been applied.
   */
  expectedPaths: string[] | null
}

// ── Results ───────────────────────────────────────────────────────────

/**
 * One headless CLI run. Builders are invoked one-shot through the Cruise
 * terminal (`gemini -p "..."`), so `output` is the whole run's stdout as a
 * single blob rather than a structured transcript.
 */
export interface TaskResult {
  id: string
  taskId: string
  agentId: string | null
  output: string
  success: boolean
  error: string | null
  durationMs: number | null
  createdAt: string
}

// ── Events ────────────────────────────────────────────────────────────

/**
 * Append-only mission history. Every status change writes one — the live UI
 * replays this log rather than polling the mutable tables.
 *
 * Open string rather than a closed union: later batches add types (lease
 * grants, validator verdicts, replans) and an event log that rejects unknown
 * types would drop history it can't yet name. The known ones are listed for
 * autocomplete via MissionEventType.
 */
export type MissionEventType =
  | 'mission.created'
  | 'mission.status_changed'
  | 'task.created'
  | 'task.status_changed'
  | 'task.result_recorded'
  | (string & {})

export interface MissionEvent {
  id: string
  missionId: string
  taskId: string | null
  ts: string
  type: MissionEventType
  payload: Record<string, unknown>
}

// ── Leases ────────────────────────────────────────────────────────────
// Table exists now; acquisition and conflict checks arrive in Batch 6.

export type LeaseType = 'read' | 'write' | 'exclusive'

export interface Lease {
  id: string
  taskId: string
  pathGlob: string
  leaseType: LeaseType
  ownerAgent: string | null
  acquiredAt: string
  expiresAt: string
  releasedAt: string | null
  /** Proof of life. Null on rows written before the Batch 6 migration. */
  heartbeatAt: string | null
  /** Denormalised from the owning task. Null pre-migration. */
  missionId: string | null
  /** Denormalised missions.repo — leases only conflict within one checkout. */
  repo: string | null
}
