/**
 * /api/missions/agents/[id] — edit a worker.
 *
 * Owner-gated for the same reason as hiring: changing an existing agent's
 * cli_command is exactly as powerful as creating one, and changing its
 * instructions changes what every future task it runs is told to do.
 *
 * PATCH semantics throughout — an absent field is left alone, and `null` on
 * instructions or cliCommand clears it. A PUT that silently blanked whatever
 * the form did not send would erase standing instructions on every enable /
 * disable toggle.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { getAgentById, recordDetection, updateAgent, type UpdateAgentInput } from '@/lib/missions/store'
import { detectClis } from '@/lib/missions/cli-detect'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

// Detection sweeps every layer-2 row and returns a report; persisting it is
// a separate step (see scripts/detect-clis.mjs), so both happen here. The
// sweep is repo-wide rather than per-agent because that is the only shape
// cli-detect offers, and one extra shell round trip is cheaper than a second
// detection path that could disagree with the first.
async function runDetection(): Promise<{ ran: boolean; error: string | null }> {
  const report = await detectClis()
  await recordDetection(
    report.host,
    report.agents.map((d) => ({ agentId: d.agent.id, path: d.path, version: d.version })),
  )
  return { ran: true, error: report.warning }
}

interface RouteCtx {
  params: Promise<{ id: string }>
}

interface PatchBody {
  name?: unknown
  cliCommand?: unknown
  instructions?: unknown
  enabled?: unknown
  /** Run CLI detection right after saving, so the roster stops saying "never checked". */
  detect?: unknown
}

export async function PATCH(req: Request, ctx: RouteCtx) {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  const { id } = await ctx.params

  let body: PatchBody
  try {
    body = (await req.json()) as PatchBody
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const patch: UpdateAgentInput = {}
  if (typeof body.name === 'string') patch.name = body.name
  if (typeof body.cliCommand === 'string' || body.cliCommand === null) {
    patch.cliCommand = body.cliCommand as string | null
  }
  if (typeof body.instructions === 'string' || body.instructions === null) {
    patch.instructions = body.instructions as string | null
  }
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled

  try {
    const existing = await getAgentById(id)
    if (!existing) return Response.json({ error: 'Agent not found' }, { status: 404 })

    const agent = await updateAgent(id, patch)

    // Detection is best-effort: it shells out to the builder host and can take
    // ten seconds or fail outright. A save that succeeded must not be reported
    // as a failure because the optional follow-up did not work.
    let detection: { ran: boolean; error: string | null } = { ran: false, error: null }
    if (body.detect === true) {
      try {
        detection = await runDetection()
      } catch (err) {
        detection = { ran: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    return Response.json({ agent, detection })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'failed to update agent' }, { status: 400 })
  }
}
