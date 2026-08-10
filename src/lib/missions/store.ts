import { supabase } from '@/lib/supabase'
import { isTableMissing } from '@/lib/usage/log'
import {
  ACTIVE_MISSION_STATUSES,
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

export async function createTask(missionId: string, input: CreateTaskInput): Promise<Task> {
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
      'id, mission_id, title, description, status, priority, assigned_agent, depends_on, created_at, started_at, completed_at',
    )
    .single()
  if (error) fail('createTask', error)

  const task = toTask(data as TaskRow)
  await recordEvent(
    missionId,
    'task.created',
    { title: task.title, priority: task.priority, dependsOn: task.dependsOn },
    task.id,
  )
  return task
}

export async function getTask(id: string): Promise<Task | null> {
  const { data, error } = await supabase
    .from('tasks')
    .select(
      'id, mission_id, title, description, status, priority, assigned_agent, depends_on, created_at, started_at, completed_at',
    )
    .eq('id', id)
    .maybeSingle()
  if (error) fail('getTask', error)
  return data ? toTask(data as TaskRow) : null
}

export async function listTasks(missionId: string): Promise<Task[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select(
      'id, mission_id, title, description, status, priority, assigned_agent, depends_on, created_at, started_at, completed_at',
    )
    .eq('mission_id', missionId)
    .order('created_at', { ascending: true })
  if (error) fail('listTasks', error)
  return ((data ?? []) as TaskRow[]).map(toTask)
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
      'id, mission_id, title, description, status, priority, assigned_agent, depends_on, created_at, started_at, completed_at',
    )
    .single()
  if (error) fail('updateTaskStatus', error)

  await recordEvent(
    previous.missionId,
    'task.status_changed',
    { from: previous.status, to: status, ...detail },
    taskId,
  )
  return toTask(data as TaskRow)
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

// ── Agent voices ──────────────────────────────────────────────────────
// Same tolerant-column pattern as instructions above: `voice_id` arrives in
// 20260810120000_agent_voice.sql. Absent, every agent still SPEAKS — the
// rotation default in src/lib/voice/voices.ts covers that — it just cannot
// remember a voice Henry picked.

const VOICE_MIGRATION = 'supabase/migrations/20260810120000_agent_voice.sql'

function voiceColumnMissing(error: { message?: string; code?: string } | null): boolean {
  return /column .*voice_id.* does not exist/i.test(error?.message ?? '') || isTableMissing(error)
}

/** Chosen voice for one agent, or null for "nobody has picked". */
export async function getAgentVoice(agentId: string): Promise<string | null> {
  const { data, error } = await supabase.from('agents').select('voice_id').eq('id', agentId).maybeSingle()
  if (error) {
    if (voiceColumnMissing(error)) return null
    fail('getAgentVoice', error)
  }
  const value = (data as { voice_id?: string | null } | null)?.voice_id
  return typeof value === 'string' && value.trim() ? value : null
}

/** Chosen voices for the whole roster. Empty map pre-migration. */
export async function listAgentVoices(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('agents').select('id, voice_id')
  if (error) {
    if (voiceColumnMissing(error)) return new Map()
    fail('listAgentVoices', error)
  }
  const out = new Map<string, string>()
  for (const row of (data ?? []) as { id: string; voice_id?: string | null }[]) {
    if (typeof row.voice_id === 'string' && row.voice_id.trim()) out.set(row.id, row.voice_id)
  }
  return out
}

/**
 * Every agent id, oldest first — the ordering the default voice rotation is
 * indexed by. Unfiltered on purpose: hiding disabled agents here would shift
 * the default voice of every agent created after one was switched off.
 */
export async function listAgentIdsByCreation(): Promise<string[]> {
  const { data, error } = await supabase.from('agents').select('id').order('created_at', { ascending: true })
  if (error) fail('listAgentIdsByCreation', error)
  return ((data ?? []) as { id: string }[]).map((r) => r.id)
}

// ── Agent writes (owner-gated at the route layer) ─────────────────────

export interface CreateAgentInput {
  name: string
  layer: AgentLayer
  cliCommand?: string | null
  instructions?: string | null
  voiceId?: string | null
  enabled?: boolean
  strengths?: string[]
}

export interface UpdateAgentInput {
  name?: string
  cliCommand?: string | null
  instructions?: string | null
  voiceId?: string | null
  enabled?: boolean
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
  if (input.voiceId !== undefined) row.voice_id = input.voiceId?.trim() || null

  const { data, error } = await supabase
    .from('agents')
    .insert(row)
    .select(
      'id, name, layer, cli_command, strengths, speed_rating, cost_rating, reliability_pct, context_window, enabled, parent_id, created_at',
    )
    .single()
  if (error) {
    if (voiceColumnMissing(error)) {
      throw new MissionStoreError(`createAgent: apply ${VOICE_MIGRATION} before choosing a voice.`, error)
    }
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
  if (patch.voiceId !== undefined) row.voice_id = patch.voiceId?.trim() || null

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
    if (voiceColumnMissing(error)) {
      throw new MissionStoreError(`updateAgent: apply ${VOICE_MIGRATION} before choosing a voice.`, error)
    }
    if (instructionsColumnMissing(error)) {
      throw new MissionStoreError(`updateAgent: apply ${INSTRUCTIONS_MIGRATION} before setting instructions.`, error)
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
