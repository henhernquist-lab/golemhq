'use client'

import { useEffect, useState, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  Loader2,
  Trash2,
  BookOpen,
  Calculator,
  GitBranch,
  BookMarked,
  Newspaper,
  Check,
  Timer,
  ShieldAlert,
  Info,
  ExternalLink,
  StickyNote,
  Bell,
} from 'lucide-react'
import { FlashcardGenerator } from '@/components/tools/flashcard-generator'
import { GradeCalculator } from '@/components/tools/grade-calculator'
import { RepoScanner } from '@/components/tools/repo-scanner'
import { ArticleNotes, ArticleNotesSavedList } from '@/components/tools/article-notes'
import { RacePaceCalculator } from '@/components/tools/race-pace-calculator'
import { QuickNotes } from '@/components/tools/quick-notes'
import { BellSchedule } from '@/components/tools/bell-schedule'
import {
  type Resource,
  type ResourceType,
  type GradeCalcPayload,
  type RepoScanPayload,
  type PromptPayload,
  type ArticleNotePayload,
  type RepoReviewPayload,
  type RepoReviewIssue,
  type NotePayload,
  type BellSchedulePayload,
  loadResources,
  deleteResource,
  resourceSummary,
} from '@/lib/resources'
import type { ResourceSource } from '@/lib/resource-source'

/* ─── Slug → type mapping ──────────────────────────────── */

const SLUG_MAP: Record<string, ResourceType> = {
  'flashcards':       'flashcards',
  'grade-calculator': 'grade_calc',
  'repo-scanner':     'repo_scan',
  'prompts':          'prompt',
  'articles':         'article_note',
  'race-pace':        'race_pace',
  'notes':            'note',
  'schedule':         'bell_schedule',
}

const SLUG_LABELS: Record<string, { name: string; icon: typeof BookOpen; desc: string }> = {
  'flashcards':       { name: 'Flashcard Generator', icon: BookOpen, desc: 'Paste notes → AI-generated Anki cards' },
  'grade-calculator': { name: 'Grade Calculator',    icon: Calculator, desc: 'What do you need on finals for target GPA?' },
  'repo-scanner':     { name: 'Repository Intelligence', icon: GitBranch, desc: 'Scan, chat, evaluate, and review any GitHub repo' },
  'prompts':          { name: 'Prompt Library',      icon: BookMarked, desc: 'Browse and save reusable AI prompts' },
  'articles':         { name: 'Article Notes',       icon: Newspaper, desc: 'Save articles with AI summaries and flashcards' },
  'race-pace':        { name: 'Race Pace Calculator', icon: Timer, desc: 'Split targets and PR tracking' },
  'notes':            { name: 'The Grimoire',         icon: StickyNote, desc: 'Fast capture, no fuss' },
  'schedule':         { name: 'Bell Schedule',       icon: Bell, desc: 'Current period and countdown to the next' },
}

/* ─── Helpers ──────────────────────────────────────────── */

