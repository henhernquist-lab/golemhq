import { supabase } from '@/lib/supabase'
import { isTableMissing } from '@/lib/usage/log'
import {
  ACTIVE_MISSION_STATUSES,
  type Lease,
  type LeaseType,
  type Agent,
  type AgentLayer,
  type Mission,
  type MissionEvent,
  type MissionEventType,
  type MissionStatus,
  type Task,
  type TaskPriority,
  type TaskResult,
  type TaskStatus,
} from './types'

// Server-side store for the mission spine. Every orchestration layer goes
// through here rather than touching Supabase directly.
//
// Deliberately NOT silent, unlike session-store.ts. That one swallows errors
// because a failed terminal-session write must never break a keystroke; this
// one is the system of record, and a mission that half-exists is worse than
// one that failed loudly. So these throw, and callers decide.
//
// The one thing that is never allowed to throw is recordEvent — see below.

export class MissionStoreError extends Error {
  // Assigned explicitly rather than via a constructor parameter property:
  // scripts/verify-missions.mjs runs this file through Node's strip-only type
  // stripping, which rejects parameter properties outright.
  readonly detail?: unknown

  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'MissionStoreError'
    this.detail = detail
  }
}

/** Postgres unique-violation. Raised by the one-active-mission-per-repo index. */
const PG_UNIQUE_VIOLATION = '23505'

function fail(scope: string, error: { message?: string; code?: string } | null): never {
  if (isTableMissing(error)) {
    throw new MissionStoreError(
      `${scope}: the mission tables don't exist yet — apply supabase/migrations/20260806030000_mission_spine.sql.`,
      error,
    )
  }
  throw new MissionStoreError(`${scope}: ${error?.message ?? 'unknown database error'}`, error)
}

// ── Row mappers ───────────────────────────────────────────────────────

interface MissionRow {
  id: string
  repo: string
  goal: string
  status: MissionStatus
  created_by: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

const toMission = (r: MissionRow): Mission => ({
  id: r.id,
  repo: r.repo,
  goal: r.goal,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
})

interface TaskRow {
  id: string
  mission_id: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  assigned_agent: string | null
  depends_on: string[] | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  expected_paths?: string[] | null
}

const toTask = (r: TaskRow): Task => ({
  id: r.id,
  missionId: r.mission_id,
  title: r.title,
  description: r.description,
  status: r.status,
  priority: r.priority,
  assignedAgent: r.assigned_agent,
  dependsOn: r.depends_on ?? [],
  createdAt: r.created_at,
  startedAt: r.started_at,
  completedAt: r.completed_at,
  // undefined (column absent) and null (present, undeclared) both mean "no
  // declaration" to the Coordinator, which is the conservative reading.
  expectedPaths: r.expected_paths ?? null,
})

interface EventRow {
  id: string
  mission_id: string
  task_id: string | null
  ts: string
  type: string
  payload: Record<string, unknown> | null
}

const toEvent = (r: EventRow): MissionEvent => ({
  id: r.id,
  missionId: r.mission_id,
  taskId: r.task_id,
  ts: r.ts,
  type: r.type,
  payload: r.payload ?? {},
})

interface AgentRow {
  id: string
  name: string
  layer: AgentLayer
  cli_command: string | null
  strengths: unknown
  speed_rating: number | null
  cost_rating: number | null
  reliability_pct: number | null
  context_window: number | null
  enabled: boolean
  parent_id: string | null
  created_at: string
}

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  name: r.name,
  layer: r.layer,
  cliCommand: r.cli_command,
  strengths: Array.isArray(r.strengths) ? (r.strengths as string[]) : [],
  speedRating: r.speed_rating,
  costRating: r.cost_rating,
  reliabilityPct: r.reliability_pct,
  contextWindow: r.context_window,
  enabled: r.enabled,
  parentId: r.parent_id,
  createdAt: r.created_at,
})

// ── Events ────────────────────────────────────────────────────────────

/**
 * Append one row to the mission's history.
 *
 * The single function here that swallows its errors. Every status change calls
 * it, and if a log write could throw it would be able to roll back a
 * transition that already happened — leaving the tables and the log disagreeing
 * about reality. A missing event is recoverable; a mission stuck because
 * logging failed is not.
 */
