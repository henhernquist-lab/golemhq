// Verification path for Batch 7 — the approval gate.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-approval.mjs
//
// Every merge below is a real merge in a real git repository, and every claim
// about what landed is read back out of git history rather than from the
// function's own return value.
//
// Task branches are built directly here rather than by running builders: this
// batch is about what happens AFTER a wave, and Batch 6.5 already proved real
// builders produce these branches. What matters is that the branch shapes are
// the ones a real wave produces — same name, same base commit, committed and
// with the worktree already gone.

import './load-env.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createMission, createTask, updateMissionStatus, listEvents } = await import(
  '../src/lib/missions/store.ts'
)
const { listPendingApprovals, approveAndMerge, rejectTasks, purgeRejectedBranches, taskBranch } =
  await import('../src/lib/missions/approval.ts')
const {
  allocateWorktree,
  preserveWorktree,
  releaseWorktree,
  reapOrphanedWorktrees,
  resolveBaseCommit,
  WORKTREE_ROOT,
} = await import('../src/lib/missions/worktrees.ts')
const { supabase } = await import('../src/lib/supabase.ts')

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  failures++
  console.log(`  ✗ ${m}`)
}
const info = (m) => console.log(`    ${m}`)
const check = (c, m) => (c ? ok(m) : bad(m))
const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const branches = (cwd) =>
  sh(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], cwd).split('\n').filter(Boolean)

const repoRoot = mkdtempSync(join(tmpdir(), 'golem-ap-verify-'))
const missionIds = []

/**
 * Build the branch a finished task leaves behind.
 *
 * Uses Batch 6.5's own preserveWorktree rather than hand-rolled git, so the
 * fixture cannot drift from what the scheduler actually produces. An earlier
 * version of this committed on the detached HEAD allocateWorktree creates and
 * left no branch at all — the fixture was wrong, and every downstream check
 * failed loudly rather than passing on nothing, which is the point.
 */
async function makeTaskBranch(taskId, base, write) {
  const wt = await allocateWorktree(taskId, repoRoot, base)
  write(wt.path)
  const kept = await preserveWorktree(taskId, repoRoot)
  if (!kept.commit) throw new Error(`fixture: preserveWorktree made no commit for ${taskId}`)
  // Mirrors reality: the worktree is gone by the time anyone approves.
  await releaseWorktree(taskId, repoRoot)
  return kept
}

