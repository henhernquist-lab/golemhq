/**
 * /api/missions/agents/[id]/audit — actually invoke one agent's CLI and
 * record whether it genuinely works.
 *
 * Owner-gated like every other write here: this runs a real shell command on
 * the builder host, on Henry's credentials. maxDuration=300 matches the chat
 * route (src/app/api/missions/chats/[id]/route.ts) — a CLI turn can take a
 * couple of minutes and this is exactly that same runHeadless path.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { getAgentById } from '@/lib/missions/store'
import { runAgentAudit, recordAuditResult } from '@/lib/missions/functional-audit'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

interface RouteCtx {
  params: Promise<{ id: string }>
}

export async function POST(_req: Request, ctx: RouteCtx) {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  const { id } = await ctx.params

  try {
    const agent = await getAgentById(id)
    if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 })

    const audit = await runAgentAudit(agent)
    await recordAuditResult(audit)

    return Response.json({ audit })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'audit failed' }, { status: 500 })
  }
}
