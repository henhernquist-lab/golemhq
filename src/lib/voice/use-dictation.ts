'use client'

// Dictation: microphone in, text out, locally.
//
// ─── Why this hook exists ─────────────────────────────────────────────
// Three surfaces take spoken input — the agent chat, Forge, and Shard — and
// they had three implementations, two of which used the browser's Web Speech
// API. That API is not local: Chrome streams the microphone to Google's
// servers and returns a transcript. Two mechanisms with different privacy
// properties behind identical-looking mic buttons is the thing to avoid, so
// there is now exactly one path and every mic button in the app goes through
// it: MediaRecorder → /api/voice/transcribe → Whisper, on this machine.
//
// ─── The cost, stated plainly ─────────────────────────────────────────
// The Web Speech API worked anywhere Chrome ran, including on Vercel. Whisper
// runs in a Python venv on the host, so dictation now works only where that
// venv exists. That is a deliberate trade — local transcription or none — and
// the reason `status` is part of this hook's contract rather than an
// afterthought: every caller must be able to say why the mic is disabled.

import { useCallback, useEffect, useRef, useState } from 'react'

export interface DictationStatus {
  available: boolean
  backend?: string
  reason: string | null
  hint: string | null
}

export interface Dictation {
  /** Null while the first availability check is in flight. */
  status: DictationStatus | null
  recording: boolean
  /** A short human-readable phase ("transcribing…"), or null when idle. */
  busy: string | null
  error: string | null
  start: () => Promise<void>
  stop: () => void
  /** For click-to-start / click-to-stop buttons. */
  toggle: () => void
}

export function useDictation(onTranscript: (text: string) => void): Dictation {
  const [status, setStatus] = useState<DictationStatus | null>(null)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const startingRef = useRef(false)
  const chunksRef = useRef<Blob[]>([])
  // Held in a ref so the MediaRecorder callbacks — which are bound once, at
  // start() — always call the caller's current handler rather than the one
  // captured when recording began.
  const handlerRef = useRef(onTranscript)
  useEffect(() => {
    handlerRef.current = onTranscript
  }, [onTranscript])

  useEffect(() => {
    let live = true
    fetch('/api/voice', { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!live) return
        // A non-OK response carries {error}, not {available}. Reading it as a
        // status object would leave `reason` undefined and render the useless
        // "voice unavailable — undefined".
        if (!res.ok) {
          setStatus({
            available: false,
            reason: body.error ?? `the voice service returned HTTP ${res.status}`,
            hint: body.hint ?? null,
          })
          return
        }
        setStatus({ available: !!body.available, backend: body.backend, reason: body.reason ?? null, hint: body.hint ?? null })
      })
      .catch(() => live && setStatus({ available: false, reason: 'could not reach the voice service', hint: null }))
    return () => {
      live = false
    }
  }, [])

  const transcribe = useCallback(async (blob: Blob) => {
    setBusy('transcribing…')
    setError(null)
    try {
      const form = new FormData()
      // The extension matters: Whisper reads the container via ffmpeg, which
      // sniffs the file, and a wrong name makes the failure obscure.
      form.append('audio', blob, blob.type.includes('mp4') ? 'recording.mp4' : 'recording.webm')
      const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error([body.error, body.hint].filter(Boolean).join(' — ') || `HTTP ${res.status}`)
      if (!body.text?.trim()) {
        setError('nothing was heard in that recording')
        return
      }
      handlerRef.current(body.text.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const start = useCallback(async () => {
    // Two guards, not one. getUserMedia is async and the permission prompt can
    // sit open for seconds, during which recorderRef is still null — so a
    // second click would open a second microphone stream that nothing ever
    // stops. The synchronous flag closes that window.
    if (recorderRef.current || startingRef.current) return
    startingRef.current = true
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
    } finally {
      startingRef.current = false
    }
  }, [transcribe])

  const stop = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    recorderRef.current = null
    setRecording(false)
  }, [])

  const toggle = useCallback(() => {
    // Clicks between "start requested" and "recorder exists" are dropped
    // rather than treated as a stop: stop() cannot cancel a recorder that has
    // not been created yet, so honouring the click would show a stopped mic
    // while the in-flight start went on to open one anyway.
    if (startingRef.current) return
    if (recorderRef.current) stop()
    else void start()
  }, [start, stop])

  // A component unmounting mid-take must not leave the microphone open.
  useEffect(() => () => {
    const recorder = recorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
    recorderRef.current = null
  }, [])

  return { status, recording, busy, error, start, stop, toggle }
}
