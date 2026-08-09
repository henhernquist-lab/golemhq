// Verification path for the Layer 3 validators (Batch 5).
//
// The whole point of a validator is to say no. A script that only proves the
// happy path proves nothing — a validator hardcoded to `return passed` would
// sail through it. So this runs two tasks against real tsc and real eslint:
// one whose output is genuinely correct, and one with a genuine type error,
// and it fails unless the second is caught with a reason that names the check.
//
// Fixtures are written into the repo on purpose. tsc has to resolve the
// project's tsconfig, its path aliases and its Next types, and a file in /tmp
// resolves none of that — it would be testing a different compiler setup than
// the one tasks are actually validated under. They are removed in `finally`.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-validator.mjs
//
// Env:
//   KEEP=1   leave the mission in the database for inspection

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

import './load-env.mjs'

const { validateTask } = await import('../src/lib/missions/validator.ts')
const { createMission, createTask, updateMissionStatus, updateTaskStatus, recordEvent, getTask, listEvents } =
  await import('../src/lib/missions/store.ts')
const { supabase } = await import('../src/lib/supabase.ts')

const FIXTURE_DIR = 'src/lib/missions/__validator_fixtures__'
const GOOD = `${FIXTURE_DIR}/good.ts`
const BAD = `${FIXTURE_DIR}/bad.ts`

const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)

// Clean, strict-mode-safe, and lint-clean.
const GOOD_SOURCE = `export function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString()
}
`

// A real type error, not a syntax error: syntax errors are caught by almost
// anything, whereas assigning a string to a number is exactly the class of bug
// a builder produces and a human reviewer misses.
const BAD_SOURCE = `export function addMinutes(iso: string, minutes: number): string {
  const total: number = 'not a number'
  return new Date(new Date(iso).getTime() + total * minutes).toISOString()
}
`

let missionId = null

const check = (report, name) => report.checks.find((c) => c.name === name)

async function taskFor(title, file) {
  const task = await createTask(missionId, { title, description: title })
  // Stand in for the adapter's own worktree event — the validator reads the
  // changed-file list from there rather than recomputing it, because by
  // validation time the tree has moved on.
  await recordEvent(missionId, 'task.worktree', { changed: true, unknown: false, fileCount: 1, files: [file] }, task.id)
  await updateTaskStatus(task.id, 'validating', { by: 'verify-validator' })
  return task
}

try {
  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(GOOD, GOOD_SOURCE)
  writeFileSync(BAD, BAD_SOURCE)

  const mission = await createMission(`verify/validator-${Date.now()}`, 'Prove the validators accept good code and reject bad code')
  missionId = mission.id
  await updateMissionStatus(missionId, 'running')
  ok(`mission ${missionId.slice(0, 8)} created`)

  // ── The pass case ────────────────────────────────────────────────
  console.log('\nGOOD OUTPUT — should reach complete')
  const goodTask = await taskFor('Add a correct helper', GOOD)
  const goodReport = await validateTask(goodTask.id)

  for (const c of goodReport.checks) {
    info(`${c.name.padEnd(9)} ${c.status.padEnd(7)} ${c.reason ?? ''}`)
  }
  if (!goodReport.passed) throw new Error(`correct code was rejected: ${JSON.stringify(goodReport.checks)}`)
  if (check(goodReport, 'typecheck').status !== 'passed') throw new Error('typecheck did not actually run on the good file')
  if (check(goodReport, 'lint').status !== 'passed') throw new Error('lint did not actually run on the good file')
  ok('typecheck and lint both RAN and passed — not skipped into a green light')

  const goodAfter = await getTask(goodTask.id)
  if (goodAfter.status !== 'complete') throw new Error(`expected complete, got "${goodAfter.status}"`)
  ok(`task advanced validating → complete in ${(goodReport.durationMs / 1000).toFixed(1)}s`)

  // ── The catch-bad-code case ──────────────────────────────────────
  console.log('\nBROKEN OUTPUT — should be caught and fail')
  const badTask = await taskFor('Add a broken helper', BAD)
  const badReport = await validateTask(badTask.id)

  for (const c of badReport.checks) {
    info(`${c.name.padEnd(9)} ${c.status.padEnd(7)} ${c.reason ?? ''}`)
  }
  if (badReport.passed) throw new Error('the validator PASSED code with a type error — it is not actually checking')
  const typeCheck = check(badReport, 'typecheck')
  if (typeCheck.status !== 'failed') throw new Error(`expected typecheck to fail, got "${typeCheck.status}"`)
  ok('the type error was caught by the typecheck check specifically')

  // "validation failed" is useless to whoever has to fix it.
  if (!/TS\d+|not assignable/.test(typeCheck.reason ?? '')) {
    throw new Error(`failure reason does not name the actual error: ${typeCheck.reason}`)
  }
  ok(`reason names the real compiler error: ${typeCheck.reason}`)

  const badAfter = await getTask(badTask.id)
  if (badAfter.status !== 'failed') throw new Error(`expected failed, got "${badAfter.status}"`)
  ok('task moved validating → failed')

  // ── The event log ────────────────────────────────────────────────
  console.log('\nEVENT LOG')
  const events = await listEvents(missionId)
  const validated = events.filter((e) => e.type === 'task.validated')
  if (validated.length !== 2) throw new Error(`expected 2 task.validated events, found ${validated.length}`)
  ok('both validations wrote a task.validated event')

  const failedEvent = validated.find((e) => e.payload.passed === false)
  const named = failedEvent?.payload.failedChecks
  if (!Array.isArray(named) || !named.some((f) => String(f).startsWith('typecheck:'))) {
    throw new Error(`the failure event does not say which check failed: ${JSON.stringify(failedEvent?.payload)}`)
  }
  ok(`the event says exactly what failed: ${named.join(' | ')}`)

  console.log('\n✓ the validator accepts correct code and rejects broken code, with a reason\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
} finally {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  if (missionId && process.env.KEEP !== '1') {
    await supabase.from('missions').delete().eq('id', missionId)
  } else if (missionId) {
    console.log(`    mission kept: ${missionId}`)
  }
  process.exit(process.exitCode ?? 0)
}
