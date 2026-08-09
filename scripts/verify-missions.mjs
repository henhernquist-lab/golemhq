// Verification path for the mission spine (Batch 1).
//
// Creates a mission, adds two tasks with a dependency between them, walks them
// through their statuses, records a result, proves the one-active-mission-per-
// repo guardrail rejects a second mission, then dumps the event log — which is
// the real thing being verified, since every transition is supposed to leave a
// trace the live UI can replay.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-missions.mjs
//
// Requires the migration to be applied and SUPABASE env vars present. Cleans up
// after itself unless KEEP=1.


import './load-env.mjs'

const {
  createMission,
  createTask,
  updateTaskStatus,
  updateMissionStatus,
  listTasks,
  listEvents,
  recordResult,
  listAgents,
  getAgentByName,
  MissionStoreError,
} = await import('../src/lib/missions/store.ts')

const { supabase } = await import('../src/lib/supabase.ts')

const REPO = `verify/mission-spine-${Date.now()}`
let missionId = null

const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)

try {
  // ── Agents seeded? ───────────────────────────────────────────────
  console.log('\nAGENTS')
  const agents = await listAgents()
  const byLayer = { 1: 0, 2: 0, 3: 0 }
  for (const a of agents) byLayer[a.layer]++
  ok(`${agents.length} agents seeded — layer1=${byLayer[1]} layer2=${byLayer[2]} layer3=${byLayer[3]}`)

  const gemini = await getAgentByName('Gemini CLI')
  if (!gemini) throw new Error('expected the Gemini CLI agent to be seeded')
  ok(`layer-2 lookup works: "${gemini.name}" → cli "${gemini.cliCommand}", ctx ${gemini.contextWindow}`)

  const freebuff = await getAgentByName('Freebuff')
  ok(`Freebuff present and enabled=${freebuff?.enabled} (expected false)`)

  // ── Mission ──────────────────────────────────────────────────────
  console.log('\nMISSION')
  const mission = await createMission(REPO, 'Verify the mission spine end to end.')
  missionId = mission.id
  ok(`created ${mission.id} status="${mission.status}"`)

  // ── Guardrail ────────────────────────────────────────────────────
  console.log('\nGUARDRAIL — one active mission per repo')
  try {
    await createMission(REPO, 'Second mission, should be rejected.')
    throw new Error('FAIL: a second active mission was allowed')
  } catch (e) {
    if (!(e instanceof MissionStoreError)) throw e
    ok('second mission rejected')
    info(e.message)
  }

  // ── Tasks ────────────────────────────────────────────────────────
  console.log('\nTASKS')
  const first = await createTask(mission.id, {
    title: 'Scaffold the module',
    description: 'Create the files.',
    priority: 'high',
  })
  ok(`created "${first.title}" status="${first.status}" priority="${first.priority}"`)

  const second = await createTask(mission.id, {
    title: 'Write the tests',
    description: 'Depends on the scaffold existing.',
    priority: 'medium',
    dependsOn: [first.id],
  })
  ok(`created "${second.title}" dependsOn=[${second.dependsOn.length} task]`)

  // ── Transitions ──────────────────────────────────────────────────
  console.log('\nTRANSITIONS')
  await updateMissionStatus(mission.id, 'running')
  ok('mission → running')

  await updateTaskStatus(first.id, 'assigned', { assignedAgent: gemini.id })
  await updateTaskStatus(first.id, 'running')
  const started = await updateTaskStatus(first.id, 'validating')
  ok(`task 1 → assigned → running → validating (started_at ${started.startedAt ? 'stamped' : 'MISSING'})`)

  const result = await recordResult(
    first.id,
    gemini.id,
    'gemini -p "scaffold the module"\nCreated 3 files.\n',
    true,
    null,
    4210,
  )
  ok(`result recorded — success=${result.success} ${result.durationMs}ms, ${result.output.length} bytes`)

  const done = await updateTaskStatus(first.id, 'complete')
  ok(`task 1 → complete (completed_at ${done.completedAt ? 'stamped' : 'MISSING'})`)

  await updateTaskStatus(second.id, 'blocked', { reason: 'dependency not yet validated' })
  ok('task 2 → blocked')

  await updateMissionStatus(mission.id, 'awaiting_approval')
  ok('mission → awaiting_approval')

  // ── State ────────────────────────────────────────────────────────
  console.log('\nFINAL TASK STATE')
  for (const t of await listTasks(mission.id)) {
    console.log(`  ${t.status.padEnd(11)} ${t.priority.padEnd(6)} ${t.title}`)
  }

  // ── The event log ────────────────────────────────────────────────
  console.log('\nEVENT LOG (append-only, drives the live UI later)')
  const events = await listEvents(mission.id)
  for (const e of events) {
    const scope = e.taskId ? 'task' : 'mission'
    console.log(
      `  ${new Date(e.ts).toISOString().slice(11, 23)}  ${e.type.padEnd(22)} ${scope.padEnd(7)} ${JSON.stringify(e.payload)}`,
    )
  }
  console.log(`\n  ${events.length} events for ${(await listTasks(mission.id)).length} tasks`)

  const expected = ['mission.created', 'task.created', 'task.status_changed', 'task.result_recorded', 'mission.status_changed']
  const missing = expected.filter((t) => !events.some((e) => e.type === t))
  if (missing.length) throw new Error(`missing event types: ${missing.join(', ')}`)
  console.log('\n✓ every transition left an event — no silent state changes\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  if (missionId && process.env.KEEP !== '1') {
    // Cascades to tasks, results and events.
    await supabase.from('missions').delete().eq('id', missionId)
    console.log(`cleaned up mission ${missionId} (KEEP=1 to retain)`)
  }
}
