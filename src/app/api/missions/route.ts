/**
 * /api/missions — read model for the mission dashboard.
 *
 * Read-only by design. Everything the mission spine does is driven by the
 * Planner, Scheduler and validators; a UI that could also write would be a
 * second, competing source of truth over the same rows. Batch 8 adds controls
 * deliberately, on top of a settled backend.
 *
 * Returns missions and the agent roster in one call — the dashboard shows both
 * on first paint, and two round trips to render one screen is two chances for
 * them to disagree.
 */

import { auth } from '@/lib/auth'
import { listMissions, listAgents, getDetections, listAgentInstructions } from '@/lib/missions/store'
import type { AgentDetectionRecord } from '@/lib/missions/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const repo = new URL(req.url).searchParams.get('repo') ?? undefined

  try {
    const [missions, agents] = await Promise.all([listMissions(repo), listAgents()])

    // Detection columns arrive in a later migration than the roster. An
    // unreadable ledger means "nothing checked yet", not a broken page —
    // showing the roster without detection beats showing an error.
    let detections = new Map<string, AgentDetectionRecord>()
    try {
      detections = await getDetections()
    } catch {
      /* migration not applied */
    }

    // Same tolerance for the instructions column — it lands in
    // 20260809160000_agent_instructions.sql, and the roster is still useful
    // without it.
    const instructions = await listAgentInstructions()

    return Response.json({
      missions,
      agents: agents.map((agent) => ({
        ...agent,
        detection: detections.get(agent.id) ?? null,
        instructions: instructions.get(agent.id) ?? null,
      })),
    })
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'failed to load missions' },
      { status: 500 },
    )
  }
}
