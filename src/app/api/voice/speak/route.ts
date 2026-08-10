/**
 * /api/voice/speak — text in, audio out.
 *
 * Returns the audio bytes directly with their real content type so the client
 * can hand the response to an <audio> element without decoding anything. A
 * JSON envelope would mean base64 in and out of a string for no gain.
 *
 * The backend is chosen by src/lib/voice (Kokoro unless TTS_BACKEND says
 * otherwise), so neither this route nor the UI names an engine.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { speak, VoiceUnavailableError } from '@/lib/voice'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  let body: { text?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) return Response.json({ error: 'text is required' }, { status: 400 })

  try {
    const result = await speak(text)
    return new Response(new Uint8Array(result.audio), {
      headers: {
        'Content-Type': result.contentType,
        'Content-Length': String(result.audio.byteLength),
        // Surfaced as headers so the client can show which engine spoke and
        // how long it took without a second request.
        'X-Voice-Backend': result.backend,
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