export async function recordEvent(
  missionId: string,
  type: MissionEventType,
  payload: Record<string, unknown> = {},
  taskId?: string | null,
): Promise<void> {
  try {
    const { error } = await supabase.from('mission_events').insert({
      mission_id: missionId,
      task_id: taskId ?? null,
      type,
      payload,
    })
    if (error && !isTableMissing(error)) {
      console.error('[missions] recordEvent failed:', error.message)
    }
  } catch (e) {
    console.error('[missions] recordEvent threw:', e)
  }
}

/**
 * Recent events across every mission, newest first — the raw material for a
 * live activity feed. Unlike listEvents this is not scoped to one mission, so
 * callers that want to exclude chat/audit "missions" (see CHAT_REPO_PREFIX,
 * AUDIT_REPO) must join against listMissions themselves; this stays a plain
 * event query rather than knowing about those conventions.
 */
export async function listRecentEvents(limit = 100): Promise<MissionEvent[]> {
  const { data, error } = await supabase
    .from('mission_events')
    .select('id, mission_id, task_id, ts, type, payload')
    .order('ts', { ascending: false })
    .limit(limit)
  if (error) fail('listRecentEvents', error)
  return ((data ?? []) as EventRow[]).map(toEvent)
}

export async function listEvents(missionId: string, limit = 500): Promise<MissionEvent[]> {
  const { data, error } = await supabase
    .from('mission_events')
    .select('id, mission_id, task_id, ts, type, payload')
    .eq('mission_id', missionId)
    .order('ts', { ascending: true })
    .limit(limit)
  if (error) fail('listEvents', error)
  return ((data ?? []) as EventRow[]).map(toEvent)
}

// ── Missions ──────────────────────────────────────────────────────────

/**
 * Start a mission.
 *
 * Guardrail: one active mission per repo. Checked here for a readable error and
 * enforced by a partial unique index in the database, which is what actually
 * holds under a race between two concurrent callers — the pre-check alone
 * would let both through.
 */
export async function createMission(
  repo: string,
  goal: string,
  createdBy?: string | null,
): Promise<Mission> {
  const existing = await getActiveMission(repo)
  if (existing) {
    throw new MissionStoreError(
      `Repo "${repo}" already has an active mission (${existing.id}, status "${existing.status}"). ` +
        'Complete or cancel it before starting another.',
    )
  }

  const { data, error } = await supabase
    .from('missions')
    .insert({ repo, goal, status: 'planning', created_by: createdBy ?? null })
    .select('id, repo, goal, status, created_by, created_at, updated_at, completed_at')
    .single()

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      // Lost the race between the pre-check and the insert.
      throw new MissionStoreError(
        `Repo "${repo}" already has an active mission — another one was created concurrently.`,
        error,
      )
    }
    fail('createMission', error)
  }

  const mission = toMission(data as MissionRow)
  await recordEvent(mission.id, 'mission.created', { repo, goal })
  return mission
}

export async function getMission(id: string): Promise<Mission | null> {
  const { data, error } = await supabase
    .from('missions')
    .select('id, repo, goal, status, created_by, created_at, updated_at, completed_at')
    .eq('id', id)
    .maybeSingle()
  if (error) fail('getMission', error)
  return data ? toMission(data as MissionRow) : null
}

export async function getActiveMission(repo: string): Promise<Mission | null> {
  const { data, error } = await supabase
    .from('missions')
    .select('id, repo, goal, status, created_by, created_at, updated_at, completed_at')
    .eq('repo', repo)
    .in('status', ACTIVE_MISSION_STATUSES)
    .maybeSingle()
  if (error) fail('getActiveMission', error)
  return data ? toMission(data as MissionRow) : null
}

export async function listMissions(repo?: string, limit = 100): Promise<Mission[]> {
  let query = supabase
    .from('missions')
    .select('id, repo, goal, status, created_by, created_at, updated_at, completed_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (repo) query = query.eq('repo', repo)
  const { data, error } = await query
  if (error) fail('listMissions', error)
  return ((data ?? []) as MissionRow[]).map(toMission)
}

export async function updateMissionStatus(
  id: string,
  status: MissionStatus,
  detail: Record<string, unknown> = {},
): Promise<Mission> {
  const previous = await getMission(id)
  if (!previous) throw new MissionStoreError(`updateMissionStatus: mission ${id} not found`)

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { status, updated_at: now }
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    patch.completed_at = now
  }

  const { data, error } = await supabase
    .from('missions')
    .update(patch)
    .eq('id', id)
    .select('id, repo, goal, status, created_by, created_at, updated_at, completed_at')
    .single()
  if (error) fail('updateMissionStatus', error)

  await recordEvent(id, 'mission.status_changed', { from: previous.status, to: status, ...detail })
  return toMission(data as MissionRow)
}

