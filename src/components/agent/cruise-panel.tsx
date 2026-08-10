'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { signIn } from 'next-auth/react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Radar, Play, Loader2, ChevronRight, ShieldCheck, ShieldOff, AlertTriangle,
  CheckCircle2, XCircle, Ban, RotateCcw, Clock, FileCode, Check, Lock,
  Target, GitPullRequest, Sparkles, CalendarClock, FileText, MessageSquare,
} from 'lucide-react'
import type {
  CruiseRepo, CruiseScan, CruiseFinding, CruiseSeverity,
  CruiseScanfixCategory, CruiseScanfixMode, ScanfixConfig,
  CruiseGoalRun, CruiseGoalStep, CruiseAutoRunFrequency,
} from '@/lib/cruise/types'
import { SCANFIX_CATEGORIES, SCANFIX_LABEL, DEFAULT_SCANFIX_CONFIG, isGoalRunActive } from '@/lib/cruise/types'
import { nextRun } from '@/lib/cruise/schedule'
import { LiveWorkspace } from '@/components/live-workspace'
import { pulseGolem } from '@/lib/golem-signals'
import { parseJsonResponse, readJsonBody } from '@/lib/fetch-json'

// Golem Cruise — the autonomous-scan main pane. Per-repo allowlist, on-demand
// static scans, scan-and-fix categories, ranked findings with dismiss/not-a-bug.
// Category auto-fix is the only write path (dispatches a scanfix run through
// /api/cruise/goal-runs — no open-ended natural-language goal input). Shares
// the page's repo selector / sidebar; only this pane is Cruise-specific.

const SEV_STYLE: Record<CruiseSeverity, string> = {
  critical: 'text-red-400 border-red-500/40 bg-red-500/10',
  high: 'text-warning border-warning/40 bg-warning/10',
  medium: 'text-accent border-accent/40 bg-accent/10',
  low: 'text-muted-foreground border-border bg-surface-secondary',
  info: 'text-muted-foreground border-border bg-surface-secondary',
}

function isActive(s: CruiseScan['status']): boolean {
  return s === 'queued' || s === 'running'
}

const FAILED_SCAN_STATUSES = new Set<CruiseScan['status']>(['failed', 'cancelled'])
const FAILED_GOAL_STATUSES = new Set<CruiseGoalRun['status']>(['failed', 'build_failed', 'cancelled'])

