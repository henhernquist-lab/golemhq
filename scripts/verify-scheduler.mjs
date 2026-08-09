// Verification path for the Scheduler / Dispatcher (Batch 4).
//
// Plans a real mission, then schedules it: tasks picked up in dependency order,
// assigned to real agents, executed through the Batch 2 adapter, landing at the
// right final status.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-scheduler.mjs
//
// Env:
//   GOAL=<text>        override the goal
//   MAX_TASKS=<n>      cap tasks executed this run (default 2 — these are real
//                      CLI runs against a real checkout and they cost money)
//   NOVALIDATE=1       dispatch without running the Batch 5 validators, so a
//                      builder problem can be told apart from a validator one
//   DRY=1              assign agents but execute nothing
//   KEEP=1             keep the mission


import './load-env.mjs'

const { scheduleTasks } = await import('../src/lib/missions/scheduler.ts')
const { planMission } = await import('../src/lib/missions/planner.ts')
const { createMission, listTasks, listEvents, listResults } = await import('../src/lib/missions/store.ts')
const { supabase } = await import('../src/lib/supabase.ts')

const GOAL =
  process.env.GOAL ??
  'Add a CONTRIBUTING.md documenting how to run the dev server, typecheck, and the e2e tests.'
const MAX_TASKS = Number(process.env.MAX_TASKS ?? 2)
const DRY = process.env.DRY === '1'

const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)
const pad = (s, n) => String(s ?? '').padEnd(n)

let missionId = null

