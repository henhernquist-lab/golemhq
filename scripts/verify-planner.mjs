// Verification path for the Mission Planner (Batch 3).
//
// Two things get proven here:
//   1. a real goal decomposes into a task graph with working dependencies
//   2. the spend cap HALTS a run rather than warning about it — demonstrated by
//      pushing the ledger over the cap and showing no model call happens
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-planner.mjs
//
// Env:
//   MODEL=<id>   plan with a specific model instead of the default
//   GOAL=<text>  use a different goal
//   KEEP=1       keep the missions for inspection


import './load-env.mjs'

const { planMission, BudgetExceededError, MAX_TASKS } = await import('../src/lib/missions/planner.ts')
const { createMission, getMission, listTasks, listEvents } = await import('../src/lib/missions/store.ts')
const { budgetLimits, missionSpend, dailySpend, checkBudget, PLANNER_USAGE_EVENT } = await import(
  '../src/lib/missions/budget.ts'
)
const { supabase } = await import('../src/lib/supabase.ts')

const GOAL =
  process.env.GOAL ??
  'Add a /api/health endpoint that reports database connectivity and build version, with a test.'

const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)
const created = []

const cleanup = async () => {
  if (process.env.KEEP === '1') return
  for (const id of created) await supabase.from('missions').delete().eq('id', id)
  if (created.length) console.log(`\ncleaned up ${created.length} mission(s) (KEEP=1 to retain)`)
}

try {
  const limits = budgetLimits()
  console.log('\nBUDGET LIMITS (env-overridable)')
  info(`per mission: ${limits.missionTokens} tokens / $${limits.missionCostUsd}`)
  info(`per day:     ${limits.dailyTokens} tokens / $${limits.dailyCostUsd}`)
  const today = await dailySpend()
  info(`today so far: ${today.tokens} tokens / $${today.costUsd.toFixed(4)} over ${today.calls} calls`)

  // ── PART 1: a real decomposition ─────────────────────────────────
  console.log('\nPART 1 — plan a real goal')
  const mission = await createMission(`verify/planner-${Date.now()}`, GOAL)
  created.push(mission.id)
  ok(`mission ${mission.id} status="${mission.status}"`)
  info(`goal: ${GOAL}`)

  const result = await planMission(mission.id, { modelId: process.env.MODEL, cwd: process.env.REPO_CWD ?? process.cwd() })
  ok(`planned with ${result.modelId} in ${result.attempts} attempt(s)`)
  info(
    `repo context: ${result.repoContext.manifestFile ?? 'none'} · ${result.repoContext.chars} chars` +
      `${result.repoContext.truncated ? ' (truncated)' : ''}${result.repoContext.warning ? ` · ${result.repoContext.warning}` : ''}`,
  )
  info(
    `usage: ${result.usage.promptTokens} in + ${result.usage.completionTokens} out = ` +
      `${result.usage.totalTokens} tokens, $${result.usage.costUsd.toFixed(4)}`,
  )

  const tasks = await listTasks(mission.id)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  console.log(`\n  TASK GRAPH (${tasks.length} tasks, cap ${MAX_TASKS})`)
  for (const [i, t] of tasks.entries()) {
    const deps = t.dependsOn.map((d) => {
      const dep = byId.get(d)
      return dep ? `#${tasks.indexOf(dep) + 1}` : '?'
    })
    console.log(`  ${String(i + 1).padStart(2)}. [${t.priority.padEnd(6)}] ${t.title}`)
    console.log(`      ${deps.length ? `after ${deps.join(', ')}` : 'no dependencies'}  · agent=${t.assignedAgent ?? 'null'}`)
    console.log(`      ${t.description.slice(0, 110)}${t.description.length > 110 ? '…' : ''}`)
  }

  // Assertions the graph has to satisfy.
  if (tasks.length === 0) throw new Error('planner created no tasks')
  if (tasks.length > MAX_TASKS) throw new Error(`planner exceeded the ${MAX_TASKS} task cap`)
  if (tasks.some((t) => t.assignedAgent !== null)) {
    throw new Error('planner assigned an agent — that is Batch 4 territory')
  }
  ok('every task left unassigned (assigned_agent null) as Batch 4 expects')

  const ids = new Set(tasks.map((t) => t.id))
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!ids.has(d)) throw new Error(`task "${t.title}" depends on an id outside this mission`)
    }
  }
  ok('all dependsOn ids resolve to real tasks in this mission')

  const after = await getMission(mission.id)
  if (after.status !== 'running') throw new Error(`expected mission "running", got "${after.status}"`)
  ok('mission moved planning → running')

  const usageEvents = (await listEvents(mission.id)).filter((e) => e.type === PLANNER_USAGE_EVENT)
  const spend = await missionSpend(mission.id)
  ok(`${usageEvents.length} usage event(s) persisted — mission ledger: ${spend.tokens} tokens / $${spend.costUsd.toFixed(4)}`)

  // ── PART 2: the cap actually halts ───────────────────────────────
  console.log('\nPART 2 — spend cap halts a run (no model call at all)')
  const capped = await createMission(`verify/planner-capped-${Date.now()}`, GOAL)
  created.push(capped.id)

  // Push this mission's ledger over the per-mission cap by writing a usage
  // event directly — the same shape planMission writes.
  const over = limits.missionTokens + 1
  const { error } = await supabase.from('mission_events').insert({
    mission_id: capped.id,
    type: PLANNER_USAGE_EVENT,
    payload: { modelId: 'verification/synthetic', totalTokens: over, costUsd: 0, promptTokens: over, completionTokens: 0, latencyMs: 0 },
  })
  if (error) throw new Error(`could not seed the ledger: ${error.message}`)
  ok(`seeded ${over} tokens against the ${limits.missionTokens} cap`)

  const verdict = await checkBudget(capped.id)
  info(`checkBudget → allowed=${verdict.allowed} breached=${verdict.breached}`)

  let halted = false
  const startedAt = Date.now()
  try {
    await planMission(capped.id)
  } catch (err) {
    if (!(err instanceof BudgetExceededError)) throw err
    halted = true
    ok(`planMission threw BudgetExceededError: ${err.message}`)
  }
  if (!halted) throw new Error('FAIL: planner ran despite the cap being exceeded')

  // A real model call cannot complete in this time — proof none was made.
  const elapsed = Date.now() - startedAt
  info(`halted in ${elapsed}ms (a model call takes seconds — nothing was spent)`)

  const cappedTasks = await listTasks(capped.id)
  if (cappedTasks.length > 0) throw new Error(`FAIL: ${cappedTasks.length} tasks written despite the halt`)
  ok('no tasks written')

  const cappedSpend = await missionSpend(capped.id)
  if (cappedSpend.calls !== 1) throw new Error(`FAIL: ledger grew to ${cappedSpend.calls} calls — a model call slipped through`)
  ok('ledger still shows only the seeded call — the planner never called the model')

  const cappedMission = await getMission(capped.id)
  if (cappedMission.status !== 'failed') throw new Error(`expected "failed", got "${cappedMission.status}"`)
  ok(`mission moved to "${cappedMission.status}"`)

  const events = await listEvents(capped.id)
  const breach = events.find((e) => e.type === 'budget_exceeded')
  if (!breach) throw new Error('FAIL: no budget_exceeded event written')
  ok('budget_exceeded event written')
  info(JSON.stringify(breach.payload))

  console.log('\n✓ planner decomposes goals, and the spend cap halts rather than warns\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
} finally {
  await cleanup()
  process.exit(process.exitCode ?? 0)
}
