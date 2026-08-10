/**
 * /api/missions/chats — list and open conversations with an agent.
 *
 * Owner-gated on both verbs. Opening a chat is cheap, but it exists only to be
 * sent to, and sending runs a CLI on the builder host — so the gate lives at
 * the entrance rather than one door further in.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { createChat, CHAT_REPO_PREFIX } from '@/lib/missions/agent-chat'
import { getAgentById, listMissions } from '@/lib/missions/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** `chat/<agentId>/<timestamp>` — see agent-chat.ts. */
function agentIdOf(repo: string): string | null {
  if (!repo.startsWith(CHAT_REPO_PREFIX)) return null
  return repo.slice(CHAT_REPO_PREFIX.length).split('/')[0] || null
}

export async function GET(req: Request) {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  const agentId = new URL(req.url).searchParams.get('agentId')

  try {
    // Chats live in the missions table, so they have to be filtered back out
    // of it — otherwise every conversation would show up on the mission
    // dashboard as a mission, which is not what it is.
    const chats = (await listMissions())
      .filter((m) => m.repo.startsWith(CHAT_REPO_PREFIX))
      .map((m) => ({
        id: m.id,
        agentId: agentIdOf(m.repo),
        title: m.goal,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      }))
      .filter((c) => (agentId ? c.agentId === agentId : true))

    return Response.json({ chats })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'failed to list chats' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  let body: { agentId?: unknown; title?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const agentId = typeof body.agentId === 'string' ? body.agentId : ''
  if (!agentId) return Response.json({ error: 'agentId is required' }, { status: 400 })

  try {
    const agent = await getAgentById(agentId)
    if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 })
    if (!agent.cliCommand) {
      // Layer 1 and 3 agents have no CLI to talk to. Said plainly rather than
      // opening a chat that can never produce a reply.
      return Response.json(
        { error: `${agent.name} has no cli_command — only agents backed by a CLI can be chatted with.` },
        { status: 400 },
      )
    }

    const chat = await createChat(agent, typeof body.title === 'string' ? body.title : '')
    return Response.json({ chat }, { status: 201 })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'failed to open chat' }, { status: 500 })
  }
}