try {
  // ── Plan ─────────────────────────────────────────────────────────
  console.log(`\nPLAN  (checkout: ${process.env.REPO_CWD ?? process.cwd()})`)
  const mission = await createMission(`verify/scheduler-${Date.now()}`, GOAL)
  missionId = mission.id
  const REPO_CWD = process.env.REPO_CWD ?? process.cwd()
  const planned = await planMission(mission.id, { cwd: REPO_CWD })
  ok(`${planned.tasks.length} tasks planned (${planned.usage.totalTokens} tokens, $${planned.usage.costUsd.toFixed(4)})`)

  const before = await listTasks(mission.id)
  const idx = new Map(before.map((t, i) => [t.id, i + 1]))
  for (const t of before) {
    const deps = t.dependsOn.map((d) => `#${idx.get(d) ?? '?'}`)
    console.log(`  ${idx.get(t.id)}. [${pad(t.priority, 6)}] ${pad(t.status, 9)} agent=${t.assignedAgent ?? 'null'}  ${t.title}`)
    if (deps.length) info(`   depends on ${deps.join(', ')}`)
  }
  if (before.some((t) => t.assignedAgent)) throw new Error('planner assigned an agent — it must not')
  ok('every task starts pending and unassigned')

  // ── Schedule ─────────────────────────────────────────────────────
  console.log(`\nSCHEDULE (sequential, max ${MAX_TASKS}${DRY ? ', DRY RUN' : ''})`)
  const result = await scheduleTasks(mission.id, {
    cwd: REPO_CWD,
    maxTasks: MAX_TASKS,
    dryRun: DRY,
    validate: process.env.NOVALIDATE !== '1',
    // Left at the default ['complete']: since Batch 5 the validators actually
    // promote tasks, so a dependent now waits for code that type-checks rather
    // than for a builder's say-so.
  })

  console.log(`\n  dispatchable agents (${result.candidates.length}):`)
  for (const a of result.candidates) {
    info(`${pad(a.name, 14)} ${pad(a.cliCommand, 22)} reliability=${a.reliabilityPct ?? '—'}%`)
  }
  if (result.warning) console.log(`\n  ⚠ ${result.warning}`)

  console.log('\n  DISPATCHED')
  for (const s of result.scheduled) {
    console.log(`  → ${s.task.title}`)
    info(`agent: ${s.agent.name} (${s.agent.cliCommand})`)
    info(`why:   ${s.rationale}`)
    info(
      s.executed
        ? `run:   ${s.success ? 'SUCCESS' : 'FAILED'} exit=${s.exitCode ?? '—'} ${s.durationMs ?? '?'}ms → ${s.finalStatus}`
        : `run:   skipped (dry) → ${s.finalStatus}`,
    )
    if (s.validation) {
      const summary = s.validation.checks
        .map((c) => `${c.name}=${c.status}`)
        .join(' ')
      info(`valid: ${s.validation.passed ? 'PASSED' : 'FAILED'}  ${summary}`)
      for (const c of s.validation.checks.filter((c) => c.status === 'failed')) {
        info(`  ✗ ${c.name}: ${c.reason}`)
      }
    } else if (s.executed && process.env.NOVALIDATE !== '1' && s.success) {
      info('valid: NOT RUN')
    }
    if (s.error) info(`error: ${s.error.slice(0, 160)}`)
  }
  info(`deferred=${result.deferred}  blocked=${result.blocked}`)

  // ── Assertions ───────────────────────────────────────────────────
  console.log('\nCHECKS')
  if (result.scheduled.length === 0) throw new Error('scheduler dispatched nothing')
  ok(`${result.scheduled.length} task(s) dispatched`)

  if (result.candidates.some((a) => a.name === 'Codex CLI')) {
    throw new Error('Codex CLI is disabled and must not be a candidate')
  }
  ok('Codex CLI excluded from candidates (disabled)')

  const after = await listTasks(mission.id)
  const afterById = new Map(after.map((t) => [t.id, t]))

  for (const s of result.scheduled) {
    const t = afterById.get(s.task.id)
    if (!t.assignedAgent) throw new Error(`"${t.title}" has no assigned_agent after scheduling`)
    // Since Batch 5 a successful build no longer ends at 'validating' — the
    // validators settle it, so 'complete' is the success state and reaching it
    // is the whole point of this run.
    const expected = DRY
      ? 'assigned'
      : process.env.NOVALIDATE === '1'
        ? s.success ? 'validating' : 'failed'
        : s.success ? 'complete' : 'failed'
    if (t.status !== expected) throw new Error(`"${t.title}" is "${t.status}", expected "${expected}"`)
  }
  ok(`every dispatched task assigned and landed at its expected status`)

  // Dependency order: a task must not have run before something it depends on.
  const ranAt = new Map(result.scheduled.map((s, i) => [s.task.id, i]))
  for (const s of result.scheduled) {
    for (const dep of s.task.dependsOn) {
      const depOrder = ranAt.get(dep)
      if (depOrder !== undefined && depOrder > ranAt.get(s.task.id)) {
        throw new Error(`"${s.task.title}" ran before its dependency`)
      }
      const depTask = afterById.get(dep)
      if (depTask && depTask.status === 'pending') {
        throw new Error(`"${s.task.title}" ran while its dependency was still pending`)
      }
    }
  }
  ok('no task ran before a task it depends on')

  if (!DRY) {
    for (const s of result.scheduled) {
      const results = await listResults(s.task.id)
      if (results.length === 0) throw new Error(`no task_result recorded for "${s.task.title}"`)
    }
    ok('every executed task has a recorded result')
  }

  console.log('\nFINAL STATE')
  for (const t of after) {
    const agent = result.candidates.find((a) => a.id === t.assignedAgent)
    console.log(`  ${pad(t.status, 11)} ${pad(agent?.name ?? '—', 14)} ${t.title}`)
  }

  console.log('\nSCHEDULER EVENTS')
  const events = await listEvents(mission.id)
  for (const e of events.filter((e) => e.type.startsWith('scheduler.'))) {
    console.log(`  ${e.type.padEnd(24)} ${JSON.stringify(e.payload)}`)
  }

  if (!DRY && process.env.NOVALIDATE !== '1') {
    const validated = events.filter((e) => e.type === 'task.validated')
    const succeeded = result.scheduled.filter((s) => s.executed && s.validation)
    if (validated.length < succeeded.length) {
      throw new Error(`${succeeded.length} task(s) validated but only ${validated.length} task.validated events`)
    }
    // The claim this whole batch exists to make good on.
    const reachedComplete = after.filter((t) => t.status === 'complete')
    if (succeeded.some((s) => s.validation.passed) && reachedComplete.length === 0) {
      throw new Error('a task passed validation but nothing reached "complete"')
    }
    ok(`${reachedComplete.length} task(s) reached true 'complete' through the validators`)
  }

  console.log('\n✓ planner graph → scheduler assigned and executed in order → validated → correct statuses\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
} finally {
  if (missionId && process.env.KEEP !== '1') {
    await supabase.from('missions').delete().eq('id', missionId)
    console.log(`cleaned up mission ${missionId} (KEEP=1 to retain)`)
  }
  process.exit(process.exitCode ?? 0)
}
