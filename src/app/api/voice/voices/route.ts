/**
 * /api/voice/voices — the voice catalog, plus who currently speaks in what.
 *
 * The picker needs both halves at once: the options, and the voice each agent
 * would use right now including the ones nobody has chosen. Serving only the
 * catalog would leave the UI unable to say whether "George" is Henry's choice
 * or just where the rotation landed — a distinction that decides whether
 * changing it is an edit or a first choice.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { listAgentIdsByCreation, listAgentVoices } from '@/lib/missions/store'
import { defaultVoiceFor, isVoiceId, VOICES } from '@/lib/voice/voices'
import { activeTtsBackend } from '@/lib/voice'

export const runtime = 'nodejs'
export const maxDuration = 30
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  const backend = activeTtsBackend()

  let assignments: { agentId: string; voice: string; source: 'chosen' | 'default' }[] = []
  try {
    const [chosen, order] = await Promise.all([listAgentVoices(), listAgentIdsByCreation()])
    assignments = order.map((agentId) => {
      const pick = chosen.get(agentId)
      return isVoiceId(pick)
        ? { agentId, voice: pick, source: 'chosen' as const }
        : { agentId, voice: defaultVoiceFor(agentId, order), source: 'default' as const }
    })
  } catch {
    // The catalog is still useful without assignments — previewing a voice
    // does not need the roster.
  }

  return Response.json({
    voices: VOICES,
    assignments,
    backend,
    // Fish Audio has its own voices and no mapping to Kokoro's, so a picker
    // shown while it is active would be choosing something with no effect.
    honoursVoiceId: backend === 'kokoro',
  })
}
