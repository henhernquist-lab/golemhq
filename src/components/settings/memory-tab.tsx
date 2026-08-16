'use client'

// The merged Memory section of /settings (previously three separate places:
// the two-textarea /resources/memory page, the richer but unlinked /memory
// page, and nothing surfacing auto-captured facts at all). One store now
// (resources, type='memory'), one UI: quick-add, search/list/edit/delete,
// import from another AI, and — new — a review queue for auto-captured
// facts (chat-extracted, already live; Lab-extracted, manually triggered
// here) with explicit Accept/Reject actions so nothing becomes "what Golem
// knows" without a human looking at it first.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Brain, Search, X, Trash2, Loader2, Import, AlertCircle, Sparkles,
  Pencil, Save, Check, MessageSquare, FlaskConical, Wand2,
} from 'lucide-react'
import type { Resource, MemoryPayload } from '@/lib/resources'

type MemoryResource = Resource<MemoryPayload>

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function sourceLabel(m: MemoryResource): string {
  const p = m.payload
  if (p.imported) return p.origin ? `imported · ${p.origin}` : 'imported'
  if (p.autoCaptured) {
    const cat = p.activityCategory === 'lab' ? 'lab' : 'chat'
    return p.reviewState === 'pending' ? `auto · ${cat} · review` : `auto · ${cat} · accepted`
  }
  return 'manual'
}

// ─── Import modal (unchanged from the old /memory page) ────────────────────

const ORIGINS = ['ChatGPT', 'Claude', 'Gemini', 'Other']

