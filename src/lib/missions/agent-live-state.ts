// What each agent is actually doing right now, derived from real events.
//
// The Agency cards showed a static ACTIVE badge that only reflected the
// `enabled` column — it read the same whether an agent had run a task five
// seconds ago or had never run one at all, which is exactly the "is this agent
// stale?" question Henry could not answer from the screen.
//
// Everything here comes from mission_events. Task events carry the agent's
// NAME in their payload (`{"agent":"Claude Code","cli":"claude …"}`), which is
// the only agent identity the stream records — there is no agent_id column on
// the event — so matching is by name. That also means an agent renamed after a
// run stops matching its own history; recording the id in the payload is a
// pipeline change, not a lens change, so it is deliberately not done here.

import type { MissionEvent } from './types'

export type AgentLiveState = 'running' | 'validating' | 'failed' | 'idle'

export interface AgentActivity {
  state: AgentLiveState
  /** Most recent event involving this agent, for "last seen". */
  lastEventAt: string | null
  /** Short human line: what it was doing at that moment. */
  detail: string | null
  /** Events involving this agent, newest first — the per-agent feed. */
  events: MissionEvent[]
}

// Layer 1 never appears in `payload.agent` — the orchestrators emit their own
// typed events instead (`planner.*`, `scheduler.*`, `coordinator.*`). Mapping
// those prefixes onto the seeded roster names is what makes the L1 nodes live
// rather than permanently blank. Keyed on the names the roster actually ships
// with; a renamed orchestrator falls back to no activity rather than guessing.
const ORCHESTRATOR_BY_PREFIX: Record<string, string> = {
  planner: 'Mission Planner',
  scheduler: 'Scheduler',
  coordinator: 'Coordinator',
}

function agentOf(event: MissionEvent): string | null {
  const p = (event.payload ?? {}) as { agent?: unknown }
  if (typeof p.agent === 'string') return p.agent
  return ORCHESTRATOR_BY_PREFIX[event.type.split('.')[0]] ?? null
}

/**
 * Newest-first scan per agent. The first event that implies a state wins, so a
 * later `failed` is not masked by the `running` that preceded it.
 */
export function deriveAgentActivity(agentName: string, events: MissionEvent[]): AgentActivity {
  const mine = events
    .filter((e) => agentOf(e) === agentName)
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))

  if (mine.length === 0) {
    return { state: 'idle', lastEventAt: null, detail: null, events: [] }
  }

  let state: AgentLiveState = 'idle'
  let detail: string | null = null

  for (const e of mine) {
    const p = (e.payload ?? {}) as { to?: unknown; error?: unknown }
    const to = typeof p.to === 'string' ? p.to : null

    if (e.type === 'scheduler.task_failed' || to === 'failed') {
      state = 'failed'
      detail = typeof p.error === 'string' ? p.error.slice(0, 140) : 'run failed'
      break
    }
    if (to === 'running') { state = 'running'; detail = 'executing a task'; break }
    if (to === 'validating') { state = 'validating'; detail = 'validators running'; break }
    if (to === 'complete') { state = 'idle'; detail = 'last run completed'; break }
    // Orchestrator events have no status transition; the event itself is the
    // activity, so the most recent one describes what it last did.
    if (!to && ORCHESTRATOR_BY_PREFIX[e.type.split('.')[0]]) {
      state = e.type.endsWith('.run') || e.type.endsWith('.completed') ? 'idle' : 'running'
      detail = e.type
      break
    }
  }

  return { state, lastEventAt: mine[0].ts, detail, events: mine }
}
