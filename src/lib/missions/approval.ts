// Batch 7 — the approval gate.
//
// Batch 6.5 changed what there is to approve. Work no longer sits as a dirty
// shared checkout; each task commits to `golem/task/<id>` and that branch
// outlives its worktree. So a completed wave is a FAN-OUT of branches, and
// approving it is a merge problem, not a "mark it done" problem.
//
// Two things follow that the earlier batches do not cover:
//
//   Leases prevented two tasks writing the same FILE. They say nothing about
//   two tasks writing adjacent LINES of the same file, which is a clean
//   parallel run and a merge conflict. Conflicts are therefore normal here,
//   not exceptional, and are surfaced as a blocking state rather than
//   resolved.
//
//   A partly-merged wave is worse than an unmerged one — half a feature on the
//   target branch, with no record of which half. Merging is therefore atomic:
//   every branch is merged onto a throwaway integration ref first, and the
//   target only moves if all of them landed.
//
// No migration. The mission spine already has 'awaiting_approval' in its
// status constraint, and every decision here is an event — which is what an
// approval IS. Folding mission_events gives the current state and the audit
// trail in one place.

import { base64Arg, runHeadless } from '@/lib/terminal/headless-run'
import { getMission, listEvents, listTasks, recordEvent, updateMissionStatus } from './store'
import type { Task } from './types'

export class ApprovalError extends Error {
  readonly detail?: unknown
  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'ApprovalError'
    this.detail = detail
  }
}

/** Where integration merges are staged. Deliberately NOT under WORKTREE_ROOT. */
const MERGE_ROOT = '/tmp/golem-merge'

const GIT_TIMEOUT_MS = 120_000
/** Patch bytes shown per task. Enough to judge, not enough to melt the page. */
const MAX_PATCH_CHARS = 20_000

export const taskBranch = (taskId: string) => `golem/task/${taskId}`

interface GitResult {
  ok: boolean
  output: string
  exitCode: number | null
}

