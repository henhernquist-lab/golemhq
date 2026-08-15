// Batch 6 — file leasing.
//
// The rule the whole thing exists to enforce: two builders must never be able
// to write the same file in the same checkout at the same time. Everything
// here is in service of answering "can this task start right now" without
// either deadlocking or quietly letting a conflict through.
//
// Enforcement only. Who gets to run is coordinator.ts; this decides what is
// held and what that excludes.

import {
  acquireLeaseRow,
  listActiveLeases,
  releaseLeasesForTask,
  reapExpiredLeases,
  heartbeatLeasesForTask,
} from './store'
import type { Lease, LeaseType } from './types'

/** Whole-repo sentinel. The one glob that overlaps every other glob. */
export const REPO_GLOB = '**'

/** Default lease lifetime. Deliberately longer than the builder timeout. */
export const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1000

export class LeaseError extends Error {
  readonly detail?: unknown
  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'LeaseError'
    this.detail = detail
  }
}

// ── Glob overlap ──────────────────────────────────────────────────────

/**
 * Normalise a declared path into a comparable glob.
 *
 * A bare directory is treated as everything under it: a task that declares
 * `src/lib` plainly intends to write files inside it, and reading that as a
 * single literal file would let a second task take `src/lib/foo.ts`
 * concurrently. Erring toward the wider reading costs parallelism; erring the
 * other way costs a lost update.
 */
export function normaliseGlob(raw: string): string {
  const trimmed = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '')
  if (!trimmed || trimmed === '.' || trimmed === '*' || trimmed === '**') return REPO_GLOB
  if (trimmed.endsWith('/')) return `${trimmed}**`
  // No wildcard and no extension — almost certainly a directory.
  if (!/[*?[\]]/.test(trimmed) && !/\.[a-z0-9]+$/i.test(trimmed)) return `${trimmed}/**`
  return trimmed
}

