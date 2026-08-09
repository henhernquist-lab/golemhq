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
import { ArrowLeft, ListTree, Pencil, Plus, RefreshCw, Server } from 'lucide-react'

import { TaskEvidencePanel } from '@/components/missions/task-evidence'
import { HireWorkerPanel, type EditableAgent } from '@/components/missions/hire-worker'

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
  const [validations, setValidations] = useState<Record<string, ValidationPayload>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [hiring, setHiring] = useState(false)
  const [editing, setEditing] = useState<EditableAgent | null>(null)

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
            <div className="flex flex-col gap-2">
              {selected &&
                tasks.map((t, i) => {
                  const validation = validations[t.id]
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
                      <button
                        onClick={() => {
                          setHiring(false)
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
