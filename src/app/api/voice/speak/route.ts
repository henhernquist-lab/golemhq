/**
 * /api/voice/speak — text in, audio out.
 *
 * Returns the audio bytes directly with their real content type so the client
 * can hand the response to an <audio> element without decoding anything. A
 * JSON envelope would mean base64 in and out of a string for no gain.
 *
 * The backend is chosen by src/lib/voice (Kokoro unless TTS_BACKEND says
 * otherwise), so neither this route nor the UI names an engine.
 *
 * ─── Who picks the voice ──────────────────────────────────────────────
 * `voiceId` wins when given — that is the picker's preview button, auditioning
 * a voice that is not assigned to anyone yet. Otherwise `agentId` resolves to
 * whatever that agent speaks in. Neither is required: a bare `text` still gets
 * spoken, in the fallback voice.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { speak, VoiceUnavailableError } from '@/lib/voice'
import { resolveAgentVoice } from '@/lib/voice/agent-voice'
import { isVoiceId } from '@/lib/voice/voices'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  let body: { text?: unknown; voiceId?: unknown; agentId?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) return Response.json({ error: 'text is required' }, { status: 400 })

  // Rejected rather than quietly ignored: a typo'd voice id that silently
  // played the default would look like the picker does not work.
  if (body.voiceId !== undefined && body.voiceId !== null && !isVoiceId(body.voiceId)) {
    return Response.json({ error: `unknown voice ${String(body.voiceId).slice(0, 40)}` }, { status: 400 })
  }

  try {
    let voice: string | null = isVoiceId(body.voiceId) ? body.voiceId : null
    if (!voice && typeof body.agentId === 'string' && body.agentId) {
      voice = (await resolveAgentVoice(body.agentId)).voice
    }

    const result = await speak(text, { voice })
    return new Response(new Uint8Array(result.audio), {
      headers: {
        'Content-Type': result.contentType,
        'Content-Length': String(result.audio.byteLength),
        // Surfaced as headers so the client can show which engine spoke and
        // how long it took without a second request.
        'X-Voice-Backend': result.backend,
        // 'none' rather than an omitted header: the UI needs to distinguish
        // "spoke as bm_george" from "this backend has no named voices".
        'X-Voice-Id': result.voice ?? 'none',
        'X-Voice-Duration-Ms': String(result.durationMs),
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    if (err instanceof VoiceUnavailableError) {
      return Response.json({ error: err.message, hint: err.hint }, { status: 503 })
    }
    return Response.json({ error: err instanceof Error ? err.message : 'synthesis failed' }, { status: 500 })
  }
}
