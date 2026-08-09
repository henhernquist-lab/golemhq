/**
 * /api/missions/agents — hire a worker.
 *
 * The first write surface in the missions UI. Everything else there is a
 * viewer; this creates a row that the Scheduler will dispatch real work to, on
 * a machine with real credentials. So it is gated on the owner check rather
 * than on "is signed in", matching the cloud-terminal routes: the blast radius
 * of a stranger adding a layer-2 agent with a cli_command of their choosing is
 * arbitrary command execution on Henry's builder host.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { createAgent, recordDetection, type CreateAgentInput } from '@/lib/missions/store'
import { detectClis } from '@/lib/missions/cli-detect'
import { AGENT_LAYERS, type AgentLayer } from '@/lib/missions/types'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

interface HireBody {
  name?: unknown
  layer?: unknown
  cliCommand?: unknown
  instructions?: unknown
  enabled?: unknown
  /** Sweep the builder host straight after hiring, so the roster shows a real
   *  detected path instead of "never checked" until someone runs a script. */
  detect?: unknown
}

export async function POST(req: Request) {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  let body: HireBody
  try {
    body = (await req.json()) as HireBody
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return Response.json({ error: 'name is required' }, { status: 400 })

  const layer = Number(body.layer)
  if (!AGENT_LAYERS.includes(layer as AgentLayer)) {
    return Response.json({ error: `layer must be one of ${AGENT_LAYERS.join(', ')}` }, { status: 400 })
  }

  const input: CreateAgentInput = {
    name,
    layer: layer as AgentLayer,
    cliCommand: typeof body.cliCommand === 'string' ? body.cliCommand : null,
    instructions: typeof body.instructions === 'string' ? body.instructions : null,
    enabled: body.enabled !== false,
  }

  try {
    const agent = await createAgent(input)

    // Best-effort, and never allowed to turn a successful hire into an error:
    // the agent row exists either way, and a failed sweep just leaves the
    // roster saying "never checked", which is true.
    let detection: { ran: boolean; error: string | null } = { ran: false, error: null }
    if (body.detect === true && agent.layer === 2) {
      try {
        const report = await detectClis()
        await recordDetection(
          report.host,
          report.agents.map((d) => ({ agentId: d.agent.id, path: d.path, version: d.version })),
        )
        detection = { ran: true, error: report.warning }
      } catch (err) {
        detection = { ran: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    return Response.json({ agent, detection }, { status: 201 })
  } catch (err) {
    // createAgent's messages are written for a human reading a form — the
    // missing-migration one in particular tells them exactly what to run.
    return Response.json({ error: err instanceof Error ? err.message : 'failed to create agent' }, { status: 400 })
  }
}
