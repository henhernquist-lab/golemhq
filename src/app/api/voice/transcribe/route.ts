/**
 * /api/voice/transcribe — recorded audio in, text out.
 *
 * Takes the raw blob MediaRecorder produced rather than a JSON-wrapped base64
 * string: a minute of audio is megabytes, and base64 inflates it by a third
 * for no benefit when the body can just be the bytes.
 *
 * Whisper on CPU takes tens of seconds for a short clip, hence maxDuration.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { transcribe, VoiceUnavailableError } from '@/lib/voice'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const MAX_BYTES = 25 * 1024 * 1024

export async function POST(req: Request) {
  const gate = await requireHenryOwner()
  if (gate.response) return gate.response

  const contentType = req.headers.get('content-type') ?? ''
  let audio: Buffer
  let filename = 'recording.webm'

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData()
      const file = form.get('audio')
      if (!(file instanceof Blob)) return Response.json({ error: 'no audio field in the form' }, { status: 400 })
      audio = Buffer.from(await file.arrayBuffer())
      if (file instanceof File && file.name) filename = file.name
    } else {
      audio = Buffer.from(await req.arrayBuffer())
    }
  } catch (err) {
    return Response.json({ error: `could not read the upload: ${String(err)}` }, { status: 400 })
  }

  if (audio.byteLength === 0) return Response.json({ error: 'the recording was empty' }, { status: 400 })
  if (audio.byteLength > MAX_BYTES) {
    return Response.json({ error: `recording is ${audio.byteLength} bytes, over the ${MAX_BYTES} cap` }, { status: 413 })
  }

  try {
    const result = await transcribe(audio, filename)
    return Response.json({ text: result.text, durationMs: result.durationMs, bytes: audio.byteLength })
  } catch (err) {
    // The hint is the useful half of an unavailability error — it says which
    // command fixes it. Losing it would leave the user with "voice failed".
    if (err instanceof VoiceUnavailableError) {
      return Response.json({ error: err.message, hint: err.hint }, { status: 503 })
    }
    return Response.json({ error: err instanceof Error ? err.message : 'transcription failed' }, { status: 500 })
  }
}
