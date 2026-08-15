'use client'

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { StickyNote, Plus, X, Loader2, ChevronRight, Link2 } from 'lucide-react'
import { saveResource } from '@/lib/resources'
import { extractUrls, urlLabel } from '@/lib/note-links'

function noteTitle(content: string): string {
  const firstLine = content.trimStart().split('\n')[0].replace(/\s+/g, ' ')
  return firstLine.length > 50 ? `${firstLine.slice(0, 50)}…` : firstLine || 'Quick note'
}

export function GrimoireFloatingPanel() {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [committing, setCommitting] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const detectedUrls = useMemo(() => extractUrls(content), [content])

  // Non-modal: no backdrop to block the rest of the app, so closing on an
  // outside click needs its own listener, scoped to the panel ref — the same
  // pattern the sidebar's demoted-nav dropdown uses. The toggle button is
  // excluded too, or a click on it while open would close via this handler
  // and immediately reopen via its own onClick.
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (toggleRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Load draft when opening
  useEffect(() => {
    if (!open) return
    ;(async () => {
      setLoading(true)
      try {
        const res = await fetch('/api/notes/draft')
        const data = await res.json()
        if (data.exists) setContent(data.content)
      } catch {
        // silently fail
      } finally {
        setLoading(false)
      }
    })()
  }, [open])

  // Focus textarea when panel opens
  useEffect(() => {
    if (open && !loading) {
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
  }, [open, loading])

  // Save draft (debounced autosave)
  const saveDraft = useCallback(async (text: string) => {
    setSaving(true)
    try {
      await fetch('/api/notes/draft', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      })
      // Notify other components about the draft change
      window.dispatchEvent(new CustomEvent('grimoire:draft-changed'))
    } catch {
      // silently fail
    } finally {
      setSaving(false)
    }
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setContent(text)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => saveDraft(text), 600)
  }

  // New Note: commit current draft, clear surface
  const handleNewNote = async () => {
    if (!content.trim()) return
    setCommitting(true)
    try {
      const title = noteTitle(content)
      await saveResource('note', title, { content: content.trim() })
      await fetch('/api/notes/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'commit' }),
      })
      setContent('')
      window.dispatchEvent(new CustomEvent('grimoire:note-saved'))
      window.dispatchEvent(new CustomEvent('grimoire:draft-changed'))
    } catch {
      // silently fail
    } finally {
      setCommitting(false)
    }
  }

  // Cleanup debounce
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // Listen for external draft changes
  useEffect(() => {
    if (!open) return
    const handler = () => {
      fetch('/api/notes/draft')
        .then((r) => r.json())
        .then((d) => setContent(d.content ?? ''))
        .catch(() => {})
    }
    window.addEventListener('grimoire:draft-changed', handler)
    return () => window.removeEventListener('grimoire:draft-changed', handler)
  }, [open])

  return (
    <>
      {/* Toggle button — fixed position, bottom-right */}
      <button
        ref={toggleRef}
        onClick={() => setOpen((prev) => !prev)}
        className="fixed bottom-5 right-5 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-primary/30 bg-surface-secondary shadow-lg transition-all hover:border-primary/50 hover:bg-surface-elevated hover:shadow-xl"
        aria-label={open ? 'Close The Grimoire' : 'Open The Grimoire'}
      >
        <StickyNote className="h-4 w-4 text-primary" />
      </button>

      {/* Floating panel — non-modal by design: no backdrop, so the rest of
          the app stays visible and usable while notes are open. */}
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="fixed bottom-16 right-5 z-50 w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface-secondary shadow-2xl"
          >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <StickyNote className="h-3.5 w-3.5 text-primary" />
                  <span className="font-display text-sm font-semibold text-foreground">
                    The Grimoire
                  </span>
                  <span className="font-mono text-[9px] text-muted-foreground">
                    quick note
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Link
                    href="/grimoire"
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-primary transition-colors"
                  >
                    Open full
                    <ChevronRight className="h-3 w-3" />
                  </Link>
                  <button
                    onClick={() => setOpen(false)}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Body */}
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="p-3">
                  <textarea
                    ref={textareaRef}
                    value={content}
                    onChange={handleChange}
                    placeholder="Start writing — it stays here across pages…"
                    rows={8}
                    className="w-full resize-none rounded border border-border bg-surface-base px-3 py-2.5 text-[13px] leading-relaxed text-foreground placeholder-muted-foreground/40 focus:border-primary/40 focus:outline-none"
                    style={{
                      lineHeight: '1.75rem',
                      backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent calc(1.75rem - 1px), rgba(184, 147, 90, 0.06) calc(1.75rem - 1px), rgba(184, 147, 90, 0.06) 1.75rem)',
                      backgroundSize: '100% 1.75rem',
                      backgroundAttachment: 'local',
                      paddingTop: 'calc(0.6rem + 2px)',
                    }}
                  />

                  {/* Detected links */}
                  {detectedUrls.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Link2 className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                      {detectedUrls.map((url) => (
                        <a
                          key={url}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate rounded border border-border/60 px-1.5 py-0.5 font-mono text-[9px] text-accent hover:border-accent/50 hover:underline max-w-[160px]"
                          title={url}
                        >
                          {urlLabel(url)}
                        </a>
                      ))}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="mt-2.5 flex items-center justify-between">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {saving ? 'saving…' : content ? 'draft saved' : ''}
                    </span>
                    <button
                      onClick={handleNewNote}
                      disabled={committing || !content.trim()}
                      className="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1 font-mono text-[10px] text-primary hover:bg-primary/20 transition-colors disabled:opacity-40"
                    >
                      {committing ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Plus className="h-3 w-3" />
                      )}
                      New Note
                    </button>
                  </div>
                </div>
              )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
