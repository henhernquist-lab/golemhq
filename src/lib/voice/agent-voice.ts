// Which voice a given agent speaks in.
//
// Kept out of src/lib/voice/index.ts on purpose: that module is pure audio and
// is imported by verification scripts that have no database. This is the one
// place the two worlds meet.

import { getAgentVoice, listAgentIdsByCreation } from '@/lib/missions/store'
import { defaultVoiceFor, isVoiceId, FALLBACK_VOICE } from './voices'

export interface ResolvedVoice {
  voice: string
  /** Chosen by Henry, or handed out by the rotation. Shown in the UI. */
  source: 'chosen' | 'default'
}

/**
 * Resolve an agent's voice, falling back through choice → rotation → fallback.
 *
 * The roster lookup costs a query on every spoken reply, which is nothing
 * beside the seconds Kokoro spends synthesising — and the alternative, caching
 * the rotation, would keep serving an agent the wrong voice after a new one
 * was hired.
 */
export async function resolveAgentVoice(agentId: string): Promise<ResolvedVoice> {
  const chosen = await getAgentVoice(agentId)
  if (isVoiceId(chosen)) return { voice: chosen, source: 'chosen' }

  try {
    const order = await listAgentIdsByCreation()
    return { voice: defaultVoiceFor(agentId, order), source: 'default' }
  } catch {
    // The roster query failing must not cost the agent its voice — it only
    // costs it a distinctive one.
    return { voice: FALLBACK_VOICE, source: 'default' }
  }
}