function timeAgo(iso: string): string {
  const then = new Date(iso)
  const ms = Date.now() - then.getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const now = new Date()
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  if (then.toDateString() === yesterday.toDateString()) return 'yesterday'
  if (then.getFullYear() === now.getFullYear()) {
    return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/* ─── DetailModal + PayloadView (from old resources page) */

function DetailModal({ item, onClose }: { item: Resource; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        className="relative max-h-[80vh] w-full max-w-lg overflow-y-auto rounded border border-border bg-surface-secondary p-5 shadow-2xl scrollbar-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:bg-surface-elevated">
          <ChevronRight className="h-4 w-4 rotate-180" />
        </button>
        <h3 className="mb-1 pr-8 text-sm font-semibold text-foreground">{item.title}</h3>
        <p className="mb-4 font-mono text-[10px] text-muted-foreground">{timeAgo(item.created_at)}</p>
        <PayloadView resource={item} />
      </motion.div>
    </motion.div>
  )
}

function PayloadView({ resource }: { resource: Resource }) {
  const p = resource.payload as Record<string, unknown>
  switch (resource.type) {
    case 'flashcards': {
      const cards = (p.cards as { question: string; answer: string }[]) ?? []
      return (
        <div className="space-y-2">
          {cards.map((c, i) => (
            <div key={i} className="rounded border border-border bg-surface-elevated p-2.5 text-xs">
              <p className="font-medium text-foreground">Q: {c.question}</p>
              <p className="mt-1 text-muted-foreground">A: {c.answer}</p>
            </div>
          ))}
        </div>
      )
    }
    case 'grade_calc': {
      const gp = p as unknown as GradeCalcPayload
      return (
        <div className="space-y-3">
          <div className="flex gap-3">
            <div className="rounded border border-border bg-surface-elevated px-3 py-2 text-center">
              <p className="font-mono text-xl font-semibold text-foreground">{typeof gp.weightedGpa === 'number' ? gp.weightedGpa.toFixed(2) : '—'}</p>
              <p className="text-[10px] text-muted-foreground">GPA</p>
            </div>
            <div className="rounded border border-primary/30 bg-primary/5 px-3 py-2 text-center">
              <p className="font-mono text-xl font-semibold text-primary">{gp.targetGpa}</p>
              <p className="text-[10px] text-muted-foreground">Target</p>
            </div>
          </div>
          {gp.classes?.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded border border-border/50 bg-surface-elevated/50 px-2.5 py-1.5 text-xs">
              <span className="text-foreground">{c.name || '(unnamed)'}</span>
              <span className="font-mono text-muted-foreground">{c.currentGrade}% · {c.credits}cr</span>
            </div>
          ))}
        </div>
      )
    }
    case 'repo_scan': {
      const rp = p as unknown as RepoScanPayload
      return (
        <div className="space-y-2">
          <p className="font-mono text-sm font-semibold text-foreground">{rp.name}</p>
          {rp.description && <p className="text-xs text-muted-foreground">{rp.description}</p>}
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span>{rp.language}</span><span>{rp.stars} ★</span><span>{rp.fileTree?.length} files</span>
          </div>
        </div>
      )
    }
    case 'prompt': {
      const pp = p as unknown as PromptPayload
      return (
        <div className="space-y-3">
          <div className="max-h-60 overflow-y-auto rounded border border-border/50 bg-surface-base p-3 font-mono text-[11px] leading-relaxed text-foreground scrollbar-hidden whitespace-pre-wrap">
            {pp.body}
          </div>
          {pp.tags && pp.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {pp.tags.map((t) => (
                <span key={t} className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{t}</span>
              ))}
            </div>
          )}
        </div>
      )
    }
    case 'article_note': {
      const ap = p as unknown as ArticleNotePayload
      return (
        <div className="space-y-3">
          {ap.summary && <p className="text-xs leading-relaxed text-foreground">{ap.summary}</p>}
          {ap.key_claims.length > 0 && (
            <div>
              <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Key Claims</p>
              <ol className="space-y-1">
                {ap.key_claims.map((c, i) => (
                  <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                    <span className="flex-shrink-0 font-mono text-[10px]">{i + 1}.</span>{c}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {ap.flashcards.length > 0 && (
            <p className="font-mono text-[10px] text-muted-foreground">{ap.flashcards.length} flashcard{ap.flashcards.length !== 1 ? 's' : ''}</p>
          )}
        </div>
      )
    }
    case 'repo_review': {
      const rp = p as unknown as RepoReviewPayload
      const severityStyles: Record<RepoReviewIssue['severity'], { badge: string; icon: typeof AlertCircle }> = {
        high: { badge: 'border-destructive/40 bg-destructive/10 text-destructive', icon: ShieldAlert },
        medium: { badge: 'border-warning/40 bg-warning/10 text-warning', icon: AlertCircle },
        low: { badge: 'border-border bg-surface-elevated text-muted-foreground', icon: Info },
      }
      return (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <a href={rp.repo_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">
              {rp.repo_full_name} <ExternalLink className="h-3 w-3" />
            </a>
            <span className="font-mono text-[10px] text-muted-foreground">{rp.branch}</span>
          </div>
          {rp.partial_sample && (
            <p className="font-mono text-[10px] text-muted-foreground">
              Partial sample — {rp.files_analyzed.length} file{rp.files_analyzed.length !== 1 ? 's' : ''} reviewed.
            </p>
          )}
          <p className="text-xs leading-relaxed text-foreground">{rp.overview}</p>
          {rp.strengths.length > 0 && (
            <div>
              <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Strengths</p>
              <ul className="space-y-1">
                {rp.strengths.map((s, i) => (
                  <li key={i} className="text-xs text-muted-foreground">• {s}</li>
                ))}
              </ul>
            </div>
          )}
          {rp.issues.length > 0 && (
            <div className="space-y-1.5">
              <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Issues</p>
              {(['high', 'medium', 'low'] as const)
                .flatMap((sev) => rp.issues.filter((i) => i.severity === sev))
                .map((issue, i) => {
                  const style = severityStyles[issue.severity]
                  const Icon = style.icon
                  return (
                    <div key={i} className="rounded border border-border bg-surface-elevated/60 p-2.5 text-xs">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <span className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${style.badge}`}>
                          <Icon className="h-2.5 w-2.5" />{issue.severity}
                        </span>
                        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">{issue.category}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">{issue.file}</span>
                      </div>
                      <p className="text-foreground">{issue.description}</p>
                      <p className="mt-1 text-muted-foreground">→ {issue.suggestion}</p>
                    </div>
                  )
                })}
            </div>
          )}
          {rp.refactor_priorities.length > 0 && (
            <div>
              <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Do these first</p>
              <ol className="space-y-1">
                {rp.refactor_priorities.map((r, i) => (
                  <li key={i} className="flex gap-2 text-xs text-foreground">
                    <span className="flex-shrink-0 font-mono text-[10px] text-primary">{i + 1}.</span>{r}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )
    }
    case 'note': {
      const np = p as unknown as NotePayload
      return <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">{np.content}</p>
    }
    case 'bell_schedule': {
      const bp = p as unknown as BellSchedulePayload
      return (
        <div className="space-y-1">
          {bp.periods.map((per) => (
            <div key={per.period} className="flex items-center justify-between text-xs">
              <span className="text-foreground">P{per.period} {per.class_name}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{per.start_time}–{per.end_time}</span>
            </div>
          ))}
        </div>
      )
    }
    default:
      return <pre className="text-xs text-muted-foreground">{JSON.stringify(resource.payload, null, 2)}</pre>
  }
}

/* ─── SavedList (generic, for all tools except article_note) ────────── */

function SavedList({ type, refreshKey, source }: { type: ResourceType; refreshKey: number; source?: ResourceSource }) {
  const [items, setItems] = useState<Resource[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Resource | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [pulsingId, setPulsingId] = useState<string | null>(null)
  const knownIdsRef = useRef<Set<string> | null>(null)

  useEffect(() => {
    setLoading(true)
    loadResources(type, source).then((r) => {
      const prevIds = knownIdsRef.current
      if (prevIds) {
        const freshlyAdded = r.find((item) => !prevIds.has(item.id))
        if (freshlyAdded) {
          setPulsingId(freshlyAdded.id)
          setTimeout(() => setPulsingId(null), 650)
        }
      }
      knownIdsRef.current = new Set(r.map((item) => item.id))
      setItems(r)
      setLoading(false)
    })
  }, [type, source, refreshKey])

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setDeleting(id)
    await deleteResource(id)
    setItems((prev) => prev.filter((i) => i.id !== id))
    setDeleting(null)
  }

  if (loading) return <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
  if (items.length === 0) return <p className="py-6 text-center text-xs text-muted-foreground">No saved items yet.</p>

  return (
    <>
      <div className="space-y-1.5">
        <AnimatePresence>
          {items.map((item) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelected(item)}
              className={`group flex cursor-pointer items-center justify-between rounded border border-border/60 bg-surface-elevated/60 px-3 py-2 transition-all duration-200 hover:border-primary/30 hover:bg-surface-elevated hover:shadow-sm ${item.id === pulsingId ? 'pulse-confirm' : ''}`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">{item.title}</p>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {resourceSummary(item)} · {timeAgo(item.created_at)}
                </p>
              </div>
              <div className="ml-3 flex flex-shrink-0 items-center gap-2">
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                <button
                  onClick={(e) => handleDelete(e, item.id)}
                  disabled={deleting === item.id}
                  className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 disabled:opacity-40"
                >
                  {deleting === item.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {selected && <DetailModal item={selected} onClose={() => setSelected(null)} />}
      </AnimatePresence>
    </>
  )
}

/* ─── Prompt library launcher (simplified, for /resources/prompts) ─── */

function PromptLibraryLauncher({ onSave }: { onSave: () => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!title.trim() || !body.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/resources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'prompt',
          title: title.trim(),
          payload: {
            body: body.trim(),
            category: 'general',
            tags: [] as string[],
          },
        }),
      })
      if (res.ok) {
        setTitle('')
        setBody('')
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
        onSave()
      } else {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'Something went wrong. Try again.')
      }
    } catch {
      setError('Network error. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded border border-border bg-surface-secondary p-5">
      <div className="mb-4 flex items-center gap-2">
        <BookMarked className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Save a Prompt</h3>
      </div>
      <div className="space-y-3">
        <input
          value={title}
          onChange={(e) => { setTitle(e.target.value); setError(null) }}
          placeholder="Prompt title"
          className="w-full rounded border border-border bg-surface-elevated px-3 py-2 text-sm text-foreground placeholder-muted-foreground/50 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        <textarea
          value={body}
          onChange={(e) => { setBody(e.target.value); setError(null) }}
          placeholder="Paste or write your prompt…"
          rows={6}
          className="w-full resize-y rounded border border-border bg-surface-elevated px-3 py-2 font-mono text-xs text-foreground placeholder-muted-foreground/50 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        {error && (
          <div className="flex items-start gap-2 rounded border border-[#ff4d4d]/30 bg-[#ff4d4d]/8 px-3 py-2 text-xs text-[#ff4d4d]">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            {error}
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={saving || !title.trim() || !body.trim()}
          className="flex w-full items-center justify-center gap-2 rounded border border-primary/40 bg-primary/15 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/25 disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <><Check className="h-4 w-4" /> Saved!</> : 'Save Prompt'}
        </button>
      </div>
      <p className="mt-3 font-mono text-[10px] text-muted-foreground">
        For the full prompt library experience with categories, tags, and editing, visit{' '}
        <Link href="/prompts" className="text-primary hover:underline">/prompts</Link>
      </p>
    </div>
  )
}

/* ─── Tool page component ──────────────────────────────── */

function ToolPageContent() {
  const params = useParams()
  const router = useRouter()
  const { status } = useSession()
  const slug = params?.slug as string ?? ''
  const resourceType = SLUG_MAP[slug]
  const meta = SLUG_LABELS[slug]
  const [saveKey, setSaveKey] = useState(0)
  const [articleTab, setArticleTab] = useState<'user' | 'daily_auto'>('user')

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  if (!resourceType || !meta) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-base">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">Tool not found.</p>
          <Link href="/resources" className="mt-2 inline-block text-xs text-primary hover:underline">Back to Resources</Link>
        </div>
      </div>
    )
  }

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-base">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const Icon = meta.icon as typeof BookOpen
  const handleSave = () => setSaveKey((k) => k + 1)

  return (
    <div className="min-h-screen bg-transparent">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-border bg-surface-secondary/95 backdrop-blur">
        <div className="flex h-11 items-center justify-between px-4">
          <Link
            href="/resources"
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Resources
          </Link>
          <div className="flex items-center gap-2">
            <Icon className="h-3.5 w-3.5 text-primary" />
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{meta.name}</span>
          </div>
          <Link
            href="/resources/saved"
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Saved
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-3xl space-y-8 px-4 py-6">
        {/* Tool launcher */}
        {resourceType === 'flashcards'   && <FlashcardGenerator onClose={() => {}} mode="page" onSave={handleSave} />}
        {resourceType === 'grade_calc'   && <GradeCalculator    onClose={() => {}} mode="page" onSave={handleSave} />}
        {resourceType === 'repo_scan'    && <RepoScanner        onClose={() => {}} mode="page" onSave={handleSave} />}
        {resourceType === 'article_note' && <ArticleNotes       onClose={() => {}} mode="page" onSave={handleSave} />}
        {resourceType === 'race_pace'    && <RacePaceCalculator onClose={() => {}} mode="page" onSave={handleSave} />}
        {resourceType === 'prompt'       && <PromptLibraryLauncher onSave={handleSave} />}
        {resourceType === 'note'         && <QuickNotes         onClose={() => {}} mode="page" onSave={handleSave} />}
        {resourceType === 'bell_schedule' && <BellSchedule      onClose={() => {}} mode="page" onSave={handleSave} />}

        {/* Saved items — countdown, checkin, and bell_schedule render their own
            list/read view above, so the generic reverse-chron browser is skipped
            for those to avoid a redundant, differently-ordered duplicate. */}
        {!(['countdown', 'checkin', 'bell_schedule'] as ResourceType[]).includes(resourceType) && (
        <div>
          {resourceType !== 'article_note' && (
            <div className="mb-3 flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Saved</p>
            </div>
          )}
          {resourceType === 'article_note' ? (
            <>
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-1 rounded border border-border bg-surface-elevated px-1 py-0.5">
                  <button
                    onClick={() => setArticleTab('user')}
                    className={`rounded px-2.5 py-1 font-mono text-[10px] transition-colors ${articleTab === 'user' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    Mine
                  </button>
                  <button
                    onClick={() => setArticleTab('daily_auto')}
                    className={`rounded px-2.5 py-1 font-mono text-[10px] transition-colors ${articleTab === 'daily_auto' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    Daily
                  </button>
                </div>
                {articleTab === 'daily_auto' && (
                  <Link href="/resources/articles/archive" className="font-mono text-[10px] text-primary hover:underline">
                    Archive →
                  </Link>
                )}
              </div>
              <ArticleNotesSavedList
                refreshKey={saveKey}
                onStudyAll={() => {}}
                source={articleTab}
                excludeArchived={articleTab === 'daily_auto'}
              />
            </>
          ) : (
            <SavedList type={resourceType} refreshKey={saveKey} source={resourceType === 'prompt' ? 'user' : undefined} />
          )}
        </div>
        )}
      </main>
    </div>
  )
}

export default function ToolPage() {
  return <ToolPageContent />
}