// ── Tasks ─────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  title: string
  description?: string
  priority?: TaskPriority
  assignedAgent?: string | null
  dependsOn?: string[]
}

/**
 * Task columns, with expected_paths only when the Batch 6 migration is applied.
 *
 * Probed once and remembered. Asking for a column that does not exist fails the
 * whole select rather than returning null for it, so every task read would
 * break on a pre-migration database — and the Coordinator is designed to
 * degrade to sequential dispatch there, not to take the mission down.
 */
let expectedPathsColumn: boolean | null = null

function taskColumns(): string {
  const base =
    'id, mission_id, title, description, status, priority, assigned_agent, depends_on, created_at, started_at, completed_at'
  return expectedPathsColumn === false ? base : `${base}, expected_paths`
}

/**
 * Decide once whether expected_paths can be selected.
 *
 * A probe rather than a try/retry around every read: retrying would double the
 * round trips on the pre-migration path, and the answer cannot change inside a
 * process lifetime without a deploy.
 */
async function ensureTaskColumns(): Promise<void> {
  if (expectedPathsColumn !== null) return
  const { error } = await supabase.from('tasks').select('expected_paths').limit(1)
  expectedPathsColumn = !(error && /column .*expected_paths.* does not exist/i.test(error.message ?? ''))
}

export async function createTask(missionId: string, input: CreateTaskInput): Promise<Task> {
  await ensureTaskColumns()
  const { data, error } = await supabase
    .from('tasks')
    .insert({
      mission_id: missionId,
      title: input.title,
      description: input.description ?? '',
      priority: input.priority ?? 'medium',
      assigned_agent: input.assignedAgent ?? null,
      depends_on: input.dependsOn?.length ? input.dependsOn : null,
      status: input.assignedAgent ? 'assigned' : 'pending',
    })
    .select(
      taskColumns(),
    )
    .single()
  if (error) fail('createTask', error)

  const task = toTask(data as unknown as TaskRow)
  await recordEvent(
    missionId,
    'task.created',
    { title: task.title, priority: task.priority, dependsOn: task.dependsOn },
    task.id,
  )
  return task
}

export async function getTask(id: string): Promise<Task | null> {
  await ensureTaskColumns()
  const { data, error } = await supabase
    .from('tasks')
    .select(
      taskColumns(),
    )
    .eq('id', id)
    .maybeSingle()
  if (error) fail('getTask', error)
  return data ? toTask(data as unknown as TaskRow) : null
}

export async function listTasks(missionId: string): Promise<Task[]> {
  await ensureTaskColumns()
  const { data, error } = await supabase
    .from('tasks')
    .select(
      taskColumns(),
    )
    .eq('mission_id', missionId)
    .order('created_at', { ascending: true })
  if (error) fail('listTasks', error)
  return ((data ?? []) as unknown as TaskRow[]).map(toTask)
}

/**
 * Move a task and log it. Stamps started_at on first entry to `running` and
 * completed_at on a terminal status, so the timeline doesn't have to be
 * reconstructed from the event log.
 */
export async function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  detail: Record<string, unknown> = {},
): Promise<Task> {
  const previous = await getTask(taskId)
  if (!previous) throw new MissionStoreError(`updateTaskStatus: task ${taskId} not found`)

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { status }
  if (status === 'running' && !previous.startedAt) patch.started_at = now
  if (status === 'complete' || status === 'failed') patch.completed_at = now
  if (typeof detail.assignedAgent === 'string') patch.assigned_agent = detail.assignedAgent

  const { data, error } = await supabase
    .from('tasks')
    .update(patch)
    .eq('id', taskId)
    .select(
      taskColumns(),
    )
    .single()
  if (error) fail('updateTaskStatus', error)

  await recordEvent(
    previous.missionId,
    'task.status_changed',
    { from: previous.status, to: status, ...detail },
    taskId,
  )
  return toTask(data as unknown as TaskRow)
}

