// Verification path for Batch 11 — the plan preview and approval gate.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-plan-gate.mjs
//
// The claim this batch has to earn is a negative one: a drafted, unapproved
// mission holds ZERO leases and has spawned ZERO builder processes. A negative
// is easy to assert and easy to fake, so it is read out of the database — the
// lease rows and the mission_events log — rather than out of any return value
// the gate produced about itself.
//
// The Planner is NOT run here. It is a paid model call and Batch 3 already
// proved it; what this needs is a drafted graph, so the tasks are written
// directly through the same store the Planner writes them through. The gate
// cannot tell the difference and neither can the Scheduler.
//
// KEEP=1 leaves the missions behind for inspection.

import './load-env.mjs'

const {
  createMission,
  createTask,
  getMission,
  listTasks,
  listEvents,
  updateMissionStatus,
  listAgents,
} = await import('../src/lib/missions/store.ts')
const {
  previewPlan,
  approvePlan,
  enterPlanGate,
  isAtPlanGate,
  PLAN_GATE_STATUS,
} = await import('../src/lib/missions/plan-approval.ts')
const { supabase } = await import('../src/lib/supabase.ts')

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  failures++
  console.log(`  ✗ ${m}`)
}
const info = (m) => console.log(`    ${m}`)
const check = (c, m) => (c ? ok(m) : bad(m))

const REPO = `golem/plan-gate-verify-${Date.now()}`
const missionIds = []

async function draft(goal, titles) {
  const mission = await createMission(REPO, goal, null)
  missionIds.push(mission.id)
  for (const title of titles) {
    await createTask(mission.id, { title, description: `${title} — drafted by the verifier`, priority: 'medium' })
  }
  const gated = await enterPlanGate(mission.id, { plannedTasks: titles.length })
  return { mission: gated.mission, migrationApplied: gated.migrationApplied }
}

/** Every lease row belonging to this mission's tasks, straight from the table. */
async function leaseCount(missionId) {
  const tasks = await listTasks(missionId)
  if (tasks.length === 0) return 0
  const { data, error } = await supabase
    .from('leases')
    .select('id')
    .in('task_id', tasks.map((t) => t.id))
  if (error) throw new Error(`lease read failed: ${error.message}`)
  return (data ?? []).length
}

