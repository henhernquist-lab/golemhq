// Prove that an agent's standing instructions actually reach the CLI and
// change what it produces.
//
// This is the whole point of the feature. A system-prompt field that is stored
// and never read would look like configuration while changing nothing — the
// exact "for show" failure this is meant to avoid. Storage is easy to check and
// worthless on its own; the claim worth testing is that the builder BEHAVED
// differently, so this runs the same task twice against the same agent and
// diffs the artifacts:
//
//   control      no instructions  -> file must NOT carry the marker
//   instructed   instructions set -> file MUST carry the marker
//
// One run proving the marker appears would not be evidence: the agent might
// add a header like that anyway. The control run is what makes it evidence.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-agent-instructions.mjs
//
// Env:
//   BUILDER=<agent name>   pin the agent (default: highest-reliability builder)
//   KEEP=1                 keep the mission and the generated files

import { existsSync, readFileSync, rmSync } from 'node:fs'

import './load-env.mjs'

const { runBuilderTask } = await import('../src/lib/missions/adapter.ts')
const { createMission, createTask, updateMissionStatus, updateTaskStatus, listAgents, listEvents } =
  await import('../src/lib/missions/store.ts')
const { supabase } = await import('../src/lib/supabase.ts')

const MARKER = 'AUTHORED-BY-GOLEM-WORKER'
const INSTRUCTIONS = `Every file you create must begin with this exact comment line, before anything else:
// ${MARKER}
This applies without exception, whatever the task says.`

const CONTROL_FILE = 'src/lib/missions/__instr_control__.ts'
const INSTRUCTED_FILE = 'src/lib/missions/__instr_instructed__.ts'
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 240_000)

const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)

const describe = (file) =>
  `Create the file ${file} exporting one function \`export function answer(): number { return 42 }\`. ` +
  `Do not create or modify any other file. Do not commit.`

let missionId = null
const created = [CONTROL_FILE, INSTRUCTED_FILE]

async function runOnce(title, file, instructions) {
  const task = await createTask(missionId, { title, description: describe(file) })
  await updateTaskStatus(task.id, 'assigned', { assignedAgent: agent.id, by: 'verify-agent-instructions' })
  const run = await runBuilderTask(task.id, {
    cwd: process.cwd(),
    timeoutMs: TIMEOUT_MS,
    instructions,
  })
  return { task, run }
}

let agent = null

try {
  const builders = await listAgents(2, true)
  const wanted = process.env.BUILDER
  agent = wanted
    ? builders.find((a) => a.name === wanted)
    : builders.sort((a, b) => (b.reliabilityPct ?? 0) - (a.reliabilityPct ?? 0))[0]
  if (!agent) throw new Error(wanted ? `no enabled builder named "${wanted}"` : 'no enabled layer-2 builders')

  const mission = await createMission(
    `verify/instructions-${Date.now()}`,
    'Prove standing instructions reach the builder CLI and change its output',
  )
  missionId = mission.id
  await updateMissionStatus(missionId, 'running')
  ok(`agent: ${agent.name} (${agent.cliCommand})`)

  for (const f of created) rmSync(f, { force: true })

  // ── Control: identical task, no instructions ─────────────────────
  console.log('\nCONTROL — same task, no standing instructions')
  const control = await runOnce('Control file', CONTROL_FILE, '')
  info(`exit=${control.run.exitCode} changed=${control.run.worktree.changed} files=${control.run.worktree.files.join(', ') || '—'}`)
  if (!existsSync(CONTROL_FILE)) throw new Error(`control run did not create ${CONTROL_FILE} — cannot compare`)
  const controlSource = readFileSync(CONTROL_FILE, 'utf8')
  if (controlSource.includes(MARKER)) {
    throw new Error('the control file ALREADY carries the marker — the agent does this unprompted, so this test proves nothing')
  }
  ok(`control file created without the marker (${controlSource.split('\n')[0].slice(0, 60)}…)`)

  // ── Instructed: same task, instructions set ──────────────────────
  console.log('\nINSTRUCTED — same task, standing instructions applied')
  const instructed = await runOnce('Instructed file', INSTRUCTED_FILE, INSTRUCTIONS)
  info(`exit=${instructed.run.exitCode} changed=${instructed.run.worktree.changed} files=${instructed.run.worktree.files.join(', ') || '—'}`)
  if (!existsSync(INSTRUCTED_FILE)) throw new Error(`instructed run did not create ${INSTRUCTED_FILE}`)
  const instructedSource = readFileSync(INSTRUCTED_FILE, 'utf8')

  console.log('\n--- first two lines of each file ---')
  console.log(`control:    ${controlSource.split('\n').slice(0, 2).join(' ⏎ ')}`)
  console.log(`instructed: ${instructedSource.split('\n').slice(0, 2).join(' ⏎ ')}`)

  if (!instructedSource.includes(MARKER)) {
    throw new Error(
      `the instructions did NOT change the output — ${INSTRUCTED_FILE} has no "${MARKER}". ` +
        'The field is stored but not reaching the CLI.',
    )
  }
  ok(`the instructed file carries "${MARKER}" and the control file does not`)

  if (!instructedSource.trimStart().startsWith(`// ${MARKER}`)) {
    info('note: the marker is present but not on the first line — instructions reached the CLI, obeyed loosely')
  } else {
    ok('the marker is the first line, exactly as instructed')
  }

  // ── The audit trail records that instructions were in play ───────
  const events = await listEvents(missionId)
  const instrEvents = events.filter((e) => e.type === 'task.instructions')
  if (instrEvents.length !== 1) {
    throw new Error(`expected exactly 1 task.instructions event (the instructed run), found ${instrEvents.length}`)
  }
  ok('exactly one task.instructions event — recorded for the instructed run, absent for the control')

  console.log('\n✓ standing instructions reach the CLI and demonstrably change what the builder writes\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
} finally {
  if (process.env.KEEP !== '1') {
    for (const f of created) rmSync(f, { force: true })
    if (missionId) await supabase.from('missions').delete().eq('id', missionId)
  } else if (missionId) {
    console.log(`    mission kept: ${missionId}`)
  }
  process.exit(process.exitCode ?? 0)
}
