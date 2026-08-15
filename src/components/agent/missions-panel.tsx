'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Target, Loader2, Radar, CheckCircle2, XCircle, AlertTriangle,
} from 'lucide-react'
import { GoalRunCard, ScanRow } from '@/components/agent/scan-history'
import type {
  CruiseGoalRun, CruiseGoalStep, CruiseScan,
} from '@/lib/cruise/types'
import { isGoalRunActive } from '@/lib/cruise/types'

function isActiveScan(s: CruiseScan['status']): boolean {
  return s === 'queued' || s === 'running'
}

// The Forge Missions view — the read-only mission/task list that used to live
// on its own dashboard surface. It is intentionally a thin shell around
// GoalRunCard / ScanRow (src/components/agent/scan-history.tsx, extracted
// from the removed Cruise tab so this view keeps working standalone): mission
// status, live step checklists, PR links. `onChat` wires each mission's
// "Chat" button into the shared Forge chat panel — one implementation,
// reachable from both the roster entry and the unified view. Read-only by
// design — the scan/goal-run backend behind it is still driven by the mobile
// Cruise auto-run surface and its schedule cron.
export function MissionsPanel({ repo, onChat }: {
  repo: string
  onChat?: (run: CruiseGoalRun) => void
}) {
  const [goalRuns, setGoalRuns] = useState<CruiseGoalRun[]>([])
  const [goalSteps, setGoalSteps] = useState<Record<string, CruiseGoalStep[]>>({})
  const [scans, setScans] = useState<CruiseScan[]>([])
  const [selectedScan, setSelectedScan] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadGoalRuns = useCallback(async () => {
    if (!repo) return
    const res = await fetch(`/api/cruise/goal-runs?repo=${encodeURIComponent(repo)}`)
    const data = await res.json()
    setGoalRuns((data.runs ?? []) as CruiseGoalRun[])
  }, [repo])

  const loadGoalSteps = useCallback(async (goalRunId: string) => {
    const res = await fetch(`/api/cruise/goal-runs/${goalRunId}`)
    const data = await res.json()
    if (data.run) setGoalRuns((prev) => prev.map((r) => (r.id === goalRunId ? data.run : r)))
    setGoalSteps((prev) => ({ ...prev, [goalRunId]: data.steps ?? [] }))
  }, [])

  const loadScans = useCallback(async () => {
    if (!repo) return
    const res = await fetch(`/api/cruise/scans?repo=${encodeURIComponent(repo)}`)
    const data = await res.json()
    const list = (data.scans ?? []) as CruiseScan[]
    setScans(list)
    setSelectedScan((cur) => cur ?? list[0]?.id ?? null)
  }, [repo])

  // Reset + load whenever the repo changes. Synchronous resets so stale data
  // from the previous repo never flashes before the new repo's fetches land.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGoalRuns([]); setGoalSteps({}); setScans([]); setSelectedScan(null); setError(null)
    if (!repo) return
    setLoading(true)
    Promise.all([loadGoalRuns(), loadScans()]).finally(() => setLoading(false))
  }, [repo, loadGoalRuns, loadScans])

  // Poll while any run/scan is in flight so status + progress update live.
  const hasActive = scans.some((s) => isActiveScan(s.status))
  const activeGoalRuns = goalRuns.filter((r) => isGoalRunActive(r.status))
  const hasActiveGoal = activeGoalRuns.length > 0
  useEffect(() => {
    if (!hasActive && !hasActiveGoal) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    pollRef.current = setInterval(() => {
      if (hasActive) { loadScans(); if (selectedScan) { /* findings not surfaced here — read-only list */ } }
      if (hasActiveGoal) { loadGoalRuns(); activeGoalRuns.forEach((r) => loadGoalSteps(r.id)) }
    }, 4000)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActive, hasActiveGoal, selectedScan, loadScans, loadGoalRuns])

  if (!repo) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center bg-background">
        <p className="font-mono text-[12px] text-muted-foreground/60">Select a repository to see its missions.</p>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex-1 overflow-y-auto scrollbar-hidden">
        <div className="mx-auto max-w-[820px] px-8 py-6">
          {/* Header row */}
          <div className="mb-5 flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-primary/10">
              <Target className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="font-mono text-[13px] font-semibold text-foreground">Missions</h1>
              <p className="font-mono text-[10px] text-muted-foreground">read-only run history · <span className="text-foreground">{repo}</span></p>
            </div>
            {goalRuns.length > 0 && (
              <span className="ml-auto rounded border border-primary/30 bg-primary/5 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary">
                {goalRuns.length} run{goalRuns.length === 1 ? '' : 's'}
              </span>
            )}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading…
            </div>
          ) : (
            <>
              {error && (
                <div className="mb-4 flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-destructive" />
                  <span className="font-mono text-[11px] text-destructive">{error}</span>
                </div>
              )}

              {/* Missions / goal runs */}
              <div className="mb-6">
                <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  <Target className="h-3 w-3" /> Autonomous runs
                </p>
                {goalRuns.length > 0 ? (
                  <div className="space-y-1.5">
                    {goalRuns.map((r) => (
                      <GoalRunCard key={r.id} run={r} steps={goalSteps[r.id] ?? []} onExpand={() => loadGoalSteps(r.id)} onChat={onChat} />
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded border border-border/60 bg-surface-secondary/40 px-3 py-3">
                    <CheckCircle2 className="h-4 w-4 text-muted-foreground/50" />
                    <span className="font-mono text-[11px] text-muted-foreground">
                      No autonomous runs yet. Scan-and-fix runs started from Cruise appear here.
                    </span>
                  </div>
                )}
              </div>

              {/* Scan history — read-only */}
              {scans.length > 0 && (
                <div>
                  <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    <Radar className="h-3 w-3" /> Scan history
                  </p>
                  <div className="space-y-1">
                    {scans.slice(0, 8).map((s) => (
                      <ScanRow key={s.id} scan={s} selected={s.id === selectedScan} onSelect={() => setSelectedScan(s.id)} />
                    ))}
                  </div>
                </div>
              )}

              {goalRuns.length === 0 && scans.length === 0 && (
                <div className="rounded border border-border/60 bg-surface-secondary/40 px-3 py-6 text-center">
                  <XCircle className="mx-auto mb-2 h-4 w-4 text-muted-foreground/40" />
                  <p className="font-mono text-[11px] text-muted-foreground">No mission or scan history for this repo yet.</p>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">Enable Golem Rounds for this repo and run a scan from Cruise to populate this view.</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
