// Prove the "did this actually happen" trail is evidence and not decoration.
//
// Two claims, and the second matters more than the first:
//
//   1. A commit GitHub really has is reported `verified`, with a URL that
//      resolves.
//   2. A commit GitHub does NOT have is reported `local_only`, with NO url —
//      because the failure mode this whole feature exists to avoid is a
//      confident github.com link that 404s on click, laundering "the builder
//      said so" into what looks like third-party confirmation.
//
// The second is checked against a real builder run that really commits, so the
// unpushed case is produced the way it happens in practice rather than mocked.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-audit-trail.mjs
//
// Env:
//   KEEP=1   keep the mission and leave the commit in place

import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'

import './load-env.mjs'

const { runBuilderTask } = await import('../src/lib/missions/adapter.ts')
const { createMission, createTask, updateMissionStatus, updateTaskStatus, listAgents, listEvents } =
  await import('../src/lib/missions/store.ts')
const { parseGitHubRemote, verifyCommit } = await import('../src/lib/missions/artifacts.ts')
const { supabase } = await import('../src/lib/supabase.ts')

const FILE = 'src/lib/missions/__audit_probe__.ts'
const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim()

let missionId = null
let startingHead = null

try {
  startingHead = sh('git rev-parse HEAD')
  const remoteUrl = sh('git config --get remote.origin.url')
  const remote = parseGitHubRemote(remoteUrl)
  if (!remote) throw new Error(`could not parse a github remote from "${remoteUrl}"`)
  ok(`remote parsed: ${remote.owner}/${remote.repo}`)

  // ── Claim 1: a pushed commit is verified, against the live API ────
  console.log('\nA COMMIT GITHUB HAS')
  const pushed = sh('git rev-parse origin/main')
  const pushedArtifact = await verifyCommit(remote, pushed)
  info(`sha ${pushed.slice(0, 7)} → ${pushedArtifact.verification}`)
  if (pushedArtifact.verification !== 'verified') {
    throw new Error(`origin/main should verify, got "${pushedArtifact.verification}": ${pushedArtifact.note}`)
  }
  if (!pushedArtifact.url) throw new Error('a verified commit must carry a url')
  ok(`verified with a real link: ${pushedArtifact.url}`)

  // The link has to actually resolve, or "verified" means nothing.
  const res = await fetch(pushedArtifact.url, { method: 'HEAD' })
  if (!res.ok) throw new Error(`the verified URL did not resolve: HTTP ${res.status}`)
  ok(`the URL resolves (HTTP ${res.status}) — a human clicking it lands on the real commit`)

  // ── Claim 2: a real, unpushed builder commit is NOT dressed up ────
  console.log('\nA COMMIT GITHUB DOES NOT HAVE (real builder run)')
  const builders = await listAgents(2, true)
  const agent = builders.sort((a, b) => (b.reliabilityPct ?? 0) - (a.reliabilityPct ?? 0))[0]
  if (!agent) throw new Error('no enabled layer-2 builders')

  const mission = await createMission(`verify/audit-${Date.now()}`, 'Prove the audit trail reports unpushed commits honestly')
  missionId = mission.id
  await updateMissionStatus(missionId, 'running')

  const task = await createTask(missionId, {
    title: 'Commit a probe file',
    description:
      `Create the file ${FILE} exporting \`export const probe = true\`, then COMMIT it with git ` +
      `(message: "test: audit trail probe"). Do not push. Do not modify any other file.`,
  })
  await updateTaskStatus(task.id, 'assigned', { assignedAgent: agent.id, by: 'verify-audit-trail' })

  const run = await runBuilderTask(task.id, { cwd: process.cwd(), timeoutMs: 240_000 })
  info(`agent=${agent.name} exit=${run.exitCode} committed=${run.worktree.committed}`)

  if (!run.worktree.committed) throw new Error('the builder did not commit — cannot exercise the unpushed path')
  ok(`HEAD moved ${run.worktree.headBefore?.slice(0, 7)} → ${run.worktree.headAfter?.slice(0, 7)}`)

  // The event is what the audit view actually reads.
  const events = await listEvents(missionId)
  const worktree = events.find((e) => e.taskId === task.id && e.type === 'task.worktree')
  if (!worktree) throw new Error('no task.worktree event recorded')
  if (!worktree.payload.headAfter) throw new Error('the worktree event carries no headAfter — nothing to link')
  if (!worktree.payload.remote) throw new Error('the worktree event carries no remote — cannot build a link')
  ok(`the event carries headAfter and remote — files: ${(worktree.payload.files ?? []).join(', ')}`)

  const localArtifact = await verifyCommit(remote, String(worktree.payload.headAfter))
  info(`sha ${String(worktree.payload.headAfter).slice(0, 7)} → ${localArtifact.verification}`)
  if (localArtifact.verification !== 'local_only') {
    throw new Error(`an unpushed commit must be local_only, got "${localArtifact.verification}"`)
  }
  if (localArtifact.url !== null) {
    throw new Error(`an unpushed commit must carry NO url — it would 404. Got: ${localArtifact.url}`)
  }
  ok('reported local_only with no link, and a note that says why')
  info(`note: ${localArtifact.note}`)

  console.log('\n✓ verified commits link out and resolve; unpushed commits are never dressed up as verified\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
} finally {
  if (process.env.KEEP !== '1') {
    // Roll the probe commit off the branch WITHOUT --hard. A hard reset here
    // would also delete every unrelated uncommitted change in the checkout,
    // which is most of the working tree while this feature is being built.
    // Soft keeps the tree exactly as it is and only moves the ref.
    try {
      if (startingHead && sh('git rev-parse HEAD') !== startingHead) {
        execSync(`git reset --soft ${startingHead}`, { stdio: 'ignore' })
        execSync(`git restore --staged ${FILE}`, { stdio: 'ignore' })
      }
    } catch { /* leave it rather than risk destroying real work */ }
    rmSync(FILE, { force: true })
    if (missionId) await supabase.from('missions').delete().eq('id', missionId)
  } else if (missionId) {
    console.log(`    mission kept: ${missionId}`)
  }
  process.exit(process.exitCode ?? 0)
}
