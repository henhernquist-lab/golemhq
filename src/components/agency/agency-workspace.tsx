'use client'

// The Agency tab (Batch 8) — cto.new-shaped HQ view of the agent roster.
//
// Supersedes the flat roster table on /missions (see missions-workspace.tsx's
// header comment). Renders against the same settled backend: /api/agency
// composites the agents table, CLI detection, and real mission_events into
// one read, pause/resume goes through the existing PATCH
// /api/missions/agents/[id] (the `enabled` column the Scheduler already gates
// dispatch on — there is no separate pause concept to invent), and hire/edit/
// chat reuse the exact components /missions built rather than duplicating
// them under new names.
//
// "Functional" status on each card is not a vibe — it is the most recent
// POST /api/missions/agents/[id]/audit result: a real invocation of the
// agent's CLI on a trivial, independently-verified task (see
// src/lib/missions/functional-audit.ts). No card claims "working" from
// enabled/detected alone.
//
// Batch 8.5: extracted from src/app/agency/page.tsx so this is reusable both
// as its own route (/agency) and embedded as a tab panel in the unified
// /forge workspace. `embedded` drops the standalone page chrome (background
// grid, back link) when a parent shell already provides navigation.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Network, Play, Pause, MessageSquare, Pencil, Plus, RefreshCw,
  CheckCircle2, XCircle, HelpCircle, Ban, Loader2, Activity, Terminal, Trash2,
} from 'lucide-react'

import { HireWorkerPanel, type EditableAgent } from '@/components/missions/hire-worker'
import { AgentChatPanel } from '@/components/missions/agent-chat-panel'
import { OrgChart, type ParentRelation } from '@/components/agency/org-chart'
import {
  WORKSPACE_CARD_CLASS,
  WORKSPACE_INSET_CLASS,
  WorkspaceShell,
} from '@/components/workspace/workspace-shell'
import { StatusBadge, type BadgeTone } from '@/components/workspace/status-badge'
import { AGENT_LAYER_LABELS, AGENT_LAYERS, type Agent, type AgentLayer, type MissionEvent } from '@/lib/missions/types'
import { modelChoicesForCli } from '@/lib/missions/cli-models'
import { deriveAgentActivity, type AgentActivity, type AgentLiveState } from '@/lib/missions/agent-live-state'

const POLL_MS = 6000

type AuditStatus = 'working' | 'broken' | 'absent' | 'not_applicable'

interface AuditView {
  status: AuditStatus
  detail: string
  ts: string
}

interface AgencyAgent extends Agent {
  detection: { cliPath: string | null; cliVersion: string | null; detectedAt: string | null; detectedHost: string | null } | null
  instructions: string | null
  /** Registry model id Henry assigned, or null = CLI's own default. */
  model: string | null
  audit: AuditView | null
}

interface ActivityEvent {
  id: string
  missionId: string
  repo: string
  taskId: string | null
  ts: string
  type: string
  payload: Record<string, unknown>
}

const EMPTY_ACTIVITY: AgentActivity = { state: 'idle', lastEventAt: null, detail: null, events: [] }

const LIVE_TONE: Record<AgentLiveState, BadgeTone> = {
  running: 'primary',
  validating: 'warning',
  failed: 'danger',
  idle: 'neutral',
}

const LAYER_DESC: Record<AgentLayer, string> = {
  1: 'plan, schedule, coordinate — never write code',
  2: 'CLI-driven — do the actual editing',
  3: 'typecheck, lint, test, review — gate the work',
}

