import type { ResourceSource } from './resource-source'
import { emitResourceSaved } from './resource-events'

export type ResourceType = 'flashcards' | 'grade_calc' | 'workout' | 'meal' | 'repo_scan' | 'habit_streak' | 'race_pace' | 'prompt' | 'article_note' | 'repo_review' | 'countdown' | 'checkin' | 'note' | 'note_draft' | 'bell_schedule' | 'uploaded_file' | 'aperture' | 'briefing' | 'root_cause' | 'terminal_session' | 'ghost_conversation' | 'github_action' | 'contradiction' | 'regret' | 'memory' | 'learn_session' | 'task'

export interface Resource<T = unknown> {
  id: string
  user_id: string
  type: ResourceType
  source: ResourceSource
  title: string
  payload: T
  created_at: string
  updated_at: string
}

export interface FlashcardsPayload {
  notes: string
  cards: { question: string; answer: string }[]
}

export interface GradeCalcPayload {
  targetGpa: string
  classes: { id: string; name: string; currentGrade: number; finalWeight: number; credits: number }[]
  weightedGpa: number
}

export interface WorkoutPayload {
  exercise: string
  sets: { reps: number; weight: number }[]
  logged_at: string
}

export interface MealPayload {
  description: string
  calories: number
  protein: number
  carbs: number
  fat: number
}

export interface RepoScanPayload {
  name: string
  description: string
  stars: number
  language: string
  topics: string[]
  readme: string
  fileTree: string[]
}

export interface HabitStreakPayload {
  habit_id: string
  habit_name: string
  checked_on: string
  streak: number
}

export interface PromptPayload {
  body: string
  category: 'coding' | 'writing' | 'study' | 'training' | 'general' | 'meta'
  tags: string[]
  notes?: string
  use_count?: number
  last_used_at?: string
}

export interface ArticleNotePayload {
  url: string
  canonical_url?: string
  source_domain: string
  article_title: string
  author?: string
  published_at?: string
  fetched_at: string
  raw_text_length: number
  summary: string
  key_claims: string[]
  flashcards: { q: string; a: string }[]
  tags: string[]
  topic?: 'ai' | 'training' | 'writing' | 'building' | 'general'
  user_note?: string
  processing_failed?: boolean
}

export interface RacePacePayload {
  mode: 'calculation' | 'result'
  distance: string
  distance_meters: number
  time_seconds: number
  splits?: number[]
  strategy?: 'even' | 'negative' | 'race_model'
  date?: string
  notes?: string
  is_pr?: boolean
  meet?: string
}

export interface RepoReviewIssue {
  severity: 'high' | 'medium' | 'low'
  category: 'security' | 'architecture' | 'code-smell' | 'dead-code' | 'inconsistency'
  file: string
  description: string
  suggestion: string
}

export interface RepoReviewPayload {
  repo_full_name: string
  repo_url: string
  branch: string
  reviewed_at: string
  files_analyzed: string[]
  overview: string
  strengths: string[]
  issues: RepoReviewIssue[]
  refactor_priorities: string[]
  partial_sample?: boolean
}

export interface CountdownPayload {
  event_name: string
  event_date: string
  event_type: 'track_meet' | 'football_game' | 'other'
  location?: string
  notes?: string
}

export interface CheckinPayload {
  date: string
  rating: 1 | 2 | 3 | 4 | 5
  note?: string
}

export interface NotePayload {
  content: string
  title?: string
  // Deliberate-action only — set by the "Summarize" button in Grimoire, never
  // by autosave/debounce. Absent until the user explicitly generates one.
  summary?: string
  // Suggested by the "Auto-tag" button (also deliberate — see summary above).
  tags?: string[]
}

// Minimal task store: no dedicated task system existed anywhere in the app
// (grepped for a `type` discriminator, /tasks routes, kanban UI — none found),
// so this reuses the existing `resources` table/pattern with a `task`
// ResourceType rather than standing up a new schema. Intentionally tiny —
// just enough to hold a task converted from a Grimoire note.
export interface TaskPayload {
  content: string
  done: boolean
  source_note_id?: string
  created_at: string
}