async function git(script: string, cwd: string, label: string): Promise<GitResult> {
  const run = await runHeadless(`bash -c ${base64Arg(script)}`, {
    timeoutMs: GIT_TIMEOUT_MS,
    runId: `ap-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    cwd,
  })
  return {
    ok: run.failure === null && !run.timedOut && run.exitCode === 0,
    output: run.output.trim(),
    exitCode: run.exitCode,
  }
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Strip the framing echo runHeadless leaves around a command's real output. */
function payload(output: string, marker: string): string[] {
  const lines = output.split('\n')
  const at = lines.findIndex((l) => l.trim() === marker)
  return at === -1 ? [] : lines.slice(at + 1).map((l) => l.replace(/\r$/, ''))
}

// ── What is waiting ───────────────────────────────────────────────────

export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'merged' | 'conflicted'

export interface TaskDiff {
  task: Task
  branch: string
  /** False when the branch is gone — the work is not recoverable from here. */
  branchExists: boolean
  commit: string | null
  files: string[]
  insertions: number
  deletions: number
  /** Truncated unified diff against the target branch. */
  patch: string
  patchTruncated: boolean
  decision: ApprovalDecision
}

export interface PendingApproval {
  missionId: string
  targetBranch: string
  targetCommit: string | null
  tasks: TaskDiff[]
  /** Any task whose branch vanished. Approving cannot recover these. */
  missingBranches: string[]
}

/**
 * Fold the event log into the current decision for one task.
 *
 * Last write wins, which is what makes a re-approval after a fixed conflict
 * behave the way anyone would expect.
 */
function decisionsFromEvents(events: Awaited<ReturnType<typeof listEvents>>): Map<string, ApprovalDecision> {
  const out = new Map<string, ApprovalDecision>()
  for (const e of events) {
    if (!e.taskId) continue
    if (e.type === 'approval.approved') out.set(e.taskId, 'approved')
    else if (e.type === 'approval.rejected') out.set(e.taskId, 'rejected')
    else if (e.type === 'approval.merged') out.set(e.taskId, 'merged')
    else if (e.type === 'approval.conflicted') out.set(e.taskId, 'conflicted')
  }
  return out
}

/**
 * Close a mission once no task on it is still waiting on Henry.
 *
 * Batch 10. Before the front door existed nothing depended on a mission ever
 * reaching a terminal status, so approving a wave landed the code and left the
 * mission `awaiting_approval` forever. createMission allows one active mission
 * per repo, and `awaiting_approval` is not terminal — so a landed, finished
 * mission still held the repo and the next one was refused at the door.
 *
 * The status is read off the decisions rather than the caller's intent: a
 * caller that approved 2 of 5 tasks has not finished the mission, and only the
 * log knows that. Nothing merged means nothing landed, which is `cancelled` —
 * every branch is still on disk (rejectTasks keeps them), so this is a
 * released repo, not discarded work.
 */
async function releaseIfDecided(missionId: string): Promise<void> {
  const [tasks, events] = await Promise.all([listTasks(missionId), listEvents(missionId, 500)])
  const decisions = decisionsFromEvents(events)
  const outstanding = tasks.filter((t) => {
    const d = decisions.get(t.id) ?? 'pending'
    return d === 'pending' || d === 'approved' || d === 'conflicted'
  })
  if (tasks.length === 0 || outstanding.length > 0) return

  const landed = tasks.some((t) => decisions.get(t.id) === 'merged')
  await updateMissionStatus(missionId, landed ? 'completed' : 'cancelled', {
    by: 'approval',
    decided: tasks.length,
    merged: tasks.filter((t) => decisions.get(t.id) === 'merged').length,
    ...(landed ? {} : { reason: 'every task was rejected — branches kept, repo released' }),
  }).catch(() => {
    /* the approval itself already succeeded; a stuck status must not undo it */
  })
}

/**
 * Everything awaiting a human on this mission, with real diffs.
 *
 * The diff is computed against the target branch rather than the task's own
 * base commit: what matters to the reviewer is what would land, and if the
 * target has moved since the wave ran those are different things.
 */
export async function listPendingApprovals(
  missionId: string,
  repoRoot: string,
  targetBranch = 'main',
): Promise<PendingApproval> {
  const mission = await getMission(missionId)
  if (!mission) throw new ApprovalError(`listPendingApprovals: mission ${missionId} not found`)

  const [tasks, events] = await Promise.all([listTasks(missionId), listEvents(missionId, 500)])
  const decisions = decisionsFromEvents(events)

  const headRes = await git(`git rev-parse ${shq(targetBranch)} 2>/dev/null || true`, repoRoot, 'target')
  const targetCommit = headRes.output.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/i.test(l)).pop() ?? null

  const out: TaskDiff[] = []
  const missingBranches: string[] = []

  for (const task of tasks) {
    const branch = taskBranch(task.id)
    const res = await git(
      [
        `if ! git rev-parse --verify --quiet ${shq(branch)} >/dev/null; then echo AP_NOBRANCH; exit 0; fi`,
        `echo AP_SHA`,
        `git rev-parse ${shq(branch)}`,
        `echo AP_STAT`,
        `git diff --numstat ${shq(`${targetBranch}...${branch}`)} 2>/dev/null || true`,
        `echo AP_PATCH`,
        `git diff ${shq(`${targetBranch}...${branch}`)} 2>/dev/null | head -c ${MAX_PATCH_CHARS + 1} || true`,
      ].join('\n'),
      repoRoot,
      'diff',
    )

    if (!res.ok || res.output.includes('AP_NOBRANCH')) {
      missingBranches.push(task.id)
      out.push({
        task, branch, branchExists: false, commit: null, files: [],
        insertions: 0, deletions: 0, patch: '', patchTruncated: false,
        decision: decisions.get(task.id) ?? 'pending',
      })
      continue
    }

    const sha = payload(res.output, 'AP_SHA')[0]?.trim() ?? null
    const statLines = payload(res.output, 'AP_STAT')
    const stopAt = statLines.findIndex((l) => l.trim() === 'AP_PATCH')
    const stats = (stopAt === -1 ? statLines : statLines.slice(0, stopAt)).filter(Boolean)

    let insertions = 0
    let deletions = 0
    const files: string[] = []
    for (const line of stats) {
      // Whitespace, not \t. git writes numstat tab-delimited, but this output
      // has been through a PTY, which expands tabs to spaces — measured:
      // `1\t0\tg.txt` arrives as `1       0       g.txt`. A tab-anchored regex
      // matches nothing and every diff silently reads as empty. Anything else
      // parsing tab-delimited git output through runHeadless has the same trap.
      const m = /^(\d+|-)\s+(\d+|-)\s+(.+)$/.exec(line.trim())
      if (!m) continue
      insertions += m[1] === '-' ? 0 : Number(m[1])
      deletions += m[2] === '-' ? 0 : Number(m[2])
      files.push(m[3])
    }

    const patchRaw = payload(res.output, 'AP_PATCH').join('\n')
    out.push({
      task,
      branch,
      branchExists: true,
      commit: sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null,
      files,
      insertions,
      deletions,
      patch: patchRaw.slice(0, MAX_PATCH_CHARS),
      patchTruncated: patchRaw.length > MAX_PATCH_CHARS,
      decision: decisions.get(task.id) ?? 'pending',
    })
  }

  return { missionId, targetBranch, targetCommit, tasks: out, missingBranches }
}

// ── Merging ───────────────────────────────────────────────────────────

export interface MergeConflict {
  taskId: string
  branch: string
  /** Which already-merged branch it collided with, when that is knowable. */
  conflictsWith: string[]
  files: string[]
  detail: string
}

export interface ApprovalResult {
  missionId: string
  targetBranch: string
  /** Target before the merge. Unchanged when the merge did not land. */
  targetBefore: string | null
  /** Target after. Same as targetBefore on any failure — this is atomic. */
  targetAfter: string | null
  merged: { taskId: string; branch: string; commit: string }[]
  conflicts: MergeConflict[]
  /** True only when the target actually moved. */
  landed: boolean
  error: string | null
}

/**
 * Merge an approved set of task branches onto the target, all or nothing.
 *
 * The merge happens on a throwaway integration ref cut from the target, never
 * on the target itself. A conflict on the third of five branches therefore
 * leaves the target exactly where it was, rather than with two branches
 * landed and a wave that cannot be described as either merged or not.
 *
 * Order is deterministic — task creation order, which the Planner already
 * wrote topologically — so approving the same wave twice produces the same
 * history, and a conflict report names the same pair each time.
 */
export async function approveAndMerge(
  missionId: string,
  repoRoot: string,
  taskIds: string[],
  options: { targetBranch?: string; approvedBy?: string } = {},
): Promise<ApprovalResult> {
  const targetBranch = options.targetBranch ?? 'main'
  const mission = await getMission(missionId)
  if (!mission) throw new ApprovalError(`approveAndMerge: mission ${missionId} not found`)

  const tasks = (await listTasks(missionId))
    .filter((t) => taskIds.includes(t.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))

  if (tasks.length === 0) throw new ApprovalError('approveAndMerge: no matching tasks')

  for (const task of tasks) {
    await recordEvent(missionId, 'approval.approved', { branch: taskBranch(task.id), by: options.approvedBy ?? 'henry' }, task.id)
  }

  const beforeRes = await git(`git rev-parse ${shq(targetBranch)}`, repoRoot, 'before')
  const targetBefore = beforeRes.output.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/i.test(l)).pop() ?? null
  if (!targetBefore) {
    throw new ApprovalError(`approveAndMerge: target branch ${targetBranch} does not resolve in ${repoRoot}`)
  }

  const stage = `${MERGE_ROOT}/${missionId}`
  const merged: { taskId: string; branch: string; commit: string }[] = []
  const conflicts: MergeConflict[] = []

  // Staging worktree, detached at the target. Detached so this never needs the
  // target branch to be free — in a real deployment the main checkout has it
  // checked out, and `git worktree add <target>` would refuse.
  const setup = await git(
    [
      `set -e`,
      `mkdir -p ${shq(MERGE_ROOT)}`,
      `git worktree remove --force ${shq(stage)} 2>/dev/null || true`,
      `rm -rf ${shq(stage)}`,
      `git worktree add --detach ${shq(stage)} ${shq(targetBefore)}`,
      `echo AP_STAGED`,
    ].join('\n'),
    repoRoot,
    'stage',
  )
  if (!setup.ok || !setup.output.includes('AP_STAGED')) {
    throw new ApprovalError(`approveAndMerge: could not stage a merge worktree: ${setup.output.slice(0, 300)}`, setup)
  }

  try {
    for (const task of tasks) {
      const branch = taskBranch(task.id)
      const res = await git(
        [
          `if ! git rev-parse --verify --quiet ${shq(branch)} >/dev/null; then echo AP_MISSING; exit 0; fi`,
          // --no-ff so every task is one identifiable merge commit in history.
          `if git -c user.email=golem@golemhq.local -c user.name='Golem Approval' merge --no-ff --no-edit ${shq(branch)} >/dev/null 2>&1; then`,
          `  echo AP_MERGED $(git rev-parse HEAD)`,
          `else`,
          `  echo AP_CONFLICT`,
          `  git diff --name-only --diff-filter=U`,
          `  git merge --abort 2>/dev/null || true`,
          `fi`,
        ].join('\n'),
        stage,
        'merge',
      )

      if (res.output.includes('AP_MISSING')) {
        conflicts.push({
          taskId: task.id,
          branch,
          conflictsWith: [],
          files: [],
          detail: 'branch no longer exists — the work cannot be merged from here',
        })
        break
      }

      if (res.output.includes('AP_CONFLICT')) {
        const files = payload(res.output, 'AP_CONFLICT').map((l) => l.trim()).filter(Boolean)
        conflicts.push({
          taskId: task.id,
          branch,
          // Anything already merged onto the stage is a candidate. When only
          // one has landed, this is exact; with several it is the honest
          // superset rather than a guess dressed up as a finding.
          conflictsWith: merged.map((m) => m.branch),
          files,
          detail:
            merged.length > 0
              ? `conflicts with already-merged ${merged.map((m) => m.branch).join(', ')} in ${files.join(', ') || 'unknown files'}`
              : `conflicts with ${targetBranch} in ${files.join(', ') || 'unknown files'}`,
        })
        break
      }

      const line = res.output.split('\n').find((l) => l.trim().startsWith('AP_MERGED '))
      const sha = line?.trim().slice('AP_MERGED '.length).trim() ?? ''
      if (!res.ok || !/^[0-9a-f]{40}$/i.test(sha)) {
        conflicts.push({
          taskId: task.id, branch, conflictsWith: [], files: [],
          detail: `merge produced no commit: ${res.output.slice(0, 200)}`,
        })
        break
      }
      merged.push({ taskId: task.id, branch, commit: sha })
    }

    // Any conflict at all and nothing lands. Half a wave on the target is the
    // outcome with no correct description.
    if (conflicts.length > 0) {
      for (const c of conflicts) {
        await recordEvent(
          missionId,
          'approval.conflicted',
          { branch: c.branch, conflictsWith: c.conflictsWith, files: c.files, detail: c.detail },
          c.taskId,
        )
      }
      await recordEvent(missionId, 'approval.merge_aborted', {
        targetBranch,
        targetUnchanged: targetBefore,
        attempted: tasks.length,
        mergedBeforeAbort: merged.length,
      })
      await updateMissionStatus(missionId, 'awaiting_approval').catch(() => {})
      return {
        missionId, targetBranch, targetBefore, targetAfter: targetBefore,
        merged: [], conflicts, landed: false,
        error: conflicts[0].detail,
      }
    }

    // Everything merged on the stage. Move the target — a fast-forward by
    // construction, since the stage started at the target and only moved
    // forward. Guarded against the target having moved underneath us.
    const stageHead = await git(`git rev-parse HEAD`, stage, 'stagehead')
    const stageSha = stageHead.output.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/i.test(l)).pop()
    if (!stageSha) throw new ApprovalError('approveAndMerge: staged merge produced no head')

    const land = await git(
      [
        `now=$(git rev-parse ${shq(targetBranch)})`,
        `if [ "$now" != ${shq(targetBefore)} ]; then echo AP_MOVED "$now"; exit 0; fi`,
        // update-ref, not checkout+merge: the target is normally checked out in
        // the main worktree, and this is a fast-forward, so the ref moves and
        // that checkout simply reports the new files as needing a checkout
        // rather than being rewritten underneath whoever is using it.
        `git update-ref ${shq(`refs/heads/${targetBranch}`)} ${shq(stageSha)} ${shq(targetBefore)}`,
        `echo AP_LANDED $(git rev-parse ${shq(targetBranch)})`,
      ].join('\n'),
      repoRoot,
      'land',
    )

    if (land.output.includes('AP_MOVED')) {
      await recordEvent(missionId, 'approval.merge_aborted', {
        targetBranch,
        reason: 'target moved during approval',
        expected: targetBefore,
      })
      return {
        missionId, targetBranch, targetBefore, targetAfter: targetBefore,
        merged: [], conflicts: [], landed: false,
        error: `${targetBranch} moved during approval — nothing was merged; re-review against the new target`,
      }
    }
    if (!land.ok || !land.output.includes('AP_LANDED')) {
      throw new ApprovalError(`approveAndMerge: could not update ${targetBranch}: ${land.output.slice(0, 300)}`, land)
    }

    for (const m of merged) {
      await recordEvent(missionId, 'approval.merged', { branch: m.branch, commit: m.commit, targetBranch }, m.taskId)
    }
    await recordEvent(missionId, 'approval.wave_landed', {
      targetBranch,
      from: targetBefore,
      to: stageSha,
      tasks: merged.map((m) => m.taskId),
    })

    // Approved and landed: the branch is now redundant with the target's
    // history, so it is deleted. Nothing is lost — the commits are reachable
    // from the merge commits.
    for (const m of merged) {
      await git(`git branch -D ${shq(m.branch)} 2>/dev/null || true`, repoRoot, 'cleanup')
    }

    await releaseIfDecided(missionId)

    return {
      missionId, targetBranch, targetBefore, targetAfter: stageSha,
      merged, conflicts: [], landed: true, error: null,
    }
  } finally {
    await git(
      [`git worktree remove --force ${shq(stage)} 2>/dev/null || true`, `rm -rf ${shq(stage)}`, `git worktree prune`].join('\n'),
      repoRoot,
      'unstage',
    )
  }
}

// ── Rejection ─────────────────────────────────────────────────────────

export interface RejectionResult {
  missionId: string
  rejected: { taskId: string; branch: string; kept: boolean }[]
}

/**
 * Reject work. Nothing merges, and the branches are KEPT.
 *
 * Retention is deliberate and is the safe direction. Since Batch 6.5 the
 * branch is the ONLY copy of a task's output — the worktree it was made in is
 * already gone — so deleting on rejection would make a single click an
 * irreversible data loss, and rejection usually means "this is wrong, let me
 * look at why", which requires the code to still exist. Disk cost is a few
 * commits against a shared object store.
 *
 * purgeRejectedBranches is the explicit, separate way to reclaim them.
 */
export async function rejectTasks(
  missionId: string,
  repoRoot: string,
  taskIds: string[],
  options: { reason?: string; rejectedBy?: string } = {},
): Promise<RejectionResult> {
  const rejected: { taskId: string; branch: string; kept: boolean }[] = []
  for (const taskId of taskIds) {
    const branch = taskBranch(taskId)
    const res = await git(
      `git rev-parse --verify --quiet ${shq(branch)} >/dev/null && echo AP_KEPT || echo AP_GONE`,
      repoRoot,
      'reject',
    )
    const kept = res.output.includes('AP_KEPT')
    await recordEvent(
      missionId,
      'approval.rejected',
      { branch, kept, reason: options.reason ?? null, by: options.rejectedBy ?? 'henry' },
      taskId,
    )
    rejected.push({ taskId, branch, kept })
  }
  await releaseIfDecided(missionId)
  return { missionId, rejected }
}

/** Delete branches for tasks already recorded as rejected. Explicit, never automatic. */
export async function purgeRejectedBranches(missionId: string, repoRoot: string): Promise<string[]> {
  const events = await listEvents(missionId, 500)
  const decisions = decisionsFromEvents(events)
  const purged: string[] = []
  for (const [taskId, decision] of decisions) {
    if (decision !== 'rejected') continue
    const branch = taskBranch(taskId)
    const res = await git(`git branch -D ${shq(branch)} >/dev/null 2>&1 && echo AP_PURGED || true`, repoRoot, 'purge')
    if (res.output.includes('AP_PURGED')) {
      purged.push(branch)
      await recordEvent(missionId, 'approval.branch_purged', { branch }, taskId)
    }
  }
  return purged
}
