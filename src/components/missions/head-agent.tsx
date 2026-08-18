'use client'

// The mission ignition surface — Batch 9.
//
// Batches 1-7 built the whole pipeline (Planner → Scheduler → Coordinator →
// Builders → Validators → Approval) and proved each stage, but nothing in the
// app ever called it: `planMission` and `scheduleTasks` had no callers outside
// scripts/verify-*.mjs. Henry could watch the roster and could not start
// anything. This is the front door, and only the front door — every stage
// below it is the shipped pipeline, untouched.
//
// Two steps on purpose, not one. Planning is a bounded model call that returns
// a task graph worth reading before real CLIs start editing a real checkout,
// so the graph is shown and dispatch is a separate, deliberate press.

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, Rocket, Send, AlertCircle, Play, XCircle } from 'lucide-react'

import { ApprovalGate } from '@/components/missions/approval-gate'
import { WorkspaceShell, WORKSPACE_CARD_CLASS, WORKSPACE_INSET_CLASS } from '@/components/workspace/workspace-shell'
import { StatusBadge, type BadgeTone } from '@/components/workspace/status-badge'
import type { Mission, Task, MissionEvent, TaskStatus, MissionStatus } from '@/lib/missions/types'
import { TERMINAL_MISSION_STATUSES } from '@/lib/missions/types'

/** The repo /api/missions/start defaults to — the one this surface commands. */
const DEFAULT_REPO = 'golemhq/enry.agent'

const POLL_MS = 2500

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

/** Events worth a line in the feed, in the words Henry would use. */
function describe(event: MissionEvent): string | null {
  const p = (event.payload ?? {}) as Record<string, unknown>
  const agent = typeof p.agent === 'string' ? p.agent : null
  switch (event.type) {
    case 'mission.created': return 'mission created'
    case 'planner.context': return `read repo context (${p.manifestFile ?? 'no manifest'})`
    case 'planner.usage': return `planner spent ${p.totalTokens ?? '?'} tokens · $${Number(p.costUsd ?? 0).toFixed(4)}`
    case 'task.created': return `task queued: ${p.title ?? ''}`
    case 'planner.completed': return `plan ready — ${p.taskCount ?? '?'} tasks`
    case 'mission.status_changed': return `mission ${p.from} → ${p.to}`
    case 'coordinator.leases_acquired': {
      const leases = Array.isArray(p.leases) ? p.leases : []
      const first = leases[0] as { pathGlob?: string; leaseType?: string } | undefined
      return `locked ${first?.pathGlob ?? 'files'} (${first?.leaseType ?? 'lease'})`
    }
    case 'coordinator.task_queued': return `queued — file conflict (${p.detail ?? 'path clash'})`
    case 'scheduler.wave_dispatched': return 'wave dispatched'
    case 'task.status_changed':
      return agent ? `${agent}: ${p.from} → ${p.to}` : `task ${p.from} → ${p.to}`
    case 'task.worktree': return `${agent ?? 'builder'} touched ${p.fileCount ?? 0} file(s)`
    case 'task.result_recorded': return p.error ? `result: ${String(p.error).slice(0, 90)}` : 'result recorded'
    case 'scheduler.task_failed': return `${agent ?? 'builder'} failed: ${String(p.error ?? '').slice(0, 90)}`
    case 'task.validated': return `validators ${p.passed ? 'passed' : 'failed'}`
    case 'scheduler.run': return `run: ${p.dispatched ?? 0} dispatched, ${p.failed ?? 0} failed`
    // The landing (Batch 10). Without these the feed went quiet exactly where
    // the mission stops being the pipeline's business and becomes Henry's.
    case 'scheduler.work_preserved': {
      const files = Array.isArray(p.files) ? p.files.length : 0
      return `work saved to ${String(p.branch ?? 'branch').replace('golem/task/', 'branch ')} (${files} file${files === 1 ? '' : 's'})`
    }
    case 'scheduler.work_lost': return `WORK LOST: ${String(p.error ?? '').slice(0, 90)}`
    case 'scheduler.worktree_failed': return `no isolated checkout: ${String(p.error ?? '').slice(0, 90)}`
    case 'approval.approved': return 'approved — merging'
    case 'approval.merged': return `merged ${String(p.branch ?? '').replace('golem/task/', '')} → ${p.targetBranch ?? 'main'}`
    case 'approval.wave_landed': return `landed on ${p.targetBranch ?? 'main'} · ${String(p.to ?? '').slice(0, 7)}`
    case 'approval.conflicted': return `conflict: ${String(p.detail ?? '').slice(0, 90)}`
    case 'approval.merge_aborted': return `nothing merged — ${p.targetBranch ?? 'main'} left untouched`
    case 'approval.rejected': return `rejected${p.kept ? ' (branch kept)' : ''}`
    default: return null
  }
}

