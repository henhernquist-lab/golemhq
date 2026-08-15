// Batch 6.5 — per-task git worktrees.
//
// Batch 6's leases stop two builders writing the same FILE. They do nothing
// about the fact that every builder ran in one checkout while adapter.ts
// decides what a task did by diffing that checkout around the run — so task A
// got credited with task B's files even when their leases never overlapped.
//
// This closes it physically rather than by agreement. A task in its own
// worktree cannot see another task's uncommitted changes, so the before/after
// signature is correct by construction and there is no rule for anyone to get
// wrong.
//
// Everything here runs through runHeadless, never node:child_process. The
// builder executes on whichever machine backend() picks — the Sprite on
// Vercel, this container otherwise — and a worktree created on the wrong side
// of that boundary is a directory the builder cannot see.

import { base64Arg, runHeadless } from '@/lib/terminal/headless-run'

export class WorktreeError extends Error {
  readonly detail?: unknown
  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'WorktreeError'
    this.detail = detail
  }
}

/**
 * Where worktrees live.
 *
 * /tmp, not the repo. Measured on this Codespace while writing this: `/` is a
 * 32G overlay at 91% with 3.0G free, `/tmp` is a 44G device at 15% with 36G
 * free. A checkout of this repo is 21M of tracked files, so eight concurrent
 * worktrees under `.worktrees/` would take a real bite out of what is left on
 * `/` — and this project has twice truncated .env.local to zero bytes by
 * filling that disk.
 *
 * /tmp being wiped on Codespace resume is not a problem here and is arguably
 * the point: a worktree is scoped to one task run. What DOES survive a wipe is
 * the admin file git keeps in .git/worktrees, which is what prune() clears.
 */
export const WORKTREE_ROOT = process.env.GOLEM_WORKTREE_ROOT ?? '/tmp/golem-worktrees'

/** Orphan cutoff. Comfortably beyond the adapter's 5-minute default timeout. */
export const WORKTREE_MAX_AGE_MS = 60 * 60 * 1000

const GIT_TIMEOUT_MS = 60_000

export interface Worktree {
  taskId: string
  path: string
  /** The commit it was checked out from, detached. */
  baseCommit: string
  createdAt: number
}

interface GitResult {
  ok: boolean
  output: string
  exitCode: number | null
}