// Memory entries are plain-text facts/notes Golem has stored about Henry.
// `imported: true` marks entries pasted in from another AI (ChatGPT custom
// instructions, Claude memory export, …) via the "Import Memory" flow so the
// UI can badge them separately from memories Golem itself captured.
export interface MemoryPayload {
  content: string
  imported?: boolean
  origin?: string
  /** Set for facts extracted from real activity and awaiting review. */
  autoCaptured?: boolean
  reviewState?: 'pending' | 'reviewed'
  /**
   * Which activity this fact was extracted from. Absent on manually-entered
   * and imported facts, and on chat-extracted facts written before this field
   * existed — 'chat' vs undefined-but-autoCaptured are not distinguished
   * retroactively, only going forward.
   */
  activityCategory?: 'chat' | 'lab'
}

export interface BellSchedulePayload {
  periods: { period: number; class_name: string; start_time: string; end_time: string }[]
}

export interface UploadedFilePayload {
  filename: string
  file_type: 'image' | 'pdf' | 'text'
  storage_path: string
  extracted_summary: string
  uploaded_at: string
}

export interface AperturePayload {
  question: string
  answer?: string
  answered_at?: string
  date: string // ISO date (YYYY-MM-DD), one per day
  context_used: string[]
}

export interface BriefingObservation {
  text: string
  sources: string[]
}

export interface BriefingAction {
  text: string
  reason: string
  completed: boolean
}

export interface BriefingFlag {
  text: string
  severity: 'low' | 'medium' | 'high'
}

export interface BriefingPayload {
  date: string
  observations: BriefingObservation[]
  suggested_actions: BriefingAction[]
  email_summary?: { urgent: string[]; grouped: { sender: string; count: number; topics: string[] }[]; low_signal: string[] }
  flag?: BriefingFlag
  generated_at: string
  refresh_count?: number
}

export interface CausalLayer {
  layer: number
  cause: string
  evidence: string[]
  accepted_by_user: boolean
}

export interface FailureSignature {
  description: string
  embedding?: number[]
}

export interface RootCausePayload {
  failure_description: string
  failure_date: string
  domain: 'training' | 'academic' | 'project' | 'other'
  causal_chain: CausalLayer[]
  root_cause: string
  preventions: string[]
  failure_signature: FailureSignature
  resolved_at: string
}

export interface TerminalCommand {
  cmd: string
  output: string
  timestamp: string
  exit_code: number
  // Set for write-mode actions (edit/apply/write/branch/commit/pr and their
  // natural-language equivalents) so the audit trail can be filtered to just
  // the actions that actually touched code, separate from read-only lookups.
  action?: 'propose_edit' | 'apply' | 'discard' | 'branch' | 'commit' | 'pr' | 'plan' | 'target_resolved' | 'reasoning_ready'
}

// A diff proposed by `edit`/`write` or a natural-language request, shown in
// the terminal but not yet written anywhere. Cleared on apply or replaced by
// the next proposal. Lives in the session row (not just client state) so a
// page refresh doesn't lose it and the audit trail can show what was
// proposed even if never applied.
export interface PendingDiff {
  file: string
  diff: string // unified diff text
  new_content: string
  is_new_file: boolean
  base_sha: string // real GitHub blob sha (first edit) or a content hash of the prior working-copy version (stacked edit)
  proposed_at: string
}

export interface TerminalSessionPayload {
  repo: string
  commands: TerminalCommand[]
  session_start: string
  session_end?: string
  // Write mode (all optional — absent entirely for a read-only session).
  current_branch?: string
  pending_diff?: PendingDiff | null
}

export interface GhostMessage {
  role: 'user' | 'ghost'
  content: string
}

export interface GhostConversationPayload {
  window_start: string
  window_end: string
  window_label: string
  messages: GhostMessage[]
  corpus_resource_ids: string[]
  created_at: string
}

// ── Learn session state ──────────────────────────────────────────────────
// Same shape convention as TerminalSessionPayload above: a durable per-session
// row in `resources` (type='learn_session'), atomically persisted via the
// same compare-and-swap helper Drive uses (see src/lib/session-cas.ts).
export interface LearnCommand {
  verb: 'learn' | 'probe' | 'gap' | 'defend' | 'teach' | 'retire'
  input: string
  output: string
  timestamp: string
  exit_code: number
}

