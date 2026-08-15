'use client'

// The Agency tab (Batch 8) — cto.new-shaped HQ view of the agent roster.
//
// Supersedes the flat roster table on /missions (see that page's header
// comment: "Deliberately not the Batch 8 org chart... will replace most of
// this"). Renders against the same settled backend: /api/agency composites
// the agents table, CLI detection, and real mission_events into one read,
// pause/resume goes through the existing PATCH /api/missions/agents/[id]
// (the `enabled` column the Scheduler already gates dispatch on — there is
// no separate pause concept to invent), and hire/edit/chat reuse the exact
// components /missions built rather than duplicating them under new names.
//
// "Functional" status on each card is not a vibe — it is the most recent
// POST /api/missions/agents/[id]/audit result: a real invocation of the
// agent's CLI on a trivial, independently-verified task (see
// src/lib/missions/functional-audit.ts). No card claims "working" from
// enabled/detected alone.

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import Link from 'next/link'
import {
  ArrowLeft, Network, Play, Pause, MessageSquare, Pencil, Plus, RefreshCw,
  CheckCircle2, XCircle, HelpCircle, Ban, Loader2, Activity, Terminal,
} from 'lucide-react'

import { HireWorkerPanel, type EditableAgent } from '@/components/missions/hire-worker'
import { AgentChatPanel } from '@/components/missions/agent-chat-panel'
import { AGENT_LAYER_LABELS, AGENT_LAYERS, type Agent, type AgentLayer } from '@/lib/missions/types'

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

const LAYER_DESC: Record<AgentLayer, string> = {
  1: 'plan, schedule, coordinate — never write code',
  2: 'CLI-driven — do the actual editing',
  3: 'typecheck, lint, test, review — gate the work',
}

