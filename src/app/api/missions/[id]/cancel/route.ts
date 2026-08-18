/**
 * POST /api/missions/[id]/cancel — release a stuck mission.
 *
 * createMission allows only one active mission per repo, and a mission that
 * failed (or whose tasks are wedged) is still "active" by that rule. Without a
 * way to close one, a single bad run locks the repo out of the front door for
 * good. This is that release valve, and the only mission write a human makes
 * directly — everything else is the pipeline's own.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { getMission, updateMissionStatus } from '@/lib/missions/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RouteCtx {
  params: Promise<{ id: string }>
}

export async function POST(_req: Request, ctx: RouteCtx) {
  const { response } = await requireHenryOwner()
  if (response) return response

  const { id } = await ctx.params
  const mission = await getMission(id)
  if (!mission) return Response.json({ error: 'Mission not found' }, { status: 404 })

  if (mission.status === 'completed' || mission.status === 'cancelled') {
    return Response.json({ mission, alreadyClosed: true })
  }

  try {
    const cancelled = await updateMissionStatus(id, 'cancelled', { by: 'owner' })
    return Response.json({ mission: cancelled })
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'failed to cancel' },
      { status: 500 },
    )
  }
}
