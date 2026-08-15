'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowLeft,
  Wand2,
  Send,
  Loader2,
  Copy,
  Check,
  BookMarked,
  Library,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────

type ChatLine =
  | { kind: 'system'; text: string }
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'error'; text: string }

const PHASE_ZERO_LINE =
  "What's the prompt for? Tell me the goal, who or what runs it, and anything it must or must not do — I'll handle the rest."

// ─── Component ────────────────────────────────────────────────────────────

function ArchitectPageInner() {
  const { status } = useSession()
  const router = useRouter()

  const [lines, setLines] = useState<ChatLine[]>([
    { kind: 'assistant', text: PHASE_ZERO_LINE },
  ])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [copied, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [lines])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || running) return
    setInput('')
    setRunning(true)
    setLines((l) => [...l, { kind: 'user', text }])
    setSaveStatus('idle')

    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const res = await fetch('/api/architect/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            ...lines
              .filter((l) => l.kind === 'user' || l.kind === 'assistant')
              .map((l) => ({ role: l.kind === 'user' ? 'user' : 'assistant', content: l.text })),
            { role: 'user', content: text },
          ],
        }),
        signal: ctrl.signal,
      })

      if (!res.ok) {
        const contentType = res.headers.get('content-type') ?? ''
        let message = `Request failed (HTTP ${res.status})`
        if (contentType.includes('application/json')) {
          const parsed = await res.json().catch(() => null) as { error?: string } | null
          if (parsed?.error) message = parsed.error
        } else {
          // Never render a framework-generated HTML error document as text.
          // The endpoint should return JSON, but this keeps a stale deployment
          // or an upstream proxy failure from turning markup into chat output.
          message = res.status >= 500
            ? 'The Prompt Engineer server hit an unexpected error. Try again shortly.'
            : 'The Prompt Engineer request was rejected. Check the prompt and try again.'
        }
        setLines((l) => [...l, { kind: 'error', text: message }])
        setRunning(false)
        return
      }

      // SSE streaming reader
      const reader = res.body?.getReader()
      if (!reader) {
        setLines((l) => [...l, { kind: 'error', text: 'No response body' }])
        setRunning(false)
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''
      let fullText = ''

      // Add an empty assistant placeholder we'll update
      setLines((l) => [...l, { kind: 'assistant', text: '' }])

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines_ = buffer.split('\n')
        buffer = lines_.pop() || ''

        for (const line of lines_) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]' || data === '') continue

          try {
            const parsed = JSON.parse(data)
            // AI SDK v3 SSE format: { type: 'text-delta', textDelta: '...' }
            if (parsed.type === 'text-delta' && typeof parsed.textDelta === 'string') {
              fullText += parsed.textDelta
              setLines((l) => {
                const updated = [...l]
                const last = updated[updated.length - 1]
                if (last.kind === 'assistant') {
                  updated[updated.length - 1] = { kind: 'assistant', text: fullText }
                }
                return updated
              })
            }
            // End of stream: { type: 'finish' }
            if (parsed.type === 'finish') {
              // Complete
            }
            // Error: { type: 'error', error: '...' }
            if (parsed.type === 'error') {
              setLines((l) => [...l.slice(0, -1), { kind: 'error', text: parsed.error || 'Stream error' }])
            }
          } catch {
            // Non-JSON line, skip
          }
        }
      }

      // Auto-save on completion
      if (fullText && fullText.length > 50) {
        setSaveStatus('saving')
        const codeBlockMatch = fullText.match(/```[\s\S]*?```/)
        const body = codeBlockMatch
          ? codeBlockMatch[0].replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim()
          : fullText.slice(0, 500)
        const titleBase = text.slice(0, 50)
        const title = `Architect: ${titleBase}`.slice(0, 200)

        try {
          const saveRes = await fetch('/api/resources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'prompt',
              title,
              payload: {
                body,
                category: 'general',
                tags: ['architect', 'ai-generated'],
                notes: `Generated by Prompt Architect on ${new Date().toLocaleDateString()}`,
              },
            }),
          })
          if (saveRes.ok) {
            setSaveStatus('saved')
            setTimeout(() => setSaveStatus('idle'), 2000)
          } else {
            setSaveStatus('idle')
          }
        } catch {
          setSaveStatus('idle')
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        setLines((l) => [...l, { kind: 'error', text: 'Request cancelled' }])
      } else {
        setLines((l) => [...l, { kind: 'error', text: 'Network error — retry' }])
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }, [input, lines, running])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleCopyLast = async () => {
    const lastAssistant = [...lines].reverse().find((l) => l.kind === 'assistant')
    if (!lastAssistant) return
    try {
      await navigator.clipboard.writeText(lastAssistant.text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = lastAssistant.text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleManualSave = async () => {
    const lastAssistant = [...lines].reverse().find((l) => l.kind === 'assistant')
    if (!lastAssistant || lastAssistant.text.length < 50) return
    setSaveStatus('saving')

    const text = lastAssistant.text
    const codeBlockMatch = text.match(/```[\s\S]*?```/)
    const body = codeBlockMatch
      ? codeBlockMatch[0].replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim()
      : text.slice(0, 500)
    const titleBase = 'Prompt Architect output'
    const title = `Architect: ${titleBase}`.slice(0, 200)

    try {
      const res = await fetch('/api/resources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'prompt',
          title,
          payload: {
            body,
            category: 'general',
            tags: ['architect', 'ai-generated'],
            notes: `Generated by Prompt Architect on ${new Date().toLocaleDateString()}`,
          },
        }),
      })
      if (res.ok) {
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } else {
        setSaveStatus('idle')
      }
    } catch {
      setSaveStatus('idle')
    }
  }

  const messageCount = lines.filter((l) => l.kind === 'user').length
  const lastAssistant = [...lines].reverse().find((l) => l.kind === 'assistant')
  const hasDeliverable = lastAssistant &&
    lastAssistant.text !== PHASE_ZERO_LINE &&
    lastAssistant.text.length > 100

  const isLoading = status === 'loading'
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-background font-sans">
      {/* Header */}
      <header className="flex h-10 flex-shrink-0 items-center gap-3 border-b border-border bg-background px-4">
        <Link
          href="/"
          className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> Home
        </Link>
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">
          <Wand2 className="h-3 w-3 text-primary/70" /> Architect
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50">
          Prompt engineering mode
        </span>

        <div className="ml-auto flex items-center gap-2">
          {/* Save to library */}
          <button
            onClick={handleManualSave}
            disabled={!hasDeliverable || saveStatus === 'saving'}
            className={`flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-all ${
              saveStatus === 'saved'
                ? 'border-primary/40 bg-primary/15 text-primary'
                : hasDeliverable
                  ? 'border-border bg-surface-secondary text-muted-foreground hover:border-primary/30 hover:text-primary'
                  : 'border-border bg-surface-secondary text-muted-foreground/40 cursor-not-allowed'
            }`}
            title="Save to Prompt Library"
          >
            {saveStatus === 'saving' ? (
              <><Loader2 className="h-3 w-3 animate-spin" /> Saving</>
            ) : saveStatus === 'saved' ? (
              <><Check className="h-3 w-3" /> Saved</>
            ) : (
              <><BookMarked className="h-3 w-3" /> Save</>
            )}
          </button>

          {/* Copy */}
          <button
            onClick={handleCopyLast}
            disabled={!hasDeliverable}
            className={`flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-all ${
              copied
                ? 'border-primary/40 bg-primary/15 text-primary'
                : hasDeliverable
                  ? 'border-border bg-surface-secondary text-muted-foreground hover:border-primary/30 hover:text-primary'
                  : 'border-border bg-surface-secondary text-muted-foreground/40 cursor-not-allowed'
            }`}
            title="Copy last response"
          >
            {copied ? <><Check className="h-3 w-3" /> Copied</> : <><Copy className="h-3 w-3" /> Copy</>}
          </button>

          {/* Link to prompt library */}
          <Link
            href="/prompts"
            className="flex items-center gap-1.5 rounded border border-border bg-surface-secondary px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
            title="Open Prompt Library"
          >
            <Library className="h-3 w-3" /> Library
          </Link>
        </div>
      </header>

      {/* Chat area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-hidden">
        <div className="mx-auto max-w-[780px] px-8 py-6">
          {lines.map((line, i) => {
            const isIntake = line.kind === 'assistant' && i === 0

            if (line.kind === 'system') {
              return (
                <div key={i} className="mb-3 border-l-2 border-muted-foreground/20 pl-3">
                  <p className="font-mono text-[11px] leading-relaxed text-muted-foreground/60">{line.text}</p>
                </div>
              )
            }

            if (line.kind === 'user') {
              return (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-5"
                >
                  <div className="border-l-2 border-primary/40 pl-4">
                    <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50">You</div>
                    <p className="font-sans text-[14px] leading-relaxed text-foreground">{line.text}</p>
                  </div>
                </motion.div>
              )
            }

            if (line.kind === 'assistant') {
              return (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: 0.1 }}
                  className="mb-5"
                >
                  <div
                    className={`border-l-2 ${
                      isIntake ? 'border-muted-foreground/20' : 'border-accent/40'
                    } pl-4`}
                  >
                    <div
                      className={`mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider ${
                        isIntake ? 'text-muted-foreground/50' : 'text-accent'
                      }`}
                    >
                      <Wand2 className="h-3 w-3" />
                      {isIntake ? 'Intake' : 'Prompt Engineer'}
                    </div>
                    <div className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-foreground">
                      {line.text}
                    </div>
                  </div>
                </motion.div>
              )
            }

            if (line.kind === 'error') {
              return (
                <div key={i} className="mb-4">
                  <div className="border-l-2 border-destructive/40 pl-4">
                    <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-destructive/60">Error</div>
                    <p className="font-mono text-[12px] leading-relaxed text-destructive">{line.text}</p>
                  </div>
                </div>
              )
            }

            return null
          })}

          {/* Running indicator */}
          <AnimatePresence>
            {running && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="mb-4 flex items-center gap-2"
              >
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/40" />
                <span className="font-mono text-[11px] text-muted-foreground/40">thinking…</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Empty state hint — only when no user messages yet */}
          {messageCount === 0 && (
            <div className="mt-12 text-center">
              <Wand2 className="mx-auto h-5 w-5 text-muted-foreground/30" />
              <p className="mt-3 font-sans text-[13px] text-muted-foreground/50">
                Describe what you need a prompt for — the Architect will design it.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div className="flex-shrink-0 border-t border-border bg-background px-4 py-3">
        <div className="mx-auto max-w-[820px]">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                messageCount === 0
                  ? 'e.g. "I need a prompt that grades student essays on argument quality and clarity"'
                  : 'Describe, iterate, or ask for changes…'
              }
              rows={1}
              spellCheck={false}
              disabled={running}
              onKeyDown={handleKeyDown}
              className="flex-1 resize-none rounded border border-border bg-surface-secondary px-3 py-2 font-mono text-[13px] leading-relaxed text-foreground placeholder-muted-foreground/40 focus:border-primary/30 focus:outline-none disabled:opacity-40 min-h-[44px]"
              style={{ maxHeight: '200px' }}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || running}
              className={`flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded border transition-colors disabled:opacity-30 ${
                input.trim() && !running
                  ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
                  : 'border-border bg-surface-secondary text-muted-foreground hover:border-primary/30 hover:text-primary'
              }`}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ArchitectPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center bg-background">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <ArchitectPageInner />
    </Suspense>
  )
}