export function HeadAgent({ embedded = false }: { embedded?: boolean }) {
  const [goal, setGoal] = useState('')
  const [starting, setStarting] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set when start() is refused because another mission still holds the repo.
  // createMission allows one active mission per repo, so this is the only way
  // back to a usable front door.
  const [blockedBy, setBlockedBy] = useState<string | null>(null)
  const [mission, setMission] = useState<Mission | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [events, setEvents] = useState<MissionEvent[]>([])
  const feedRef = useRef<HTMLDivElement>(null)

  const missionId = mission?.id ?? null
  // Which mission the screen is actually showing. A poll that was in flight
  // when a new mission started would otherwise land after the reset and
  // repaint the previous mission's tasks over it.
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeIdRef.current = missionId
  }, [missionId])

  // Adopt the repo's active mission on mount.
  //
  // The mission lived only in this component's state, so a reload lost it —
  // survivable while dispatch was the last step, and not survivable now that a
  // mission ends at `awaiting_approval` and goes on holding the repo until
  // someone decides. Without this the gate is unreachable after a refresh and
  // the only symptom is the next start being refused by a mission the screen
  // cannot show. One active mission per repo is createMission's rule, so there
  // is at most one to adopt.
  useEffect(() => {
    let cancelled = false
    const adopt = async () => {
      try {
        const res = await fetch(`/api/missions?repo=${encodeURIComponent(DEFAULT_REPO)}`, { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        const active = (data.missions ?? []).find(
          (m: Mission) => !TERMINAL_MISSION_STATUSES.includes(m.status),
        )
        if (active && !cancelled) setMission(active)
      } catch {
        /* the front door still works without an adopted mission */
      }
    }
    adopt()
    return () => {
      cancelled = true
    }
  }, [])

  // Live feedback comes from the real mission_events stream via the existing
  // detail route — the same rows the dashboard reads. Nothing is synthesised
  // client-side, so what shows here is exactly what the pipeline recorded.
  // Also the approval gate's refresh hook: landing a merge changes the mission
  // status, and this is what reads it back.
  const refresh = useCallback(async () => {
    if (!missionId) return
    try {
      const res = await fetch(`/api/missions/${missionId}`, { cache: 'no-store' })
      if (!res.ok || activeIdRef.current !== missionId) return
      const data = await res.json()
      setTasks(data.tasks ?? [])
      setEvents(data.events ?? [])
      if (data.mission) setMission((m) => (m && data.mission.status !== m.status ? data.mission : m))
    } catch {
      /* a dropped poll must not clear the screen Henry is reading */
    }
  }, [missionId])

  useEffect(() => {
    if (!missionId) return
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [missionId, refresh])

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' })
  }, [events.length])

  const start = useCallback(async () => {
    const text = goal.trim()
    if (text.length < 8) { setError('Describe what you want built — at least a sentence.'); return }
    setStarting(true); setError(null); setEvents([]); setTasks([])
    try {
      const res = await fetch('/api/missions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: text }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not start the mission.')
        const held = typeof data.error === 'string' ? /\(([0-9a-f-]{36}),/.exec(data.error) : null
        setBlockedBy(held?.[1] ?? null)
        return
      }
      setBlockedBy(null)
      setMission(data.mission)
      setTasks(data.tasks ?? [])
      setGoal('')
    } catch {
      setError('Network error starting the mission.')
    } finally {
      setStarting(false)
    }
  }, [goal])

  const release = useCallback(async () => {
    if (!blockedBy) return
    const res = await fetch(`/api/missions/${blockedBy}/cancel`, { method: 'POST' })
    if (res.ok) { setBlockedBy(null); setError(null) }
    else setError('Could not cancel the mission holding this repo.')
  }, [blockedBy])

  const dispatch = useCallback(async () => {
    if (!mission) return
    setDispatching(true); setError(null)
    try {
      const res = await fetch(`/api/missions/${mission.id}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxTasks: 2, maxConcurrent: 1 }),
      })
      const data = await res.json()
      if (!res.ok) setError(data.error ?? 'Dispatch failed.')
    } catch {
      setError('Network error dispatching.')
    } finally {
      setDispatching(false)
    }
  }, [mission])

  const feed = events.map((e) => ({ e, text: describe(e) })).filter((x) => x.text)

  return (
    <WorkspaceShell
      embedded={embedded}
      icon={Rocket}
      title="command"
      subtitle="describe what you want built · it becomes a real mission and runs the pipeline"
    >
      <div className={`${WORKSPACE_CARD_CLASS} mb-6 p-4`}>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start() }}
          rows={3}
          placeholder="e.g. Add a /api/uptime route returning uptimeSeconds, with a Playwright test."
          className="w-full resize-none rounded-lg bg-surface-elevated/70 px-3 py-2.5 font-mono text-xs leading-5 text-foreground placeholder-muted-foreground/50 shadow-sm ring-1 ring-foreground/5 focus:outline-none focus:ring-primary/30"
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="font-mono text-[10px] leading-4 text-muted-foreground">
            plans first · you review the task graph before any builder runs
          </p>
          <button
            onClick={start}
            disabled={starting || goal.trim().length < 8}
            className="inline-flex items-center gap-2 rounded-lg bg-primary/10 px-3.5 py-2 font-mono text-xs leading-5 text-primary shadow-sm ring-1 ring-primary/20 transition-colors hover:bg-primary/20 disabled:opacity-40"
          >
            {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {starting ? 'planning…' : 'plan mission'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 font-mono text-xs leading-5 text-destructive shadow-sm ring-1 ring-destructive/20">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          {blockedBy && (
            <button
              onClick={release}
              title="Cancel the mission currently holding this repo"
              className="inline-flex flex-shrink-0 items-center gap-1 rounded-lg bg-destructive/10 px-2 py-1 font-mono text-[10px] leading-4 text-destructive ring-1 ring-destructive/25 transition-colors hover:bg-destructive/20"
            >
              <XCircle className="h-3 w-3" /> cancel it
            </button>
          )}
        </div>
      )}

      <AnimatePresence>
        {mission && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            {/* The mission's last step is a human one. Before Batch 10 this
                surface ended at dispatch and the work sat on unmerged branches
                a tab away, so "done" here never meant anything had landed. */}
            <ApprovalGate missionId={mission.id} pollMs={POLL_MS} onSettled={refresh} />

            <div className="grid gap-4 lg:grid-cols-2">
              <div className={`${WORKSPACE_CARD_CLASS} p-4`}>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">task graph</p>
                    <StatusBadge label={mission.status} tone={MISSION_TONE[mission.status]} size="sm" />
                  </div>
                  <button
                    onClick={dispatch}
                    disabled={dispatching || tasks.length === 0 || mission.status !== 'running'}
                    title={
                      mission.status === 'running'
                        ? 'Hand the graph to the Scheduler — real builder CLIs, real checkout'
                        : `Mission is "${mission.status}" — only a planned mission can be dispatched`
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 font-mono text-[11px] leading-4 text-primary shadow-sm ring-1 ring-primary/20 transition-colors hover:bg-primary/20 disabled:opacity-40"
                  >
                    {dispatching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} dispatch
                  </button>
                </div>
                <p className="mb-3 font-mono text-[11px] leading-5 text-foreground/80">{mission.goal}</p>
                <div className="flex flex-col gap-2">
                  {tasks.map((t, i) => (
                    <div key={t.id} className={`${WORKSPACE_INSET_CLASS} flex items-start justify-between gap-3 px-3 py-2`}>
                      <p className="font-mono text-[11px] leading-5 text-foreground/90">
                        <span className="text-muted-foreground">{i + 1}. </span>{t.title}
                      </p>
                      <StatusBadge label={t.status} tone={TASK_TONE[t.status]} size="sm" />
                    </div>
                  ))}
                </div>
              </div>

              <div className={`${WORKSPACE_CARD_CLASS} flex max-h-[26rem] flex-col p-4`}>
                <p className="mb-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  live · mission_events
                </p>
                <div ref={feedRef} className="flex flex-col gap-1.5 overflow-y-auto">
                  {feed.length === 0 && (
                    <p className="font-mono text-[11px] leading-5 text-muted-foreground/60">waiting for events…</p>
                  )}
                  {feed.map(({ e, text }) => (
                    <motion.div
                      key={e.id}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex items-baseline gap-2 font-mono text-[10px] leading-5"
                    >
                      <span className="flex-shrink-0 text-muted-foreground/50">{e.ts.slice(11, 19)}</span>
                      <span className="text-foreground/85">{text}</span>
                    </motion.div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </WorkspaceShell>
  )
}
