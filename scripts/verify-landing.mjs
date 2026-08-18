// Verification path for Batch 10 — the landing.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-landing.mjs
//
// The claim under test is that a mission's output survives as something that
// can be landed. Before this batch a serial wave — which is what the Command
// tab dispatches — ran in the shared checkout, because worktrees were gated on
// maxConcurrent > 1 alone. preserveWorktree never ran, no `golem/task/<id>`
// branch was written, and the approval gate had nothing to merge. The work
// existed only as uncommitted changes in whatever checkout the server was
// pointed at.
//
// So this runs the SAME wave twice against the same scratch repo — once with
// isolate:true and once without — and reads the outcome out of git rather than
// out of the scheduler's return value. The second run is the control: it is
// expected to fail the branch check, and a green control means the fix is not
// doing anything.
//
// The builder is a real Layer 2 agent whose cli_command writes a file. That is
// not a mock of the scheduler — the wave, the adapter's before/after diffing,
// the lease cycle, preserveWorktree and releaseWorktree are all the shipped
// code. Only the model call is replaced, because what a model writes is not
// what this batch changed and paying for one would make the check flaky.

import './load-env.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  createMission,
  createTask,
  updateMissionStatus,
  updateTaskStatus,
  getMission,
  listTasks,
  createAgent,
  deleteAgent,
} = await import('../src/lib/missions/store.ts')
const { scheduleTasks } = await import('../src/lib/missions/scheduler.ts')
const { approveAndMerge, rejectTasks, listPendingApprovals, taskBranch } = await import(
  '../src/lib/missions/approval.ts'
)
const { allocateWorktree, preserveWorktree, releaseWorktree, resolveBaseCommit } = await import(
  '../src/lib/missions/worktrees.ts'
)

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  failures++
  console.log(`  ✗ ${m}`)
}
const info = (m) => console.log(`    ${m}`)
const check = (c, m) => (c ? ok(m) : bad(m))
const head = (m) => console.log(`\n${m}`)

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const branches = (cwd) =>
  git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], cwd).split('\n').filter(Boolean)
const dirty = (cwd) => git(['status', '--porcelain=v1', '--untracked-files=all'], cwd)

// Unique per run: createMission allows one active mission per repo, so reusing
// a fixed identifier would make the second run of this script fail at setup
// for a reason that has nothing to do with what it tests.
const stamp = Date.now()
const repoId = (suffix) => `golem/verify-landing-${stamp}-${suffix}`

const repoRoot = mkdtempSync(join(tmpdir(), 'golem-landing-'))
const created = { agentId: null }

/** A scratch repository shaped like the one a builder really runs in. */
function initRepo() {
  git(['init', '-q', '-b', 'main'], repoRoot)
  git(['config', 'user.email', 'verify@golemhq.local'], repoRoot)
  git(['config', 'user.name', 'Landing Verify'], repoRoot)
  writeFileSync(join(repoRoot, 'README.md'), '# scratch\n')
  git(['add', '-A'], repoRoot)
  git(['commit', '-q', '-m', 'base'], repoRoot)
}

/**
 * A builder that writes one file, deterministically.
 *
 * cli_command carries the whole invocation up to the prompt, which the adapter
 * appends as one shell word — so `sh -c '<script>' --` receives the prompt as
 * $1 and ignores it, exactly like a CLI that was handed a task it does not
 * need to read.
 */
async function makeProbeAgent(marker) {
  const agent = await createAgent({
    name: `landing-probe-${stamp}`,
    layer: 2,
    // Single-word strength that only this fixture's task titles contain, so
    // pickAgent scores it 1 and every real builder 0. Without that the wave
    // would be handed to Claude Code and cost real tokens.
    strengths: ['batch10probe'],
    cliCommand: `sh -c 'printf %s\\\\n ${marker} > ${marker}.txt' --`,
    enabled: true,
  })
  created.agentId = agent.id
  return agent
}

/** One mission, one task, dispatched through the real scheduler. */
async function runWave(suffix, { isolate }) {
  const mission = await createMission(repoId(suffix), `landing check (${suffix})`)
  await updateMissionStatus(mission.id, 'running')
  await createTask(mission.id, {
    title: `batch10probe ${suffix}`,
    description: `batch10probe fixture ${suffix}`,
  })
  const result = await scheduleTasks(mission.id, {
    cwd: repoRoot,
    maxTasks: 1,
    maxConcurrent: 1,
    // Validators run tsc and eslint in the task's checkout. This scratch repo
    // has neither, and what they would decide is not what this batch changed.
    validate: false,
    ...(isolate ? { isolate: true } : {}),
  })
  const tasks = await listTasks(mission.id)
  return { mission, tasks, result }
}

