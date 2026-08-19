'use client'

// Batch 11 — the plan preview and approval gate.
//
// The gate BEFORE dispatch, not the one after it. ApprovalGate (Batch 7/10) is
// the other end of the mission: it lists finished task branches and merges
// them. This lists a drafted graph that has not run, and its approval is what
// lets the Scheduler start.
//
// What it exists to show is the assignment. Batch 9 already made dispatch a
// separate press, so a human was already in the loop — but assigned_agent stays
// null until the Scheduler picks inside scheduleTasks, so the screen that asked
// for authorisation could not say which CLI it was authorising. This asks the
// Scheduler's own pickAgent up front and shows the answer.

import { useCallback, useEffect, useState } from 'react'
import { Loader2, ShieldCheck, XCircle, AlertTriangle } from 'lucide-react'

import { WORKSPACE_CARD_CLASS, WORKSPACE_INSET_CLASS } from '@/components/workspace/workspace-shell'

interface PlannedAssignment {
  taskId: string
  title: string
  description: string
  priority: 'low' | 'medium' | 'high'
  dependsOn: string[]
  agent: { id: string; name: string; cliCommand: string | null } | null
  rationale: string
  overridden: boolean
}

interface PlanPreview {
  atGate: boolean
  status: string
  migrationApplied: boolean
  assignments: PlannedAssignment[]
  candidates: { id: string; name: string; cliCommand: string | null }[]
  plannerSpend: { costUsd: number; totalTokens: number; calls: number }
  warning: string | null
}

