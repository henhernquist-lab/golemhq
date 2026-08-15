// Verification path for Batch 6.5 — per-task git worktrees.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-worktrees.mjs
//
// The headline claim is the one Batch 6 could not make: two REAL builder CLI
// processes running at the same time, each seeing and being credited with only
// its own files. So this drives the real scheduler against a real throwaway
// git repo with real agents — no sleep stubs anywhere.
//
// KEEP=1 leaves the scratch repo and mission behind.

import './load-env.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  createMission,
  createTask,
  updateMissionStatus,
  listTasks,
  listEvents,
  listActiveLeases,
} = await import('../src/lib/missions/store.ts')
const { scheduleTasks } = await import('../src/lib/missions/scheduler.ts')
const {
  allocateWorktree,
  releaseWorktree,
  reapOrphanedWorktrees,
  resolveBaseCommit,
  worktreeDiskUsage,
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
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()
const df = (path) => {
  const line = execFileSync('df', ['-k', path], { encoding: 'utf8' }).trim().split('\n').pop()
  const cols = line.split(/\s+/)
  return { usedKb: Number(cols[2]), availKb: Number(cols[3]), pct: cols[4] }
}

// ── A throwaway repo, so nothing here can touch the real checkout ──
const repoRoot = mkdtempSync(join(tmpdir(), 'golem-wt-verify-'))
sh('git', ['init', '-q', '-b', 'main'], repoRoot)
sh('git', ['config', 'user.email', 'verify@golem.local'], repoRoot)
sh('git', ['config', 'user.name', 'Batch 6.5 Verify'], repoRoot)
writeFileSync(join(repoRoot, 'README.md'), '# scratch\n')
// Representative of a real repo: every project that runs npx ignores this, and
// without it the node_modules symlink the allocator adds shows up as untracked
// and pollutes each task's file delta.
writeFileSync(join(repoRoot, '.gitignore'), '/node_modules\n')
sh('git', ['add', '-A'], repoRoot)
sh('git', ['commit', '-qm', 'base'], repoRoot)

let missionId = null
const REPO = `verify/batch65-${Date.now()}`

try {
  console.log(`\nSCRATCH REPO ${repoRoot}`)
  const diskBefore = df('/tmp')
  const rootBefore = df('/')
  info(`/tmp before: ${diskBefore.pct} used, ${(diskBefore.availKb / 1048576).toFixed(1)}G avail`)
  info(`/     before: ${rootBefore.pct} used, ${(rootBefore.availKb / 1048576).toFixed(1)}G avail`)

  // ── PROOF 3: concurrent worktree creation is race-safe ───────────
  console.log('\nPROOF 3 — concurrent worktree creation does not collide or corrupt')
  const base = await resolveBaseCommit(repoRoot)
  info(`base commit ${base.slice(0, 8)}`)
  const ids = Array.from({ length: 4 }, (_, i) => `race-${i}-${Date.now()}`)
  const settled = await Promise.allSettled(ids.map((id) => allocateWorktree(id, repoRoot, base)))
  const made = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value)
  check(made.length === ids.length, `${made.length}/${ids.length} concurrent worktrees created`)
  for (const s of settled) if (s.status === 'rejected') info(`rejected: ${s.reason?.message?.slice(0, 140)}`)
  check(new Set(made.map((w) => w.path)).size === made.length, 'every path is distinct')
  check(made.every((w) => w.baseCommit === base), 'all cut from the same base commit')
  // git's own view has to agree — a worktree that "succeeded" but is not
  // registered would be invisible to prune and leak.
  const registered = sh('git', ['worktree', 'list', '--porcelain'], repoRoot)
  check(
    made.every((w) => registered.includes(w.path)),
    'git worktree list registers all of them',
  )
  check(
    made.every((w) => existsSync(join(w.path, 'README.md'))),
    'each worktree has the repo content checked out',
  )
  for (const w of made) await releaseWorktree(w.taskId, repoRoot)

  // ── PROOF 2: orphan reaped, live one kept ────────────────────────
  console.log('\nPROOF 2 — an orphaned worktree is reaped; a live one is not')
  const orphanId = `orphan-${Date.now()}`
  const liveId = `live-${Date.now()}`
  await allocateWorktree(orphanId, repoRoot, base)
  await allocateWorktree(liveId, repoRoot, base)
  // Age the orphan past the cutoff. The reaper reads mtime off the directory
  // because the process that made it is normally gone by then.
  sh('touch', ['-d', '2 hours ago', `${WORKTREE_ROOT}/${orphanId}`])
  const reap = await reapOrphanedWorktrees(repoRoot, [liveId], 60 * 60 * 1000)
  check(reap.reaped.includes(orphanId), `orphan ${orphanId} reaped`)
  check(!reap.reaped.includes(liveId), 'CONTROL: the live worktree was NOT reaped')
  check(reap.kept.includes(liveId), 'live worktree explicitly kept')
  check(!existsSync(`${WORKTREE_ROOT}/${orphanId}`), 'orphan directory gone from disk')
  check(existsSync(`${WORKTREE_ROOT}/${liveId}`), 'live directory still on disk')
  const afterReapList = sh('git', ['worktree', 'list', '--porcelain'], repoRoot)
  check(!afterReapList.includes(orphanId), 'orphan deregistered from git')
  await releaseWorktree(liveId, repoRoot)

  // ── PROOF 1: two REAL builders, concurrent, correctly attributed ──
  console.log('\nPROOF 1 — two real builder CLIs run concurrently with correct attribution')
  const mission = await createMission(REPO, 'Batch 6.5 worktree isolation verification.')
  missionId = mission.id
  await updateMissionStatus(missionId, 'running')

  const taskA = await createTask(missionId, {
    title: 'Create alpha.txt',
    description:
      'Create a file named alpha.txt in the repository root containing exactly the single line ALPHA. ' +
      'Do not create, modify or delete any other file. Do not commit.',
    priority: 'high',
  })
  const taskB = await createTask(missionId, {
    title: 'Create beta.txt',
    description:
      'Create a file named beta.txt in the repository root containing exactly the single line BETA. ' +
      'Do not create, modify or delete any other file. Do not commit.',
    priority: 'high',
  })
  ok(`two tasks created in ${REPO}`)

  const declarations = new Map([
    [taskA.id, ['alpha.txt']],
    [taskB.id, ['beta.txt']],
  ])

  const started = Date.now()
  const result = await scheduleTasks(missionId, {
    cwd: repoRoot,
    maxConcurrent: 2,
    declarationOverride: declarations,
    // Validators would need this scratch repo to be a TypeScript project; it
    // is not, and this batch is about isolation, not validation.
    validate: false,
    timeoutMs: 240_000,
  })
  info(`scheduler returned in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  info(`peakConcurrency=${result.peakConcurrency} dispatched=${result.scheduled.length}`)
  check(result.peakConcurrency === 2, `peak concurrency was ${result.peakConcurrency}`)

  const events = await listEvents(missionId, 500)
  const dispatch = events.find((e) => e.type === 'scheduler.wave_dispatched')
  check(dispatch?.payload?.isolation === 'worktree', `isolation reported as "${dispatch?.payload?.isolation}"`)
  const cwds = (dispatch?.payload?.tasks ?? []).map((t) => t.cwd)
  check(new Set(cwds).size === cwds.length && cwds.every(Boolean), `each task got its own cwd: ${cwds.join(' , ')}`)

  // Overlap, from Postgres-stamped rows — the claim Batch 6 could not make.
  const span = (taskId) => {
    const rows = events.filter((e) => e.taskId === taskId)
    // The builder's own span: 'running' is written immediately before the CLI
    // is invoked, and the next status change immediately after it returns.
    const start = rows.find((e) => e.type === 'task.status_changed' && e.payload?.to === 'running')
    const end = rows.find(
      (e) => e.type === 'task.status_changed' && (e.payload?.to === 'validating' || e.payload?.to === 'failed'),
    )
    return start && end ? { start: Date.parse(start.ts), end: Date.parse(end.ts) } : null
  }
  const sa = span(taskA.id)
  const sb = span(taskB.id)
  if (!sa || !sb) {
    bad('could not read both task spans from mission_events')
    info(`event types seen: ${[...new Set(events.map((e) => e.type))].join(', ')}`)
  } else {
    info(`A ${new Date(sa.start).toISOString()} → ${new Date(sa.end).toISOString()}`)
    info(`B ${new Date(sb.start).toISOString()} → ${new Date(sb.end).toISOString()}`)
    const overlapMs = Math.min(sa.end, sb.end) - Math.max(sa.start, sb.start)
    check(overlapMs > 0, `real builder runs overlapped by ${overlapMs}ms (Postgres timestamps)`)
  }

  // Attribution: each task's recorded delta must contain ONLY its own file.
  for (const [task, mine, theirs] of [
    [taskA, 'alpha.txt', 'beta.txt'],
    [taskB, 'beta.txt', 'alpha.txt'],
  ]) {
    const s = result.scheduled.find((x) => x.task.id === task.id)
    const { data } = await supabase
      .from('task_results')
      .select('output, success')
      .eq('task_id', task.id)
      .order('created_at', { ascending: false })
      .limit(1)
    const delta = events.filter((e) => e.taskId === task.id).map((e) => e.payload?.files).filter(Boolean).flat()
    info(`${task.title}: success=${s?.success} files=${JSON.stringify(delta)}`)
    check(delta.length > 0, `${task.title} recorded a file delta at all`)
    check(delta.includes(mine), `${task.title} credited with ${mine}`)
    check(!delta.includes(theirs), `${task.title} NOT credited with ${theirs} (no cross-contamination)`)
    void data
  }

  // PROOF 5: the work survived the worktree it was made in.
  console.log('\nPROOF 5 — output is preserved on a per-task branch, not destroyed with the worktree')
  for (const [task, file] of [[taskA, 'alpha.txt'], [taskB, 'beta.txt']]) {
    const branch = `golem/task/${task.id}`
    let listed = ''
    try {
      listed = sh('git', ['ls-tree', '-r', '--name-only', branch], repoRoot)
    } catch {
      listed = ''
    }
    check(listed.includes(file), `${branch} holds ${file}`)
    const other = file === 'alpha.txt' ? 'beta.txt' : 'alpha.txt'
    check(!listed.includes(other), `${branch} does NOT hold ${other}`)
  }
  const preserved = events.filter((e) => e.type === 'scheduler.work_preserved')
  check(preserved.length === 2, `${preserved.length} work_preserved events recorded`)
  check(events.filter((e) => e.type === 'scheduler.work_lost').length === 0, 'no work_lost events')

  // Leases and worktrees both let go.
  const leftLeases = await listActiveLeases(REPO)
  check(leftLeases.length === 0, `${leftLeases.length} leases still held (expected 0)`)
  const leftWorktrees = existsSync(WORKTREE_ROOT)
    ? readdirSync(WORKTREE_ROOT).filter((d) => d === taskA.id || d === taskB.id)
    : []
  check(leftWorktrees.length === 0, `${leftWorktrees.length} task worktrees left on disk (expected 0)`)

  // ── PROOF 4: disk ────────────────────────────────────────────────
  console.log('\nPROOF 4 — disk')
  const diskAfter = df('/tmp')
  const rootAfter = df('/')
  const usage = await worktreeDiskUsage(repoRoot)
  info(`/tmp after: ${diskAfter.pct} used, ${(diskAfter.availKb / 1048576).toFixed(1)}G avail ` +
       `(delta ${((diskAfter.usedKb - diskBefore.usedKb) / 1024).toFixed(1)}MB)`)
  info(`/     after: ${rootAfter.pct} used, ${(rootAfter.availKb / 1048576).toFixed(1)}G avail ` +
       `(delta ${((rootAfter.usedKb - rootBefore.usedKb) / 1024).toFixed(1)}MB)`)
  info(`worktree root holds ${(usage / 1048576).toFixed(1)}MB`)
  check(rootAfter.availKb >= rootBefore.availKb - 51200, 'the 32G / overlay did not lose more than 50MB')
  check(usage < 200 * 1048576, `worktree root under 200MB after the run (${(usage / 1048576).toFixed(1)}MB)`)
} catch (err) {
  failures++
  console.error('\nFATAL:', err?.message ?? err)
  if (err?.detail) console.error('detail:', JSON.stringify(err.detail).slice(0, 500))
} finally {
  if (!process.env.KEEP) {
    if (missionId) {
      const tasks = await listTasks(missionId).catch(() => [])
      for (const t of tasks) await supabase.from('leases').delete().eq('task_id', t.id)
      await supabase.from('missions').delete().eq('id', missionId)
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