try {
  // ── 1. The gate holds ────────────────────────────────────────────────
  console.log('\n1. a drafted plan parks outside the dispatchable state')
  const { mission, migrationApplied } = await draft('add an /api/uptime route', [
    'write the route handler',
    'add a Playwright test',
  ])
  info(`migration applied: ${migrationApplied} (status "${mission.status}")`)
  check(mission.status !== 'running', `mission is "${mission.status}", not "running"`)
  check(
    isAtPlanGate(mission.status, 2),
    'isAtPlanGate recognises it as awaiting plan approval',
  )
  if (migrationApplied) {
    check(mission.status === PLAN_GATE_STATUS, `holds the real gate status "${PLAN_GATE_STATUS}"`)
  } else {
    check(
      mission.status === 'planning',
      'falls back to "planning" with the migration unapplied — still not dispatchable',
    )
    const events = await listEvents(mission.id, 100)
    check(
      events.some((e) => e.type === 'plan.gate_degraded'),
      'and says so with a plan.gate_degraded event rather than failing silently',
    )
  }

  // ── 2. Nothing has been dispatched ───────────────────────────────────
  console.log('\n2. the whole point: nothing ran')
  const tasks = await listTasks(mission.id)
  check(
    tasks.every((t) => t.status === 'pending'),
    `all ${tasks.length} tasks still "pending" (${tasks.map((t) => t.status).join(', ')})`,
  )
  check(
    tasks.every((t) => t.assignedAgent === null),
    'no task carries an assigned agent',
  )
  check((await leaseCount(mission.id)) === 0, 'ZERO lease rows exist for this mission')
  const preEvents = await listEvents(mission.id, 200)
  const ranTypes = [
    'scheduler.wave_dispatched',
    'task.result_recorded',
    'scheduler.task_failed',
    'coordinator.leases_acquired',
  ]
  const fired = preEvents.filter((e) => ranTypes.includes(e.type))
  check(fired.length === 0, `ZERO dispatch/execution events (${fired.map((e) => e.type).join(', ') || 'none'})`)
  check(
    !preEvents.some((e) => e.type === 'task.status_changed' && e.payload?.to === 'assigned'),
    'no task was ever moved to "assigned"',
  )

  // ── 3. The preview is the Scheduler's own answer ─────────────────────
  console.log('\n3. the preview shows who would actually run each task')
  const preview = await previewPlan(mission.id)
  check(preview.atGate, 'previewPlan reports the mission is at the gate')
  check(preview.assignments.length === tasks.length, `an assignment for each of ${tasks.length} tasks`)
  if (preview.warning) info(`warning: ${preview.warning}`)
  for (const a of preview.assignments) {
    info(`  "${a.title}" → ${a.agent?.name ?? 'NONE'} (${a.rationale})`)
  }
  check(
    preview.assignments.every((a) => a.agent !== null),
    'every task has a named builder before anything is approved',
  )
  // The candidate list is the gate's honesty check: only layer-2 CLI builders.
  const allAgents = await listAgents()
  const nonBuilders = allAgents.filter((a) => a.layer !== 2).map((a) => a.id)
  check(
    preview.candidates.every((c) => !nonBuilders.includes(c.id)),
    `candidates are layer-2 builders only (${preview.candidates.length} offered, ${nonBuilders.length} non-builders excluded)`,
  )
  check(
    preview.candidates.every((c) => c.cliCommand),
    'every offered candidate has a real CLI command',
  )
  check(
    (await leaseCount(mission.id)) === 0,
    'previewPlan took no leases — still ZERO after the preview',
  )

  // ── 4. Reassignment reaches the task row ─────────────────────────────
  console.log('\n4. a reassignment at the gate is what the Scheduler will read')
  const target = preview.assignments[0]
  const other = preview.candidates.find((c) => c.id !== target.agent.id)
  if (!other) {
    info('only one dispatchable builder on this host — reassignment not exercisable here')
  } else {
    const approved = await approvePlan(mission.id, {
      assignments: [{ taskId: target.taskId, agentId: other.id }],
    })
    check(approved.assigned.length === 1, `approvePlan pinned 1 task to ${other.name}`)
    const after = await listTasks(mission.id)
    const pinned = after.find((t) => t.id === target.taskId)
    check(
      pinned.assignedAgent === other.id,
      `tasks.assigned_agent now holds ${other.name}, not the Scheduler's pick (${target.agent.name})`,
    )
    check(approved.mission.status === 'running', 'mission moved to "running" — now dispatchable')
    const evts = await listEvents(mission.id, 200)
    check(
      evts.some((e) => e.type === 'plan.approved'),
      'a plan.approved event records the decision',
    )
    check(
      evts.some((e) => e.type === 'task.agent_assigned' && e.taskId === target.taskId),
      'and a task.agent_assigned event records which builder was pinned',
    )
  }

  // ── 5. Approval is refused twice ─────────────────────────────────────
  console.log('\n5. an already-approved plan cannot be approved again')
  let refused = false
  try {
    await approvePlan(mission.id, {})
  } catch (err) {
    refused = true
    info(err.message)
  }
  check(refused, 'approvePlan refuses a mission that is no longer at the gate')

  // ── 6. Reject unjams the repo ────────────────────────────────────────
  console.log('\n6. rejecting a plan releases the repo')
  await updateMissionStatus(mission.id, 'cancelled', { by: 'verifier' })
  const second = await draft('a second mission on the same repo', ['prove the door reopened'])
  check(!!second.mission.id, 'a new mission starts on the same repo after the first is cancelled')
  check(
    second.mission.id !== mission.id,
    'and it is genuinely a new mission, not the old one returned',
  )
  const held = await getMission(mission.id)
  check(held.status === 'cancelled', 'the rejected mission is terminal')

  // ── 7. An invalid override is refused ────────────────────────────────
  console.log('\n7. the gate will not pin a task to something that cannot run it')
  const orchestrator = allAgents.find((a) => a.layer !== 2)
  if (!orchestrator) {
    info('no non-builder agent in the roster to test against')
  } else {
    let rejected = false
    try {
      await approvePlan(second.mission.id, {
        assignments: [
          { taskId: (await listTasks(second.mission.id))[0].id, agentId: orchestrator.id },
        ],
      })
    } catch (err) {
      rejected = true
      info(err.message)
    }
    check(rejected, `refused to assign a task to "${orchestrator.name}" (layer ${orchestrator.layer})`)
  }
} finally {
  if (!process.env.KEEP) {
    for (const id of missionIds) {
      await supabase.from('missions').delete().eq('id', id)
    }
    console.log(`\ncleaned up ${missionIds.length} mission(s) — set KEEP=1 to keep them`)
  } else {
    console.log(`\nkept ${missionIds.length} mission(s): ${missionIds.join(', ')}`)
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