function when(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function AuditBadge({ agent, busy, onRun }: { agent: AgencyAgent; busy: boolean; onRun: () => void }) {
  if (agent.layer !== 2 || !agent.cliCommand) {
    return <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">logic · not a CLI</span>
  }
  const a = agent.audit
  const tone =
    !a ? 'border-border text-muted-foreground'
    : a.status === 'working' ? 'border-primary/40 bg-primary/10 text-primary'
    : a.status === 'broken' ? 'border-red-500/40 bg-red-500/10 text-red-400'
    : a.status === 'absent' ? 'border-warning/40 bg-warning/10 text-warning'
    : 'border-border text-muted-foreground'
  const Icon = !a ? HelpCircle : a.status === 'working' ? CheckCircle2 : a.status === 'broken' ? XCircle : a.status === 'absent' ? Ban : HelpCircle
  return (
    <button
      onClick={onRun}
      disabled={busy}
      title={a ? `${a.detail} · audited ${when(a.ts)}` : 'never audited — click to run a real invocation'}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide transition-colors hover:border-primary/40 disabled:opacity-50 ${tone}`}
    >
      {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Icon className="h-2.5 w-2.5" />}
      {busy ? 'auditing…' : a ? a.status.replace('_', ' ') : 'not audited'}
    </button>
  )
}

function AgentCard({
  agent, auditing, onToggleEnabled, onEdit, onChat, onAudit,
}: {
  agent: AgencyAgent
  auditing: boolean
  onToggleEnabled: () => void
  onEdit: () => void
  onChat: () => void
  onAudit: () => void
}) {
  return (
    <div className="w-64 rounded-lg border border-border bg-surface-secondary p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs text-foreground">{agent.name}</p>
          {agent.cliCommand && (
            <p className="truncate font-mono text-[9px] text-muted-foreground" title={agent.cliCommand}>
              {agent.cliCommand}
            </p>
          )}
        </div>
        <button
          onClick={onToggleEnabled}
          title={agent.enabled ? 'pause — sets enabled=false, Scheduler will not dispatch to it' : 'resume — sets enabled=true'}
          className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border transition-colors ${
            agent.enabled ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20' : 'border-border text-muted-foreground hover:text-foreground'
          }`}
        >
          {agent.enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${agent.enabled ? 'border-primary/30 text-primary' : 'border-border text-muted-foreground'}`}>
          {agent.enabled ? 'active' : 'paused'}
        </span>
        <AuditBadge agent={agent} busy={auditing} onRun={onAudit} />
      </div>

      {agent.detection && (
        <p className="mt-1.5 font-mono text-[9px] text-muted-foreground">
          {agent.detection.cliPath ? `detected on ${agent.detection.detectedHost}` : `absent on ${agent.detection.detectedHost}`}
        </p>
      )}

      <div className="mt-2.5 flex items-center gap-3 border-t border-border/60 pt-2">
        {agent.cliCommand && (
          <button onClick={onChat} className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-primary">
            <MessageSquare className="h-3 w-3" /> chat
          </button>
        )}
        <button onClick={onEdit} className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-primary">
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

export default function AgencyPage() {
  const [agents, setAgents] = useState<AgencyAgent[]>([])
  const [activity, setActivity] = useState<ActivityEvent[]>([])
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

  const agentName = (id: string | null) => (id ? agents.find((a) => a.id === id)?.name ?? null : null)

  return (
    <div className="relative flex min-h-screen flex-col bg-transparent">
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 grid-overlay opacity-30" />
        <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at center, transparent 0%, rgba(8,8,8,0.6) 100%)' }} />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-6xl px-6 py-10">
        <Link href="/" className="mb-8 inline-flex items-center gap-2 font-mono text-xs text-muted-foreground transition-colors hover:text-primary">
          <ArrowLeft className="h-3.5 w-3.5" /> back to golem
        </Link>

        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-8 flex items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-primary/30 bg-primary/10">
              <Network className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h1 className="font-mono text-lg text-foreground">agency</h1>
              <p className="font-mono text-xs text-muted-foreground">
                org chart · pause/resume · real functional status · refreshes every {POLL_MS / 1000}s
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setEditing(null); setHiring((v) => !v) }}
              className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-2.5 py-1.5 font-mono text-xs text-primary transition-colors hover:bg-primary/20"
            >
              <Plus className="h-3 w-3" /> hire worker
            </button>
            <button
              onClick={load}
              className="inline-flex items-center gap-2 rounded border border-border px-2.5 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              <RefreshCw className="h-3 w-3" /> refresh
            </button>
          </div>
        </motion.div>

        {error && (
          <div className="mb-6 rounded border border-warning/40 bg-warning/10 px-3 py-2 font-mono text-xs text-warning">{error}</div>
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

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* ── Org chart ────────────────────────────────────────── */}
          <section className="space-y-6">
            {AGENT_LAYERS.map((layer) => {
              const layerAgents = agents.filter((a) => a.layer === layer)
              return (
                <div key={layer}>
                  <div className="mb-2 flex items-baseline gap-2">
                    <h2 className="font-mono text-xs uppercase tracking-wide text-foreground">
                      layer {layer} · {AGENT_LAYER_LABELS[layer]}
                    </h2>
                    <span className="font-mono text-[10px] text-muted-foreground">{LAYER_DESC[layer]}</span>
                  </div>
                  {layerAgents.length === 0 ? (
                    <p className="font-mono text-[10px] text-muted-foreground">no agents registered at this layer</p>
                  ) : (
                    <div className="flex flex-wrap gap-3">
                      {layerAgents.map((a) => (
                        <AgentCard
                          key={a.id}
                          agent={a}
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
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </section>

          {/* ── Live activity feed ──────────────────────────────── */}
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 font-mono text-xs uppercase tracking-wide text-foreground">
              <Terminal className="h-3.5 w-3.5" /> activity
            </h2>
            <div className="max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-surface-secondary">
              {activity.length === 0 ? (
                <p className="px-2 py-3 font-mono text-[10px] text-muted-foreground">no mission activity yet</p>
              ) : (
                activity.map((e) => <ActivityRow key={e.id} event={e} agentName={agentName} />)
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
