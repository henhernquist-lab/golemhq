/**
 * /api/agency — read model for the Agency tab (Batch 8).
 *
 * One call for the whole tab, same reasoning as /api/missions: the org chart,
 * roster and activity feed all render on first paint, and separate round
 * trips are separate chances for them to disagree. Read-only — pause/resume
 * goes through the existing PATCH /api/missions/agents/[id] (the `enabled`
 * column the Scheduler already gates dispatch on), and an audit run goes
 * through POST /api/missions/agents/[id]/audit. This route only reads.
 */

import { auth } from '@/lib/auth'
import { listMissions, listAgents, getDetections, listAgentInstructions, listAgentModels, listRecentEvents } from '@/lib/missions/store'
import { CHAT_REPO_PREFIX } from '@/lib/missions/agent-chat'
import { AUDIT_REPO, latestAuditResults, type AuditResult } from '@/lib/missions/functional-audit'
import type { AgentDetectionRecord } from '@/lib/missions/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NON_MISSION_PREFIXES = [CHAT_REPO_PREFIX, AUDIT_REPO]

export async function GET() {
  const session = await auth()
  if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const [missions, agents, events] = await Promise.all([
      listMissions(),
      listAgents(),
      listRecentEvents(150),
    ])

    let detections = new Map<string, AgentDetectionRecord>()
    try {
      detections = await getDetections()
    } catch {
      /* migration not applied — roster still renders without it */
    }

    const instructions = await listAgentInstructions()
    const models = await listAgentModels()

    let audits = new Map<string, AuditResult>()
    try {
      audits = await latestAuditResults()
    } catch {
      /* audit mission not created yet — nothing audited so far */
    }

    // Real missions only: chats and the audit "mission" are the same table
    // for storage reasons but read as noise on a mission-hierarchy activity
    // feed, exactly like /api/missions already excludes chats.
    const missionRepoById = new Map(missions.map((m) => [m.id, m.repo]))
    const realMissionIds = new Set(
      missions.filter((m) => !NON_MISSION_PREFIXES.some((p) => m.repo.startsWith(p))).map((m) => m.id),
    )

    const activity = events
      .filter((e) => realMissionIds.has(e.missionId))
      .slice(0, 60)
      .map((e) => ({
        id: e.id,
        missionId: e.missionId,
        repo: missionRepoById.get(e.missionId) ?? 'unknown',
        taskId: e.taskId,
        ts: e.ts,
        type: e.type,
        payload: e.payload,
      }))

    return Response.json({
      agents: agents.map((agent) => ({
        ...agent,
        detection: detections.get(agent.id) ?? null,
        instructions: instructions.get(agent.id) ?? null,
        model: models.get(agent.id) ?? null,
        audit: audits.get(agent.id) ?? null,
      })),
      activity,
    })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'failed to load agency data' }, { status: 500 })
  }
}
