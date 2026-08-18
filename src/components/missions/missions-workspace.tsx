'use client'

// A window onto the mission spine, and the roster's control surface.
//
// Batches 1-5 are entirely backend, verified through scripts and terminal
// output. That worked, but it meant a question as basic as "is Codex actually
// installed" needed a script run to answer. This is the smallest thing that
// makes the database visible.
//
// Missions and tasks stay read-only — they are driven by the Planner,
// Scheduler and validators, and a second writer over the same rows would be a
// competing source of truth. The roster is the exception: hiring and editing
// workers is configuration, not execution, and both routes are owner-gated.
//
// Batch 8.5: extracted from src/app/missions/page.tsx so this is THE ONE
// missions view, reusable both as its own route (/missions) and embedded as a
// tab panel in the unified /forge workspace — not duplicated under a second
// name. `embedded` drops the standalone page chrome (background grid, back
// link) when a parent shell already provides navigation and framing.

import { useCallback, useEffect, useState } from 'react'
import { ListTree, MessageSquare, Pencil, Plus, RefreshCw, Server } from 'lucide-react'

import { TaskEvidencePanel } from '@/components/missions/task-evidence'
import { HireWorkerPanel, type EditableAgent } from '@/components/missions/hire-worker'
import { AgentChatPanel } from '@/components/missions/agent-chat-panel'
import { ApprovalGate } from '@/components/missions/approval-gate'
import {
  WORKSPACE_CARD_CLASS,
  WORKSPACE_INSET_CLASS,
  WorkspaceShell,
} from '@/components/workspace/workspace-shell'
import { StatusBadge, type BadgeTone } from '@/components/workspace/status-badge'

import type { Agent, Mission, Task, TaskStatus, MissionStatus } from '@/lib/missions/types'
import { AGENT_LAYER_LABELS } from '@/lib/missions/types'

const POLL_MS = 5000

interface AgentWithDetection extends Agent {
  detection: {
    cliPath: string | null
    cliVersion: string | null
    detectedAt: string | null
    detectedHost: string | null
  } | null
  instructions: string | null
}

interface LeaseView {
  id: string
  pathGlob: string
  leaseType: 'read' | 'write' | 'exclusive'
  expiresAt: string
}

interface ConflictView {
  blockedBy: string[]
  detail: string
}

interface ValidationPayload {
  passed?: boolean
  failedChecks?: string[]
  checks?: { name: string; status: string; reason: string | null }[]
}

// Tone names, not class strings — the classes live in one place now
// (src/components/workspace/status-badge.tsx). Same rendered output.
const TASK_TONE: Record<TaskStatus, BadgeTone> = {
  pending: 'neutral',
  assigned: 'foreground',
  running: 'primary',
  validating: 'warning',
  complete: 'primaryStrong',
  failed: 'danger',
  blocked: 'surface',
}

const MISSION_TONE: Record<MissionStatus, BadgeTone> = {
  planning: 'neutral',
  awaiting_approval: 'warning',
  running: 'primary',
  completed: 'primaryStrong',
  failed: 'danger',
  cancelled: 'neutral',
}

const LEASE_TONE: Record<LeaseView['leaseType'], BadgeTone> = {
  exclusive: 'warning',
  write: 'primary',
  read: 'neutral',
}