async function git(script: string, cwd: string | undefined, label: string): Promise<GitResult> {
  const run = await runHeadless(`bash -c ${base64Arg(script)}`, {
    timeoutMs: GIT_TIMEOUT_MS,
    runId: `wt-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    cwd,
  })
  return {
    ok: run.failure === null && !run.timedOut && run.exitCode === 0,
    output: run.output.trim(),
    exitCode: run.exitCode,
  }
}

/**
 * The commit every worktree in a wave is cut from.
 *
 * Resolved once by the caller and passed to each allocation, rather than each
 * worktree resolving HEAD for itself. Two tasks in one wave must start from
 * the same tree — if one lands a commit while the other is still being
 * created, resolving per-worktree would silently give them different bases and
 * the second task's diff would include the first task's work.
 */
export async function resolveBaseCommit(repoRoot: string): Promise<string> {
  const res = await git('git rev-parse HEAD', repoRoot, 'base')
  const sha = res.output.split('\n').pop()?.trim() ?? ''
  if (!res.ok || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new WorktreeError(`resolveBaseCommit: could not read HEAD in ${repoRoot}: ${res.output.slice(0, 200)}`)
  }
  return sha
}

/**
 * Serialises `git worktree add` within this process.
 *
 * git takes a lock on .git/worktrees while registering one, and two adds
 * racing it fail with "cannot lock ref" rather than queueing. Names cannot
 * collide — the path is the task's uuid — so the only contention is that lock,
 * and a short in-process queue is cheaper and more predictable than retrying
 * on a string match against git's error text.
 */
let addQueue: Promise<unknown> = Promise.resolve()
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = addQueue.then(fn, fn)
  addQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/**
 * Give a task its own checkout of `baseCommit`.
 *
 * Detached on purpose. git refuses two worktrees on the same branch, and every
 * task in a wave starts from the same commit — so a branch checkout would let
 * exactly one task in a wave succeed.
 */
export async function allocateWorktree(
  taskId: string,
  repoRoot: string,
  baseCommit: string,
): Promise<Worktree> {
  const path = `${WORKTREE_ROOT}/${taskId}`

  const created = await serialised(() =>
    git(
      [
        `set -e`,
        `mkdir -p ${shq(WORKTREE_ROOT)}`,
        // Re-allocating for a retried task must not fail on the leftovers.
        `git worktree remove --force ${shq(path)} 2>/dev/null || true`,
        `rm -rf ${shq(path)}`,
        `git worktree add --detach ${shq(path)} ${shq(baseCommit)}`,
        // Validators run `npx --no-install tsc` / `eslint` in the task's cwd.
        // A fresh worktree has no node_modules, so every validator would fail
        // with "this is not the tsc command you are looking for" — a failure
        // that reads as a broken task rather than a missing symlink. Linked,
        // not copied: 21M of tracked files per worktree is affordable, a
        // node_modules copy each is not.
        //
        // This assumes the repo ignores node_modules (this one does, via
        // .gitignore line 4). Somewhere that does not, the symlink shows up as
        // an untracked entry and lands in the task's file delta. It cannot be
        // fixed with a per-worktree exclude: `git rev-parse --git-path
        // info/exclude` resolves to the SHARED admin dir, so writing there
        // would edit the main checkout's excludes — measured, not assumed.
        `ln -sfn ${shq(`${repoRoot}/node_modules`)} ${shq(`${path}/node_modules`)}`,
        `echo WT_OK`,
      ].join('\n'),
      repoRoot,
      'add',
    ),
  )

  if (!created.ok || !created.output.includes('WT_OK')) {
    throw new WorktreeError(
      `allocateWorktree: git worktree add failed for task ${taskId}: ${created.output.slice(0, 300)}`,
      created,
    )
  }

  // Proving the directory is really there matters more than it looks:
  // runHeadless frames every command as `cd <cwd> 2>/dev/null; ...`, which
  // SWALLOWS a failed cd. A worktree that was not created would silently run
  // the builder in the shared checkout instead — the exact contamination this
  // module exists to prevent, reappearing as a silent fallback.
  const check = await git(`git rev-parse --show-toplevel && git rev-parse HEAD`, path, 'verify')
  const lines = check.output.split('\n').map((l) => l.trim()).filter(Boolean)
  const top = lines.find((l) => l.startsWith('/'))
  if (!check.ok || top !== path) {
    await releaseWorktree(taskId, repoRoot).catch(() => {})
    throw new WorktreeError(
      `allocateWorktree: worktree for ${taskId} did not verify — expected toplevel ${path}, saw ${top ?? 'nothing'}`,
      check,
    )
  }

  return { taskId, path, baseCommit, createdAt: Date.now() }
}

/**
 * Commit whatever a task produced onto a branch of its own, before the
 * worktree goes away.
 *
 * Without this, isolation would be a regression rather than a fix. Batch 6
 * left every builder writing into the shared checkout, so the work simply
 * stayed there; a worktree is removed with `--force` when the task ends, which
 * takes the uncommitted changes with it. Isolating the work and then deleting
 * it is worse than not isolating it.
 *
 * A branch rather than a merge on purpose — see the batch report. Committing
 * to `golem/task/<id>` preserves the result without deciding what happens to
 * it, which is the approval gate's call, not this layer's. Branches are refs
 * in the shared .git directory, so they outlive the worktree that made them.
 */
export async function preserveWorktree(
  taskId: string,
  repoRoot: string,
  branch = `golem/task/${taskId}`,
): Promise<{ branch: string; commit: string | null; files: string[] }> {
  const path = `${WORKTREE_ROOT}/${taskId}`
  const res = await git(
    [
      `set -e`,
      // Nothing to preserve is a normal outcome (a read-only task, or a
      // builder that did nothing) and must not look like a failure.
      `if [ -z "$(git status --porcelain=v1 --untracked-files=all)" ]; then echo WT_CLEAN; exit 0; fi`,
      `git checkout -q -B ${shq(branch)}`,
      `git add -A`,
      `git -c user.email=golem@golemhq.local -c user.name='Golem Builder' commit -q -m ${shq(`task ${taskId}`)}`,
      `echo WT_COMMIT $(git rev-parse HEAD)`,
      `git diff-tree --no-commit-id --name-only -r HEAD`,
    ].join('\n'),
    path,
    'preserve',
  )
  if (!res.ok) {
    throw new WorktreeError(`preserveWorktree: failed for ${taskId}: ${res.output.slice(0, 300)}`, res)
  }
  if (res.output.includes('WT_CLEAN')) return { branch, commit: null, files: [] }

  const lines = res.output.split('\n').map((l) => l.trim()).filter(Boolean)
  const marker = lines.findIndex((l) => l.startsWith('WT_COMMIT '))
  const commit = marker === -1 ? null : lines[marker].slice('WT_COMMIT '.length).trim()
  const files = marker === -1 ? [] : lines.slice(marker + 1).filter((l) => !l.startsWith('WT_'))
  return { branch, commit, files }
}

