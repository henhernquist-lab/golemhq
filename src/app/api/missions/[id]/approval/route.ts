/**
 * /api/missions/[id]/approval — the human decision point.
 *
 * Owner-gated, unlike the read-only mission routes: approving moves a real
 * branch in a real repository. A signed-in non-owner can watch a mission, not
 * land one.
 *
 * There is no repo-root resolver in this codebase — missions.repo is an
 * "owner/name" identifier, not a checkout path, and every existing caller
 * (scheduler, validator) takes `cwd` from whoever invoked it. So the checkout
 * comes from GOLEM_REPO_ROOT, and a missing one is reported rather than
 * guessed at: merging into the wrong checkout is not a failure worth being
 * clever about.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import {
  approveAndMerge,
  listPendingApprovals,
  purgeRejectedBranches,
  rejectTasks,
} from '@/lib/missions/approval'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

interface RouteCtx {
  params: Promise<{ id: string }>
}

function repoRoot(): string | null {
  return process.env.GOLEM_REPO_ROOT?.trim() || null
}

const NO_ROOT = {
  error:
    'GOLEM_REPO_ROOT is not set. The approval gate needs the local checkout to merge into; ' +
    'missions.repo is an identifier, not a path.',
}

export async function GET(req: Request, ctx: RouteCtx) {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  const { id } = await ctx.params
  const root = repoRoot()
  if (!root) return Response.json(NO_ROOT, { status: 503 })

  const target = new URL(req.url).searchParams.get('target') ?? 'main'
  try {
    return Response.json(await listPendingApprovals(id, root, target))
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'failed to read pending approvals' },
      { status: 500 },
    )
  }
}

export async function POST(req: Request, ctx: RouteCtx) {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  const { id } = await ctx.params
  const root = repoRoot()
  if (!root) return Response.json(NO_ROOT, { status: 503 })

  let body: { action?: string; taskIds?: unknown; targetBranch?: string; reason?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 })
  }

  const taskIds = Array.isArray(body.taskIds) ? body.taskIds.filter((t): t is string => typeof t === 'string') : []
  if (body.action !== 'purge' && taskIds.length === 0) {
    return Response.json({ error: 'taskIds must be a non-empty array' }, { status: 400 })
  }

  try {
    if (body.action === 'approve') {
      const result = await approveAndMerge(id, root, taskIds, { targetBranch: body.targetBranch })
      // A conflicted wave is a real answer, not a server error — the caller
      // has to render it as a blocking state, which it cannot do from a 500.
      return Response.json(result, { status: result.landed ? 200 : 409 })
    }
    if (body.action === 'reject') {
      return Response.json(await rejectTasks(id, root, taskIds, { reason: body.reason }))
    }
    if (body.action === 'purge') {
      return Response.json({ purged: await purgeRejectedBranches(id, root) })
    }
    return Response.json({ error: `unknown action "${body.action}"` }, { status: 400 })
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'approval action failed' },
      { status: 500 },
    )
  }
}
