// Verification path for the headless builder adapter (Batch 2).
//
// Creates a mission and one task, assigns it to a real enabled layer-2 agent,
// runs it through runBuilderTask, and prints the captured stdout alongside the
// row that landed in task_results. The point is to prove one builder can be
// driven programmatically end to end — not to test the model's answer.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-adapter.mjs
//
// Env:
//   BUILDER=<agent name>   pin the agent instead of auto-picking (e.g. "Claude Code")
//   PROMPT=<text>          override the task description
//   TIMEOUT_MS=<n>         override the run cap (default 120000)
//   KEEP=1                 keep the mission for inspection
//
// Requires the mission spine migration applied, SUPABASE env vars, and the
// chosen CLI installed and authenticated on this machine.

import { execSync } from 'node:child_process'

import './load-env.mjs'

const { runBuilderTask } = await import('../src/lib/missions/adapter.ts')
const { createMission, createTask, updateTaskStatus, listAgents, listResults, listEvents, getTask } =
  await import('../src/lib/missions/store.ts')
const { supabase } = await import('../src/lib/supabase.ts')

const REPO = `verify/builder-adapter-${Date.now()}`
const PROMPT =
  process.env.PROMPT ??
  'Reply with exactly the word PONG and nothing else. Do not explain, do not use tools.'
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 120_000)

const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)

// cli_command may carry flags (e.g. "gemini --skip-trust"), so probe the
// executable only — `command -v` would treat the flags as more names to look up.
const onPath = (cli) => {
  try {
    execSync(`command -v ${cli.trim().split(/\s+/)[0]}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let missionId = null

try {
  // ── Pick a builder that actually exists here ─────────────────────
  console.log('\nBUILDER SELECTION')
  const builders = await listAgents(2, true)
  ok(`${builders.length} enabled layer-2 agents seeded`)
  for (const b of builders) {
    info(`${b.name.padEnd(12)} cli="${b.cliCommand}" ${onPath(b.cliCommand) ? 'on PATH' : '— not installed here'}`)
  }

  const agent = process.env.BUILDER
    ? builders.find((b) => b.name === process.env.BUILDER)
    : builders.find((b) => onPath(b.cliCommand))
  if (!agent) throw new Error('no enabled layer-2 agent with its CLI installed on this machine')
  if (!onPath(agent.cliCommand)) throw new Error(`${agent.name}'s CLI "${agent.cliCommand}" is not on PATH`)
  ok(`using ${agent.name} (${agent.cliCommand})`)

  // ── Mission + task ───────────────────────────────────────────────
  console.log('\nSETUP')
  const mission = await createMission(REPO, 'Prove a builder can be driven programmatically.')
  missionId = mission.id
  ok(`mission ${mission.id}`)

  const task = await createTask(mission.id, {
    title: 'Headless builder smoke test',
    description: PROMPT,
    priority: 'high',
  })
  await updateTaskStatus(task.id, 'assigned', { assignedAgent: agent.id })
  ok(`task ${task.id} assigned to ${agent.name}`)
  info(`prompt: ${PROMPT}`)

  // ── The run ──────────────────────────────────────────────────────
  console.log(`\nRUN (cap ${TIMEOUT_MS}ms)`)
  const run = await runBuilderTask(task.id, { timeoutMs: TIMEOUT_MS, cwd: process.cwd() })

  console.log(`\n  session   ${run.sessionId}`)
  console.log(`  exit code ${run.exitCode ?? 'none — no end marker'}`)
  console.log(`  duration  ${run.durationMs}ms`)
  console.log(`  timed out ${run.timedOut}`)

  console.log('\n  ── captured stdout ────────────────────────────────')
  for (const line of (run.output || '(empty)').split('\n')) console.log(`  │ ${line}`)
  console.log('  ───────────────────────────────────────────────────')

  // ── What actually landed in the DB ───────────────────────────────
  console.log('\nRECORDED RESULT')
  const [stored] = await listResults(task.id)
  if (!stored) throw new Error('recordResult wrote nothing')
  ok(`task_results row ${stored.id}`)
  info(`success=${stored.success} error=${stored.error ?? 'null'} duration=${stored.durationMs}ms bytes=${stored.output.length}`)
  if (stored.output !== run.output) throw new Error('stored output differs from the returned output')
  ok('stored output matches what the adapter returned')

  const after = await getTask(task.id)
  if (after.status !== 'running') {
    throw new Error(`adapter must not move the task past running — found "${after.status}"`)
  }
  ok(`task left at "${after.status}" — validating/failed is the caller's call, per Batch 1`)

  console.log('\nEVENT LOG')
  for (const e of await listEvents(mission.id)) {
    console.log(`  ${new Date(e.ts).toISOString().slice(11, 23)}  ${e.type.padEnd(22)} ${JSON.stringify(e.payload)}`)
  }

  console.log(
    run.exitCode === 0
      ? '\n✓ builder driven headlessly, exit 0, output captured and recorded\n'
      : `\n⚠ adapter worked (markers parsed, result recorded) but the CLI exited ${run.exitCode ?? '?'} — see stdout above\n`,
  )
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
} finally {
  if (missionId && process.env.KEEP !== '1') {
    await supabase.from('missions').delete().eq('id', missionId)
    console.log(`cleaned up mission ${missionId} (KEEP=1 to retain)`)
  }
  // node-pty keeps the loop alive even after killSession.
  process.exit(process.exitCode ?? 0)
}
