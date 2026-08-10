'use client'

// Voice mode for the agent chat: hold to talk, release to send.
//
// ─── Push-to-talk, not always-listening ───────────────────────────────
// The mic opens while a button is held and closes when it is released. No wake
// word, no ambient capture. That is a deliberate limit, not a missing feature:
// an always-on mic in a dev tool is a recording device in a room, and the
// start/stop boundary is the only thing making it obvious when it is live.
//
// ─── Degrading loudly ─────────────────────────────────────────────────
// The Python environment behind this lives on /tmp and a Codespace restart
// wipes it, so unavailability is routine. The toggle checks first, disables
// itself, and shows the reason plus the command that fixes it. Silent failure
// here looks identical to a broken microphone.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Mic, Square, Volume2, VolumeX } from 'lucide-react'

interface VoiceStatus {
  available: boolean
  backend: string
  reason: string | null
  hint: string | null
}

export type VoiceMode = 'type' | 'voice'

export function VoiceControls({
  mode,
  onModeChange,
  onTranscript,
  speakingText,
  agentId,
  disabled,
}: {
  mode: VoiceMode
  onModeChange: (mode: VoiceMode) => void
  /** Called with the transcribed text once a recording is processed. */
  onTranscript: (text: string) => void
  /** Latest agent reply to read aloud, or null. */
  speakingText: string | null
  /** Whose voice to speak in. The server resolves it — see /api/voice/speak. */
  agentId?: string
  disabled?: boolean
}) {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [speakReplies, setSpeakReplies] = useState(true)
  // Reported by the server rather than assumed from the agent: if the backend
  // has no named voices, or the chosen one has left the catalog, this is what
  // actually spoke.
  const [spokenVoice, setSpokenVoice] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const spokenRef = useRef<string | null>(null)

  useEffect(() => {
    let live = true
    fetch('/api/voice', { cache: 'no-store' })
      .then((r) => r.json())
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus({ available: false, backend: 'kokoro', reason: 'could not reach the voice service', hint: null }))
    return () => {
      live = false
    }
  }, [])

  const transcribe = useCallback(
    async (blob: Blob) => {
      setBusy('transcribing…')
      setError(null)
      try {
        const form = new FormData()
        // The extension matters: Whisper reads the container via ffmpeg, which
        // sniffs the file, and a wrong name makes the failure obscure.
        form.append('audio', blob, blob.type.includes('mp4') ? 'recording.mp4' : 'recording.webm')
        const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form })
        const body = await res.json()
        if (!res.ok) throw new Error([body.error, body.hint].filter(Boolean).join(' — '))
        if (!body.text?.trim()) {
          setError('nothing was heard in that recording')
          return
        }
        onTranscript(body.text.trim())
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(null)
      }
    },
    [onTranscript],
  )

  async function startRecording() {
    if (recording || disabled) return
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data)
      recorder.onstop = () => {
        // Release the mic as soon as the take ends — leaving the track live
        // keeps the browser's recording indicator on and the device open.
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType })
        if (blob.size > 0) transcribe(blob)
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
    } catch (err) {
      setError(`microphone unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    recorderRef.current = null
    setRecording(false)
  }

  // Speak each new agent reply once. The ref guards against React re-running
  // this for the same text and talking over itself.
  useEffect(() => {
    if (mode !== 'voice' || !speakReplies || !speakingText || !status?.available) return
    if (spokenRef.current === speakingText) return
    spokenRef.current = speakingText

    let live = true
    setBusy('speaking…')
    fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: speakingText, agentId }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error([body.error, body.hint].filter(Boolean).join(' — ') || `HTTP ${res.status}`)
        }
        const voice = res.headers.get('X-Voice-Id')
        if (live) setSpokenVoice(voice && voice !== 'none' ? voice : null)
        const url = URL.createObjectURL(await res.blob())
        if (!live) return URL.revokeObjectURL(url)
        const audio = new Audio(url)
        audioRef.current = audio
        audio.onended = () => URL.revokeObjectURL(url)
        return audio.play()
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setBusy(null))
    return () => {
      live = false
    }
  }, [mode, speakReplies, speakingText, status?.available, agentId])

  const unavailable = status && !status.available

  return (
    <div className="border-t border-border px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {(['type', 'voice'] as VoiceMode[]).map((m) => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              disabled={m === 'voice' && !!unavailable}
              className={`rounded border px-2 py-1 font-mono text-[10px] transition-colors disabled:opacity-40 ${
                mode === m ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground'
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {mode === 'voice' && status?.available && (
          <>
            <button
              onMouseDown={startRecording}
              onMouseUp={stopRecording}
              onMouseLeave={() => recording && stopRecording()}
              onTouchStart={(e) => {
                e.preventDefault()
                startRecording()
              }}
              onTouchEnd={stopRecording}
              disabled={disabled || !!busy}
              className={`inline-flex items-center gap-1.5 rounded border px-3 py-1 font-mono text-[10px] transition-colors disabled:opacity-40 ${
                recording
                  ? 'border-red-500/50 bg-red-500/15 text-red-400'
                  : 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
              }`}
            >
              {recording ? <Square className="h-3 w-3" /> : <Mic className="h-3 w-3" />}
              {recording ? 'release to send' : 'hold to talk'}
            </button>

            <button
              onClick={() => {
                setSpeakReplies((v) => !v)
                if (audioRef.current) audioRef.current.pause()
              }}
              className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-primary"
            >
              {speakReplies ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
              {speakReplies ? 'replies spoken' : 'replies muted'}
            </button>

            <span className="font-mono text-[10px] text-muted-foreground">
              via {status.backend}
              {spokenVoice ? ` · ${spokenVoice}` : ''}
            </span>
          </>
        )}

        {busy && (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {busy}
          </span>
        )}
      </div>

      {unavailable && (
        // The whole point of checking up front: say what is wrong and what
        // fixes it, and leave Type working.
        <p className="mt-1 font-mono text-[10px] text-warning">
          voice unavailable — {status.reason}
          {status.hint ? ` · ${status.hint}` : ''} · type mode still works
        </p>
      )}
      {error && <p className="mt-1 font-mono text-[10px] text-red-400">{error}</p>}
    </div>
  )
}