/** Remove a task's worktree. Safe to call when it was never created. */
export async function releaseWorktree(taskId: string, repoRoot: string): Promise<boolean> {
  const path = `${WORKTREE_ROOT}/${taskId}`
  const res = await git(
    [
      `git worktree remove --force ${shq(path)} 2>/dev/null || true`,
      `rm -rf ${shq(path)}`,
      // Clears the admin file when the directory went away without git being
      // told — a killed container, or /tmp being wiped on Codespace resume.
      `git worktree prune`,
      `echo WT_RELEASED`,
    ].join('\n'),
    repoRoot,
    'rm',
  )
  return res.ok && res.output.includes('WT_RELEASED')
}

export interface WorktreeReapResult {
  reaped: string[]
  kept: string[]
}

/**
 * Remove worktrees whose task is no longer running.
 *
 * The mirror of Batch 6's lease reaping, and necessary for the same reason:
 * nothing else will. A crashed task leaves 21M on disk and a registered
 * worktree forever, and this Codespace has hit 94% and 100% disk in earlier
 * batches. `activeTaskIds` is what the caller knows to be in flight — anything
 * under our root that is not in that set and is older than the cutoff is dead.
 *
 * Only ever touches paths under WORKTREE_ROOT. A worktree someone added by
 * hand elsewhere is listed and left alone.
 */
export async function reapOrphanedWorktrees(
  repoRoot: string,
  activeTaskIds: Iterable<string>,
  maxAgeMs = WORKTREE_MAX_AGE_MS,
): Promise<WorktreeReapResult> {
  const active = new Set(activeTaskIds)
  const listed = await git(`git worktree list --porcelain`, repoRoot, 'list')
  if (!listed.ok) return { reaped: [], kept: [] }

  const paths = listed.output
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter((p) => p.startsWith(`${WORKTREE_ROOT}/`))

  const reaped: string[] = []
  const kept: string[] = []
  const cutoff = Date.now() - maxAgeMs

  for (const path of paths) {
    const taskId = path.slice(WORKTREE_ROOT.length + 1)
    if (active.has(taskId)) {
      kept.push(taskId)
      continue
    }
    // Age is read from the directory itself rather than tracked in memory: the
    // process that created it is usually gone by the time anyone reaps.
    const stat = await git(`stat -c %Y ${shq(path)} 2>/dev/null || echo 0`, repoRoot, 'age')
    const mtimeSec = Number(stat.output.split('\n').pop()?.trim() ?? '0')
    const mtimeMs = Number.isFinite(mtimeSec) && mtimeSec > 0 ? mtimeSec * 1000 : 0
    // mtime 0 means the directory is gone but git still has the admin file —
    // definitively an orphan, reap it.
    if (mtimeMs !== 0 && mtimeMs > cutoff) {
      kept.push(taskId)
      continue
    }
    await releaseWorktree(taskId, repoRoot)
    reaped.push(taskId)
  }

  return { reaped, kept }
}

/** Disk used by all allocated worktrees, in bytes. For the disk-safety check. */
export async function worktreeDiskUsage(repoRoot: string): Promise<number> {
  const res = await git(
    `du -sb ${shq(WORKTREE_ROOT)} 2>/dev/null | cut -f1 || echo 0`,
    repoRoot,
    'du',
  )
  const n = Number(res.output.split('\n').pop()?.trim() ?? '0')
  return Number.isFinite(n) ? n : 0
}

/** Single-quote for POSIX sh. Paths here are uuids and configured roots. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