/**
 * Set a task's builder without moving its status.
 *
 * Batch 11 writes the approved assignment at the plan gate, before anything is
 * dispatched, so the task has to stay `pending` — it is the Scheduler's job to
 * move it to `assigned`, and pre-empting that would make an unrun task look
 * claimed to every reader of the roster.
 *
 * updateTaskStatus is the wrong tool for this even though it can carry
 * assignedAgent: called with the status the task already has, it records a
 * task.status_changed event reading `pending → pending`, which is noise in the
 * one log the whole pipeline is audited from.
 */
export async function assignTaskAgent(taskId: string, agentId: string): Promise<Task> {
  const previous = await getTask(taskId)
  if (!previous) throw new MissionStoreError(`assignTaskAgent: task ${taskId} not found`)

  const { data, error } = await supabase
    .from('tasks')
    .update({ assigned_agent: agentId })
    .eq('id', taskId)
    .select(taskColumns())
    .single()
  if (error) fail('assignTaskAgent', error)

  await recordEvent(
    previous.missionId,
    'task.agent_assigned',
    { from: previous.assignedAgent, to: agentId },
    taskId,
  )
  return toTask(data as unknown as TaskRow)
}

// ── Results ───────────────────────────────────────────────────────────

/**
 * Store one headless CLI run's output.
 *
 * Batch 2's builder adapter calls this with whatever the Cruise terminal
 * captured from `<cli> -p "..."`. It does not change task status — the caller
 * decides whether a successful run means `validating` or `complete`.
 */
export async function recordResult(
  taskId: string,
  agentId: string | null,
  output: string,
  success: boolean,
  error?: string | null,
  durationMs?: number | null,
): Promise<TaskResult> {
  const { data, error: dbError } = await supabase
    .from('task_results')
    .insert({
      task_id: taskId,
      agent_id: agentId,
      output,
      success,
      error: error ?? null,
      duration_ms: durationMs ?? null,
    })
    .select('id, task_id, agent_id, output, success, error, duration_ms, created_at')
    .single()
  if (dbError) fail('recordResult', dbError)

  const row = data as {
    id: string
    task_id: string
    agent_id: string | null
    output: string
    success: boolean
    error: string | null
    duration_ms: number | null
    created_at: string
  }

  const task = await getTask(taskId)
  if (task) {
    await recordEvent(
      task.missionId,
      'task.result_recorded',
      { success, durationMs: durationMs ?? null, outputBytes: output.length, error: error ?? null },
      taskId,
    )
  }

  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    output: row.output,
    success: row.success,
    error: row.error,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }
}

