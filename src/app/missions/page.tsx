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
// Deliberately not the Batch 8 org chart. That renders against a settled
// backend and will replace most of this; the styling here borrows /usage and
// /trials rather than inventing conventions Batch 8 would have to honour or
// throw away.

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { ArrowLeft, ListTree, MessageSquare, Pencil, Plus, RefreshCw, Server } from 'lucide-react'

import { TaskEvidencePanel } from '@/components/missions/task-evidence'
import { HireWorkerPanel, type EditableAgent } from '@/components/missions/hire-worker'
import { AgentChatPanel } from '@/components/missions/agent-chat-panel'

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

interface ApprovalTaskView {
  task: { id: string; title: string }
  branch: string
  branchExists: boolean
  files: string[]
  insertions: number
  deletions: number
  patch: string
  patchTruncated: boolean
  decision: 'pending' | 'approved' | 'rejected' | 'merged' | 'conflicted'
}

interface ApprovalView {
  targetBranch: string
  tasks: ApprovalTaskView[]
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

// Tokens only — raw Tailwind colours would drift from the rest of the app.
const TASK_TONE: Record<TaskStatus, string> = {
  pending: 'border-border text-muted-foreground',
  assigned: 'border-border text-foreground',
  running: 'border-primary/40 bg-primary/10 text-primary',
  validating: 'border-warning/40 bg-warning/10 text-warning',
  complete: 'border-primary/50 bg-primary/15 text-primary',
  failed: 'border-red-500/40 bg-red-500/10 text-red-400',
  blocked: 'border-border bg-surface-elevated text-muted-foreground',
}

const MISSION_TONE: Record<MissionStatus, string> = {
  planning: 'border-border text-muted-foreground',
  awaiting_approval: 'border-warning/40 bg-warning/10 text-warning',
  running: 'border-primary/40 bg-primary/10 text-primary',
  completed: 'border-primary/50 bg-primary/15 text-primary',
  failed: 'border-red-500/40 bg-red-500/10 text-red-400',
  cancelled: 'border-border text-muted-foreground',
}

function Badge({ label, tone }: { label: string; tone: string }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${tone}`}>
      {label}
    </span>
  )
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

export default function MissionsPage() {
  const [missions, setMissions] = useState<Mission[]>([])
  const [agents, setAgents] = useState<AgentWithDetection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [approval, setApproval] = useState<ApprovalView | null>(null)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [approvalBusy, setApprovalBusy] = useState(false)
  const [openDiffId, setOpenDiffId] = useState<string | null>(null)
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

      // Separate route: it shells out to git, so it is owner-gated and slower
      // than the task list. A failure here must not blank the dashboard.
      try {
        const ar = await fetch(`/api/missions/${id}/approval`, { cache: 'no-store' })
        const ab = await ar.json().catch(() => ({}))
        if (ar.ok) {
          setApproval(ab)
          setApprovalError(null)
        } else {
          setApproval(null)
          setApprovalError(ab.error ?? `approval unavailable (${ar.status})`)
        }
      } catch {
        setApproval(null)
      }
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

  const act = async (action: 'approve' | 'reject') => {
    if (!selectedId || !approval) return
    setApprovalBusy(true)
    setApprovalError(null)
    try {
      const ids = approval.tasks.filter((t) => t.decision === 'pending' && t.branchExists).map((t) => t.task.id)
      const res = await fetch(`/api/missions/${selectedId}/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, taskIds: ids }),
      })
      const body = await res.json().catch(() => ({}))
      // 409 is a conflicted wave, which is an answer and not an error — it has
      // to render as blocking state rather than as a failed request.
      if (!res.ok) setApprovalError(body.error ?? (body.conflicts?.[0]?.detail as string) ?? `failed (${res.status})`)
      await loadMission(selectedId)
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : 'approval failed')
    } finally {
      setApprovalBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col bg-transparent">
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 grid-overlay opacity-30" />
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(ellipse at center, transparent 0%, rgba(8,8,8,0.6) 100%)' }}
        />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-6xl px-6 py-10">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-2 font-mono text-xs text-muted-foreground transition-colors hover:text-primary"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          back to golem
        </Link>

        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 flex items-end justify-between gap-4"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-primary/30 bg-primary/10">
              <ListTree className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h1 className="font-mono text-lg text-foreground">missions</h1>
              <p className="font-mono text-xs text-muted-foreground">
                mission spine · open a task for its evidence · refreshes every {POLL_MS / 1000}s
              </p>
            </div>
          </div>
          <button
            onClick={loadList}
            className="inline-flex items-center gap-2 rounded border border-border px-2.5 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            <RefreshCw className="h-3 w-3" />
            refresh
          </button>
        </motion.div>

        {error && (
          <div className="mb-6 rounded border border-warning/40 bg-warning/10 px-3 py-2 font-mono text-xs text-warning">
            {error}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          {/* ── Missions ─────────────────────────────────────────── */}
          <section>
            <h2 className="mb-3 font-mono text-xs uppercase tracking-wide text-muted-foreground">
              missions ({missions.length})
            </h2>
            <div className="flex flex-col gap-2">
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
                  className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    m.id === selectedId
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border bg-surface-secondary hover:border-primary/30'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-foreground">{m.repo}</span>
                    <Badge label={m.status} tone={MISSION_TONE[m.status]} />
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{m.goal}</p>
                  <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">{when(m.createdAt)}</p>
                </button>
              ))}
            </div>
          </section>

          {/* ── Tasks for the selected mission ───────────────────── */}
          <section>
            <h2 className="mb-3 font-mono text-xs uppercase tracking-wide text-muted-foreground">
              {selected ? `tasks · ${selected.repo}` : 'tasks'}
            </h2>
            {!selected && (
              <p className="font-mono text-xs text-muted-foreground">select a mission to see its task graph</p>
            )}
            {selected && tasks.length === 0 && (
              <p className="font-mono text-xs text-muted-foreground">no tasks on this mission</p>
            )}
            {/* ── Approval gate (Batch 7) ──────────────────────────
                Each task lands as its own branch, so what is being approved
                is a fan-out, not one diff. Conflicts between two task
                branches are normal here and are shown as blocking. */}
            {selected && (approval || approvalError) && (
              <div className="mb-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-warning">
                    approval gate{approval ? ` · target ${approval.targetBranch}` : ''}
                  </span>
                  {approval && approval.tasks.some((t) => t.decision === 'pending' && t.branchExists) && (
                    <div className="flex items-center gap-1.5">
                      <button
                        disabled={approvalBusy}
                        onClick={() => void act('approve')}
                        className="rounded border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/20 disabled:opacity-40"
                      >
                        {approvalBusy ? 'merging…' : 'approve + merge'}
                      </button>
                      <button
                        disabled={approvalBusy}
                        onClick={() => void act('reject')}
                        className="rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-red-400 disabled:opacity-40"
                      >
                        reject
                      </button>
                    </div>
                  )}
                </div>
                {approvalError && (
                  <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">{approvalError}</p>
                )}
                {approval?.tasks.filter((t) => t.decision !== 'merged').map((t) => (
                  <div key={t.branch} className="mt-2 border-t border-border/60 pt-2">
                    <div className="flex items-start justify-between gap-3">
                      <button
                        onClick={() => setOpenDiffId(openDiffId === t.task.id ? null : t.task.id)}
                        className="flex-1 text-left font-mono text-[10px] text-foreground hover:text-primary"
                      >
                        {openDiffId === t.task.id ? '▾' : '▸'} {t.task.title}
                        <span className="ml-1.5 text-muted-foreground">
                          {t.branchExists
                            ? `+${t.insertions}/-${t.deletions} · ${t.files.length} file${t.files.length === 1 ? '' : 's'}`
                            : 'branch missing — work not recoverable'}
                        </span>
                      </button>
                      <Badge
                        label={t.decision}
                        tone={
                          t.decision === 'conflicted'
                            ? 'border-red-500/40 bg-red-500/10 text-red-400'
                            : t.decision === 'rejected'
                              ? 'border-border text-muted-foreground'
                              : t.decision === 'approved'
                                ? 'border-primary/40 bg-primary/10 text-primary'
                                : 'border-warning/40 bg-warning/10 text-warning'
                        }
                      />
                    </div>
                    {openDiffId === t.task.id && t.patch && (
                      <pre className="mt-1.5 max-h-72 overflow-auto rounded border border-border bg-surface-base p-2 font-mono text-[9px] leading-relaxed text-muted-foreground">
                        {t.patch}
                        {t.patchTruncated ? '\n… truncated' : ''}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-2">
              {selected &&
                tasks.map((t, i) => {
                  const validation = validations[t.id]
                  const held = leases[t.id] ?? []
                  // Only meaningful while the task has not run: a conflict
                  // recorded before a successful run is history, not state.
                  const conflict = t.status === 'pending' ? conflicts[t.id] : undefined
                  return (
                    <div key={t.id} className="rounded-lg border border-border bg-surface-secondary px-3 py-2.5">
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
                        <Badge label={t.status} tone={TASK_TONE[t.status]} />
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
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
                            <span
                              key={l.id}
                              title={`expires ${new Date(l.expiresAt).toLocaleTimeString()}`}
                              className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                                l.leaseType === 'exclusive'
                                  ? 'border-warning/40 bg-warning/10 text-warning'
                                  : l.leaseType === 'write'
                                    ? 'border-primary/40 bg-primary/10 text-primary'
                                    : 'border-border text-muted-foreground'
                              }`}
                            >
                              {l.leaseType} {l.pathGlob}
                            </span>
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
                        <div className="mt-2 border-t border-border pt-2 font-mono text-[10px]">
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
        <section className="mt-10">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
              <Server className="h-3.5 w-3.5" />
              agent roster ({agents.length})
            </h2>
            <button
              onClick={() => {
                setEditing(null)
                setHiring((v) => !v)
              }}
              className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-2.5 py-1.5 font-mono text-xs text-primary transition-colors hover:bg-primary/20"
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
          <div className="overflow-x-auto rounded-lg border border-border bg-surface-secondary">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="border-b border-border font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2">agent</th>
                  <th className="px-3 py-2">layer</th>
                  <th className="px-3 py-2">cli command</th>
                  <th className="px-3 py-2">state</th>
                  <th className="px-3 py-2">instructions</th>
                  <th className="px-3 py-2">detected</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-foreground">{a.name}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
                      {a.layer} · {AGENT_LAYER_LABELS[a.layer]}
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">{a.cliCommand ?? '—'}</td>
                    <td className="px-3 py-2">
                      <Badge
                        label={a.enabled ? 'enabled' : 'disabled'}
                        tone={a.enabled ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground'}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
                      {a.instructions ? (
                        <span className="text-foreground" title={a.instructions}>
                          {a.instructions.length > 40 ? `${a.instructions.slice(0, 40)}…` : a.instructions}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px]">
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
                    <td className="px-3 py-2">
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
      </div>
    </div>
  )
}
