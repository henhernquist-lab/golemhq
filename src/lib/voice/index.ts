// Voice mode: speech in, speech out.
//
// ─── The environment this has to survive ──────────────────────────────
// Whisper and Kokoro are Python, and their packages live in a venv on /tmp
// because that is the only volume here with room (see scripts/setup-voice.sh).
// /tmp is wiped by a Codespace restart, so "the venv is missing" is a NORMAL
// state, not an exceptional one. Every entry point checks for it and returns a
// reason a human can act on, because voice mode failing silently — a mic
// button that records and produces nothing — is the worst outcome available.

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'

const execFileAsync = promisify(execFile)

export const VOICE_VENV = process.env.GOLEM_VOICE_VENV ?? '/tmp/golem-voice-venv'
const PYTHON = join(VOICE_VENV, 'bin', 'python')
const SETUP_HINT = 'run `bash scripts/setup-voice.sh` on the host (the venv lives on /tmp and a Codespace restart wipes it)'

/** Whisper base: 74M params, no GPU needed, good enough for dictation. */
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'base'
const KOKORO_VOICE = process.env.KOKORO_VOICE ?? 'af_heart'
const SAMPLE_RATE = 24_000

export class VoiceUnavailableError extends Error {
  readonly hint: string
  constructor(message: string, hint = SETUP_HINT) {
    super(message)
    this.name = 'VoiceUnavailableError'
    this.hint = hint
  }
}

export interface VoiceStatus {
  available: boolean
  stt: boolean
  tts: boolean
  backend: TtsBackendName
  reason: string | null
  hint: string | null
}

// ─── Readiness ─────────────────────────────────────────────────────────

/**
 * Whether voice can actually run right now.
 *
 * Imports the modules rather than checking that the directory exists: a
 * half-built venv from an interrupted install has all the right paths and
 * fails at the first import, which is exactly the failure this is meant to
 * catch before the user holds down a mic button.
 */
export async function voiceStatus(): Promise<VoiceStatus> {
  const backend = activeTtsBackend()
  if (!existsSync(PYTHON)) {
    return {
      available: false,
      stt: false,
      tts: backend === 'fish',
      backend,
      reason: `no Python environment at ${VOICE_VENV}`,
      hint: SETUP_HINT,
    }
  }
  try {
    await execFileAsync(PYTHON, ['-c', 'import whisper, kokoro, soundfile'], { timeout: 60_000 })
    return { available: true, stt: true, tts: true, backend, reason: null, hint: null }
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n').slice(-2).join(' ').trim() : String(err)
    return {
      available: false,
      stt: false,
      tts: backend === 'fish',
      backend,
      reason: `the voice environment is incomplete: ${detail.slice(0, 200)}`,
      hint: SETUP_HINT,
    }
  }
}

async function requirePython(): Promise<void> {
  const status = await voiceStatus()
  if (!status.available) throw new VoiceUnavailableError(status.reason ?? 'voice is unavailable')
}

// ─── Speech → text ─────────────────────────────────────────────────────

export interface TranscriptionResult {
  text: string
  durationMs: number
}

/**
 * Transcribe recorded audio.
 *
 * The browser hands over whatever MediaRecorder produced — webm/opus in
 * Chrome, mp4 in Safari — and Whisper reads it via ffmpeg, so the container
 * format is not this function's problem as long as the bytes are intact.
 */
