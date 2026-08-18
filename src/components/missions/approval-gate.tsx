'use client'

// The approval gate — Batch 7's decision point, extracted in Batch 10.
//
// It lived inline in missions-workspace, which was fine while the dashboard
// was the only place a mission could be watched. Batch 9 added the Command
// tab, where a mission is started and dispatched — and that surface ended mid
// -air: the work landed on `golem/task/<id>` branches and the only way to land
// it was to switch tabs and find the mission again. Copying the block would
// have made two approve buttons over one owner-gated route, so it moved here
// and both surfaces mount the same one.
//
// It owns its own fetch. The gate shells out to git and is owner-gated, so it
// is slower and fails differently from the mission read its parents poll —
// keeping it separate means a 503 here reports itself instead of blanking a
// dashboard.

import { useCallback, useEffect, useState } from 'react'

import { WORKSPACE_INSET_CLASS } from '@/components/workspace/workspace-shell'
import { StatusBadge, type BadgeTone } from '@/components/workspace/status-badge'
import type { TaskStatus } from '@/lib/missions/types'

export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'merged' | 'conflicted'

interface ApprovalTaskView {
  task: { id: string; title: string; status: TaskStatus }
  branch: string
  branchExists: boolean
  files: string[]
  insertions: number
  deletions: number
  patch: string
  patchTruncated: boolean
  decision: ApprovalDecision
}

interface ApprovalView {
  targetBranch: string
  tasks: ApprovalTaskView[]
}

const DECISION_TONE: Record<ApprovalDecision, BadgeTone> = {
  conflicted: 'danger',
  rejected: 'neutral',
  approved: 'primary',
  merged: 'primaryStrong',
  pending: 'warning',
}

/**
 * What a row without a branch actually means.
 *
 * The old copy said "work not recoverable" for every branchless task, which
 * read as data loss on tasks that had simply not run yet. Since Batch 10 the
 * dispatcher isolates every wave, so a completed task with no branch means the
 * builder wrote nothing — a real and different outcome from a lost branch.
 */
function branchlessReason(status: TaskStatus): string {
  if (status === 'complete') return 'no branch — this task wrote nothing to land'
  if (status === 'failed') return 'no branch — the task failed before writing'
  return 'not finished — nothing to land yet'
}

export function ApprovalGate({
  missionId,
  pollMs = 5000,
  onSettled,
}: {
  missionId: string | null
  pollMs?: number
  /** Fired after a merge or rejection, so the parent can re-read the mission. */
  onSettled?: () => void
}) {
  const [approval, setApproval] = useState<ApprovalView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [openDiffId, setOpenDiffId] = useState<string | null>(null)

  const load = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/missions/${id}/approval`, { cache: 'no-store' })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        setApproval(body)
        setError(null)
      } else {
        setApproval(null)
        setError(body.error ?? `approval unavailable (${res.status})`)
      }
    } catch {
      /* keep last-known — a dropped poll must not clear a diff being read */
    }
  }, [])

  useEffect(() => {
    if (!missionId) {
      setApproval(null)
      setError(null)
      return
    }
    load(missionId)
    const timer = setInterval(() => load(missionId), pollMs)
    return () => clearInterval(timer)
  }, [missionId, pollMs, load])

  const act = useCallback(
    async (action: 'approve' | 'reject') => {
      if (!missionId || !approval) return
      setBusy(true)
      setError(null)
      try {
        const taskIds = approval.tasks
          .filter((t) => t.decision === 'pending' && t.branchExists)
          .map((t) => t.task.id)
        if (taskIds.length === 0) return
        const res = await fetch(`/api/missions/${missionId}/approval`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, taskIds }),
        })
        const body = await res.json().catch(() => ({}))
        // 409 is a conflicted wave, which is an answer and not an error — it
        // has to render as blocking state rather than as a failed request.
        if (!res.ok) setError(body.error ?? (body.conflicts?.[0]?.detail as string) ?? `failed (${res.status})`)
        await load(missionId)
        onSettled?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'approval failed')
      } finally {
        setBusy(false)
      }
    },
    [missionId, approval, load, onSettled],
  )

  if (!missionId) return null

  // A task nobody has decided on and that has produced no branch is not a
  // pending decision — it is a task that has not run. Showing those as gate
  // rows is what made the gate look broken on a mission that was still going.
  const rows = (approval?.tasks ?? []).filter(
    (t) => t.decision !== 'merged' && (t.branchExists || t.decision !== 'pending'),
  )
  const landable = (approval?.tasks ?? []).some((t) => t.decision === 'pending' && t.branchExists)
  if (rows.length === 0 && !error) return null

  return (
    <div className={`mb-4 px-4 py-4 ${WORKSPACE_INSET_CLASS}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="font-mono text-[10px] uppercase tracking-wider text-warning">
          approval gate{approval ? ` · target ${approval.targetBranch}` : ''}
        </span>
        {landable && (
          <div className="flex items-center gap-1.5">
            <button
              disabled={busy}
              onClick={() => void act('approve')}
              className="rounded-lg bg-primary/10 px-3 py-1.5 font-mono text-[10px] leading-4 text-primary shadow-sm ring-1 ring-primary/15 hover:bg-primary/15 disabled:opacity-40"
            >
              {busy ? 'merging…' : 'approve + merge'}
            </button>
            <button
              disabled={busy}
              onClick={() => void act('reject')}
              className="rounded-lg bg-surface-secondary px-3 py-1.5 font-mono text-[10px] leading-4 text-muted-foreground shadow-sm ring-1 ring-foreground/10 hover:text-red-400 disabled:opacity-40"
            >
              reject
            </button>
          </div>
        )}
      </div>
      {error && <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">{error}</p>}
      {rows.map((t) => (
        <div key={t.branch} className="mt-3 border-t border-border/30 pt-3">
          <div className="flex items-start justify-between gap-3">
            <button
              onClick={() => setOpenDiffId(openDiffId === t.task.id ? null : t.task.id)}
              className="flex-1 text-left font-mono text-[10px] text-foreground hover:text-primary"
            >
              {openDiffId === t.task.id ? '▾' : '▸'} {t.task.title}
              <span className="ml-1.5 text-muted-foreground">
                {t.branchExists
                  ? `+${t.insertions}/-${t.deletions} · ${t.files.length} file${t.files.length === 1 ? '' : 's'}`
                  : branchlessReason(t.task.status)}
              </span>
            </button>
            <StatusBadge label={t.decision} tone={DECISION_TONE[t.decision]} />
          </div>
          {openDiffId === t.task.id && t.patch && (
            <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-surface-base p-3 font-mono text-[10px] leading-relaxed text-muted-foreground shadow-sm ring-1 ring-foreground/5">
              {t.patch}
              {t.patchTruncated ? '\n… truncated' : ''}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}
