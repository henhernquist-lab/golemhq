// Batch 6 — the Coordinator (Layer 1).
//
// Same shape as the Planner and the Scheduler: pure decision logic and DB
// writes, never a CLI, never a line of code. Its single question is "of the
// tasks that are ready right now, which set can safely run at the same time",
// and its single output is that set plus an explicit reason for everyone left
// out.
//
// It does NOT decide readiness — dependency satisfaction is the Scheduler's,
// and Batch 4's satisfiedBy/'complete' gating is untouched. A task arrives
// here already ready; the only thing that can hold it back is file overlap.

import {
  DEFAULT_LEASE_TTL_MS,
  acquireLeases,
  reapOrphanedLeases,
  requestsFor,
  type LeaseConflict,
  type LeaseRequest,
} from './leases'
import { listActiveLeases, recordEvent } from './store'
import type { Lease, Task } from './types'

export class CoordinatorError extends Error {
  readonly detail?: unknown
  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'CoordinatorError'
    this.detail = detail
  }
}

/** Why a ready task is not in this wave. */
export type HoldReason = 'conflict' | 'batch_full'

export interface AdmittedTask {
  task: Task
  leases: Lease[]
  requests: LeaseRequest[]
}

export interface HeldTask {
  task: Task
  reason: HoldReason
  /** Which task is holding the paths it wants. Set when reason is 'conflict'. */
  blockedBy: string[]
  detail: string
}

export interface CoordinationPlan {
  missionId: string
  repo: string
  admitted: AdmittedTask[]
  held: HeldTask[]
  /** Leases released because their holder stopped heartbeating. */
  reaped: Lease[]
  /** True when nothing could be admitted despite tasks being ready. */
  starved: boolean
}

export interface CoordinateOptions {
  /** Ceiling on concurrent builders in one wave. */
  maxConcurrent?: number
  /** Lease lifetime for this wave. */
  ttlMs?: number
  /**
   * Declarations to use instead of what is on the task rows.
   *
   * Exists so the coordinator can be exercised without the Batch 6 migration
   * applied — the verification script uses it. Not a production path: the
   * Planner writes tasks.expected_paths and that is what normally feeds this.
   */
  declarationOverride?: Map<string, string[] | null>
}

/** Default concurrency. Two is enough to be parallel and cheap to reason about. */
export const DEFAULT_MAX_CONCURRENT = 2

/**
 * Choose a safe concurrent batch from the ready tasks.
 *
 * Greedy in priority order, and that ordering is what stops it deadlocking:
 * the highest-priority ready task is always admitted first (nothing is holding
 * a lease at the start of a wave except a still-running task), so the wave can
 * never come back empty while work is available and unblocked. A task that
 * loses a conflict is HELD, not dropped — it stays 'pending' and is
 * reconsidered on the next pass, once the winner has released.
 *
 * The starvation case is real and is reported rather than hidden: if every
 * ready task conflicts with a lease held by a task that is still running from
 * an earlier wave, nothing is admitted and `starved` is true. The Scheduler
 * treats that as "wait", not as "done".
 */
export async function coordinateWave(
  missionId: string,
  repo: string,
  ready: Task[],
  options: CoordinateOptions = {},
): Promise<CoordinationPlan> {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS

  // Always before deciding. A wave that queues behind a dead task's lease is
  // the exact failure this is here to prevent, and the reap has to happen on
  // the read path because there is no background worker on Vercel to run it.
  const reaped = await reapOrphanedLeases(repo)
  if (reaped.length > 0) {
    await recordEvent(missionId, 'coordinator.leases_reaped', {
      count: reaped.length,
      leases: reaped.map((l) => ({ taskId: l.taskId, pathGlob: l.pathGlob, expiredAt: l.expiresAt })),
    })
  }

  const admitted: AdmittedTask[] = []
  const held: HeldTask[] = []

  for (const task of ready) {
    if (admitted.length >= maxConcurrent) {
      held.push({
        task,
        reason: 'batch_full',
        blockedBy: [],
        detail: `wave is full at ${maxConcurrent} concurrent tasks`,
      })
      continue
    }

    const declared = options.declarationOverride?.has(task.id)
      ? options.declarationOverride.get(task.id) ?? null
      : task.expectedPaths
    const requests = requestsFor(declared)

    const result = await acquireLeases(task.id, missionId, repo, requests, { ttlMs })
    if (result.conflicts.length > 0) {
      held.push({
        task,
        reason: 'conflict',
        blockedBy: [...new Set(result.conflicts.map((c) => c.heldBy.taskId))],
        detail: describeConflicts(result.conflicts),
      })
      await recordEvent(
        missionId,
        'coordinator.task_queued',
        {
          reason: 'conflict',
          wanted: requests.map((r) => `${r.leaseType}:${r.pathGlob}`),
          blockedBy: [...new Set(result.conflicts.map((c) => c.heldBy.taskId))],
          detail: describeConflicts(result.conflicts),
        },
        task.id,
      )
      continue
    }

    admitted.push({ task, leases: result.acquired, requests })
    await recordEvent(
      missionId,
      'coordinator.leases_acquired',
      {
        leases: result.acquired.map((l) => ({ pathGlob: l.pathGlob, leaseType: l.leaseType })),
        declared: declared === null ? null : declared,
        undeclared: declared === null,
      },
      task.id,
    )
  }

  const starved = admitted.length === 0 && ready.length > 0

  await recordEvent(missionId, 'coordinator.wave', {
    ready: ready.length,
    admitted: admitted.length,
    heldByConflict: held.filter((h) => h.reason === 'conflict').length,
    heldByBatchSize: held.filter((h) => h.reason === 'batch_full').length,
    reaped: reaped.length,
    maxConcurrent,
    starved,
  })

  return { missionId, repo, admitted, held, reaped, starved }
}

function describeConflicts(conflicts: LeaseConflict[]): string {
  return conflicts
    .slice(0, 4)
    .map((c) => `${c.request.leaseType} ${c.request.pathGlob} vs ${c.heldBy.leaseType} ${c.heldBy.pathGlob}`)
    .join('; ')
}

/** Active leases for a mission, for the dashboard. */
export async function activeLeasesForRepo(repo: string): Promise<Lease[]> {
  return listActiveLeases(repo)
}