function when(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const AUDIT_TONE: Record<AuditStatus, BadgeTone> = {
  working: 'primary',
  broken: 'danger',
  absent: 'warning',
  not_applicable: 'neutral',
}

const AUDIT_ICON: Record<AuditStatus, typeof HelpCircle> = {
  working: CheckCircle2,
  broken: XCircle,
  absent: Ban,
  not_applicable: HelpCircle,
}

function AuditBadge({ agent, busy, onRun }: { agent: AgencyAgent; busy: boolean; onRun: () => void }) {
  if (agent.layer !== 2 || !agent.cliCommand) {
    return <StatusBadge tone="neutral" size="sm" uppercase={false} label="logic · not a CLI" />
  }
  const a = agent.audit
  return (
    <StatusBadge
      tone={a ? AUDIT_TONE[a.status] : 'neutral'}
      size="sm"
      icon={a ? AUDIT_ICON[a.status] : HelpCircle}
      busy={busy}
      busyIcon={Loader2}
      onClick={onRun}
      disabled={busy}
      title={a ? `${a.detail} · audited ${when(a.ts)}` : 'never audited — click to run a real invocation'}
      label={busy ? 'auditing…' : a ? a.status.replace('_', ' ') : 'not audited'}
    />
  )
}

function AgentCard({
  agent, relation, auditing, onToggleEnabled, onEdit, onChat, onAudit, onChangeModel, onFire, live, onInspect,
}: {
  agent: AgencyAgent
  relation: ParentRelation<AgencyAgent>
  auditing: boolean
  onToggleEnabled: () => void
  onEdit: () => void
  onChat: () => void
  onAudit: () => void
  onChangeModel: (model: string | null) => void
  onFire: () => void
  live: AgentActivity
  onInspect: () => void
}) {
  // null ⇒ this agent runs no CLI, so it gets no model control at all.
  const modelChoices = modelChoicesForCli(agent.cliCommand)

  return (
    <div className={`w-72 p-4 ${WORKSPACE_CARD_CLASS}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm leading-5 text-foreground">{agent.name}</p>
          {agent.cliCommand && (
            <p className="truncate font-mono text-[10px] leading-4 text-muted-foreground" title={agent.cliCommand}>
              {agent.cliCommand}
            </p>
          )}
        </div>
        <button
          onClick={onToggleEnabled}
          title={agent.enabled ? 'pause — sets enabled=false, Scheduler will not dispatch to it' : 'resume — sets enabled=true'}
          className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-colors shadow-sm ring-1 ${
            agent.enabled
              ? 'bg-primary/10 text-primary ring-primary/20 hover:bg-primary/15'
              : 'bg-surface-elevated/60 text-muted-foreground ring-foreground/10 hover:text-foreground'
          }`}
        >
          {agent.enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {/* `enabled` is configuration; live state is what it is DOING, derived
            from real mission_events. Both matter and they are not the same:
            an enabled agent that has never run is stale, not active. */}
        <StatusBadge
          tone={agent.enabled ? 'primaryOutline' : 'neutral'}
          size="sm"
          label={agent.enabled ? 'enabled' : 'paused'}
        />
        <StatusBadge
          tone={LIVE_TONE[live.state]}
          size="sm"
          label={live.events.length === 0 ? 'never run' : live.state}
          title={
            live.lastEventAt
              ? `${live.detail ?? live.state} · last event ${when(live.lastEventAt)} · ${live.events.length} events`
              : 'no recorded activity in the recent event stream'
          }
        />
        <AuditBadge agent={agent} busy={auditing} onRun={onAudit} />
      </div>

      {live.events.length > 0 && (
        <button
          onClick={onInspect}
          title="Show this agent's real recent events"
          className="mt-2 flex w-full items-center justify-between gap-2 rounded-lg bg-surface-elevated/60 px-2 py-1.5 text-left font-mono text-[10px] leading-4 text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="truncate">{live.detail ?? live.state}</span>
          <span className="flex-shrink-0 text-muted-foreground/60">{when(live.lastEventAt)}</span>
        </button>
      )}

      {agent.detection && (
        <p className="mt-2 font-mono text-[10px] leading-4 text-muted-foreground">
          {agent.detection.cliPath ? `detected on ${agent.detection.detectedHost}` : `absent on ${agent.detection.detectedHost}`}
        </p>
      )}

      {relation.kind === 'missing-parent' && (
        <p className="mt-3 font-mono text-[10px] leading-4 text-warning" data-parent-warning>
          parent unavailable · showing as root
        </p>
      )}
      {relation.kind === 'unexpected-layer' && relation.parent && (
        <p className="mt-3 font-mono text-[10px] leading-4 text-muted-foreground" data-parent-warning>
          cross-layer parent · layer {relation.parent.layer}
        </p>
      )}
      {relation.kind === 'self-parent' && (
        <p className="mt-3 font-mono text-[10px] leading-4 text-warning" data-parent-warning>
          invalid self-parent · showing as root
        </p>
      )}

      {/* Layer 1 orchestrators and Layer 3 validators are logic modules: no
          CLI, no model, so no control at all rather than a disabled one. */}
      {modelChoices && (
        <div className="mt-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider leading-4 text-muted-foreground">
              model
            </span>
            <select
              value={agent.model ?? ''}
              onChange={(e) => onChangeModel(e.target.value || null)}
              title={
                modelChoices.unfiltered
                  ? `${agent.cliCommand} is a multi-provider CLI — its supported model list is configured host-side and cannot be read from here, so the full registry is offered.`
                  : `Models ${agent.cliCommand?.split(' ')[0]} can actually run`
              }
              className="w-full rounded-lg border border-border/50 bg-surface-base px-2 py-1.5 font-mono text-[10px] leading-4 text-foreground shadow-sm outline-none focus:border-primary/40"
            >
              <option value="">use the CLI&apos;s own default</option>
              {modelChoices.models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            {modelChoices.unfiltered && (
              <span className="font-mono text-[9px] leading-4 text-muted-foreground/70">
                supported list not programmatically knowable for this CLI — full registry shown
              </span>
            )}
          </label>
        </div>
      )}

      <div className="mt-4 flex items-center gap-4 border-t border-border/40 pt-3">
        {/* Layer 1 is the pipeline itself — the store refuses to delete it, so
            the control is not offered rather than offered and rejected. */}
        {agent.layer !== 1 && (
          <button
            onClick={onFire}
            title={`Remove ${agent.name} from the roster`}
            className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] leading-5 text-muted-foreground transition-colors hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" /> fire
          </button>
        )}
        {agent.cliCommand && (
          <button onClick={onChat} className="inline-flex items-center gap-1 font-mono text-[11px] leading-5 text-muted-foreground transition-colors hover:text-primary">
            <MessageSquare className="h-3 w-3" /> chat
          </button>
        )}
        <button onClick={onEdit} className="inline-flex items-center gap-1 font-mono text-[11px] leading-5 text-muted-foreground transition-colors hover:text-primary">
          <Pencil className="h-3 w-3" /> edit
        </button>
      </div>
    </div>
  )
}

function ActivityRow({ event, agentName }: { event: ActivityEvent; agentName: (id: string | null) => string | null }) {
  const kind = event.type.split('.')[0]
  const label =
    event.type === 'mission.created' ? `mission started · ${event.repo}`
    : event.type === 'mission.status_changed' ? `${event.repo} → ${event.payload.to ?? '?'}`
    : event.type === 'task.created' ? `task queued: ${event.payload.title ?? ''}`
    : event.type === 'task.status_changed' ? `task → ${event.payload.to ?? '?'}${event.payload.assignedAgent ? ` (${agentName(event.payload.assignedAgent as string) ?? 'agent'})` : ''}`
    : event.type === 'task.result_recorded' ? `run ${event.payload.success ? 'succeeded' : 'failed'} · ${event.payload.outputBytes ?? 0}b`
    : event.type

  return (
    <div className="flex items-start gap-2 border-b border-border/40 px-2 py-1.5 last:border-0">
      <Activity className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground/60" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[10px] text-foreground/90">{label}</p>
        <p className="font-mono text-[9px] text-muted-foreground">{kind} · {when(event.ts)}</p>
      </div>
    </div>
  )
}

export function AgencyWorkspace({ embedded = false }: { embedded?: boolean }) {
  const [agents, setAgents] = useState<AgencyAgent[]>([])
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [inspecting, setInspecting] = useState<AgencyAgent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hiring, setHiring] = useState(false)
  const [editing, setEditing] = useState<EditableAgent | null>(null)
  const [chatAgent, setChatAgent] = useState<{ id: string; name: string; cliCommand: string | null } | null>(null)
  const [auditingId, setAuditingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/agency', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setAgents(data.agents ?? [])
      setActivity(data.activity ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  const toggleEnabled = async (agent: AgencyAgent) => {
    // Optimistic — the roster reads live off this state and a 6s poll gap
    // reads as an unresponsive button otherwise.
    setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, enabled: !a.enabled } : a)))
    try {
      const res = await fetch(`/api/missions/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !agent.enabled }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
    } catch (err) {
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, enabled: agent.enabled } : a)))
      setError(err instanceof Error ? err.message : 'failed to update agent')
    }
  }

  const changeModel = async (agent: AgencyAgent, model: string | null) => {
    // Optimistic, same shape as toggleEnabled: the card reads live off state.
    const previous = agent.model
    setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, model } : a)))
    try {
      const res = await fetch(`/api/missions/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
    } catch (err) {
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, model: previous } : a)))
      setError(err instanceof Error ? err.message : 'failed to update model')
    }
  }

  const runAudit = async (agent: AgencyAgent) => {
    setAuditingId(agent.id)
    setError(null)
    try {
      const res = await fetch(`/api/missions/agents/${agent.id}/audit`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, audit: data.audit } : a)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'audit failed')
    } finally {
      setAuditingId(null)
    }
  }

  // One pass over the event stream per poll, shared by every card. Deriving
  // inside each card would re-scan the whole stream 17 times per render.
  const liveByAgent = useMemo(() => {
    const map = new Map<string, AgentActivity>()
    for (const a of agents) map.set(a.id, deriveAgentActivity(a.name, activity as MissionEvent[]))
    return map
  }, [agents, activity])

  const fireAgent = useCallback(async (agent: AgencyAgent) => {
    if (!window.confirm(`Remove ${agent.name} from the roster? Historical missions keep their event trail.`)) return
    const res = await fetch(`/api/missions/agents/${agent.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? `Could not remove ${agent.name}.`)
      return
    }
    load()
  }, [load])

  const agentName = (id: string | null) => (id ? agents.find((a) => a.id === id)?.name ?? null : null)

  return (
    <WorkspaceShell
      embedded={embedded}
      icon={Network}
      title="agency"
      subtitle={`org chart · pause/resume · real functional status · refreshes every ${POLL_MS / 1000}s`}
      actions={
        <>
          <button
            onClick={() => { setEditing(null); setHiring((v) => !v) }}
            className="inline-flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 font-mono text-xs leading-5 text-primary shadow-sm ring-1 ring-primary/15 transition-colors hover:bg-primary/15"
          >
            <Plus className="h-3 w-3" /> hire worker
          </button>
          <button
            onClick={load}
            className="inline-flex items-center gap-2 rounded-lg bg-surface-secondary px-3 py-2 font-mono text-xs leading-5 text-muted-foreground shadow-sm ring-1 ring-foreground/10 transition-colors hover:bg-surface-elevated/70 hover:text-primary"
          >
            <RefreshCw className="h-3 w-3" /> refresh
          </button>
        </>
      }
    >
      {error && (
        <div className="mb-8 rounded-xl bg-warning/10 px-4 py-3 font-mono text-xs leading-5 text-warning shadow-sm ring-1 ring-warning/20">{error}</div>
      )}

      {/* Per-agent event stream — the real answer to "is this agent stale?".
          Every line is a mission_events row involving this agent; an agent with
          nothing here has genuinely never run. */}
      {inspecting && (
        <div className={`mb-8 p-4 ${WORKSPACE_CARD_CLASS}`}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="font-mono text-xs leading-5 text-foreground">
              {inspecting.name}
              <span className="ml-2 text-muted-foreground">
                · {(liveByAgent.get(inspecting.id) ?? EMPTY_ACTIVITY).events.length} recent events
              </span>
            </p>
            <button
              onClick={() => setInspecting(null)}
              className="font-mono text-[10px] leading-4 text-muted-foreground transition-colors hover:text-foreground"
            >
              close
            </button>
          </div>
          <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
            {(liveByAgent.get(inspecting.id) ?? EMPTY_ACTIVITY).events.map((e) => (
              <div key={e.id} className="flex items-baseline gap-2 font-mono text-[10px] leading-4">
                <span className="flex-shrink-0 text-muted-foreground/50">{when(e.ts)}</span>
                <span className="flex-shrink-0 text-primary/80">{e.type}</span>
                <span className="truncate text-muted-foreground">
                  {JSON.stringify(e.payload).slice(0, 120)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {chatAgent && <AgentChatPanel key={chatAgent.id} agent={chatAgent} onClose={() => setChatAgent(null)} />}
      {(hiring || editing) && (
        <HireWorkerPanel
          agent={editing ?? undefined}
          onClose={() => { setHiring(false); setEditing(null) }}
          onSaved={load}
        />
      )}

      {loading && agents.length === 0 && <p className="font-mono text-xs text-muted-foreground">loading…</p>}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ── Org chart ────────────────────────────────────────── */}
        <section>
          <OrgChart
            agents={agents}
            layers={AGENT_LAYERS}
            layerLabels={AGENT_LAYER_LABELS}
            layerDescriptions={LAYER_DESC}
            renderCard={(a, relation) => (
              <AgentCard
                agent={a}
                relation={relation}
                auditing={auditingId === a.id}
                onToggleEnabled={() => toggleEnabled(a)}
                onAudit={() => runAudit(a)}
                onEdit={() => {
                  setHiring(false); setChatAgent(null)
                  setEditing({ id: a.id, name: a.name, layer: a.layer, cliCommand: a.cliCommand, enabled: a.enabled, instructions: a.instructions })
                }}
                onChat={() => {
                  setHiring(false); setEditing(null)
                  setChatAgent({ id: a.id, name: a.name, cliCommand: a.cliCommand })
                }}
                onChangeModel={(m) => changeModel(a, m)}
                onFire={() => fireAgent(a)}
                live={liveByAgent.get(a.id) ?? EMPTY_ACTIVITY}
                onInspect={() => setInspecting(inspecting?.id === a.id ? null : a)}
              />
            )}
          />
        </section>

        {/* ── Live activity feed ──────────────────────────────── */}
        <section>
          <h2 className="mb-4 flex items-center gap-2 font-mono text-sm uppercase tracking-wide leading-6 text-foreground">
            <Terminal className="h-3.5 w-3.5" /> activity
          </h2>
          <div className={`max-h-[70vh] overflow-y-auto p-2 ${WORKSPACE_INSET_CLASS}`}>
            {activity.length === 0 ? (
              <p className="px-3 py-4 font-mono text-[11px] leading-5 text-muted-foreground">no mission activity yet</p>
            ) : (
              activity.map((e) => <ActivityRow key={e.id} event={e} agentName={agentName} />)
            )}
          </div>
        </section>
      </div>
    </WorkspaceShell>
  )
}