export async function listResults(taskId: string): Promise<TaskResult[]> {
  const { data, error } = await supabase
    .from('task_results')
    .select('id, task_id, agent_id, output, success, error, duration_ms, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
  if (error) fail('listResults', error)
  return (
    (data ?? []) as {
      id: string
      task_id: string
      agent_id: string | null
      output: string
      success: boolean
      error: string | null
      duration_ms: number | null
      created_at: string
    }[]
  ).map((r) => ({
    id: r.id,
    taskId: r.task_id,
    agentId: r.agent_id,
    output: r.output,
    success: r.success,
    error: r.error,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  }))
}

// ── Agents ────────────────────────────────────────────────────────────

export async function listAgents(layer?: AgentLayer, enabledOnly = false): Promise<Agent[]> {
  let query = supabase
    .from('agents')
    .select(
      'id, name, layer, cli_command, strengths, speed_rating, cost_rating, reliability_pct, context_window, enabled, parent_id, created_at',
    )
    .order('layer', { ascending: true })
    .order('name', { ascending: true })
  if (layer) query = query.eq('layer', layer)
  if (enabledOnly) query = query.eq('enabled', true)
  const { data, error } = await query
  if (error) fail('listAgents', error)
  return ((data ?? []) as AgentRow[]).map(toAgent)
}

export async function getAgentByName(name: string): Promise<Agent | null> {
  const { data, error } = await supabase
    .from('agents')
    .select(
      'id, name, layer, cli_command, strengths, speed_rating, cost_rating, reliability_pct, context_window, enabled, parent_id, created_at',
    )
    .eq('name', name)
    .maybeSingle()
  if (error) fail('getAgentByName', error)
  return data ? toAgent(data as AgentRow) : null
}

// ── Agent instructions ────────────────────────────────────────────────
// Same reasoning as the detection columns below: `instructions` arrives in
// 20260809160000_agent_instructions.sql, so it stays off listAgents' SELECT.
// The adapter reads it on every builder run and must degrade to "no standing
// instructions" — not to a crash — on a database without the migration.

const INSTRUCTIONS_MIGRATION = 'supabase/migrations/20260809160000_agent_instructions.sql'

function instructionsColumnMissing(error: { message?: string; code?: string } | null): boolean {
  return /column .*instructions.* does not exist/i.test(error?.message ?? '') || isTableMissing(error)
}

const MODEL_MIGRATION = 'supabase/migrations/20260816020000_agent_model.sql'

function modelColumnMissing(error: { message?: string; code?: string } | null): boolean {
  return /column .*model.* does not exist/i.test(error?.message ?? '') || isTableMissing(error)
}

/**
 * Standing instructions for one agent, or null.
 *
 * Returns null rather than throwing when the column is absent. An agent with
 * no instructions and an agent on a pre-migration database behave identically
 * — both simply get the task prompt — so the run should proceed either way.
 */
export async function getAgentInstructions(agentId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('agents')
    .select('instructions')
    .eq('id', agentId)
    .maybeSingle()
  if (error) {
    if (instructionsColumnMissing(error)) return null
    fail('getAgentInstructions', error)
  }
  const value = (data as { instructions?: string | null } | null)?.instructions
  return typeof value === 'string' && value.trim() ? value : null
}

/** Instructions for every agent, for the roster view. Empty map pre-migration. */
export async function listAgentInstructions(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('agents').select('id, instructions')
  if (error) {
    if (instructionsColumnMissing(error)) return new Map()
    fail('listAgentInstructions', error)
  }
  const out = new Map<string, string>()
  for (const row of (data ?? []) as { id: string; instructions?: string | null }[]) {
    if (typeof row.instructions === 'string' && row.instructions.trim()) out.set(row.id, row.instructions)
  }
  return out
}

/** Assigned model for every agent (id → model id). Empty map pre-migration. */
export async function listAgentModels(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('agents').select('id, model')
  if (error) {
    if (modelColumnMissing(error)) return new Map()
    fail('listAgentModels', error)
  }
  const out = new Map<string, string>()
  for (const row of (data ?? []) as { id: string; model?: string | null }[]) {
    if (typeof row.model === 'string' && row.model.trim()) out.set(row.id, row.model)
  }
  return out
}

// ── Agent writes (owner-gated at the route layer) ─────────────────────

export interface CreateAgentInput {
  name: string
  layer: AgentLayer
  cliCommand?: string | null
  instructions?: string | null
  enabled?: boolean
  strengths?: string[]
}

export interface UpdateAgentInput {
  name?: string
  cliCommand?: string | null
  instructions?: string | null
  enabled?: boolean
  /** Registry model id (src/lib/nim.ts MODEL_LIST). Null = use the CLI's own default. */
  model?: string | null
}

/** Blank is not a value here — see the check constraint in the migration. */
function normaliseInstructions(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  // A layer-2 agent with no cli_command cannot be dispatched to, and the
  // adapter throws when it meets one. Refusing here turns a confusing runtime
  // failure into an obvious form error.
  if (input.layer === 2 && !input.cliCommand?.trim()) {
    throw new MissionStoreError('A builder (layer 2) needs a cli_command — that is what gets executed.')
  }

  const row: Record<string, unknown> = {
    name: input.name.trim(),
    layer: input.layer,
    cli_command: input.cliCommand?.trim() || null,
    enabled: input.enabled ?? true,
    strengths: input.strengths ?? [],
  }
  const instructions = normaliseInstructions(input.instructions)
  if (instructions !== undefined) row.instructions = instructions

  const { data, error } = await supabase
    .from('agents')
    .insert(row)
    .select(
      'id, name, layer, cli_command, strengths, speed_rating, cost_rating, reliability_pct, context_window, enabled, parent_id, created_at',
    )
    .single()
  if (error) {
    if (instructionsColumnMissing(error)) {
      throw new MissionStoreError(`createAgent: apply ${INSTRUCTIONS_MIGRATION} before setting instructions.`, error)
    }
    if (error.code === PG_UNIQUE_VIOLATION) {
      throw new MissionStoreError(`An agent named "${input.name}" already exists.`, error)
    }
    fail('createAgent', error)
  }
  return toAgent(data as AgentRow)
}

export async function updateAgent(id: string, patch: UpdateAgentInput): Promise<Agent> {
  const row: Record<string, unknown> = {}
  if (patch.name !== undefined) row.name = patch.name.trim()
  if (patch.cliCommand !== undefined) row.cli_command = patch.cliCommand?.trim() || null
  if (patch.enabled !== undefined) row.enabled = patch.enabled
  const instructions = normaliseInstructions(patch.instructions)
  if (instructions !== undefined) row.instructions = instructions
  if (patch.model !== undefined) {
    const model = patch.model?.trim()
    row.model = model ? model : null
  }

  if (Object.keys(row).length === 0) {
    const existing = await getAgentById(id)
    if (!existing) throw new MissionStoreError(`updateAgent: agent ${id} not found`)
    return existing
  }

  const { data, error } = await supabase
    .from('agents')
    .update(row)
    .eq('id', id)
    .select(
      'id, name, layer, cli_command, strengths, speed_rating, cost_rating, reliability_pct, context_window, enabled, parent_id, created_at',
    )
    .single()
  if (error) {
    if (instructionsColumnMissing(error)) {
      throw new MissionStoreError(`updateAgent: apply ${INSTRUCTIONS_MIGRATION} before setting instructions.`, error)
    }
    if (modelColumnMissing(error)) {
      throw new MissionStoreError(`updateAgent: apply ${MODEL_MIGRATION} before setting model.`, error)
    }
    fail('updateAgent', error)
  }
  return toAgent(data as AgentRow)
}

export async function getAgentById(id: string): Promise<Agent | null> {
  const { data, error } = await supabase
    .from('agents')
    .select(
      'id, name, layer, cli_command, strengths, speed_rating, cost_rating, reliability_pct, context_window, enabled, parent_id, created_at',
    )
    .eq('id', id)
    .maybeSingle()
  if (error) fail('getAgentById', error)
  return data ? toAgent(data as AgentRow) : null
}

// ── CLI detection ─────────────────────────────────────────────────────
// Kept off listAgents' SELECT on purpose: these columns arrive in a later
// migration, and widening that SELECT would break the adapter's agent lookup
// on any database where it hasn't been applied yet. Reading them is opt-in.

export type DetectionHost = 'local' | 'sprite'

export interface AgentDetectionRecord {
  cliPath: string | null
  cliVersion: string | null
  detectedAt: string | null
  detectedHost: DetectionHost | null
}

const DETECTION_MIGRATION = 'supabase/migrations/20260807040000_agent_cli_detection.sql'

/** "column ... does not exist" also matches isTableMissing, so check first. */
function failDetection(scope: string, error: { message?: string; code?: string } | null): never {
  if (/column .* does not exist/i.test(error?.message ?? '') || isTableMissing(error)) {
    throw new MissionStoreError(`${scope}: detection columns are missing — apply ${DETECTION_MIGRATION}.`, error)
  }
  throw new MissionStoreError(`${scope}: ${error?.message ?? 'unknown database error'}`, error)
}

/**
 * Persist one host's detection sweep.
 *
 * A null path means "checked on that host and absent" — deliberately distinct
 * from detected_at being null, which means never checked at all.
 */
export async function recordDetection(
  host: DetectionHost,
  results: { agentId: string; path: string | null; version: string | null }[],
): Promise<number> {
  const detectedAt = new Date().toISOString()
  for (const r of results) {
    const { error } = await supabase
      .from('agents')
      .update({ cli_path: r.path, cli_version: r.version, detected_at: detectedAt, detected_host: host })
      .eq('id', r.agentId)
    if (error) failDetection('recordDetection', error)
  }
  return results.length
}

export async function getDetections(): Promise<Map<string, AgentDetectionRecord>> {
  const { data, error } = await supabase
    .from('agents')
    .select('id, cli_path, cli_version, detected_at, detected_host')
  if (error) failDetection('getDetections', error)

  const rows = (data ?? []) as {
    id: string
    cli_path: string | null
    cli_version: string | null
    detected_at: string | null
    detected_host: DetectionHost | null
  }[]
  return new Map(
    rows.map((r) => [
      r.id,
      { cliPath: r.cli_path, cliVersion: r.cli_version, detectedAt: r.detected_at, detectedHost: r.detected_host },
    ]),
  )
}

// ── Leases (Batch 6) ──────────────────────────────────────────────────
// The table is Batch 1's `leases`. mission_id / repo / heartbeat_at are Batch
// 6 additions and every read here tolerates their absence, because the
// Coordinator's fallback on a pre-migration database is sequential dispatch —
// the Batch 4 behaviour — rather than a failed mission.

interface LeaseRow {
  id: string
  task_id: string
  path_glob: string
  lease_type: LeaseType
  owner_agent: string | null
  acquired_at: string
  expires_at: string
  released_at: string | null
  heartbeat_at?: string | null
  mission_id?: string | null
  repo?: string | null
}

const toLease = (r: LeaseRow): Lease => ({
  id: r.id,
  taskId: r.task_id,
  pathGlob: r.path_glob,
  leaseType: r.lease_type,
  ownerAgent: r.owner_agent,
  acquiredAt: r.acquired_at,
  expiresAt: r.expires_at,
  releasedAt: r.released_at ?? null,
  heartbeatAt: r.heartbeat_at ?? null,
  missionId: r.mission_id ?? null,
  repo: r.repo ?? null,
})

let leaseExtrasColumn: boolean | null = null

const LEASE_BASE = 'id, task_id, path_glob, lease_type, owner_agent, acquired_at, expires_at, released_at'
const LEASE_EXTRAS = 'heartbeat_at, mission_id, repo'

async function ensureLeaseColumns(): Promise<void> {
  if (leaseExtrasColumn !== null) return
  const { error } = await supabase.from('leases').select(LEASE_EXTRAS).limit(1)
  leaseExtrasColumn = !(error && /column .* does not exist/i.test(error.message ?? ''))
}

function leaseColumns(): string {
  return leaseExtrasColumn === false ? LEASE_BASE : `${LEASE_BASE}, ${LEASE_EXTRAS}`
}

export interface AcquireLeaseInput {
  taskId: string
  missionId: string
  repo: string
  pathGlob: string
  leaseType: LeaseType
  ownerAgent: string | null
  expiresAt: string
}

export async function acquireLeaseRow(input: AcquireLeaseInput): Promise<Lease> {
  await ensureLeaseColumns()
  const now = new Date().toISOString()
  const row: Record<string, unknown> = {
    task_id: input.taskId,
    path_glob: input.pathGlob,
    lease_type: input.leaseType,
    owner_agent: input.ownerAgent,
    expires_at: input.expiresAt,
  }
  if (leaseExtrasColumn !== false) {
    row.mission_id = input.missionId
    row.repo = input.repo
    row.heartbeat_at = now
  }
  const { data, error } = await supabase.from('leases').insert(row).select(leaseColumns()).single()
  if (error) fail('acquireLeaseRow', error)
  return toLease(data as unknown as LeaseRow)
}

/**
 * Every unreleased lease in a repo.
 *
 * Without the repo column there is nothing to filter on, so this falls back to
 * every active lease everywhere. That is over-broad rather than under-broad —
 * it can only cause extra serialisation, never a missed conflict.
 */
export async function listActiveLeases(repo?: string): Promise<Lease[]> {
  await ensureLeaseColumns()
  let query = supabase.from('leases').select(leaseColumns()).is('released_at', null)
  if (repo && leaseExtrasColumn !== false) query = query.eq('repo', repo)
  const { data, error } = await query.order('acquired_at', { ascending: true })
  if (error) {
    if (isTableMissing(error)) return []
    fail('listActiveLeases', error)
  }
  return ((data ?? []) as unknown as LeaseRow[]).map(toLease)
}

export async function listLeasesForTasks(taskIds: string[]): Promise<Lease[]> {
  if (taskIds.length === 0) return []
  await ensureLeaseColumns()
  const { data, error } = await supabase
    .from('leases')
    .select(leaseColumns())
    .in('task_id', taskIds)
    .is('released_at', null)
  if (error) {
    if (isTableMissing(error)) return []
    fail('listLeasesForTasks', error)
  }
  return ((data ?? []) as unknown as LeaseRow[]).map(toLease)
}

/** Release everything a task holds. Returns how many rows moved. */
export async function releaseLeasesForTask(taskId: string): Promise<number> {
  const { data, error } = await supabase
    .from('leases')
    .update({ released_at: new Date().toISOString() })
    .eq('task_id', taskId)
    .is('released_at', null)
    .select('id')
  if (error) {
    if (isTableMissing(error)) return 0
    fail('releaseLeasesForTask', error)
  }
  return (data ?? []).length
}

/** Push a task's leases forward. No-op pre-migration (nothing to beat with). */
export async function heartbeatLeasesForTask(taskId: string, expiresAt: string): Promise<number> {
  await ensureLeaseColumns()
  if (leaseExtrasColumn === false) return 0
  const { data, error } = await supabase
    .from('leases')
    .update({ heartbeat_at: new Date().toISOString(), expires_at: expiresAt })
    .eq('task_id', taskId)
    .is('released_at', null)
    .select('id')
  if (error) {
    if (isTableMissing(error)) return 0
    fail('heartbeatLeasesForTask', error)
  }
  return (data ?? []).length
}

/**
 * Release leases whose holder has stopped proving it is alive.
 *
 * Selected first and released by id rather than released in one predicate
 * update, because the caller has to be able to say WHICH leases were reaped —
 * a reaper that reports only a count cannot be verified, and this is the path
 * that unwedges a mission after a crash.
 */
export async function reapExpiredLeases(nowIso: string, repo?: string): Promise<Lease[]> {
  await ensureLeaseColumns()
  let query = supabase.from('leases').select(leaseColumns()).is('released_at', null).lt('expires_at', nowIso)
  if (repo && leaseExtrasColumn !== false) query = query.eq('repo', repo)
  const { data, error } = await query
  if (error) {
    if (isTableMissing(error)) return []
    fail('reapExpiredLeases', error)
  }
  const stale = ((data ?? []) as unknown as LeaseRow[]).map(toLease)
  if (stale.length === 0) return []

  const { error: relErr } = await supabase
    .from('leases')
    .update({ released_at: nowIso })
    .in('id', stale.map((l) => l.id))
    .is('released_at', null)
  if (relErr) fail('reapExpiredLeases.release', relErr)
  return stale
}

/** Persist a task's declared paths. Silently no-ops pre-migration. */
export async function setTaskExpectedPaths(taskId: string, paths: string[] | null): Promise<boolean> {
  await ensureTaskColumns()
  if (expectedPathsColumn === false) return false
  const { error } = await supabase.from('tasks').update({ expected_paths: paths }).eq('id', taskId)
  if (error) {
    if (/column .*expected_paths.* does not exist/i.test(error.message ?? '')) return false
    fail('setTaskExpectedPaths', error)
  }
  return true
}

/**
 * Remove a worker from the roster.
 *
 * Layer 1 is refused: Planner, Scheduler and Coordinator are not staff, they
 * are the pipeline. Deleting one would leave missions that can never be
 * planned or dispatched, with no UI path back. Layer 2 builders and Layer 3
 * validators are genuinely optional and can go.
 *
 * Tasks reference agents via assigned_agent; the column is nullable and set
 * null on delete, so historical missions keep their event trail (which records
 * the agent NAME in the payload) even after the row is gone.
 */
export async function deleteAgent(id: string): Promise<Agent> {
  const existing = await getAgentById(id)
  if (!existing) throw new MissionStoreError(`deleteAgent: agent ${id} not found`)
  if (existing.layer === 1) {
    throw new MissionStoreError(
      `deleteAgent: ${existing.name} is a Layer 1 orchestrator — the pipeline needs it. Disable it instead.`,
    )
  }

  const { error } = await supabase.from('agents').delete().eq('id', id)
  if (error) throw new MissionStoreError(`deleteAgent: ${error.message}`)
  return existing
}