export function CruisePanel({ repo }: { repo: string }) {
  const [config, setConfig] = useState<CruiseRepo | null>(null)
  const [scans, setScans] = useState<CruiseScan[]>([])
  const [selectedScan, setSelectedScan] = useState<string | null>(null)
  const [findings, setFindings] = useState<CruiseFinding[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsReauth, setNeedsReauth] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [enableNote, setEnableNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [savingCat, setSavingCat] = useState(false)
  const [confirmButtons, setConfirmButtons] = useState(false)
  const [autoSaving, setAutoSaving] = useState(false)

  const [goalRuns, setGoalRuns] = useState<CruiseGoalRun[]>([])
  const [goalSteps, setGoalSteps] = useState<Record<string, CruiseGoalStep[]>>({})
  const [goalBusy, setGoalBusy] = useState(false)
  const [goalError, setGoalError] = useState<string | null>(null)
  // A scan whose completion should auto-chain a scanfix run (set by scanNow),
  // and the scans already chained (so it fires at most once each).
  const pendingChainRef = useRef<string | null>(null)
  const chainedRef = useRef<Set<string>>(new Set())
  const findingsScanIdRef = useRef<string | null>(null)

  const loadConfig = useCallback(async () => {
    if (!repo) return
    const res = await fetch('/api/cruise/repos')
    const data = await res.json()
    const rows = (data.repos ?? []) as CruiseRepo[]
    setConfig(rows.find((r) => r.full_name === repo) ?? null)
  }, [repo])

  const loadScans = useCallback(async () => {
    if (!repo) return
    const res = await fetch(`/api/cruise/scans?repo=${encodeURIComponent(repo)}`)
    const data = await res.json()
    const list = (data.scans ?? []) as CruiseScan[]
    setScans(list)
    setSelectedScan((cur) => cur ?? list[0]?.id ?? null)
  }, [repo])

  const loadFindings = useCallback(async (scanId: string) => {
    const res = await fetch(`/api/cruise/findings?scan=${scanId}`)
    const data = await res.json()
    setFindings((data.findings ?? []) as CruiseFinding[])
    findingsScanIdRef.current = scanId
  }, [])

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

  // Reset + load whenever the selected repo changes. The resets are
  // synchronous (clearing stale data from the previous repo before the new
  // repo's fetches land) — not a cascading-render risk, just ordering.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfig(null); setScans([]); setSelectedScan(null); setFindings([]); setError(null); setNeedsReauth(false)
    setGoalRuns([]); setGoalSteps({}); setGoalError(null)
    if (!repo) return
    setLoading(true)
    Promise.all([loadConfig(), loadScans(), loadGoalRuns()]).finally(() => setLoading(false))
  }, [repo, loadConfig, loadScans, loadGoalRuns])

  // Load findings when the selected scan changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selectedScan) loadFindings(selectedScan)
    else setFindings([])
  }, [selectedScan, loadFindings])

  // Poll while any scan or goal run is in flight, so status + progress update live.
  const hasActive = scans.some((s) => isActive(s.status))
  const activeGoalRuns = goalRuns.filter((r) => isGoalRunActive(r.status))
  const hasActiveGoal = activeGoalRuns.length > 0
  useEffect(() => {
    if (!hasActive && !hasActiveGoal) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    pollRef.current = setInterval(() => {
      if (hasActive) { loadScans(); if (selectedScan) loadFindings(selectedScan) }
      if (hasActiveGoal) { loadGoalRuns(); activeGoalRuns.forEach((r) => loadGoalSteps(r.id)) }
    }, 4000)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActive, hasActiveGoal, selectedScan, loadScans, loadFindings, loadGoalRuns])

  // Golem reacts when a run lands. Both lists come back newest-first, so [0]
  // is whatever just finished; a failure on either side reads as a failure.
  const wasRunningRef = useRef(false)
  useEffect(() => {
    const running = hasActive || hasActiveGoal
    if (wasRunningRef.current && !running) {
      const scanFailed = scans[0] ? FAILED_SCAN_STATUSES.has(scans[0].status) : false
      const goalFailed = goalRuns[0] ? FAILED_GOAL_STATUSES.has(goalRuns[0].status) : false
      pulseGolem(scanFailed || goalFailed ? 'error' : 'success')
    }
    wasRunningRef.current = running
  }, [hasActive, hasActiveGoal, scans, goalRuns])

  const enable = async () => {
    setBusy(true); setError(null); setNeedsReauth(false); setEnableNote(null)
    try {
      const res = await fetch('/api/cruise/repos/enable', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo }),
      })
      const { data, fallbackMessage } = await readJsonBody<{ error?: string; message?: string; workflow_present?: boolean; workflow_version?: string; default_branch?: string }>(res)
      if (res.status === 403 && data?.error === 'missing_scope') { setNeedsReauth(true); setError(data.message ?? fallbackMessage); return }
      if (!res.ok || !data) { setError(data?.message ?? data?.error ?? fallbackMessage ?? 'Enable failed'); return }
      setEnableNote(data.workflow_present
        ? { ok: true, text: `Golem Relay v${data.workflow_version} confirmed on ${data.default_branch}.` }
        : { ok: false, text: 'Enable Golem Rounds scan workflow is NOT on the default branch. Try disable + enable again.' })
      await loadConfig()
    } finally { setBusy(false) }
  }

  const disable = async () => {
    setBusy(true); setError(null)
    try {
      await fetch('/api/cruise/repos/disable', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo }),
      })
      await loadConfig()
    } finally { setBusy(false) }
  }

  const scanNow = async () => {
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/cruise/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo }),
      })
      const parsed = await parseJsonResponse<{ scan_id: string }>(res)
      if (!parsed.ok) { setError(parsed.message); return }
      const data = parsed.data
      setSelectedScan(data.scan_id)
      // Auto-chain: when this scan completes, if any auto-fix category produced
      // findings, dispatch a scanfix run (one PR). See the effect below.
      pendingChainRef.current = data.scan_id
      await loadScans()
    } finally { setBusy(false) }
  }

  const cats: ScanfixConfig = { ...DEFAULT_SCANFIX_CONFIG, ...(config?.scanfix_categories ?? {}) }

  const saveCategory = async (category: CruiseScanfixCategory, mode: CruiseScanfixMode, confirmBtns?: boolean) => {
    const prev = config
    setConfig((c) => (c ? { ...c, scanfix_categories: { ...cats, [category]: mode }, buttons_autofix_confirmed: confirmBtns ?? c.buttons_autofix_confirmed } : c))
    setSavingCat(true); setError(null)
    try {
      const res = await fetch('/api/cruise/repos/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, categories: { [category]: mode }, ...(confirmBtns !== undefined ? { buttons_autofix_confirmed: confirmBtns } : {}) }),
      })
      const parsed = await parseJsonResponse(res)
      if (!parsed.ok) { setConfig(prev); setError(parsed.message); return }
    } catch { setConfig(prev) } finally { setSavingCat(false) }
  }

  // Persist the Auto-run schedule config. Returns whether it saved (so the panel
  // can surface a validation error inline).
  const saveAutoRun = async (payload: Record<string, unknown>): Promise<boolean> => {
    setAutoSaving(true); setError(null)
    try {
      const res = await fetch('/api/cruise/repos/autorun', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, ...payload }),
      })
      const parsed = await parseJsonResponse(res)
      if (!parsed.ok) { setError(parsed.message); return false }
      await loadConfig()
      return true
    } finally { setAutoSaving(false) }
  }

  // Dispatch a deterministic scan-and-fix run over the enabled auto-fix
  // categories. Bundles every category's fixes into one PR.
  const runScanfix = async () => {
    setGoalBusy(true); setGoalError(null)
    try {
      const res = await fetch('/api/cruise/goal-runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo }),
      })
      const parsed = await parseJsonResponse(res)
      if (!parsed.ok) { setGoalError(parsed.message); return }
      await loadGoalRuns()
    } finally { setGoalBusy(false) }
  }

  // Auto-chain the scanfix run once the scan we launched reaches a terminal
  // state and its findings (for this scan) are loaded. Fires at most once per
  // scan, and only if an auto-fix category actually has open findings — so a
  // clean scan never opens an empty PR.
  useEffect(() => {
    const sid = selectedScan
    if (!sid || hasActiveGoal || goalBusy || pendingChainRef.current !== sid) return
    const scan = scans.find((s) => s.id === sid)
    if (!scan || isActive(scan.status)) return
    if (findingsScanIdRef.current !== sid || chainedRef.current.has(sid)) return
    chainedRef.current.add(sid)
    pendingChainRef.current = null
    const autoCats = SCANFIX_CATEGORIES.filter((c) => cats[c] === 'auto_fix')
    const hasFixable = findings.some((f) => f.status === 'open' && f.category && autoCats.includes(f.category))
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (hasFixable) runScanfix()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scans, findings, selectedScan, hasActiveGoal])

  const act = async (findingId: string, action: 'dismiss' | 'not_a_bug' | 'reopen') => {
    setFindings((prev) => prev.map((f) => f.id === findingId
      ? { ...f, status: action === 'reopen' ? 'open' : action === 'dismiss' ? 'dismissed' : 'not_a_bug' }
      : f))
    await fetch(`/api/cruise/findings/${findingId}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    })
  }

  if (!repo) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center bg-background">
        <p className="font-mono text-[12px] text-muted-foreground/60">Select a repository to use Cruise.</p>
      </div>
    )
  }

  const enabled = !!config?.enabled

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex-1 overflow-y-auto scrollbar-hidden">
        <div className="mx-auto max-w-[820px] px-8 py-6">
          {/* Header row */}
          <div className="mb-5 flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-primary/10">
              <Radar className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="font-mono text-[13px] font-semibold text-foreground">Golem Cruise</h1>
              <p className="font-mono text-[10px] text-muted-foreground">scan &amp; fix · <span className="text-foreground">{repo}</span></p>
            </div>
            {enabled && (
              <span className="ml-auto rounded border border-primary/30 bg-primary/5 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary">
                {SCANFIX_CATEGORIES.filter((c) => cats[c] === 'auto_fix').length} auto-fix
              </span>
            )}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> loading…</div>
          ) : !enabled ? (
            <EnableCard busy={busy} needsReauth={needsReauth} error={error} onEnable={enable} onReauth={() => signIn('github')} repo={repo} />
          ) : (
            <>
              {/* Live Workspace — visible when a scan or goal run is active */}
              <div className="mb-5">
                <LiveWorkspace
                  pollUrl={
                    hasActive
                      ? `/api/cruise/live-steps?scan_id=${scans.find((s) => isActive(s.status))?.id ?? ''}`
                      : hasActiveGoal
                        ? `/api/lab/overnight/live-steps?run_id=${activeGoalRuns[0]?.id ?? ''}`
                        : null
                  }
                  controlUrl={hasActive ? '/api/cruise/control' : null}
                  controlId={scans.find((s) => isActive(s.status))?.id ?? null}
                />
              </div>

              {/* Controls */}
              <div className="mb-5 flex items-center gap-2">
                <button onClick={scanNow} disabled={busy || hasActive}
                  className="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40">
                  {hasActive ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  {hasActive ? 'scanning…' : 'Scan now'}
                </button>
                <span className="flex items-center gap-1 font-mono text-[10px] text-primary/70"><ShieldCheck className="h-3 w-3" /> enabled</span>
                <button onClick={disable} disabled={busy}
                  className="ml-auto flex items-center gap-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40">
                  <ShieldOff className="h-3 w-3" /> disable
                </button>
              </div>

              <CategoriesPanel
                cats={cats}
                buttonsConfirmed={!!config?.buttons_autofix_confirmed}
                saving={savingCat}
                onSet={saveCategory}
                confirmOpen={confirmButtons}
                onConfirmOpen={setConfirmButtons}
              />

              {config && (
                <AutoRunPanel key={repo} config={config} saving={autoSaving} onSave={saveAutoRun} />
              )}

              {error && (
                <div className="mb-4 flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-destructive" />
                  <span className="font-mono text-[11px] text-destructive">{error}</span>
                </div>
              )}

              {enableNote && (
                <div className={`mb-4 flex items-start gap-2 rounded border px-3 py-2 ${enableNote.ok ? 'border-primary/30 bg-primary/5' : 'border-warning/40 bg-warning/10'}`}>
                  {enableNote.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />}
                  <span className={`font-mono text-[11px] ${enableNote.ok ? 'text-foreground/90' : 'text-warning'}`}>{enableNote.text}</span>
                </div>
              )}

              {goalError && (
                <div className="mb-4 flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-destructive" />
                  <span className="font-mono text-[11px] text-destructive">{goalError}</span>
                </div>
              )}

              {/* Autonomous scan-and-fix runs */}
              {goalRuns.length > 0 && (
                <div className="mb-6">
                  <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    <Target className="h-3 w-3" /> Autonomous runs
                  </p>
                  <div className="space-y-1.5">
                    {goalRuns.slice(0, 5).map((r) => (
                      <GoalRunCard key={r.id} run={r} steps={goalSteps[r.id] ?? []} onExpand={() => loadGoalSteps(r.id)} />
                    ))}
                  </div>
                </div>
              )}

              {/* Scan history */}
              {scans.length > 0 && (
                <div className="mb-5">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Scans</p>
                  <div className="space-y-1">
                    {scans.slice(0, 6).map((s) => (
                      <ScanRow key={s.id} scan={s} selected={s.id === selectedScan} onSelect={() => setSelectedScan(s.id)} />
                    ))}
                  </div>
                </div>
              )}

              {/* Scan Summary */}
              <ScanSummaryBlock
                scan={scans.find((s) => s.id === selectedScan)}
                findings={findings}
              />

              {/* Findings — grouped by category */}
              <FindingsList
                findings={findings}
                scan={scans.find((s) => s.id === selectedScan)}
                onAct={act}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function EnableCard({ busy, needsReauth, error, onEnable, onReauth, repo }: {
  busy: boolean; needsReauth: boolean; error: string | null; onEnable: () => void; onReauth: () => void; repo: string
}) {
  return (
    <div className="rounded-md border border-border bg-surface-secondary p-5">
      <div className="mb-2 flex items-center gap-2">
        <ShieldOff className="h-4 w-4 text-muted-foreground" />
        <span className="font-mono text-[12px] font-semibold text-foreground">Cruise is off for this repo</span>
      </div>
      <p className="mb-4 max-w-lg font-mono text-[11px] leading-relaxed text-muted-foreground">
        Enabling commits a managed workflow (<span className="text-foreground">.github/workflows/enry-cruise.yml</span>) and a
        static analyzer to <span className="text-foreground">{repo}</span>&apos;s default branch. Nothing scans until you press Scan now.
      </p>
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
          <span className="font-mono text-[11px] text-warning">{error}</span>
        </div>
      )}
      {needsReauth ? (
        <button onClick={onReauth}
          className="rounded border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/20">
          Re-authorize GitHub (grant workflow scope)
        </button>
      ) : (
        <button onClick={onEnable} disabled={busy}
          className="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          Enable Golem Rounds for this repo
        </button>
      )}
    </div>
  )
}

const CAT_DESC: Record<CruiseScanfixCategory, string> = {
  dead_code: 'unused imports/vars, orphaned files',
  formatting: 'prettier --write (repo config)',
  lint_autofix: 'eslint --fix, safe rules only',
  unused_deps: 'remove never-imported packages',
  broken_imports: 'repath imports to moved files',
  debug_statements: 'console.log / debugger / stale TODOs',
  non_functional_buttons: 'buttons with no onClick handler',
}

function CategoriesPanel({ cats, buttonsConfirmed, saving, onSet, confirmOpen, onConfirmOpen }: {
  cats: ScanfixConfig; buttonsConfirmed: boolean; saving: boolean
  onSet: (c: CruiseScanfixCategory, m: CruiseScanfixMode, confirmBtns?: boolean) => void
  confirmOpen: boolean; onConfirmOpen: (v: boolean) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const MODES: { key: CruiseScanfixMode; label: string }[] = [
    { key: 'off', label: 'Off' }, { key: 'report_only', label: 'Report' }, { key: 'auto_fix', label: 'Fix' },
  ]
  return (
    <div className="mb-5 rounded-md border border-border bg-surface-secondary/50">
      <button onClick={() => setExpanded((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2">
        <ChevronRight className={`h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Categories</span>
        {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        <span className="ml-auto font-mono text-[9px] text-muted-foreground/70">Fix opens one PR per scan</span>
      </button>
      {expanded && (
        <div className="divide-y divide-border/60 border-t border-border/60">
          {SCANFIX_CATEGORIES.map((c) => {
            const mode = cats[c]
            const isButtons = c === 'non_functional_buttons'
            return (
              <div key={c} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[11px] text-foreground">{SCANFIX_LABEL[c]}</p>
                  <p className="truncate font-mono text-[9px] text-muted-foreground">{CAT_DESC[c]}</p>
                </div>
                <div className="flex flex-shrink-0 overflow-hidden rounded border border-border">
                  {MODES.map((m) => {
                    const active = mode === m.key
                    const lockedFix = isButtons && m.key === 'auto_fix' && !buttonsConfirmed
                    return (
                      <button key={m.key} disabled={saving}
                        onClick={() => { if (lockedFix) { onConfirmOpen(true); return } onSet(c, m.key) }}
                        className={`flex items-center gap-1 px-2 py-1 font-mono text-[9px] uppercase transition-colors disabled:opacity-50 ${active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
                        {lockedFix && <Lock className="h-2.5 w-2.5" />}{m.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {confirmOpen && (
            <div className="flex items-center gap-2 bg-warning/5 px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-warning" />
              <p className="min-w-0 flex-1 font-mono text-[10px] text-warning">Button auto-fix only inserts a TODO comment above the button — it never guesses a handler. Enable it for this repo?</p>
              <button onClick={() => { onSet('non_functional_buttons', 'auto_fix', true); onConfirmOpen(false) }}
                className="flex-shrink-0 rounded border border-warning/40 bg-warning/10 px-2 py-1 font-mono text-[9px] uppercase text-warning">Enable</button>
              <button onClick={() => onConfirmOpen(false)} className="flex-shrink-0 font-mono text-[9px] uppercase text-muted-foreground">Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Per-repo scheduled auto-scan-and-fix. Time is local (browser tz); the server
// evaluates it DST-safely each tick. Fully autonomous — opens a PR, never merges.
function AutoRunPanel({ config, saving, onSave }: {
  config: CruiseRepo; saving: boolean; onSave: (payload: Record<string, unknown>) => Promise<boolean>
}) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const buttonsConfirmed = !!config.buttons_autofix_confirmed
  const defaultCats = (config.auto_run_categories?.length ? config.auto_run_categories : SCANFIX_CATEGORIES.filter((c) => config.scanfix_categories?.[c] === 'auto_fix'))
  const [enabled, setEnabled] = useState(config.auto_run_enabled)
  const [time, setTime] = useState(config.auto_run_time ?? '03:00')
  const [freq, setFreq] = useState<CruiseAutoRunFrequency>(config.auto_run_frequency ?? 'daily')
  const [weekday, setWeekday] = useState(config.auto_run_weekday ?? 4)
  const [intervalDays, setIntervalDays] = useState(config.auto_run_interval_days ?? 3)
  const [sel, setSel] = useState<Set<CruiseScanfixCategory>>(new Set(defaultCats))

  const preview = nextRun(
    { auto_run_enabled: true, auto_run_time: time, auto_run_tz: tz, auto_run_frequency: freq, auto_run_weekday: weekday, auto_run_interval_days: intervalDays, auto_run_anchor_date: null, auto_run_categories: [...sel], auto_run_last_fired_local_date: null, auto_run_monthly_cap: 30, auto_run_month: null, auto_run_month_count: 0 },
    new Date(),
  )
  const previewText = preview
    ? preview.toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit', timeZone: tz })
    : null

  const toggle = () => {
    if (enabled) { setEnabled(false); onSave({ enabled: false }) }
    else setEnabled(true)
  }
  const save = () => onSave({
    enabled: true, time, tz, frequency: freq,
    ...(freq === 'weekly' ? { weekday } : {}),
    ...(freq === 'every_n_days' ? { interval_days: intervalDays } : {}),
    categories: [...sel],
  })
  const toggleCat = (c: CruiseScanfixCategory) => setSel((prev) => { const n = new Set(prev); if (n.has(c)) n.delete(c); else n.add(c); return n })

  return (
    <div className="mb-5 rounded-md border border-border bg-surface-secondary/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <CalendarClock className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Auto-run</span>
        {config.auto_run_enabled && previewText && (
          <span className="truncate font-mono text-[9px] text-primary/80">next: {previewText} your time</span>
        )}
        {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        <button onClick={toggle} disabled={saving}
          className={`ml-auto flex h-4 w-7 flex-shrink-0 items-center rounded-full px-0.5 transition-colors disabled:opacity-50 ${enabled ? 'justify-end bg-primary/70' : 'justify-start bg-border'}`}>
          <span className="h-3 w-3 rounded-full bg-background" />
        </button>
      </div>

      {enabled && (
        <div className="space-y-3 border-t border-border/60 px-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
              className="rounded border border-border bg-surface-secondary px-2 py-1 font-mono text-[11px] text-foreground focus:border-primary/40 focus:outline-none" />
            <select value={freq} onChange={(e) => setFreq(e.target.value as CruiseAutoRunFrequency)}
              className="rounded border border-border bg-surface-secondary px-2 py-1 font-mono text-[11px] text-foreground focus:border-primary/40 focus:outline-none">
              <option value="daily">Daily</option>
              <option value="weekly">Weekly on</option>
              <option value="every_n_days">Every N days</option>
            </select>
            {freq === 'weekly' && (
              <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}
                className="rounded border border-border bg-surface-secondary px-2 py-1 font-mono text-[11px] text-foreground focus:border-primary/40 focus:outline-none">
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            )}
            {freq === 'every_n_days' && (
              <input type="number" min={1} max={60} value={intervalDays} onChange={(e) => setIntervalDays(Number(e.target.value))}
                className="w-16 rounded border border-border bg-surface-secondary px-2 py-1 font-mono text-[11px] text-foreground focus:border-primary/40 focus:outline-none" />
            )}
            <span className="font-mono text-[9px] text-muted-foreground">{tz}</span>
          </div>

          <div>
            <p className="mb-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Categories allowed on schedule</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {SCANFIX_CATEGORIES.map((c) => {
                const locked = c === 'non_functional_buttons' && !buttonsConfirmed
                return (
                  <label key={c} className={`flex items-center gap-1.5 font-mono text-[10px] ${locked ? 'opacity-40' : 'text-foreground/90'}`}>
                    <input type="checkbox" checked={sel.has(c)} disabled={locked}
                      onChange={() => toggleCat(c)} className="h-3 w-3 accent-primary" />
                    {locked && <Lock className="h-2.5 w-2.5" />}{SCANFIX_LABEL[c]}
                  </label>
                )
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button onClick={save} disabled={saving || sel.size === 0}
              className="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1 font-mono text-[10px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40">
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Save schedule
            </button>
            {previewText && <span className="font-mono text-[9px] text-muted-foreground">next auto-run: {previewText} your time</span>}
          </div>
          <p className="font-mono text-[9px] leading-relaxed text-muted-foreground/70">
            Runs autonomously on schedule, fixing only the checked categories. Opens a PR (draft if the build fails) — never auto-merged. Skipped if a run is already active or the monthly cap ({config.auto_run_monthly_cap}) is hit.
          </p>
        </div>
      )}
    </div>
  )
}

const GOAL_STATUS_LABEL: Record<CruiseGoalRun['status'], string> = {
  queued: 'queued', planning: 'planning', running: 'working',
  awaiting_clarification: 'needs input', completed: 'completed', capped: 'capped',
  no_changes: 'no changes', build_failed: 'build failing', failed: 'failed', cancelled: 'cancelled',
}

// A scan-and-fix run card: status, live per-category step checklist, and the
// resulting PR link. Scanfix runs have no planning phase and never pause for
// clarification (that was goal-mode-only, now removed), so this renders a
// smaller state machine than the run status enum technically allows for.
export function GoalRunCard({ run, steps, onExpand, onChat }: {
  run: CruiseGoalRun; steps: CruiseGoalStep[]; onExpand: () => void; onChat?: (run: CruiseGoalRun) => void
}) {
  const [open, setOpen] = useState(false)
  const active = isGoalRunActive(run.status)

  const icon = run.status === 'completed' ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
    : run.status === 'capped' ? <AlertTriangle className="h-3.5 w-3.5 text-warning" />
    : run.status === 'build_failed' ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
    : run.status === 'failed' ? <XCircle className="h-3.5 w-3.5 text-destructive" />
    : run.status === 'no_changes' ? <Ban className="h-3.5 w-3.5 text-muted-foreground" />
    : <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />

  return (
    <div className="overflow-hidden rounded border border-border bg-surface-secondary">
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button onClick={() => { const next = !open; setOpen(next); if (next) onExpand() }} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRight className={`h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
          {icon}
          <Sparkles className="h-3 w-3 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{run.goal}</span>
          {run.trigger === 'scheduled' && (
            <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">scheduled</span>
          )}
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{GOAL_STATUS_LABEL[run.status]}</span>
        </button>
        {onChat && (
          <button onClick={() => onChat(run)} title="Open this mission in the Forge chat"
            className="flex flex-shrink-0 items-center gap-1 rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary">
            <MessageSquare className="h-3 w-3" /> Chat
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="border-t border-border/60 px-3 py-2.5">
              {steps.length > 0 ? (
                <div className="space-y-1 border-l border-border/60 pl-3">
                  {steps.map((s) => (
                    <div key={s.seq} className="flex items-start gap-2 font-mono text-[11px]">
                      {s.status === 'done' ? <Check className="mt-0.5 h-3 w-3 flex-shrink-0 text-primary" />
                        : s.status === 'failed' ? <XCircle className="mt-0.5 h-3 w-3 flex-shrink-0 text-destructive" />
                        : s.status === 'running' ? <Loader2 className="mt-0.5 h-3 w-3 flex-shrink-0 animate-spin text-primary" />
                        : <span className="mt-1 h-1 w-1 flex-shrink-0 rounded-full bg-muted-foreground/40" />}
                      <div className="min-w-0">
                        <p className={s.status === 'pending' ? 'text-muted-foreground' : 'text-foreground/90'}>{s.description}</p>
                        {s.detail && <p className={`whitespace-pre-wrap text-[10px] ${s.status === 'failed' ? 'text-destructive/80' : 'text-muted-foreground'}`}>{s.detail}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : active ? (
                <p className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> starting…</p>
              ) : null}

              {run.status === 'no_changes' && (
                <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                  No PR opened — every fix was reverted for introducing type/lint errors, or nothing needed fixing. Expand the failed steps above for the exact errors.
                </p>
              )}

              {run.remaining_summary && (
                <div className="mt-3 rounded border border-border px-3 py-2">
                  <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Remaining</p>
                  <p className="whitespace-pre-wrap font-mono text-[11px] text-foreground/80">{run.remaining_summary}</p>
                </div>
              )}

              {run.error && <p className="mt-3 font-mono text-[11px] text-destructive">{run.error}</p>}

              {run.pr_url && (
                <a href={run.pr_url} target="_blank" rel="noreferrer"
                  className="mt-3 flex w-fit items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-[10px] text-primary transition-colors hover:bg-primary/20">
                  <GitPullRequest className="h-3 w-3" /> View PR
                </a>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function ScanRow({ scan, selected, onSelect }: { scan: CruiseScan; selected: boolean; onSelect: () => void }) {
  const icon = scan.status === 'completed' ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
    : scan.status === 'failed' ? <XCircle className="h-3.5 w-3.5 text-destructive" />
    : scan.status === 'partial' ? <AlertTriangle className="h-3.5 w-3.5 text-warning" />
    : <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
  return (
    <button onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded border px-3 py-1.5 text-left transition-colors ${
        selected ? 'border-primary/30 bg-primary/5' : 'border-border bg-surface-secondary hover:border-primary/20'
      }`}>
      {icon}
      <span className="font-mono text-[11px] text-foreground">{scan.status}</span>
      <span className="font-mono text-[10px] text-muted-foreground">· {scan.trigger}</span>
      <span className="ml-auto flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
        <Clock className="h-3 w-3" />{new Date(scan.dispatched_at).toLocaleString()}
      </span>
    </button>
  )
}

function FindingsList({ findings, scan, onAct }: {
  findings: CruiseFinding[]; scan?: CruiseScan
  onAct: (id: string, a: 'dismiss' | 'not_a_bug' | 'reopen') => void
}) {
  if (!scan) return null
  if (isActive(scan.status) && findings.length === 0) {
    return <p className="font-mono text-[11px] text-muted-foreground">Scan running — findings will stream in…</p>
  }
  if (findings.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded border border-primary/20 bg-primary/5 px-3 py-3">
        <CheckCircle2 className="h-4 w-4 text-primary" />
        <span className="font-mono text-[11px] text-foreground">No findings. Clean scan.</span>
      </div>
    )
  }
  const open = findings.filter((f) => f.status === 'open')
  const resolved = findings.filter((f) => f.status !== 'open')

  // Group open findings by category; uncategorized last.
  const GROUP_ORDER: (CruiseScanfixCategory | 'other')[] = [...SCANFIX_CATEGORIES, 'other']
  const groups = new Map<CruiseScanfixCategory | 'other', CruiseFinding[]>()
  for (const f of open) {
    const key = (f.category ?? 'other') as CruiseScanfixCategory | 'other'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(f)
  }

  return (
    <div>
      <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        Findings · <span className="text-foreground">{open.length} open</span>{resolved.length > 0 && ` · ${resolved.length} resolved`}
      </p>
      <div className="space-y-4">
        {GROUP_ORDER.filter((k) => groups.has(k)).map((k) => (
          <div key={k}>
            <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
              <span className="text-foreground/80">{k === 'other' ? 'Type / other' : SCANFIX_LABEL[k]}</span>
              <span className="text-muted-foreground/60">· {groups.get(k)!.length}</span>
            </p>
            <div className="space-y-1.5">
              {groups.get(k)!.map((f) => <FindingCard key={f.id} f={f} onAct={onAct} />)}
            </div>
          </div>
        ))}
        {resolved.length > 0 && (
          <div>
            <p className="mb-1.5 font-mono text-[10px] text-muted-foreground/70">Resolved · {resolved.length}</p>
            <div className="space-y-1.5">
              {resolved.map((f) => <FindingCard key={f.id} f={f} onAct={onAct} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ScanSummaryBlock({ scan, findings }: { scan?: CruiseScan; findings: CruiseFinding[] }) {
  const [expanded, setExpanded] = useState(true)
  if (!scan || isActive(scan.status)) return null

  const summaryText = (scan as CruiseScan & { summary_text?: string }).summary_text
  if (!summaryText && findings.length === 0) return null

  // If the server generated a summary, use it. Otherwise render a simple inline one.
  const text = summaryText
    || `${findings.filter((f) => f.status === 'open').length} finding${findings.length === 1 ? '' : 's'} found. No summary generated yet.`

  return (
    <div className="mb-5 rounded-md border border-primary/20 bg-surface-secondary">
      <button onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2">
        <ChevronRight className={`h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <FileText className="h-3.5 w-3.5 text-primary" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-primary">Scan Summary</span>
        <span className="ml-auto font-mono text-[9px] text-muted-foreground">
          {scan.status} · {new Date(scan.finished_at ?? scan.dispatched_at).toLocaleString()}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/60 px-3 py-3">
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground/90">
            {text}
          </pre>
        </div>
      )}
    </div>
  )
}

function FindingCard({ f, onAct }: {
  f: CruiseFinding; onAct: (id: string, a: 'dismiss' | 'not_a_bug' | 'reopen') => void
}) {
  const [open, setOpen] = useState(false)
  const resolved = f.status !== 'open'
  return (
    <div className={`overflow-hidden rounded border ${resolved ? 'border-border opacity-60' : 'border-border'} bg-surface-secondary`}>
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <ChevronRight className={`h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${SEV_STYLE[f.severity]}`}>{f.severity}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{f.title}</span>
        {f.file_path && (
          <span className="hidden items-center gap-1 font-mono text-[10px] text-muted-foreground sm:flex">
            <FileCode className="h-3 w-3" />{f.file_path.split('/').pop()}{f.line_start ? `:${f.line_start}` : ''}
          </span>
        )}
        {resolved && <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{f.status.replace('_', ' ')}</span>}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="border-t border-border/60 px-3 py-2.5">
              {f.file_path && <p className="mb-1.5 font-mono text-[10px] text-muted-foreground">{f.file_path}{f.line_start ? `:${f.line_start}` : ''} · {f.layer} · {Math.round(f.confidence * 100)}% conf</p>}
              <p className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground/90">{f.detail}</p>
              <div className="mt-3 flex items-center gap-1.5">
                {f.status === 'open' ? (
                  <>
                    <button onClick={() => onAct(f.id, 'dismiss')} className="flex items-center gap-1 rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground">
                      <Ban className="h-3 w-3" /> Dismiss
                    </button>
                    <button onClick={() => onAct(f.id, 'not_a_bug')} className="flex items-center gap-1 rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground">
                      <XCircle className="h-3 w-3" /> Not a bug
                    </button>
                  </>
                ) : (
                  <button onClick={() => onAct(f.id, 'reopen')} className="flex items-center gap-1 rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground">
                    <RotateCcw className="h-3 w-3" /> Reopen
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