try {
  // ── scratch repo ─────────────────────────────────────────────────
  sh(['init', '-q', '-b', 'main'], repoRoot)
  sh(['config', 'user.email', 'verify@golem.local'], repoRoot)
  sh(['config', 'user.name', 'Batch 7 Verify'], repoRoot)
  writeFileSync(join(repoRoot, '.gitignore'), '/node_modules\n')
  writeFileSync(join(repoRoot, 'shared.txt'), 'line1\nline2\nline3\n')
  writeFileSync(join(repoRoot, 'README.md'), '# scratch\n')
  sh(['add', '-A'], repoRoot)
  sh(['commit', '-qm', 'base'], repoRoot)
  console.log(`\nSCRATCH REPO ${repoRoot}`)

  // ══ PROOF 1: clean approval merges onto target ═══════════════════
  console.log('\nPROOF 1 — approved wave merges cleanly, visible in real git history')
  const m1 = await createMission(`verify/b7-clean-${Date.now()}`, 'Batch 7 clean merge.')
  missionIds.push(m1.id)
  await updateMissionStatus(m1.id, 'running')
  const t1 = await createTask(m1.id, { title: 'alpha', priority: 'high' })
  const t2 = await createTask(m1.id, { title: 'beta', priority: 'high' })

  const base1 = await resolveBaseCommit(repoRoot)
  await makeTaskBranch(t1.id, base1, (p) => writeFileSync(join(p, 'alpha.txt'), 'ALPHA\n'))
  await makeTaskBranch(t2.id, base1, (p) => writeFileSync(join(p, 'beta.txt'), 'BETA\n'))
  await updateMissionStatus(m1.id, 'awaiting_approval')

  const pending = await listPendingApprovals(m1.id, repoRoot, 'main')
  check(pending.tasks.length === 2, `${pending.tasks.length} tasks awaiting approval`)
  check(pending.tasks.every((t) => t.branchExists), 'both branches exist')
  for (const t of pending.tasks) {
    info(`${t.task.title}: ${t.branch} +${t.insertions}/-${t.deletions} files=${JSON.stringify(t.files)}`)
  }
  check(
    pending.tasks.every((t) => t.patch.includes('diff --git') && t.insertions > 0),
    'a real diff is available per task (not just "complete")',
  )

  const before1 = sh(['rev-parse', 'main'], repoRoot)
  const res1 = await approveAndMerge(m1.id, repoRoot, [t1.id, t2.id], { targetBranch: 'main' })
  const after1 = sh(['rev-parse', 'main'], repoRoot)
  check(res1.landed, 'approval reported as landed')
  check(after1 !== before1, `main moved ${before1.slice(0, 8)} → ${after1.slice(0, 8)}`)
  check(res1.targetAfter === after1, 'reported targetAfter matches real git')

  // Read the claim back out of git, not out of the return value.
  const log1 = sh(['log', '--oneline', '--merges', `${before1}..main`], repoRoot)
  info(`merge commits: ${log1.replace(/\n/g, ' | ')}`)
  check(log1.split('\n').filter(Boolean).length === 2, 'two merge commits in real history')
  const tree1 = sh(['ls-tree', '-r', '--name-only', 'main'], repoRoot).split('\n')
  check(tree1.includes('alpha.txt') && tree1.includes('beta.txt'), 'both tasks’ files are on main')
  const left1 = branches(repoRoot)
  check(
    !left1.includes(taskBranch(t1.id)) && !left1.includes(taskBranch(t2.id)),
    'merged branches deleted (commits still reachable from the merges)',
  )

  // ══ PROOF 2: two task branches conflicting WITH EACH OTHER ═══════
  console.log('\nPROOF 2 — two task branches conflicting with each other is blocking, not resolved')
  const m2 = await createMission(`verify/b7-conflict-${Date.now()}`, 'Batch 7 conflict.')
  missionIds.push(m2.id)
  await updateMissionStatus(m2.id, 'running')
  const c1 = await createTask(m2.id, { title: 'edit line2 one way', priority: 'high' })
  const c2 = await createTask(m2.id, { title: 'edit line2 another way', priority: 'high' })

  const base2 = await resolveBaseCommit(repoRoot)
  // Same file, same line, different content — different FILES would have been
  // a clean parallel run; this is the case leases cannot prevent.
  await makeTaskBranch(c1.id, base2, (p) =>
    writeFileSync(join(p, 'shared.txt'), 'line1\nFROM-TASK-ONE\nline3\n'),
  )
  await makeTaskBranch(c2.id, base2, (p) =>
    writeFileSync(join(p, 'shared.txt'), 'line1\nFROM-TASK-TWO\nline3\n'),
  )
  await updateMissionStatus(m2.id, 'awaiting_approval')

  const before2 = sh(['rev-parse', 'main'], repoRoot)
  const res2 = await approveAndMerge(m2.id, repoRoot, [c1.id, c2.id], { targetBranch: 'main' })
  const after2 = sh(['rev-parse', 'main'], repoRoot)

  check(!res2.landed, 'wave did NOT land')
  check(res2.conflicts.length > 0, `${res2.conflicts.length} conflict(s) surfaced`)
  const conflict = res2.conflicts[0]
  info(`conflict: ${conflict.detail}`)
  check(conflict.files.includes('shared.txt'), 'the conflicted file is named')
  check(
    conflict.conflictsWith.includes(taskBranch(c1.id)),
    'names the other TASK branch it collided with, not just the target',
  )
  check(after2 === before2, `main untouched at ${after2.slice(0, 8)} — atomic, no partial merge`)
  const tree2 = sh(['show', 'main:shared.txt'], repoRoot)
  check(
    !tree2.includes('FROM-TASK-ONE') && !tree2.includes('FROM-TASK-TWO'),
    'neither side silently won on main',
  )
  check(!tree2.includes('<<<<<<<'), 'no conflict markers were committed anywhere')
  const left2 = branches(repoRoot)
  check(
    left2.includes(taskBranch(c1.id)) && left2.includes(taskBranch(c2.id)),
    'both branches retained so the conflict can actually be fixed',
  )
  const ev2 = await listEvents(m2.id, 200)
  check(ev2.some((e) => e.type === 'approval.conflicted'), 'approval.conflicted recorded')
  check(ev2.some((e) => e.type === 'approval.merge_aborted'), 'approval.merge_aborted recorded')
  check(!ev2.some((e) => e.type === 'approval.merged'), 'nothing recorded as merged')

  // ══ PROOF 3: rejection does not merge; branches are kept ═════════
  console.log('\nPROOF 3 — rejection does not merge, and the branch is kept')
  const before3 = sh(['rev-parse', 'main'], repoRoot)
  const rej = await rejectTasks(m2.id, repoRoot, [c1.id, c2.id], { reason: 'conflicting approaches' })
  const after3 = sh(['rev-parse', 'main'], repoRoot)
  check(after3 === before3, 'main unchanged by rejection')
  check(rej.rejected.every((r) => r.kept), 'every rejected branch reported as kept')
  const left3 = branches(repoRoot)
  check(
    left3.includes(taskBranch(c1.id)) && left3.includes(taskBranch(c2.id)),
    'rejected branches still exist in git (retention policy: KEEP)',
  )
  const content = sh(['show', `${taskBranch(c1.id)}:shared.txt`], repoRoot)
  check(content.includes('FROM-TASK-ONE'), 'rejected work is still readable for review')
  const pending3 = await listPendingApprovals(m2.id, repoRoot, 'main')
  check(
    pending3.tasks.every((t) => t.decision === 'rejected'),
    'dashboard state reads back as rejected',
  )
  // The explicit reclaim path, which is never automatic.
  const purged = await purgeRejectedBranches(m2.id, repoRoot)
  check(purged.length === 2, `purgeRejectedBranches removed ${purged.length} on explicit request`)
  check(!branches(repoRoot).includes(taskBranch(c1.id)), 'branch gone only after an explicit purge')

  // ══ PROOF 4: orphan reaping must not touch a pending branch ══════
  console.log('\nPROOF 4 — Batch 6.5 orphan reaping does not delete a branch awaiting approval')
  const m3 = await createMission(`verify/b7-orphan-${Date.now()}`, 'Batch 7 orphan/branch safety.')
  missionIds.push(m3.id)
  await updateMissionStatus(m3.id, 'running')
  const o1 = await createTask(m3.id, { title: 'work then wait for review', priority: 'high' })

  const base3 = await resolveBaseCommit(repoRoot)
  const wt = await allocateWorktree(o1.id, repoRoot, base3)
  writeFileSync(join(wt.path, 'pending-review.txt'), 'NEEDS REVIEW\n')
  const keptO1 = await preserveWorktree(o1.id, repoRoot)
  if (!keptO1.commit) throw new Error('fixture: no commit for the orphan-timing task')
  // Branch exists; worktree deliberately left behind and aged past the cutoff,
  // which is the real timing gap: task done, human has not looked yet.
  execFileSync('touch', ['-d', '2 hours ago', `${WORKTREE_ROOT}/${o1.id}`])
  check(branches(repoRoot).includes(taskBranch(o1.id)), 'branch exists before reaping')

  const reaped = await reapOrphanedWorktrees(repoRoot, [], 60 * 60 * 1000)
  check(reaped.reaped.includes(o1.id), 'the stale worktree WAS reaped')
  check(
    branches(repoRoot).includes(taskBranch(o1.id)),
    'CONTROL: the branch survived reaping — work awaiting approval is not destroyed',
  )
  const stillThere = sh(['show', `${taskBranch(o1.id)}:pending-review.txt`], repoRoot)
  check(stillThere.includes('NEEDS REVIEW'), 'the reaped task’s content is still readable')

  // And it can still be approved afterwards — the gap is survivable end to end.
  await updateMissionStatus(m3.id, 'awaiting_approval')
  const before4 = sh(['rev-parse', 'main'], repoRoot)
  const res4 = await approveAndMerge(m3.id, repoRoot, [o1.id], { targetBranch: 'main' })
  check(res4.landed, 'a reaped-worktree task can still be approved and merged')
  check(
    sh(['ls-tree', '-r', '--name-only', 'main'], repoRoot).includes('pending-review.txt'),
    'its file landed on main',
  )
  check(sh(['rev-parse', 'main'], repoRoot) !== before4, 'main moved')

  // ══ PROOF 5: no stray merge worktrees left behind ════════════════
  console.log('\nHYGIENE')
  const wtList = sh(['worktree', 'list', '--porcelain'], repoRoot)
  check(!wtList.includes('/tmp/golem-merge'), 'no staging worktree left registered')
  check(!wtList.includes(WORKTREE_ROOT), 'no task worktrees left registered')
} catch (err) {
  failures++
  console.error('\nFATAL:', err?.message ?? err)
  if (err?.detail) console.error('detail:', JSON.stringify(err.detail).slice(0, 500))
} finally {
  if (!process.env.KEEP) {
    for (const id of missionIds) {
      await supabase.from('missions').delete().eq('id', id)
    }
    try {
      execFileSync('rm', ['-rf', repoRoot])
    } catch {}
    console.log('\ncleaned up')
  } else {
    console.log(`\nKEEP=1 — repo left at ${repoRoot}`)
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
