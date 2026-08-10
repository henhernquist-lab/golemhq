/**
 * /api/missions/chats/[id] — read a thread, or take one turn in it.
 *
 * POST runs the agent's real CLI, so it inherits that CLI's latency: a turn
 * involving file reads and a model round trip takes tens of seconds, not
 * milliseconds. maxDuration is set accordingly, and the client is expected to
 * show the turn as in-flight rather than to poll.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { chatHistory, sendChatMessage, structuredSupport, CHAT_REPO_PREFIX } from '@/lib/missions/agent-chat'
import { getAgentById, getMission } from '@/lib/missions/store'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

interface RouteCtx {
  params: Promise<{ id: string }>
}

function agentIdOf(repo: string): string | null {
  if (!repo.startsWith(CHAT_REPO_PREFIX)) return null
  return repo.slice(CHAT_REPO_PREFIX.length).split('/')[0] || null
}

export async function GET(_req: Request, ctx: RouteCtx) {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  const { id } = await ctx.params
  try {
    const mission = await getMission(id)
    if (!mission || !mission.repo.startsWith(CHAT_REPO_PREFIX)) {
      return Response.json({ error: 'Chat not found' }, { status: 404 })
    }
    const agentId = agentIdOf(mission.repo)
    const agent = agentId ? await getAgentById(agentId) : null

    return Response.json({
      chat: { id: mission.id, agentId, title: mission.goal, createdAt: mission.createdAt },
      agent,
      // The UI needs this before the first turn, so it can say up front that
      // this CLI will not report tool calls rather than after the fact.
      toolCallsSupported: agent ? structuredSupport(agent) : false,
      messages: await chatHistory(id),
    })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'failed to load chat' }, { status: 500 })
  }
}

export async function POST(req: Request, ctx: RouteCtx) {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  const { id } = await ctx.params

  let body: { content?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 })
  }
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  if (!content) return Response.json({ error: 'content is required' }, { status: 400 })

  try {
    const mission = await getMission(id)
    if (!mission || !mission.repo.startsWith(CHAT_REPO_PREFIX)) {
      return Response.json({ error: 'Chat not found' }, { status: 404 })
    }
    const agentId = agentIdOf(mission.repo)
    const agent = agentId ? await getAgentById(agentId) : null
    if (!agent) return Response.json({ error: 'The agent for this chat no longer exists' }, { status: 404 })

    const result = await sendChatMessage(id, agent, content, { cwd: process.cwd() })
    return Response.json(result)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'failed to send message' }, { status: 500 })
  }
}
