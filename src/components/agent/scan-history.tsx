'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChevronRight, CheckCircle2, XCircle, Ban, Clock, Check,
  AlertTriangle, Loader2, Sparkles, GitPullRequest, MessageSquare,
} from 'lucide-react'
import type { CruiseGoalRun, CruiseGoalStep, CruiseScan } from '@/lib/cruise/types'
import { isGoalRunActive } from '@/lib/cruise/types'

// Read-only history cards for autonomous scan-and-fix runs, shared between
// the Missions workspace tab (src/components/agent/missions-panel.tsx) and,
// previously, the removed Golem Cruise tab. Extracted from cruise-panel.tsx
// so Missions keeps working without pulling in the scan-trigger/category-
// editor UI that only Cruise used. The backend these read from
// (/api/cruise/goal-runs, /api/cruise/scans) is still live — it also drives
// the mobile Cruise auto-run surface — so it was left untouched.

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