function when(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function MissionsWorkspace({ embedded = false }: { embedded?: boolean }) {
  const [missions, setMissions] = useState<Mission[]>([])
  const [agents, setAgents] = useState<AgentWithDetection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [leases, setLeases] = useState<Record<string, LeaseView[]>>({})
  const [conflicts, setConflicts] = useState<Record<string, ConflictView>>({})
  const [validations, setValidations] = useState<Record<string, ValidationPayload>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [hiring, setHiring] = useState(false)
  const [editing, setEditing] = useState<EditableAgent | null>(null)
  const [chatAgent, setChatAgent] = useState<{ id: string; name: string; cliCommand: string | null } | null>(null)

  const loadList = useCallback(async () => {
    try {
      const res = await fetch('/api/missions', { cache: 'no-store' })
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
      const data = await res.json()
      setMissions(data.missions ?? [])
      setAgents(data.agents ?? [])
      setError(null)
    } catch (err) {
      // Keep the last-known view rather than blanking it — a poll that fails
      // once should not wipe the screen the user is reading.
      setError(err instanceof Error ? err.message : 'failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMission = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/missions/${id}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setTasks(data.tasks ?? [])
      setValidations(data.validations ?? {})
      setLeases(data.leases ?? {})
      setConflicts(data.conflicts ?? {})
    } catch {
      /* keep last-known */
    }
  }, [])

  useEffect(() => {
    loadList()
    const timer = setInterval(loadList, POLL_MS)
    return () => clearInterval(timer)
  }, [loadList])

  useEffect(() => {
    if (!selectedId) return
    loadMission(selectedId)
    const timer = setInterval(() => loadMission(selectedId), POLL_MS)
    return () => clearInterval(timer)
  }, [selectedId, loadMission])

  const selected = missions.find((m) => m.id === selectedId) ?? null
  const taskIndex = new Map(tasks.map((t, i) => [t.id, i + 1]))

  // A landed merge moves the mission to a terminal status (Batch 10), so the
  // list is stale the moment the gate settles, not just the open mission.
  const onSettled = useCallback(() => {
    void loadList()
    if (selectedId) void loadMission(selectedId)
  }, [loadList, loadMission, selectedId])

  return (
    <WorkspaceShell
      embedded={embedded}
      icon={ListTree}
      title="missions"
      subtitle={`mission spine · open a task for its evidence · refreshes every ${POLL_MS / 1000}s`}
      actions={
        <button
          onClick={loadList}
          className="inline-flex items-center gap-2 rounded-lg bg-surface-secondary px-3 py-2 font-mono text-xs leading-5 text-muted-foreground shadow-sm ring-1 ring-foreground/10 transition-colors hover:bg-surface-elevated/70 hover:text-primary"
        >
          <RefreshCw className="h-3 w-3" />
          refresh
        </button>
      }
    >
      {error && (
        <div className="mb-8 rounded-xl bg-warning/10 px-4 py-3 font-mono text-xs leading-5 text-warning shadow-sm ring-1 ring-warning/20">
          {error}
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* ── Missions ─────────────────────────────────────────── */}
        <section>
          <h2 className="mb-4 font-mono text-sm uppercase tracking-wide leading-6 text-muted-foreground">
            missions ({missions.length})
          </h2>
          <div className="flex flex-col gap-3">
            {loading && missions.length === 0 && (
              <p className="font-mono text-xs text-muted-foreground">loading…</p>
            )}
            {!loading && missions.length === 0 && (
              <p className="font-mono text-xs text-muted-foreground">
                no missions yet — the verification scripts clean up after themselves unless run with KEEP=1
              </p>
            )}
            {missions.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelectedId(m.id === selectedId ? null : m.id)}
                className={`rounded-xl px-4 py-4 text-left leading-5 shadow-sm ring-1 transition-colors ${
                  m.id === selectedId
                    ? 'bg-primary/5 ring-primary/20'
                    : 'bg-surface-secondary ring-foreground/5 hover:bg-surface-elevated/70'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-foreground">{m.repo}</span>
                  <StatusBadge label={m.status} tone={MISSION_TONE[m.status]} />
                </div>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">{m.goal}</p>
                <p className="mt-2 font-mono text-[11px] leading-5 text-muted-foreground">{when(m.createdAt)}</p>
              </button>
            ))}
          </div>
        </section>

        {/* ── Tasks for the selected mission ───────────────────── */}
        <section>
          <h2 className="mb-4 font-mono text-sm uppercase tracking-wide leading-6 text-muted-foreground">
            {selected ? `tasks · ${selected.repo}` : 'tasks'}
          </h2>
          {!selected && (
            <p className="font-mono text-xs text-muted-foreground">select a mission to see its task graph</p>
          )}
          {selected && tasks.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground">no tasks on this mission</p>
          )}
          {/* Each task lands as its own branch, so what is being approved is a
              fan-out, not one diff. Shared with the Command tab since Batch 10
              — one approve button over one owner-gated route. */}
          {selected && <ApprovalGate missionId={selected.id} pollMs={POLL_MS} onSettled={onSettled} />}

          <div className="flex flex-col gap-3">
            {selected &&
              tasks.map((t, i) => {
                const validation = validations[t.id]
                const held = leases[t.id] ?? []
                // Only meaningful while the task has not run: a conflict
                // recorded before a successful run is history, not state.
                const conflict = t.status === 'pending' ? conflicts[t.id] : undefined
                return (
                  <div key={t.id} className={`px-4 py-4 ${WORKSPACE_CARD_CLASS}`}>
                    <div className="flex items-start justify-between gap-3">
                      <button
                        onClick={() => setOpenTaskId(openTaskId === t.id ? null : t.id)}
                        className="flex-1 text-left text-xs text-foreground transition-colors hover:text-primary"
                      >
                        <span className="font-mono text-muted-foreground">{i + 1}. </span>
                        {t.title}
                        <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                          {openTaskId === t.id ? '▾ evidence' : '▸ evidence'}
                        </span>
                      </button>
                      <StatusBadge label={t.status} tone={TASK_TONE[t.status]} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11px] leading-5 text-muted-foreground">
                      <span>priority: {t.priority}</span>
                      <span>
                        agent:{' '}
                        {agents.find((a) => a.id === t.assignedAgent)?.name ?? (t.assignedAgent ? 'unknown' : '—')}
                      </span>
                      {t.dependsOn.length > 0 && (
                        <span>depends on {t.dependsOn.map((d) => `#${taskIndex.get(d) ?? '?'}`).join(', ')}</span>
                      )}
                    </div>
                    {held.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[10px] text-muted-foreground">leases:</span>
                        {held.map((l) => (
                          <StatusBadge
                            key={l.id}
                            title={`expires ${new Date(l.expiresAt).toLocaleTimeString()}`}
                            tone={LEASE_TONE[l.leaseType]}
                            size="sm"
                            uppercase={false}
                            label={`${l.leaseType} ${l.pathGlob}`}
                          />
                        ))}
                      </div>
                    )}
                    {/* Two different kinds of "pending". A dependency wait
                        resolves itself; a file conflict resolves when the
                        blocking task lets go, and shows which one that is. */}
                    {conflict && (
                      <div className="mt-1.5 font-mono text-[10px] text-warning">
                        queued — file conflict with{' '}
                        {conflict.blockedBy.map((d) => `#${taskIndex.get(d) ?? '?'}`).join(', ') || 'another task'}
                        <span className="ml-1 text-muted-foreground">({conflict.detail})</span>
                      </div>
                    )}
                    {!conflict && t.status === 'pending' && t.dependsOn.length > 0 && (
                      <div className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                        queued — waiting on dependencies
                      </div>
                    )}
                    {validation && (
                      <div className="mt-3 border-t border-border/30 pt-3 font-mono text-[11px] leading-5">
                        <span className={validation.passed ? 'text-primary' : 'text-red-400'}>
                          validation {validation.passed ? 'passed' : 'failed'}
                        </span>
                        {/* The reason, not just the verdict — a "failed" with
                            no cause is what made these tasks unfixable. */}
                        {validation.failedChecks?.map((f) => (
                          <p key={f} className="mt-0.5 text-red-400/80">
                            {f}
                          </p>
                        ))}
                        {validation.passed && validation.checks && (
                          <p className="mt-0.5 text-muted-foreground">
                            {validation.checks.map((c) => `${c.name}=${c.status}`).join(' · ')}
                          </p>
                        )}
                      </div>
                    )}
                    {openTaskId === t.id && <TaskEvidencePanel taskId={t.id} />}
                  </div>
                )
              })}
          </div>
        </section>
      </div>

      {/* ── Agent roster ───────────────────────────────────────── */}
      <section className="mt-14">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-mono text-sm uppercase tracking-wide leading-6 text-muted-foreground">
            <Server className="h-3.5 w-3.5" />
            agent roster ({agents.length})
          </h2>
          <button
            onClick={() => {
              setEditing(null)
              setHiring((v) => !v)
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 font-mono text-xs leading-5 text-primary shadow-sm ring-1 ring-primary/15 transition-colors hover:bg-primary/15"
          >
            <Plus className="h-3 w-3" />
            hire worker
          </button>
        </div>

        {chatAgent && (
          <AgentChatPanel
            key={chatAgent.id}
            agent={chatAgent}
            onClose={() => setChatAgent(null)}
          />
        )}

        {(hiring || editing) && (
          <HireWorkerPanel
            agent={editing ?? undefined}
            onClose={() => {
              setHiring(false)
              setEditing(null)
            }}
            onSaved={loadList}
          />
        )}
        <div className={`overflow-x-auto p-2 ${WORKSPACE_CARD_CLASS}`}>
          <table className="w-full min-w-[720px] text-left">
            <thead>
              <tr className="border-b border-border/30 font-mono text-[11px] uppercase tracking-wide leading-5 text-muted-foreground">
                <th className="px-4 py-3">agent</th>
                <th className="px-4 py-3">layer</th>
                <th className="px-4 py-3">cli command</th>
                <th className="px-4 py-3">state</th>
                <th className="px-4 py-3">instructions</th>
                <th className="px-4 py-3">detected</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} className="border-b border-border/25 last:border-0">
                  <td className="px-4 py-3 font-mono text-xs text-foreground">{a.name}</td>
                  <td className="px-4 py-3 font-mono text-[10px] text-muted-foreground">
                    {a.layer} · {AGENT_LAYER_LABELS[a.layer]}
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px] text-muted-foreground">{a.cliCommand ?? '—'}</td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      label={a.enabled ? 'enabled' : 'disabled'}
                      tone={a.enabled ? 'primary' : 'neutral'}
                    />
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px] text-muted-foreground">
                    {a.instructions ? (
                      <span className="text-foreground" title={a.instructions}>
                        {a.instructions.length > 40 ? `${a.instructions.slice(0, 40)}…` : a.instructions}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px]">
                    {/* Never checked and checked-and-absent are different
                        facts, and conflating them is what let a disabled,
                        uninstalled Codex look dispatchable for two batches. */}
                    {!a.detection?.detectedAt ? (
                      <span className="text-muted-foreground">never checked</span>
                    ) : a.detection.cliPath ? (
                      <span className="text-primary">
                        {a.detection.cliPath}
                        <span className="text-muted-foreground">
                          {' '}
                          on {a.detection.detectedHost} · {when(a.detection.detectedAt)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-warning">
                        absent on {a.detection.detectedHost} · {when(a.detection.detectedAt)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                    {/* Only agents with a CLI can be chatted with — the
                        orchestrators and validators have nothing to run. */}
                    {a.cliCommand && (
                      <button
                        onClick={() => {
                          setHiring(false)
                          setEditing(null)
                          setChatAgent({ id: a.id, name: a.name, cliCommand: a.cliCommand })
                        }}
                        className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-primary"
                        aria-label={`chat with ${a.name}`}
                      >
                        <MessageSquare className="h-3 w-3" />
                        chat
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setHiring(false)
                        setChatAgent(null)
                        setEditing({
                          id: a.id,
                          name: a.name,
                          layer: a.layer,
                          cliCommand: a.cliCommand,
                          enabled: a.enabled,
                          instructions: a.instructions,
                        })
                      }}
                      className="text-muted-foreground transition-colors hover:text-primary"
                      aria-label={`edit ${a.name}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </WorkspaceShell>
  )
}
