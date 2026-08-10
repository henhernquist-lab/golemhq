'use client'

// Pick the voice an agent speaks in — by ear, not by name.
//
// The preview button is the whole point. "af_bella" and "af_sarah" are not
// choosable from a dropdown; they are two strings. Synthesising a line on
// demand turns the list into something you can actually decide between, which
// is why the button synthesises rather than playing a bundled sample: a
// pre-recorded clip would eventually stop matching the model that speaks.
//
// Kokoro takes a couple of seconds on CPU, so previews are cached per voice for
// the life of the panel — auditioning six voices then going back to the second
// should not re-synthesise it.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Play, Volume2 } from 'lucide-react'

interface VoiceOption {
  id: string
  label: string
  accent: string
  gender: string
  note: string
}

const PREVIEW_LINE = 'Standing by. Tell me what you need built.'

export function VoicePicker({
  value,
  onChange,
  /** What this agent would use today if nothing is chosen, for the "keep default" option. */
  fallbackVoice,
}: {
  value: string | null
  onChange: (voiceId: string | null) => void
  fallbackVoice?: string | null
}) {
  const [voices, setVoices] = useState<VoiceOption[]>([])
  const [honoured, setHonoured] = useState(true)
  const [playing, setPlaying] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Object URLs are revoked on unmount, so an audition does not leak a blob per
  // click for the rest of the session.
  const cache = useRef<Map<string, string>>(new Map())
  const audio = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    let live = true
    fetch('/api/voice/voices', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body) => {
        if (!live) return
        setVoices(body.voices ?? [])
        setHonoured(body.honoursVoiceId !== false)
      })
      .catch(() => live && setError('could not load the voice catalog'))
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    // Captured in the effect body, not during render: the map identity is
    // stable for the component's life, and reading a ref while rendering is
    // the pattern that silently stops re-renders from seeing updates.
    const urls = cache.current
    const player = audio
    return () => {
      player.current?.pause()
      urls.forEach((url) => URL.revokeObjectURL(url))
      urls.clear()
    }
  }, [])

  const preview = useCallback(async (voiceId: string) => {
    setError(null)
    audio.current?.pause()
    setPlaying(voiceId)
    try {
      let url = cache.current.get(voiceId)
      if (!url) {
        const res = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: PREVIEW_LINE, voiceId }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error([body.error, body.hint].filter(Boolean).join(' — ') || `HTTP ${res.status}`)
        }
        url = URL.createObjectURL(await res.blob())
        cache.current.set(voiceId, url)
      }
      const el = new Audio(url)
      audio.current = el
      el.onended = () => setPlaying(null)
      await el.play()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPlaying(null)
    }
  }, [])

  const selected = value ?? ''

  return (
    <div className="flex flex-col gap-1 sm:col-span-2">
      <span className="font-mono text-[10px] uppercase text-muted-foreground">voice</span>

      <div className="flex flex-wrap gap-2">
        <select
          className="min-w-[16rem] flex-1 rounded border border-border bg-surface-base px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary/50"
          value={selected}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">
            no choice — use the rotation{fallbackVoice ? ` (${fallbackVoice})` : ''}
          </option>
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label} · {v.accent} {v.gender} — {v.note}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => preview(value || fallbackVoice || 'bm_george')}
          disabled={!!playing || voices.length === 0}
          className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-[10px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
        >
          {playing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          {playing ? 'speaking…' : 'preview'}
        </button>
      </div>

      {/* Auditioning the whole list without opening the dropdown ten times.
          Selecting is deliberately separate from hearing — clicking a chip
          plays it, it does not silently change the agent's voice. */}
      <div className="mt-1 flex flex-wrap gap-1">
        {voices.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => preview(v.id)}
            disabled={!!playing}
            title={`${v.note} — click to hear`}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors disabled:opacity-40 ${
              v.id === value ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-primary'
            }`}
          >
            {playing === v.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Volume2 className="h-2.5 w-2.5" />}
            {v.label}
          </button>
        ))}
      </div>

      {!honoured && (
        // Silence here would let Henry pick a voice, hear nothing change, and
        // conclude the picker is broken — when in fact TTS_BACKEND is the cause.
        <span className="font-mono text-[10px] text-warning">
          TTS_BACKEND is not kokoro — Fish Audio has its own voices, so this choice is stored but will not be heard
        </span>
      )}
      {error && <span className="font-mono text-[10px] text-red-400">{error}</span>}
    </div>
  )
}
