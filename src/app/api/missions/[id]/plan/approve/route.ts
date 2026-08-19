/**
 * POST /api/missions/[id]/plan/approve — release a drafted plan for dispatch.
 *
 * Owner-gated: everything downstream of this spends money and edits a real
 * checkout, and this is the press that authorises it.
 *
 * Approval and dispatch stay two calls. /api/missions/[id]/dispatch already
 * refuses on Vercel, already bounds the wave, and already returns 202 because a
 * builder run outlives a request — a second dispatch path here would reproduce
 * all of that or, more likely, quietly omit some of it. The Command tab makes
 * it one press by calling both.
 *
 * Rejecting is not here either. That is POST /api/missions/[id]/cancel, which
 * Batch 9 wrote for exactly this: releasing the one-active-mission-per-repo
 * hold so the front door works again.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { readRequestJson } from '@/lib/request-json'
import { approvePlan, PlanApprovalError } from '@/lib/missions/plan-approval'
import { MissionStoreError } from '@/lib/missions/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RouteCtx {
  params: Promise<{ id: string }>
}

export async function POST(req: Request, ctx: RouteCtx) {
  const { response } = await requireHenryOwner()
  if (response) return response

  const { id } = await ctx.params
  const body = await readRequestJson(req)
  const { assignments } = body as { assignments?: unknown }

  // Validated here rather than trusted into the store: this is a request body,
  // and assignTaskAgent writes a foreign key from it.
  let parsed: { taskId: string; agentId: string }[] | undefined
  if (assignments !== undefined) {
    if (!Array.isArray(assignments)) {
      return Response.json({ error: '"assignments" must be an array' }, { status: 400 })
    }
    parsed = []
    for (const raw of assignments) {
      const a = raw as { taskId?: unknown; agentId?: unknown }
      if (typeof a?.taskId !== 'string' || typeof a?.agentId !== 'string') {
        return Response.json(
          { error: 'each assignment needs a string taskId and a string agentId' },
          { status: 400 },
        )
      }
      parsed.push({ taskId: a.taskId, agentId: a.agentId })
    }
  }

  try {
    const result = await approvePlan(id, { assignments: parsed })
    return Response.json({ ok: true, ...result })
  } catch (err) {
    if (err instanceof PlanApprovalError) {
      return Response.json({ error: err.message }, { status: err.status })
    }
    if (err instanceof MissionStoreError) {
      return Response.json({ error: err.message }, { status: 409 })
    }
    return Response.json(
      { error: err instanceof Error ? err.message : 'failed to approve the plan' },
      { status: 500 },
    )
  }
}