function ImportMemoryModal({ onClose, onImported }: { onClose: () => void; onImported: (m: MemoryResource) => void }) {
  const [content, setContent] = useState('')
  const [origin, setOrigin] = useState<string>(ORIGINS[0])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (e.target === backdropRef.current) onClose() }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSubmit = useCallback(async () => {
    const text = content.trim()
    if (!text) { setError('Paste something to import.'); return }
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, origin, imported: true }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Import failed.'); setSaving(false); return }
      onImported(data.memory as MemoryResource)
      onClose()
    } catch {
      setError('Network error. Try again.'); setSaving(false)
    }
  }, [content, origin, onImported, onClose])

  return (
    <motion.div ref={backdropRef} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center">
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
        transition={{ type: 'spring', stiffness: 300, damping: 28 }}
        className="w-full max-w-2xl rounded-t border border-border bg-surface-secondary p-6 sm:rounded">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Import className="h-4 w-4 text-primary" /> Import Memory from Other AIs
          </h2>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-surface-elevated hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          Paste memory, custom instructions, or context exported from another AI. Golem will store it and use it going forward.
        </p>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Source</label>
            <select value={origin} onChange={(e) => setOrigin(e.target.value)}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-2 text-sm text-foreground focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30">
              {ORIGINS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Memory / context</label>
            <textarea value={content} onChange={(e) => setContent(e.target.value)}
              placeholder="Paste exported memory, custom instructions, or context here…" rows={10} autoFocus
              className="w-full resize-y rounded border border-border bg-surface-elevated px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder-muted-foreground/50 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30" />
          </div>
        </div>
        {error && (
          <div className="mt-3 flex items-center gap-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /> {error}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border border-border px-4 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border/80 hover:text-foreground">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={saving || !content.trim()}
            className="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/15 px-4 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/25 disabled:opacity-50">
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Import className="h-3 w-3" />} Import
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

// ─── Memory row ──────────────────────────────────────────────────────────

function MemoryRow({
  memory, index, onDelete, onUpdate, onAccept,
}: {
  memory: MemoryResource
  index: number
  onDelete: (id: string) => Promise<void>
  onUpdate: (memory: MemoryResource, content: string) => Promise<void>
  onAccept: (memory: MemoryResource) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memory.payload.content)
  const [saving, setSaving] = useState(false)
  const p = memory.payload
  const isLong = p.content.length > 200
  const snippet = expanded ? p.content : p.content.slice(0, 200)
  const pending = p.autoCaptured && p.reviewState === 'pending'
  const CategoryIcon = p.imported ? Import : p.activityCategory === 'lab' ? FlaskConical : p.autoCaptured ? MessageSquare : Brain

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    await onDelete(memory.id)
    setDeleting(false)
  }, [memory.id, onDelete])

  const handleAccept = useCallback(async () => {
    setAccepting(true)
    await onAccept(memory)
    setAccepting(false)
  }, [memory, onAccept])

  const handleSave = useCallback(async () => {
    const content = draft.trim()
    if (!content || content === p.content) { setEditing(false); return }
    setSaving(true)
    await onUpdate(memory, content)
    setSaving(false)
    setEditing(false)
  }, [draft, memory, onUpdate, p.content])

  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}
      transition={{ delay: Math.min(index * 0.02, 0.25), type: 'spring', stiffness: 300, damping: 28 }}
      className={`group rounded border bg-surface-secondary transition-colors ${pending ? 'border-warning/40' : 'border-border hover:border-border/80'}`}>
      <div
        role={isLong ? 'button' : undefined}
        tabIndex={isLong ? 0 : undefined}
        onClick={() => isLong && setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (isLong && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setExpanded((v) => !v) }
        }}
        className={`flex w-full items-start gap-3 p-3 text-left ${isLong ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <div className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border ${
          p.imported ? 'border-accent/30 bg-accent/10 text-accent'
            : p.autoCaptured ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
              : 'border-primary/30 bg-primary/10 text-primary'
        }`}>
          <CategoryIcon className="h-3 w-3" />
        </div>
        <div className="min-w-0 flex-1">
          {editing ? (
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onClick={(e) => e.stopPropagation()}
              rows={3} autoFocus
              className="w-full resize-y rounded border border-primary/40 bg-surface-elevated px-2 py-1.5 text-xs leading-relaxed text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30" />
          ) : (
            <p className={`text-xs leading-relaxed text-foreground ${expanded ? 'whitespace-pre-wrap' : ''}`}>
              {snippet}{!expanded && isLong && <span className="text-muted-foreground">…</span>}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
              pending ? 'border-warning/40 text-warning'
                : p.imported ? 'border-accent/30 text-accent'
                  : p.autoCaptured ? 'border-amber-400/30 text-amber-300'
                    : 'border-primary/30 text-primary'
            }`}>
              {sourceLabel(memory)}
            </span>
            <span className="font-mono text-[9px] text-muted-foreground">{fmtDate(memory.created_at)}</span>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1 px-3 pb-2">
        {pending && (
          <button onClick={handleAccept} disabled={accepting}
            className="flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-[9px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
            aria-label="Accept fact">
            {accepting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Accept
          </button>
        )}
        {editing ? (
          <button onClick={handleSave} disabled={saving || !draft.trim()}
            className="flex items-center gap-1 rounded p-1 font-mono text-[9px] text-primary transition-colors hover:bg-surface-elevated disabled:opacity-50" aria-label="Save memory">
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save
          </button>
        ) : (
          <button onClick={() => setEditing(true)}
            className="rounded p-1 text-muted-foreground opacity-0 transition-all hover:bg-surface-elevated hover:text-foreground group-hover:opacity-100" aria-label="Edit memory">
            <Pencil className="h-3 w-3" />
          </button>
        )}
        <button onClick={handleDelete} disabled={deleting}
          className={`rounded p-1 text-muted-foreground transition-all hover:bg-surface-elevated hover:text-destructive disabled:opacity-50 ${pending ? '' : 'opacity-0 group-hover:opacity-100'}`}
          aria-label={pending ? 'Reject fact' : 'Delete memory'}>
          {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
        </button>
      </div>
    </motion.div>
  )
}

// ─── Quick add (from the old two-textarea /resources/memory page) ─────────

function QuickAdd({ onSaved, onRecall }: { onSaved: (m: MemoryResource) => void; onRecall: (recall: unknown) => void }) {
  const [memoryInput, setMemoryInput] = useState('')
  const [commPrefs, setCommPrefs] = useState('')
  const [saving, setSaving] = useState<'memory' | 'preference' | null>(null)

  const save = async (kind: 'memory' | 'preference', raw: string) => {
    const content = raw.trim()
    if (!content) return
    setSaving(kind)
    try {
      const text = kind === 'preference' ? `[pref:communication] ${content}` : content
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      })
      const data = await res.json()
      if (res.ok) {
        onSaved(data.memory as MemoryResource)
        onRecall(data.recall)
        if (kind === 'memory') setMemoryInput(''); else setCommPrefs('')
      }
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-2">
      <div className="rounded border border-border bg-surface-secondary p-3">
        <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Things Golem should know</p>
        <textarea value={memoryInput} onChange={(e) => setMemoryInput(e.target.value)}
          placeholder="Facts, preferences, context…" rows={3}
          className="w-full resize-none rounded border border-border bg-surface-elevated px-2.5 py-2 font-mono text-xs text-foreground placeholder-muted-foreground/50 focus:border-primary/40 focus:outline-none" />
        <button onClick={() => save('memory', memoryInput)} disabled={!memoryInput.trim() || saving === 'memory'}
          className="mt-2 flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-2.5 py-1 font-mono text-[10px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40">
          {saving === 'memory' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save
        </button>
      </div>
      <div className="rounded border border-border bg-surface-secondary p-3">
        <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">How Golem should talk to you</p>
        <textarea value={commPrefs} onChange={(e) => setCommPrefs(e.target.value)}
          placeholder="Tone, depth, initiative level…" rows={3}
          className="w-full resize-none rounded border border-border bg-surface-elevated px-2.5 py-2 font-mono text-xs text-foreground placeholder-muted-foreground/50 focus:border-primary/40 focus:outline-none" />
        <button onClick={() => save('preference', commPrefs)} disabled={!commPrefs.trim() || saving === 'preference'}
          className="mt-2 flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-2.5 py-1 font-mono text-[10px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40">
          {saving === 'preference' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save
        </button>
      </div>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────

export function MemoryTab() {
  const [memories, setMemories] = useState<MemoryResource[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<string | null>(null)
  // A fact can be saved here and still not be recallable in chat: the resource
  // row is the source of truth, but chat's semantic recall reads the separate
  // pgvector `memories` table. Say so rather than implying the fact is live.
  const [recallWarning, setRecallWarning] = useState<string | null>(null)

  const noteRecall = useCallback((recall: unknown) => {
    const r = recall as { ok?: boolean; error?: string } | undefined
    setRecallWarning(r && r.ok === false ? `Saved, but not added to chat recall: ${r.error ?? 'unknown error'}` : null)
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetch('/api/memory')
      .then((r) => r.json())
      .then((d) => setMemories((d.memories ?? []) as MemoryResource[]))
      .catch(() => setError('Failed to load memories.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return memories
    const q = searchQuery.toLowerCase()
    return memories.filter((m) => {
      const p = m.payload
      return p.content.toLowerCase().includes(q) || m.title.toLowerCase().includes(q) || (p.origin ?? '').toLowerCase().includes(q)
    })
  }, [memories, searchQuery])

  const pendingCount = memories.filter((m) => m.payload.autoCaptured && m.payload.reviewState === 'pending').length

  const handleDelete = useCallback(async (id: string) => {
    const prev = memories
    setMemories((m) => m.filter((x) => x.id !== id))
    try {
      const res = await fetch(`/api/memory?id=${id}`, { method: 'DELETE' })
      if (!res.ok) { setMemories(prev); setError('Delete failed — reloaded list.') }
    } catch {
      setMemories(prev); setError('Network error on delete — reloaded list.')
    }
  }, [memories])

  const handleSaved = useCallback((m: MemoryResource) => {
    setMemories((prev) => [m, ...prev])
  }, [])

  const handleUpdate = useCallback(async (memory: MemoryResource, content: string) => {
    const nextPayload: MemoryPayload = { ...memory.payload, content, reviewState: memory.payload.autoCaptured ? 'reviewed' : memory.payload.reviewState }
    const res = await fetch(`/api/resources/${memory.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'memory', title: content.slice(0, 80), payload: nextPayload }),
    })
    if (!res.ok) { setError('Could not update memory.'); return }
    const data = await res.json()
    setMemories((prev) => prev.map((item) => item.id === memory.id ? (data.resource as MemoryResource) : item))
  }, [])

  const handleAccept = useCallback(async (memory: MemoryResource) => {
    const res = await fetch('/api/memory', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: memory.id, action: 'accept' }),
    })
    if (!res.ok) { setError('Could not accept fact.'); return }
    const data = await res.json()
    noteRecall(data.recall)
    setMemories((prev) => prev.map((item) => item.id === memory.id ? (data.memory as MemoryResource) : item))
  }, [noteRecall])

  const scanLab = useCallback(async () => {
    setScanning(true)
    setScanResult(null)
    setError(null)
    try {
      const res = await fetch('/api/memory/auto-extract/lab', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Lab scan failed.'); return }
      if (data.factsWritten > 0) {
        setScanResult(`Found ${data.factsWritten} new fact${data.factsWritten === 1 ? '' : 's'} — review below.`)
        load()
      } else {
        setScanResult(data.skippedReason ?? 'Nothing new found.')
      }
    } catch {
      setError('Network error running Lab scan.')
    } finally {
      setScanning(false)
    }
  }, [load])

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Brain className="h-4 w-4 text-primary" /> Memory
          </h2>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {memories.length} entr{memories.length === 1 ? 'y' : 'ies'}
            {pendingCount > 0 && <span className="text-warning"> · {pendingCount} awaiting review</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={scanLab} disabled={scanning}
            title="Scan recent Lab activity (Evolutionary + Overnight R&D) for recurring patterns worth remembering"
            className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50">
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
            Scan Lab activity
          </button>
          <button onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/15 px-3 py-1.5 font-mono text-[11px] font-medium text-primary transition-colors hover:bg-primary/25">
            <Import className="h-3.5 w-3.5" /> Import
          </button>
        </div>
      </div>

      {scanResult && (
        <div className="mb-3 flex items-center gap-2 rounded border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground/90">
          <Wand2 className="h-3.5 w-3.5 flex-shrink-0 text-primary" /> {scanResult}
        </div>
      )}
      {error && (
        <div className="mb-3 flex items-center gap-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /> {error}
        </div>
      )}
      {recallWarning && (
        <div className="mb-3 flex items-center gap-2 rounded border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /> {recallWarning}
        </div>
      )}

      <QuickAdd onSaved={handleSaved} onRecall={noteRecall} />

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search memories…"
          className="w-full rounded border border-border bg-surface-elevated py-2 pl-9 pr-8 text-xs text-foreground placeholder-muted-foreground/50 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30" />
        {searchQuery && (
          <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : memories.length === 0 ? (
        <div className="rounded border border-dashed border-border p-10 text-center">
          <Brain className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm font-medium text-foreground">No memories yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Add one above, import from another AI, or scan Lab activity.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-muted-foreground">No memories match &ldquo;{searchQuery}&rdquo;.</p>
          <button onClick={() => setSearchQuery('')} className="mt-2 text-xs text-primary hover:underline">Clear search</button>
        </div>
      ) : (
        <div className="space-y-2">
          <AnimatePresence mode="popLayout">
            {filtered.map((m, i) => (
              <MemoryRow key={m.id} memory={m} index={i} onDelete={handleDelete} onUpdate={handleUpdate} onAccept={handleAccept} />
            ))}
          </AnimatePresence>
        </div>
      )}

      <div className="mt-6 rounded border border-border bg-surface-secondary p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded border border-accent/30 bg-accent/10 text-accent">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">Where auto-captured facts come from</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Chat: every 3rd turn in a conversation, Golem checks for durable facts worth remembering.
              Lab: click &ldquo;Scan Lab activity&rdquo; above to check recent Evolutionary Code Generation and Overnight R&amp;D
              runs for recurring patterns. Either way, nothing is used in future conversations until you Accept it here —
              rejecting just deletes the candidate.
            </p>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showImport && <ImportMemoryModal onClose={() => setShowImport(false)} onImported={handleSaved} />}
      </AnimatePresence>
    </div>
  )
}