export function PlanGate({
  missionId,
  pollMs,
  onSettled,
}: {
  missionId: string
  pollMs: number
  onSettled: () => void
}) {
  const [plan, setPlan] = useState<PlanPreview | null>(null)
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/missions/${missionId}/plan`, { cache: 'no-store' })
      if (!res.ok) return
      setPlan(await res.json())
    } catch {
      /* a dropped poll must not clear a gate mid-decision */
    }
  }, [missionId])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), pollMs)
    return () => clearInterval(timer)
  }, [load, pollMs])

  // Reset when the gate moves to a different mission, or the previous
  // mission's choices would be posted against this one's task ids.
  useEffect(() => {
    setOverrides({})
    setError(null)
  }, [missionId])

  const approve = useCallback(async () => {
    if (!plan) return
    setBusy('approve')
    setError(null)
    try {
      // Every task's shown builder is sent, not only the ones touched. What is
      // on screen is what gets pinned — otherwise an untouched task would be
      // re-picked by the Scheduler at dispatch, and a roster that changed in
      // between would run something other than what was approved. Approving
      // means approving what you were looking at.
      const assignments = plan.assignments
        .map((a) => ({ taskId: a.taskId, agentId: overrides[a.taskId] ?? a.agent?.id }))
        .filter((a): a is { taskId: string; agentId: string } => !!a.agentId)
      const res = await fetch(`/api/missions/${missionId}/plan/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not approve the plan.')
        return
      }
      // Approval only unlocks dispatch; the existing dispatch route is what
      // actually starts the wave. Two calls, one press.
      const fired = await fetch(`/api/missions/${missionId}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxTasks: 2, maxConcurrent: 1 }),
      })
      if (!fired.ok) {
        const d = await fired.json()
        setError(`Plan approved, but dispatch failed: ${d.error ?? `HTTP ${fired.status}`}`)
      }
      onSettled()
    } catch {
      setError('Network error approving the plan.')
    } finally {
      setBusy(null)
    }
  }, [missionId, overrides, onSettled, plan])

  const reject = useCallback(async () => {
    setBusy('reject')
    setError(null)
    try {
      // Batch 9's release valve, unchanged. Nothing has been dispatched at this
      // point, so cancelling is the whole of the cleanup: no lease is held, no
      // worktree exists, and the repo is free the moment the status lands.
      const res = await fetch(`/api/missions/${missionId}/cancel`, { method: 'POST' })
      if (!res.ok) {
        setError('Could not reject the plan.')
        return
      }
      onSettled()
    } catch {
      setError('Network error rejecting the plan.')
    } finally {
      setBusy(null)
    }
  }, [missionId, onSettled])

  if (!plan?.atGate) return null

  const index = new Map(plan.assignments.map((a, i) => [a.taskId, i + 1]))

  return (
    <div className={`${WORKSPACE_CARD_CLASS} mb-4 p-4`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-wider text-warning">
            plan drafted · awaiting your approval
          </p>
          <p className="mt-1 font-mono text-[11px] leading-5 text-muted-foreground">
            nothing has been dispatched — no builder has run and no file is locked
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={reject}
            disabled={busy !== null}
            title="Cancel this mission and release the repo"
            className="inline-flex items-center gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-1.5 font-mono text-[11px] leading-4 text-destructive shadow-sm ring-1 ring-destructive/20 transition-colors hover:bg-destructive/20 disabled:opacity-40"
          >
            {busy === 'reject' ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
            reject
          </button>
          <button
            onClick={approve}
            disabled={busy !== null || plan.assignments.some((a) => !a.agent && !overrides[a.taskId])}
            title="Approve this plan and hand it to the Scheduler — real builder CLIs, real checkout"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 font-mono text-[11px] leading-4 text-primary shadow-sm ring-1 ring-primary/20 transition-colors hover:bg-primary/20 disabled:opacity-40"
          >
            {busy === 'approve' ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
            approve plan
          </button>
        </div>
      </div>

      {/* The only real cost figure that exists before dispatch. Deliberately
          labelled as planning spend: the builders are CLI processes billed
          against their own vendor accounts and this repo records their cost
          nowhere, so a per-task build estimate would be a made-up number. */}
      <p className="mb-3 font-mono text-[11px] leading-5 text-muted-foreground">
        planner spend: ${plan.plannerSpend.costUsd.toFixed(4)} ·{' '}
        {plan.plannerSpend.totalTokens.toLocaleString()} tokens over {plan.plannerSpend.calls} call
        {plan.plannerSpend.calls === 1 ? '' : 's'}
        <span className="text-muted-foreground/60"> · builder spend is not metered by this repo</span>
      </p>

      {!plan.migrationApplied && (
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 font-mono text-[10px] leading-4 text-warning ring-1 ring-warning/20">
          <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>
            holding at &quot;{plan.status}&quot; — supabase/migrations/20260819010000_batch11_plan_approval.sql is
            not applied. The gate still holds (this status is not dispatchable), only its name is wrong.
          </span>
        </div>
      )}

      {plan.warning && (
        <div className="mb-3 rounded-lg bg-warning/10 px-3 py-2 font-mono text-[10px] leading-4 text-warning ring-1 ring-warning/20">
          {plan.warning}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {plan.assignments.map((a, i) => {
          const chosen = overrides[a.taskId] ?? a.agent?.id ?? ''
          return (
            <div key={a.taskId} className={`${WORKSPACE_INSET_CLASS} px-3 py-2.5`}>
              <div className="flex items-start justify-between gap-3">
                <p className="font-mono text-[11px] leading-5 text-foreground/90">
                  <span className="text-muted-foreground">{i + 1}. </span>
                  {a.title}
                </p>
                <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground">{a.priority}</span>
              </div>

              {a.description && (
                <p className="mt-1 font-mono text-[10px] leading-4 text-muted-foreground">{a.description}</p>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                {/* Only dispatchable layer-2 builders are ever offered. Layer 1
                    orchestrators and Layer 3 validators have no CLI and cannot
                    run a task, so they are absent rather than shown disabled —
                    the same rule Batch 9.5 applied to the roster's model
                    selector, where offering the whole registry meant picking
                    something that silently did nothing. */}
                <select
                  value={chosen}
                  onChange={(e) => setOverrides((o) => ({ ...o, [a.taskId]: e.target.value }))}
                  className="rounded-lg bg-surface-elevated/70 px-2 py-1 font-mono text-[10px] leading-4 text-foreground shadow-sm ring-1 ring-foreground/10 focus:outline-none focus:ring-primary/30"
                >
                  {plan.candidates.length === 0 && <option value="">no dispatchable builder</option>}
                  {plan.candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.cliCommand ? ` · ${c.cliCommand}` : ''}
                    </option>
                  ))}
                </select>
                <span className="font-mono text-[10px] leading-4 text-muted-foreground">
                  {overrides[a.taskId] && overrides[a.taskId] !== a.agent?.id
                    ? 'reassigned by you'
                    : a.rationale}
                </span>
              </div>

              {a.dependsOn.length > 0 && (
                <p className="mt-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                  depends on {a.dependsOn.map((d) => `#${index.get(d) ?? '?'}`).join(', ')}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {error && (
        <p className="mt-3 font-mono text-[10px] leading-4 text-destructive">{error}</p>
      )}
    </div>
  )
}
