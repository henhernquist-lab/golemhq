/**
 * GET /api/missions/[id]/plan — the drafted plan, and who would run it.
 *
 * Read-only and side-effect free, which is the entire point: a mission waiting
 * at this gate must hold no lease and have spawned no CLI, so the surface that
 * renders it cannot be one that assigns tasks to find out. See previewPlan for
 * why `scheduleTasks({ dryRun: true })` is not that surface.
 *
 * Session-gated rather than owner-gated, matching /api/missions/[id]: this
 * reads rows and spends nothing. Approving is the owner's, and that is a
 * different route.
 */

import { auth } from '@/lib/auth'
import { previewPlan, PlanApprovalError } from '@/lib/missions/plan-approval'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RouteCtx {
  params: Promise<{ id: string }>
}

export async function GET(_req: Request, ctx: RouteCtx) {
  const session = await auth()
  if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params

  try {
    return Response.json(await previewPlan(id))
  } catch (err) {
    if (err instanceof PlanApprovalError) {
      return Response.json({ error: err.message }, { status: err.status })
    }
    return Response.json(
      { error: err instanceof Error ? err.message : 'failed to load the plan' },
      { status: 500 },
    )
  }
}
