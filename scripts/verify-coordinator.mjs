// Verification path for Batch 6 — Coordinator + file leasing.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-coordinator.mjs
//
// Every assertion below is against real rows in real Supabase with real
// timestamps. Nothing is mocked at the store layer — the point is to prove the
// lease table actually arbitrates, not that the functions return what they say.
//
// Cleans up after itself unless KEEP=1.

import './load-env.mjs'

const {
  createMission,
  createTask,
  updateMissionStatus,
  updateTaskStatus,
  listTasks,
  listEvents,
  listActiveLeases,
  acquireLeaseRow,
  releaseLeasesForTask,
  recordEvent,
} = await import('../src/lib/missions/store.ts')

const { coordinateWave } = await import('../src/lib/missions/coordinator.ts')
const { acquireLeases, globsOverlap, normaliseGlob, requestsFor, reapOrphanedLeases } =
  await import('../src/lib/missions/leases.ts')
const { scheduleTasks } = await import('../src/lib/missions/scheduler.ts')
const { supabase } = await import('../src/lib/supabase.ts')

const REPO = `verify/batch6-${Date.now()}`
let missionId = null
let failures = 0

const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  failures++
  console.log(`  ✗ ${m}`)
}
const info = (m) => console.log(`    ${m}`)
const check = (cond, m) => (cond ? ok(m) : bad(m))

