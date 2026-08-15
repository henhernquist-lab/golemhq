// Real, per-agent functional audits — not a guess from `enabled`, not a
// presence check like cli-detect.ts. This actually runs the agent's CLI on a
// trivial task in an isolated scratch directory and independently re-reads
// the result, because a headless CLI that exits 0 having written nothing is
// exactly the failure mode `worktreeSignature`/`diffSignatures` exists to
// catch in the builder adapter (see headless-run.ts) — an audit that only
// checked the exit code would repeat that mistake.
//
// Results persist as mission_events on one long-lived "system" mission, the
// same pattern agent-chat.ts uses for conversations — no migration needed,
// and the audit trail is recoverable from the same append-only log as
// everything else.

import { randomUUID } from 'node:crypto'

import { base64Arg, runHeadless } from '@/lib/terminal/headless-run'
import { createMission, getActiveMission, listEvents, recordEvent } from './store'
import { executableOf } from './cli-detect'
import type { Agent } from './types'

export const AUDIT_REPO = 'audit/system'
export const AUDIT_EVENT = 'agent.functional_audit'

const PROBE_TIMEOUT_MS = 10_000
const RUN_TIMEOUT_MS = 90_000
const VERIFY_TIMEOUT_MS = 10_000

export type AuditStatus = 'working' | 'broken' | 'absent' | 'not_applicable'

export interface AuditResult {
  agentId: string
  agentName: string
  status: AuditStatus
  detail: string
  ts: string
  durationMs: number
}

async function getOrCreateAuditMission(): Promise<string> {
  const existing = await getActiveMission(AUDIT_REPO)
  if (existing) return existing.id
  const mission = await createMission(AUDIT_REPO, 'Agent functional audits (Batch 8)')
  return mission.id
}

export async function recordAuditResult(result: AuditResult): Promise<void> {
  const missionId = await getOrCreateAuditMission()
  await recordEvent(missionId, AUDIT_EVENT, { ...result })
}

/** Most recent audit event per agent, newest audit mission first. */
export async function latestAuditResults(): Promise<Map<string, AuditResult>> {
  const mission = await getActiveMission(AUDIT_REPO)
  if (!mission) return new Map()
  const events = await listEvents(mission.id, 500)
  const out = new Map<string, AuditResult>()
  // listEvents is oldest-first; walking in order and overwriting leaves the
  // most recent result per agent, same trick as agent-chat's lastCliSession.
  for (const e of events) {
    if (e.type !== AUDIT_EVENT) continue
    const p = e.payload
    if (typeof p.agentId !== 'string') continue
    out.set(p.agentId, {
      agentId: p.agentId,
      agentName: typeof p.agentName === 'string' ? p.agentName : '',
      status: (p.status as AuditStatus) ?? 'broken',
      detail: typeof p.detail === 'string' ? p.detail : '',
      ts: e.ts,
      durationMs: typeof p.durationMs === 'number' ? p.durationMs : 0,
    })
  }
  return out
}

function result(agent: Agent, status: AuditStatus, detail: string, startedAt: number): AuditResult {
  return {
    agentId: agent.id,
    agentName: agent.name,
    status,
    detail,
    ts: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Actually invoke the agent. Layer 1/3 rows are logic, not CLIs — they have
 * no cli_command and there is nothing here to run, so they report
 * 'not_applicable' rather than a false pass or fail.
 */
export async function runAgentAudit(agent: Agent): Promise<AuditResult> {
  const startedAt = Date.now()

  if (agent.layer !== 2 || !agent.cliCommand) {
    return result(
      agent,
      'not_applicable',
      'Layer 1/3 agents are logic (Planner/Scheduler/Coordinator/validators), not a CLI to invoke.',
      startedAt,
    )
  }

  const exe = executableOf(agent.cliCommand)

  const probe = await runHeadless(`command -v ${exe} 2>/dev/null`, {
    timeoutMs: PROBE_TIMEOUT_MS,
    runId: `audit-probe-${randomUUID().slice(0, 8)}`,
  })
  if (probe.failure || !probe.output.trim()) {
    return result(agent, 'absent', `\`${exe}\` not found on PATH on this host.`, startedAt)
  }

  const mk = await runHeadless('mktemp -d', {
    timeoutMs: PROBE_TIMEOUT_MS,
    runId: `audit-mktemp-${randomUUID().slice(0, 8)}`,
  })
  const scratchDir = mk.output.trim()
  if (mk.failure || !scratchDir) {
    return result(agent, 'broken', `could not create a scratch directory to audit in: ${mk.failure ?? 'empty mktemp output'}`, startedAt)
  }

  const token = `VERIFY-${exe.toUpperCase()}-${randomUUID().slice(0, 8)}`
  const prompt =
    `Create a file named marker.txt containing exactly this text and nothing else: ${token}. ` +
    'Do not create or modify any other file.'

  const run = await runHeadless(`${agent.cliCommand} ${base64Arg(prompt)}`.replace(/\s+/g, ' '), {
    timeoutMs: RUN_TIMEOUT_MS,
    runId: `audit-run-${randomUUID().slice(0, 8)}`,
    cwd: scratchDir,
  })

  if (run.timedOut) {
    return result(agent, 'broken', `timed out after ${RUN_TIMEOUT_MS}ms without finishing.`, startedAt)
  }
  if (run.failure) {
    return result(agent, 'broken', `run failed: ${run.failure}`, startedAt)
  }

  // Independent verification: re-read the file over a fresh shell command
  // rather than trusting the CLI's own claim in its stdout. This is exactly
  // the check that caught Claude Code writing to its own nested-session
  // scratch path instead of the given cwd during this audit (see Batch 8
  // report) — a run that "says" it created the file is not the same as one
  // that did.
  const verify = await runHeadless(`cat ${scratchDir}/marker.txt 2>/dev/null`, {
    timeoutMs: VERIFY_TIMEOUT_MS,
    runId: `audit-verify-${randomUUID().slice(0, 8)}`,
  })
  const actual = verify.output.trim()

  if (actual === token) {
    return result(agent, 'working', `wrote the exact requested marker to ${scratchDir}/marker.txt.`, startedAt)
  }
  if (!actual) {
    return result(
      agent,
      'broken',
      `exited ${run.exitCode ?? 'without an end marker'} but marker.txt was never written (or written elsewhere — CLI stdout tail: ${run.output.slice(-300)})`,
      startedAt,
    )
  }
  return result(agent, 'broken', `marker.txt exists but content did not match — expected "${token}", got "${actual.slice(0, 200)}"`, startedAt)
}