async function main() {
  initRepo()
  const marker = `probe${stamp}`
  await makeProbeAgent(marker)
  info(`scratch repo: ${repoRoot}`)
  info(`probe builder writes ${marker}.txt`)

  // ── 1. The fix: a serial wave isolates and preserves ────────────────
  head('1. serial dispatch with isolate:true')
  const isolated = await runWave('isolated', { isolate: true })
  const isolatedTask = isolated.tasks[0]
  const isolatedBranch = taskBranch(isolatedTask.id)
  const afterIsolated = branches(repoRoot)

  check(
    afterIsolated.includes(isolatedBranch),
    `branch ${isolatedBranch.slice(0, 24)}… exists — the approval gate has something to merge`,
  )
  check(
    dirty(repoRoot) === '',
    'the shared checkout is clean — the builder never touched it',
  )
  if (afterIsolated.includes(isolatedBranch)) {
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', isolatedBranch], repoRoot)
    check(files.includes(`${marker}.txt`), `the branch actually holds the builder's file (${files})`)
  }

  // ── 2. The control: the same wave, pre-Batch-10 ─────────────────────
  head('2. control — the same wave without isolate (the shipped Batch 9 behaviour)')
  const shared = await runWave('shared', { isolate: false })
  const sharedTask = shared.tasks[0]
  const sharedBranch = taskBranch(sharedTask.id)
  const afterShared = branches(repoRoot)
  const dirtAfterShared = dirty(repoRoot)

  check(
    !afterShared.includes(sharedBranch),
    'no branch was written — this is the bug, and a pass here means the control is honest',
  )
  check(
    dirtAfterShared.includes(`${marker}.txt`),
    `the builder's work is loose in the checkout instead (${dirtAfterShared.split('\n')[0]})`,
  )
  // Leave the scratch checkout clean for the merge checks below.
  git(['clean', '-fdq'], repoRoot)

  // ── 3. Landing releases the mission ─────────────────────────────────
  head('3. approve + merge closes the mission')
  await updateTaskStatus(isolatedTask.id, 'complete', { by: 'verify' })
  await updateMissionStatus(isolated.mission.id, 'awaiting_approval')

  const pending = await listPendingApprovals(isolated.mission.id, repoRoot, 'main')
  const row = pending.tasks.find((t) => t.task.id === isolatedTask.id)
  check(!!row?.branchExists, 'the gate lists the task with a real branch')
  check((row?.insertions ?? 0) > 0, `the gate shows a real diff (+${row?.insertions ?? 0})`)

  const mainBefore = git(['rev-parse', 'main'], repoRoot)
  const merge = await approveAndMerge(isolated.mission.id, repoRoot, [isolatedTask.id], {
    targetBranch: 'main',
  })
  const mainAfter = git(['rev-parse', 'main'], repoRoot)

  check(merge.landed, 'approveAndMerge reports it landed')
  check(mainBefore !== mainAfter, 'main actually moved — read back out of git, not from the return value')
  check(
    existsSync(join(repoRoot, `${marker}.txt`)) ||
      git(['ls-tree', '--name-only', '-r', 'main'], repoRoot).includes(`${marker}.txt`),
    "the builder's file is on main",
  )

  const closed = await getMission(isolated.mission.id)
  check(
    closed?.status === 'completed',
    `mission released after landing: status is "${closed?.status}" (was awaiting_approval)`,
  )

  // ── 4. Rejecting everything also releases the repo ──────────────────
  head('4. reject-all releases the repo without discarding the work')
  const rejected = await createMission(repoId('rejected'), 'landing check (rejected)')
  await updateMissionStatus(rejected.id, 'running')
  const rejTask = await createTask(rejected.id, {
    title: 'batch10probe rejected',
    description: 'batch10probe fixture rejected',
  })
  // Build the branch shape a finished task leaves behind, with the real
  // functions, rather than re-running a wave for a case that is about what
  // happens after one.
  const base = await resolveBaseCommit(repoRoot)
  const wt = await allocateWorktree(rejTask.id, repoRoot, base)
  writeFileSync(join(wt.path, 'rejected.txt'), 'nope\n')
  await preserveWorktree(rejTask.id, repoRoot)
  await releaseWorktree(rejTask.id, repoRoot)
  await updateTaskStatus(rejTask.id, 'complete', { by: 'verify' })
  await updateMissionStatus(rejected.id, 'awaiting_approval')

  await rejectTasks(rejected.id, repoRoot, [rejTask.id], { reason: 'verify' })
  const rejClosed = await getMission(rejected.id)
  check(
    rejClosed?.status === 'cancelled',
    `mission released after a full rejection: status is "${rejClosed?.status}"`,
  )
  check(
    branches(repoRoot).includes(taskBranch(rejTask.id)),
    'the rejected branch is kept — releasing the repo is not discarding the work',
  )

  // ── 5. A half-decided mission stays open ────────────────────────────
  head('5. a partly decided mission is NOT released')
  const partial = await createMission(repoId('partial'), 'landing check (partial)')
  await updateMissionStatus(partial.id, 'running')
  const pTasks = []
  for (const n of ['one', 'two']) {
    const t = await createTask(partial.id, {
      title: `batch10probe partial ${n}`,
      description: `batch10probe fixture partial ${n}`,
    })
    const w = await allocateWorktree(t.id, repoRoot, await resolveBaseCommit(repoRoot))
    writeFileSync(join(w.path, `partial-${n}.txt`), `${n}\n`)
    await preserveWorktree(t.id, repoRoot)
    await releaseWorktree(t.id, repoRoot)
    await updateTaskStatus(t.id, 'complete', { by: 'verify' })
    pTasks.push(t)
  }
  await updateMissionStatus(partial.id, 'awaiting_approval')

  await approveAndMerge(partial.id, repoRoot, [pTasks[0].id], { targetBranch: 'main' })
  const partialAfter = await getMission(partial.id)
  check(
    partialAfter?.status === 'awaiting_approval',
    `still waiting on the second task: status is "${partialAfter?.status}"`,
  )
}

try {
  await main()
} catch (err) {
  failures++
  console.log(`\n  ✗ threw: ${err instanceof Error ? err.stack : String(err)}`)
} finally {
  if (created.agentId) {
    await deleteAgent(created.agentId).catch((e) => console.log(`    (probe agent left behind: ${e.message})`))
  }
  console.log(`\nscratch repo kept for inspection: ${repoRoot}`)
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