try {
  // ── 0. Pure overlap logic ────────────────────────────────────────
  console.log('\nGLOB OVERLAP (pure, no DB)')
  const cases = [
    ['src/a.ts', 'src/a.ts', true],
    ['src/a.ts', 'src/b.ts', false],
    ['src/**', 'src/a.ts', true],
    ['src/lib/**', 'src/app/**', false],
    ['src/lib/**', 'src/lib/missions/x.ts', true],
    ['**', 'anything/at/all.ts', true],
    ['src/lib', 'src/lib/missions/x.ts', true], // bare dir widens
    ['package.json', 'src/a.ts', false],
  ]
  for (const [a, b, expected] of cases) {
    check(globsOverlap(a, b) === expected, `${a} vs ${b} → ${expected}`)
  }
  check(normaliseGlob('src/lib') === 'src/lib/**', 'bare directory normalises to a subtree')
  check(requestsFor(null)[0].leaseType === 'exclusive', 'undeclared task → whole-repo exclusive')
  check(requestsFor([]).length === 0, 'explicitly-empty declaration leases nothing')

  // ── 1. Mission + tasks ───────────────────────────────────────────
  console.log('\nSETUP')
  const mission = await createMission(REPO, 'Batch 6 coordinator verification.')
  missionId = mission.id
  await updateMissionStatus(missionId, 'running')
  ok(`mission ${missionId} running in ${REPO}`)

  const taskA = await createTask(missionId, { title: 'Task A — writes src/a', priority: 'high' })
  const taskB = await createTask(missionId, { title: 'Task B — writes src/b', priority: 'high' })
  const taskC = await createTask(missionId, { title: 'Task C — also writes src/a', priority: 'medium' })
  ok(`three tasks created`)

  // tasks.expected_paths only exists once the Batch 6 migration is applied, so
  // the declarations are passed in directly. This is the same data the Planner
  // would have written to the column.
  const declarations = new Map([
    [taskA.id, ['src/a/**']],
    [taskB.id, ['src/b/**']],
    [taskC.id, ['src/a/**']],
  ])
  const migrationApplied = (await listTasks(missionId))[0].expectedPaths !== null
  info(`tasks.expected_paths present: ${migrationApplied} (declarations passed explicitly either way)`)

  // ── 2. PROOF: write conflict is serialised, not dropped ──────────
  console.log('\nPROOF 2 — write conflict serialised, not deadlocked or dropped')
  const wave1 = await coordinateWave(missionId, REPO, [taskA, taskB, taskC], {
    maxConcurrent: 3,
    declarationOverride: declarations,
  })
  const admitted1 = wave1.admitted.map((a) => a.task.id)
  check(admitted1.includes(taskA.id), 'A admitted')
  check(admitted1.includes(taskB.id), 'B admitted (disjoint paths — runs alongside A)')
  check(!admitted1.includes(taskC.id), 'C NOT admitted (overlaps A)')
  const heldC = wave1.held.find((h) => h.task.id === taskC.id)
  check(heldC?.reason === 'conflict', `C held with reason "${heldC?.reason}" (not dropped)`)
  check(heldC?.blockedBy.includes(taskA.id) === true, 'C reports A as the blocker')
  info(`conflict detail: ${heldC?.detail}`)
  check(wave1.starved === false, 'wave not starved')

  const activeNow = await listActiveLeases(REPO)
  check(activeNow.length === 2, `exactly 2 leases held (A + B), saw ${activeNow.length}`)

  // C must become admissible the moment A lets go — this is the no-deadlock claim.
  await releaseLeasesForTask(taskA.id)
  const wave2 = await coordinateWave(missionId, REPO, [taskC], {
    maxConcurrent: 3,
    declarationOverride: declarations,
  })
  check(
    wave2.admitted.some((a) => a.task.id === taskC.id),
    'C admitted once A released — queued, then ran',
  )
  await releaseLeasesForTask(taskB.id)
  await releaseLeasesForTask(taskC.id)

  // ── 3. PROOF: two tasks genuinely overlap in time ────────────────
  console.log('\nPROOF 1 — two admitted tasks run concurrently (overlapping event timestamps)')
  const wave3 = await coordinateWave(missionId, REPO, [taskA, taskB], {
    maxConcurrent: 2,
    declarationOverride: declarations,
  })
  check(wave3.admitted.length === 2, `coordinator admitted ${wave3.admitted.length} tasks into one wave`)

  // Each worker stands in for runOne's builder call: it records a start event,
  // holds its lease for a beat, and records an end event. The timestamps are
  // written by Postgres (mission_events.ts defaults to now()), not by this
  // script, so overlap cannot be faked by clock arithmetic here.
  const worker = async (task) => {
    await recordEvent(missionId, 'verify.work_started', { task: task.title }, task.id)
    await new Promise((r) => setTimeout(r, 1500))
    await recordEvent(missionId, 'verify.work_finished', { task: task.title }, task.id)
    await releaseLeasesForTask(task.id)
  }
  await Promise.all(wave3.admitted.map((a) => worker(a.task)))

  const events = await listEvents(missionId, 500)
  const span = (taskId) => {
    const s = events.find((e) => e.taskId === taskId && e.type === 'verify.work_started')
    const f = events.find((e) => e.taskId === taskId && e.type === 'verify.work_finished')
    return s && f ? { start: Date.parse(s.ts), end: Date.parse(f.ts) } : null
  }
  const sa = span(taskA.id)
  const sb = span(taskB.id)
  if (!sa || !sb) {
    bad('could not read both work spans back from mission_events')
  } else {
    const overlapMs = Math.min(sa.end, sb.end) - Math.max(sa.start, sb.start)
    info(`A ${new Date(sa.start).toISOString()} → ${new Date(sa.end).toISOString()}`)
    info(`B ${new Date(sb.start).toISOString()} → ${new Date(sb.end).toISOString()}`)
    check(overlapMs > 0, `spans overlap by ${overlapMs}ms in Postgres-stamped mission_events`)
  }

  // ── 4. PROOF: orphaned lease is reaped ───────────────────────────
  console.log('\nPROOF 3 — a lease whose holder died is reaped, not stuck forever')
  // A task that crashed mid-run: lease row written, never released, already
  // past its expiry with no heartbeat since.
  const orphan = await acquireLeaseRow({
    taskId: taskC.id,
    missionId,
    repo: REPO,
    pathGlob: 'src/a/**',
    leaseType: 'write',
    ownerAgent: null,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })
  info(`orphan lease ${orphan.id} expired at ${orphan.expiresAt}`)

  const blockedWave = await coordinateWave(missionId, REPO, [taskA], {
    maxConcurrent: 1,
    declarationOverride: declarations,
  })
  // The reap runs first inside coordinateWave, so A should get in — and the
  // plan should say the orphan was taken, not merely that A ran.
  check(blockedWave.reaped.some((l) => l.id === orphan.id), 'orphan lease reaped by the coordinator')
  check(
    blockedWave.admitted.some((a) => a.task.id === taskA.id),
    'A admitted after the reap (mission unwedged)',
  )
  const stillActive = (await listActiveLeases(REPO)).map((l) => l.id)
  check(!stillActive.includes(orphan.id), 'orphan no longer active')
  await releaseLeasesForTask(taskA.id)

  // A lease that is NOT expired must survive the reaper — otherwise "reaping"
  // would just be "releasing everything", which proves nothing.
  const live = await acquireLeaseRow({
    taskId: taskB.id,
    missionId,
    repo: REPO,
    pathGlob: 'src/b/**',
    leaseType: 'write',
    ownerAgent: null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  })
  const reapedAgain = await reapOrphanedLeases(REPO)
  check(!reapedAgain.some((l) => l.id === live.id), 'CONTROL: a live lease is not reaped')
  await releaseLeasesForTask(taskB.id)

  // ── 5. Unsafe concurrency is refused, not silently downgraded ────
  console.log('\nWORKTREE SAFETY GATE')
  let refused = null
  try {
    await scheduleTasks(missionId, { maxConcurrent: 2, dryRun: true })
  } catch (err) {
    refused = err
  }
  check(refused !== null, 'scheduleTasks refuses maxConcurrent>1 without isolated checkouts')
  if (refused) info(refused.message.slice(0, 160))

  let allowed = null
  try {
    const res = await scheduleTasks(missionId, {
      maxConcurrent: 2,
      allowSharedCheckout: true,
      dryRun: true,
      declarationOverride: declarations,
    })
    allowed = res
  } catch (err) {
    bad(`explicit opt-in still threw: ${err.message}`)
  }
  if (allowed) {
    check(allowed.scheduled.length === 2, `dry run assigned a wave of ${allowed.scheduled.length}`)
    const leftover = await listActiveLeases(REPO)
    check(leftover.length === 0, `dry run left ${leftover.length} leases held (expected 0)`)
  }

  // ── 6. Event trail ───────────────────────────────────────────────
  console.log('\nEVENT TRAIL')
  const trail = await listEvents(missionId, 500)
  for (const type of [
    'coordinator.wave',
    'coordinator.task_queued',
    'coordinator.leases_acquired',
    'coordinator.leases_reaped',
  ]) {
    check(trail.some((e) => e.type === type), `${type} recorded`)
  }
} catch (err) {
  failures++
  console.error('\nFATAL:', err?.message ?? err)
  if (err?.detail) console.error('detail:', JSON.stringify(err.detail).slice(0, 400))
} finally {
  if (missionId && !process.env.KEEP) {
    await supabase.from('leases').delete().eq('mission_id', missionId).then(() => {})
    const tasks = await listTasks(missionId).catch(() => [])
    for (const t of tasks) await supabase.from('leases').delete().eq('task_id', t.id)
    await supabase.from('missions').delete().eq('id', missionId)
    console.log('\ncleaned up')
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