/** The literal leading portion of a glob, up to the first wildcard. */
function literalPrefix(glob: string): string {
  const wildcard = glob.search(/[*?[]/)
  const head = wildcard === -1 ? glob : glob.slice(0, wildcard)
  // Trim back to the last complete segment so `src/li*` does not claim `src/li`
  // as a directory it owns.
  const cut = head.lastIndexOf('/')
  return wildcard === -1 ? head : cut === -1 ? '' : head.slice(0, cut)
}

function hasWildcard(glob: string): boolean {
  return /[*?[]/.test(glob)
}

function toRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**` spans separators; `**/` should also match zero directories so
        // `src/**/x.ts` matches `src/x.ts`.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') out += '[^/]'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/**
 * Could any single path match both globs?
 *
 * Conservative by construction. A false "yes" serialises two tasks that could
 * have run together — a performance cost, visible in the dashboard as a
 * conflict. A false "no" is a lost update, which is silent and unrecoverable.
 * So every uncertain case answers yes.
 */
export function globsOverlap(a: string, b: string): boolean {
  const left = normaliseGlob(a)
  const right = normaliseGlob(b)
  if (left === right) return true
  if (left === REPO_GLOB || right === REPO_GLOB) return true

  // Two concrete paths: they overlap only if identical, already handled.
  if (!hasWildcard(left) && !hasWildcard(right)) return false

  // One concrete, one pattern — decidable exactly.
  if (!hasWildcard(left)) return toRegExp(right).test(left)
  if (!hasWildcard(right)) return toRegExp(left).test(right)

  // Both patterns. Deciding this exactly is not worth it; compare the
  // directory each is rooted at and treat containment either way as overlap.
  const pa = literalPrefix(left)
  const pb = literalPrefix(right)
  return pa === pb || pa.startsWith(pb ? `${pb}/` : '') || pb.startsWith(pa ? `${pa}/` : '')
}

/**
 * Do two lease types on overlapping paths actually conflict?
 *
 * Only read/read is compatible. A read lease blocks writes by design — the
 * point of holding one is that the file will not move under you mid-run.
 */
export function typesConflict(a: LeaseType, b: LeaseType): boolean {
  if (a === 'exclusive' || b === 'exclusive') return true
  return !(a === 'read' && b === 'read')
}

export interface LeaseRequest {
  pathGlob: string
  leaseType: LeaseType
}

export interface LeaseConflict {
  request: LeaseRequest
  /** The already-held lease standing in the way. */
  heldBy: Lease
}

/**
 * Which requested leases collide with what is already held.
 *
 * Leases owned by the requesting task itself are skipped: a task re-acquiring
 * or extending its own lease is not a conflict, and treating it as one would
 * deadlock a retry against its own leftovers.
 */
export function findConflicts(
  requests: LeaseRequest[],
  held: Lease[],
  requestingTaskId: string,
): LeaseConflict[] {
  const conflicts: LeaseConflict[] = []
  for (const request of requests) {
    for (const lease of held) {
      if (lease.taskId === requestingTaskId) continue
      if (!typesConflict(request.leaseType, lease.leaseType)) continue
      if (!globsOverlap(request.pathGlob, lease.pathGlob)) continue
      conflicts.push({ request, heldBy: lease })
    }
  }
  return conflicts
}

/**
 * What a task should lease, given what it declared.
 *
 * An undeclared task takes the whole repo exclusively. That is the Batch 4
 * behaviour — one task at a time — and it is the only safe reading of "we do
 * not know what this will touch". Declaring nothing at all (an empty array,
 * as opposed to null) is taken at face value and leases nothing.
 */
export function requestsFor(expectedPaths: string[] | null): LeaseRequest[] {
  if (expectedPaths === null) return [{ pathGlob: REPO_GLOB, leaseType: 'exclusive' }]
  return expectedPaths.map((p) => ({ pathGlob: normaliseGlob(p), leaseType: 'write' as LeaseType }))
}

// ── Acquisition ───────────────────────────────────────────────────────

export interface AcquireResult {
  acquired: Lease[]
  conflicts: LeaseConflict[]
}

/**
 * Take every requested lease, or none of them.
 *
 * All-or-nothing on purpose. A task holding three of its four leases is a task
 * that cannot run and is blocking others while it fails to — the classic
 * partial-acquisition deadlock. On conflict this releases whatever it managed
 * to take and reports, leaving the caller to queue the task.
 *
 * The recheck after writing is what makes this safe against a second scheduler
 * pass racing it: both can pass the pre-check, but only one survives the
 * recheck, because by then both rows are visible. The loser yields. Postgres
 * cannot express this as a constraint — overlap is a glob predicate, not an
 * equality — so it is done as read-write-reread rather than pretended away.
 */
export async function acquireLeases(
  taskId: string,
  missionId: string,
  repo: string,
  requests: LeaseRequest[],
  options: { ttlMs?: number; ownerAgent?: string | null } = {},
): Promise<AcquireResult> {
  if (requests.length === 0) return { acquired: [], conflicts: [] }

  const held = await listActiveLeases(repo)
  const preConflicts = findConflicts(requests, held, taskId)
  if (preConflicts.length > 0) return { acquired: [], conflicts: preConflicts }

  const expiresAt = new Date(Date.now() + (options.ttlMs ?? DEFAULT_LEASE_TTL_MS)).toISOString()
  const acquired: Lease[] = []
  try {
    for (const request of requests) {
      acquired.push(
        await acquireLeaseRow({
          taskId,
          missionId,
          repo,
          pathGlob: request.pathGlob,
          leaseType: request.leaseType,
          ownerAgent: options.ownerAgent ?? null,
          expiresAt,
        }),
      )
    }
  } catch (err) {
    await releaseLeasesForTask(taskId).catch(() => {})
    throw new LeaseError(
      `acquireLeases: failed writing leases for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }

  const after = await listActiveLeases(repo)
  const raced = findConflicts(requests, after, taskId)
  if (raced.length > 0) {
    await releaseLeasesForTask(taskId).catch(() => {})
    return { acquired: [], conflicts: raced }
  }

  return { acquired, conflicts: [] }
}

export async function releaseLeases(taskId: string): Promise<number> {
  return releaseLeasesForTask(taskId)
}

export async function heartbeatLeases(taskId: string, ttlMs = DEFAULT_LEASE_TTL_MS): Promise<number> {
  return heartbeatLeasesForTask(taskId, new Date(Date.now() + ttlMs).toISOString())
}

/**
 * Release leases whose holder has gone quiet.
 *
 * Orphans are the failure mode that turns a transient crash into a permanently
 * wedged mission: the task is gone, nothing will ever release its lease, and
 * every future task that touches those paths queues behind a ghost. Reaping is
 * therefore not an optimisation.
 */
export async function reapOrphanedLeases(repo?: string): Promise<Lease[]> {
  return reapExpiredLeases(new Date().toISOString(), repo)
}

export { listActiveLeases }