export interface LearnSessionPayload {
  commands: LearnCommand[]
  session_start: string
  session_end?: string
  // The claim currently awaiting an answer from probe() — set when probe
  // surfaces a due claim, cleared once the answer event is recorded. Lives
  // in the session row (not just client state) so a page refresh doesn't
  // lose which claim is "live," same reasoning as PendingDiff above.
  // is_enemy carried through from surfaceNextDue so a future Freebuff feature
  // can tell an enemy claim apart once surfaced, without another schema/session
  // change. Optional — absent on sessions created before migration 020.
  pending_probe?: { claim_id: string; content: string; topic: string; asked_at: string; is_enemy?: boolean } | null
  // Two-phase `defend`: phase 1 surfaces a counterargument and parks it here;
  // phase 2 (the user's rebuttal) logs both sides and clears it. Same
  // "one thing in flight" discipline as pending_probe.
  pending_defense?: { claim_id: string; claim_content: string; counterargument: string; asked_at: string } | null
  // Two-phase `teach` (Feynman gate): phase 1 asks the user to explain the
  // claim; phase 2 grades the explanation, logs the verdict, and clears this.
  pending_teach?: { claim_id: string; claim_content: string; asked_at: string } | null
  // Open tabs — persisted across refreshes so the tab bar survives a reload.
  // Chat is always open; every other tab is opt-in via the "+" menu.
  // Stored as a list of tab ids; chat excluded (it's always first).
  open_tabs?: string[]
  // Casino balance — persisted per session for fast access (also derivable
  // from claim_events via src/lib/learn/casino.ts#getBalance but this avoids
  // re-scanning on every tab load).
  casino_balance?: number
}

export type GitHubActionType = 'create_file' | 'update_file' | 'create_branch' | 'create_pr' | 'create_repo'

export interface GitHubActionPayload {
  action: GitHubActionType
  repo: string
  branch?: string
  file_path?: string
  pr_url?: string
  summary: string
  timestamp: string
}

export async function saveResource(
  type: ResourceType,
  title: string,
  payload: unknown,
): Promise<void> {
  // Must actually await the write — callers do `await saveResource(...)`
  // then immediately reload a list. Without this await, the function was
  // returning before the network round-trip finished, so the reload could
  // (and did, reproducibly) race ahead of the save and show a stale list.
  try {
    const res = await fetch('/api/resources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, title, payload }),
    })
    if (!res.ok) {
      console.error('[resources] save failed:', res.status, await res.text().catch(() => ''))
      return
    }
    emitResourceSaved()
  } catch (e) {
    console.error('[resources] save failed:', e)
  }
}

export async function loadResources(type: ResourceType, source?: ResourceSource): Promise<Resource[]> {
  try {
    const qs = source ? `&source=${source}` : ''
    const res = await fetch(`/api/resources?type=${type}${qs}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.resources ?? []
  } catch {
    return []
  }
}

export async function deleteResource(id: string): Promise<void> {
  await fetch(`/api/resources/${id}`, { method: 'DELETE' })
}

export async function updateResource(
  id: string,
  type: ResourceType,
  title: string,
  payload: unknown,
): Promise<Resource | null> {
  try {
    const res = await fetch(`/api/resources/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, title, payload }),
    })
    if (!res.ok) return null
    const data = await res.json()
    emitResourceSaved()
    return data.resource ?? null
  } catch {
    return null
  }
}