export async function transcribe(audio: Buffer, filename = 'recording.webm'): Promise<TranscriptionResult> {
  await requirePython()
  if (audio.byteLength === 0) throw new VoiceUnavailableError('the recording was empty', 'hold the mic button while speaking')

  const dir = await mkdtemp(join(tmpdir(), 'golem-stt-'))
  const audioPath = join(dir, filename)
  const started = Date.now()
  try {
    await writeFile(audioPath, audio)
    // fp16=False because this is CPU: half precision there is both unsupported
    // and slower, and whisper warns about it on every call otherwise.
    const script = `
import json, sys, whisper
model = whisper.load_model(${JSON.stringify(WHISPER_MODEL)})
result = model.transcribe(sys.argv[1], fp16=False)
print("__GOLEM_STT__" + json.dumps({"text": result["text"]}))
`.trim()
    const { stdout } = await execFileAsync(PYTHON, ['-c', script, audioPath], {
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    const line = stdout.split('\n').find((l) => l.startsWith('__GOLEM_STT__'))
    if (!line) throw new VoiceUnavailableError('Whisper produced no transcript')
    const { text } = JSON.parse(line.slice('__GOLEM_STT__'.length)) as { text: string }
    return { text: text.trim(), durationMs: Date.now() - started }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ─── Text → speech ─────────────────────────────────────────────────────
//
// One interface, two backends. Kokoro is the default because it is local,
// unlimited and free; Fish Audio is kept behind the same shape so it can be
// swapped in for its streaming latency without touching a caller. Neither is
// hard-coded into the routes or the UI.

export type TtsBackendName = 'kokoro' | 'fish'

export interface SpeechResult {
  audio: Buffer
  /** MIME type of `audio`, for the browser to play directly. */
  contentType: string
  backend: TtsBackendName
  durationMs: number
}

export interface TtsBackend {
  readonly name: TtsBackendName
  readonly available: () => Promise<boolean>
  readonly speak: (text: string) => Promise<SpeechResult>
}

export function activeTtsBackend(): TtsBackendName {
  return process.env.TTS_BACKEND === 'fish' ? 'fish' : 'kokoro'
}

const kokoroBackend: TtsBackend = {
  name: 'kokoro',
  available: async () => (await voiceStatus()).available,
  async speak(text: string): Promise<SpeechResult> {
    await requirePython()
    const started = Date.now()
    const dir = await mkdtemp(join(tmpdir(), 'golem-tts-'))
    const outPath = join(dir, 'speech.wav')
    try {
      // Kokoro yields one chunk per sentence-ish segment; they are concatenated
      // rather than played in sequence so the browser gets a single file it can
      // seek and replay.
      const script = `
import sys, numpy as np, soundfile as sf
from kokoro import KPipeline
text, out = sys.argv[1], sys.argv[2]
pipe = KPipeline(lang_code='a')
chunks = [audio for _, _, audio in pipe(text, voice=${JSON.stringify(KOKORO_VOICE)})]
if not chunks:
    raise SystemExit("kokoro produced no audio")
sf.write(out, np.concatenate(chunks) if len(chunks) > 1 else chunks[0], ${SAMPLE_RATE})
`.trim()
      await execFileAsync(PYTHON, ['-c', script, text, outPath], {
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      const audio = await readFile(outPath)
      if (audio.byteLength < 100) throw new VoiceUnavailableError('Kokoro wrote an empty audio file')
      return { audio, contentType: 'audio/wav', backend: 'kokoro', durationMs: Date.now() - started }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
}

/**
 * Fish Audio Pro 2.1 through OpenRouter. Present and wired, not the default.
 *
 * Kept because Kokoro is local and unlimited while this costs a quota and a
 * round trip; it earns its place only if streaming latency turns out to matter.
 */
const fishBackend: TtsBackend = {
  name: 'fish',
  available: async () => !!process.env.FISHPRO_API_KEY,
  async speak(text: string): Promise<SpeechResult> {
    const key = process.env.FISHPRO_API_KEY
    if (!key) throw new VoiceUnavailableError('FISHPRO_API_KEY is not set', 'add FISHPRO_API_KEY, or leave TTS_BACKEND unset to use Kokoro')
    const started = Date.now()
    const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fishaudio/fish-speech-pro-2.1', input: text, response_format: 'mp3' }),
    })
    if (!res.ok) {
      throw new VoiceUnavailableError(`Fish Audio returned ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    return {
      audio: Buffer.from(await res.arrayBuffer()),
      contentType: 'audio/mpeg',
      backend: 'fish',
      durationMs: Date.now() - started,
    }
  },
}

const BACKENDS: Record<TtsBackendName, TtsBackend> = { kokoro: kokoroBackend, fish: fishBackend }

export function ttsBackend(name: TtsBackendName = activeTtsBackend()): TtsBackend {
  return BACKENDS[name]
}

export async function speak(text: string, name: TtsBackendName = activeTtsBackend()): Promise<SpeechResult> {
  const trimmed = text.trim()
  if (!trimmed) throw new VoiceUnavailableError('nothing to speak')
  // Long replies would take minutes to synthesise and longer to listen to.
  // Truncated at a sentence boundary where possible so it does not cut mid-word.
  const capped = trimmed.length > 1200 ? `${trimmed.slice(0, 1200).replace(/\s+\S*$/, '')}…` : trimmed
  return ttsBackend(name).speak(capped)
}