function fmtSecsShort(s: number): string {
  if (s < 60) return s.toFixed(2)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`
}

export function resourceSummary(resource: Resource): string {
  const p = resource.payload as Record<string, unknown>
  switch (resource.type) {
    case 'flashcards': {
      const cards = (p.cards as unknown[]) ?? []
      return `${cards.length} card${cards.length !== 1 ? 's' : ''}`
    }
    case 'grade_calc': {
      const gpa = typeof p.weightedGpa === 'number' ? p.weightedGpa.toFixed(2) : '—'
      return `GPA ${gpa} · target ${p.targetGpa}`
    }
    case 'workout': {
      const sets = (p.sets as { reps: number; weight: number }[]) ?? []
      const max = sets.reduce((m, s) => Math.max(m, s.weight), 0)
      return `${sets.length} set${sets.length !== 1 ? 's' : ''} · ${max}lbs max`
    }
    case 'meal': {
      return `${p.calories}cal · ${p.protein}g protein`
    }
    case 'repo_scan': {
      const files = (p.fileTree as unknown[]) ?? []
      return `${p.language || 'unknown'} · ${p.stars} ★ · ${files.length} files`
    }
    case 'habit_streak': {
      const streak = typeof p.streak === 'number' ? p.streak : 0
      return streak > 0 ? `${streak}d streak` : 'checked in'
    }
    case 'race_pace': {
      const rp = p as unknown as RacePacePayload
      const t = fmtSecsShort(rp.time_seconds)
      return rp.mode === 'result'
        ? `${rp.distance} ${t}${rp.is_pr ? ' · PR' : ''}`
        : `${rp.distance} goal ${t}`
    }
    case 'article_note': {
      const an = p as unknown as ArticleNotePayload
      const fc = (an.flashcards ?? []).length
      return `${an.source_domain} · ${fc} card${fc !== 1 ? 's' : ''}`
    }
    case 'repo_review': {
      const rp = p as unknown as RepoReviewPayload
      const counts = { high: 0, medium: 0, low: 0 }
      for (const issue of rp.issues ?? []) counts[issue.severity]++
      return `${counts.high} high · ${counts.medium} medium · ${counts.low} low`
    }
    case 'countdown': {
      const cp = p as unknown as CountdownPayload
      const typeLabel = cp.event_type === 'track_meet' ? 'track meet' : cp.event_type === 'football_game' ? 'football game' : 'event'
      return `${cp.event_date} · ${typeLabel}`
    }
    case 'checkin': {
      const cp = p as unknown as CheckinPayload
      return `${cp.rating}/5${cp.note ? ' · ' + cp.note.slice(0, 40) : ''}`
    }
    case 'note': {
      const np = p as unknown as NotePayload
      return np.content.slice(0, 60)
    }
    case 'bell_schedule': {
      const bp = p as unknown as BellSchedulePayload
      const n = (bp.periods ?? []).length
      return `${n} period${n !== 1 ? 's' : ''}`
    }
    case 'uploaded_file': {
      const up = p as unknown as UploadedFilePayload
      return `${up.file_type} · ${up.extracted_summary.slice(0, 50)}`
    }
    case 'aperture': {
      const ap = p as unknown as AperturePayload
      return ap.answer ? `${ap.date} · answered` : `${ap.date} · unanswered`
    }
    case 'briefing': {
      const bp = p as unknown as BriefingPayload
      const obs = (bp.observations ?? []).length
      const acts = (bp.suggested_actions ?? []).length
      return `${obs} observation${obs !== 1 ? 's' : ''} · ${acts} action${acts !== 1 ? 's' : ''}`
    }
    case 'root_cause': {
      const rc = p as unknown as RootCausePayload
      return `${rc.domain} · ${(rc.causal_chain ?? []).length} layers`
    }
    case 'terminal_session': {
      const ts = p as unknown as TerminalSessionPayload
      const n = (ts.commands ?? []).length
      return `${ts.repo} · ${n} command${n !== 1 ? 's' : ''}`
    }
    case 'ghost_conversation': {
      const gc = p as unknown as GhostConversationPayload
      const n = (gc.messages ?? []).length
      return `${gc.window_label} · ${n} message${n !== 1 ? 's' : ''}`
    }
    case 'github_action': {
      const ga = p as unknown as GitHubActionPayload
      return `${ga.action} · ${ga.repo}`
    }
    case 'note_draft': {
      const np = p as unknown as NotePayload
      return `draft · ${np.content.slice(0, 40)}`
    }
    case 'memory': {
      const mp = p as unknown as MemoryPayload
      return mp.imported ? `imported${mp.origin ? ' · ' + mp.origin : ''}` : 'captured'
    }
    default:
      return ''
  }
}
