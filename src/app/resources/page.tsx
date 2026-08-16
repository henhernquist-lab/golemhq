'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowLeft,
  BarChart3,
  ChevronRight,
  ChevronLeft,
  Loader2,
  BookOpen,
  Calculator,
  GitBranch,
  BookMarked,
  Timer,
  ScanSearch,
  StickyNote,
  Bell,
  Aperture,
  Briefcase,
  Waypoints,
  TerminalSquare,
  Ghost,
} from 'lucide-react'
import type { ResourceType } from '@/lib/resources'
import { loadResources } from '@/lib/resources'
import { AnimatedNumber } from '@/components/animated-number'

/* ─── Tool Definitions ─────────────────────────────────── */

interface ToolDef {
  slug: string
  type?: ResourceType
  name: string
  desc: string
  icon: typeof BookOpen
  href?: string
  /** Reference tool: nothing saved, so skip the count fetch and [SAVED] footer. */
  saved?: false
}

// NOTE: 'flashcards' and 'articles' were migrated into Golem Learn (tool
// migration). Flashcards now live in the `learn` verb (paste notes → claims);
// Article Notes + Reading List are folded into Learn's Sources tab. Their route
// pages remain in the repo but are intentionally unlinked from this grid.
//
// Retired: workout, meal, habits, checkin, countdown, and repo-review are no
// longer linked here. Repo Reviewer/Analyzer are merged into Repo Scanner.
const TOOLS: ToolDef[] = [
  { slug: 'grade-calculator', type: 'grade_calc',   name: 'Grade Calculator',    desc: 'What do you need on finals for target GPA?',          icon: Calculator },
  { slug: 'repo-scanner',     type: 'repo_scan',     name: 'Repo Scanner',        desc: 'Chat, evaluate fit, or run a code review for any GitHub repo', icon: GitBranch },
  { slug: 'model-comparer',   name: 'Model Comparer',      desc: 'Compare models across capability, benchmarks, price & context', icon: BarChart3, href: '/resources/model-comparer', saved: false },
  { slug: 'prompts',          type: 'prompt',        name: 'Prompt Library',      desc: 'Browse and save reusable AI prompts',               icon: BookMarked },
  { slug: 'race-pace',        type: 'race_pace',       name: 'Race Pace Calculator', desc: 'Split targets and PR tracking',                     icon: Timer },
  { slug: 'notes',            type: 'note',            name: 'The Grimoire',         desc: 'Fast capture, no fuss',                             icon: StickyNote },
  { slug: 'schedule',         type: 'bell_schedule',   name: 'Bell Schedule',       desc: 'Current period and countdown to the next',          icon: Bell },
  { slug: 'briefing',         type: 'briefing',        name: 'Chief of Staff',      desc: 'Daily cross-tool briefing and suggested actions',   icon: Briefcase },
  { slug: 'aperture',         type: 'aperture',        name: 'The Oculus',        desc: 'One question a day — an archive of your thinking',   icon: Aperture },
  { slug: 'root-cause',       type: 'root_cause',      name: 'The Root Cause',      desc: '5-whys investigations grounded in your data',       icon: Waypoints },
  { slug: 'terminal',         type: 'terminal_session', name: 'Coding Agent',        desc: 'Describe a change; watch it plan, diff, and open a PR', icon: TerminalSquare, href: '/agent' },
  { slug: 'ghost',            type: 'ghost_conversation', name: 'Ghost Mode',       desc: 'Talk to who you were — a past window of yourself',   icon: Ghost },
  { slug: 'contradictions',   type: 'contradiction',     name: 'Contradiction Finder', desc: 'Surface beliefs you stated that contradict each other over time', icon: ScanSearch },
  { slug: 'regrets',          type: 'regret',            name: 'Regret Ledger',      desc: 'Log uncertain decisions — revisit monthly to see if regrets hold up', icon: BookOpen },
]

/* ─── Saved count fetcher ───────────────────────────────── */

function useSavedCounts() {
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const savedTools = TOOLS.filter(
      (tool): tool is ToolDef & { type: ResourceType } => tool.saved !== false && tool.type !== undefined,
    )

    Promise.all(
      savedTools.map(async (tool) => {
        try {
          const items = await loadResources(tool.type)
          return { type: tool.type, count: items.length }
        } catch {
          return { type: tool.type, count: 0 }
        }
      }),
    ).then((results) => {
      if (!cancelled) {
        const map: Record<string, number> = {}
        for (const r of results) map[r.type] = r.count
        setCounts(map)
        setLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [])

  return { counts, loading }
}

/* ─── Responsive grid hook ──────────────────────────────── */

function useGridLayout() {
  const [cols, setCols] = useState(2)
  const [rows, setRows] = useState(2)

  useEffect(() => {
    const calc = () => {
      const mobile = window.innerWidth < 640
      setCols(mobile ? 1 : 2)
      setRows(mobile ? 2 : 2)
    }
    calc()
    window.addEventListener('resize', calc)
    return () => window.removeEventListener('resize', calc)
  }, [])

  const perPage = cols * rows
  const totalPages = Math.ceil(TOOLS.length / perPage)
  return { cols, rows, perPage, totalPages }
}

/* ─── Grid page ────────────────────────────────────────── */

function ResourcesContent() {
  const { status } = useSession()
  const router = useRouter()
  const { counts, loading: countsLoading } = useSavedCounts()
  const { cols, perPage, totalPages } = useGridLayout()
  const [page, setPage] = useState(0)

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1))
  }, [totalPages])

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  const totalSaved = Object.values(counts).reduce((a, b) => a + b, 0)

  const pageTools = TOOLS.slice(page * perPage, page * perPage + perPage)

  const goNext = () => setPage((p) => Math.min(p + 1, totalPages - 1))
  const goPrev = () => setPage((p) => Math.max(p - 1, 0))

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goNext()
      else if (e.key === 'ArrowLeft') goPrev()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [goNext, goPrev])

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-base">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-transparent">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 border-b border-border/40 bg-surface-secondary/95 backdrop-blur">
        <div className="flex h-11 items-center justify-between px-5">
          {/* Left: back */}
          <Link
            href="/"
            className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" />
            <span>[BACK]</span>
          </Link>

          {/* Center: system block */}
          <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <span className="text-muted-foreground/40">TOOLS &amp; RESOURCES</span>
            <span className="text-border">·</span>
            <span>{TOOLS.length} TOOLS</span>
            {!countsLoading && totalSaved > 0 && (
              <>
                <span className="text-border">·</span>
                <span className="text-primary">
                  <AnimatedNumber value={totalSaved} /> SAVED
                </span>
              </>
            )}
            {countsLoading && (
              <>
                <span className="text-border">·</span>
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              </>
            )}
          </div>

          {/* Right: saved link */}
          <Link
            href="/resources/saved"
            className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-primary"
          >
            <span>[SAVED]</span>
            <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      </header>

      {/* ── Main content ───────────────────────────────────── */}
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-6 py-10 lg:px-12 lg:py-12">
        {/* Section label */}
        <div className="mb-2">
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/40">
            /resources
          </p>
        </div>

        <div className="mb-10">
          <h1 className="font-display text-2xl font-bold leading-tight tracking-tight text-foreground">
            Tools &amp; Resources
          </h1>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {TOOLS.length} tools
            {!countsLoading && (
              <>
                {' · '}
                <span className={totalSaved > 0 ? 'text-primary' : 'text-muted-foreground/60'}>
                  <AnimatedNumber value={totalSaved} /> saved
                </span>
              </>
            )}
            {countsLoading && ' · loading…'}
          </p>
        </div>

        {/* ── Grid ──────────────────────────────────────────── */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            className="absolute inset-0 z-0"
            onTouchStart={(e) => {
              const touch = e.touches[0]
              ;(e.currentTarget as HTMLDivElement).dataset.startX = String(touch.clientX)
            }}
            onTouchEnd={(e) => {
              const startX = parseFloat((e.currentTarget as HTMLDivElement).dataset.startX || '0')
              const endX = e.changedTouches[0].clientX
              const delta = endX - startX
              if (delta < -50) goNext()
              else if (delta > 50) goPrev()
            }}
          />
          <AnimatePresence mode="wait">
            <motion.div
              key={page}
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -30 }}
              transition={{ type: 'spring', stiffness: 300, damping: 28 }}
              className="relative z-10 h-full"
            >
              <div
                className="grid h-full gap-4 lg:gap-5"
                style={{
                  gridTemplateColumns: `repeat(${cols}, 1fr)`,
                  gridTemplateRows: cols === 2 ? '1fr 1fr' : `repeat(${pageTools.length}, minmax(0, 1fr))`,
                }}
              >
                {pageTools.map((tool, i) => {
                  const Icon = tool.icon
                  const count = tool.type ? (counts[tool.type] ?? 0) : 0
                  return (
                    <motion.a
                      key={tool.slug}
                      href={tool.href ?? `/resources/${tool.slug}`}
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.035, type: 'spring', stiffness: 300, damping: 28 }}
                      className="group flex h-full min-h-0 flex-col gap-5 rounded-lg border border-transparent bg-surface-secondary p-6 transition-all duration-300 hover:border-border/60 hover:bg-surface-secondary/80 lg:p-7"
                    >
                      <div className="flex items-start gap-4">
                        {/* Icon — plain on dark card, green only on hover */}
                        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md border border-border/40 bg-surface-elevated transition-all duration-300 group-hover:border-primary/30 group-hover:bg-primary/5">
                          <Icon className="h-5 w-5 text-muted-foreground transition-colors duration-300 group-hover:text-primary" />
                        </div>
                        <div className="min-w-0 flex-1 pt-0.5">
                          <h3 className="text-base font-bold tracking-tight text-foreground">
                            {tool.name}
                          </h3>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {tool.desc}
                          </p>
                        </div>
                        <ChevronRight className="mt-2 h-4 w-4 flex-shrink-0 text-muted-foreground opacity-0 transition-all duration-300 group-hover:translate-x-1 group-hover:opacity-100" />
                      </div>

                      {/* Saved count footer — terminal style */}
                      <div className="mt-auto flex items-center justify-between border-t border-border/20 pt-3">
                        {tool.saved === false ? (
                          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/30">
                            [REFERENCE]
                          </span>
                        ) : countsLoading ? (
                          <div className="flex items-center gap-1.5">
                            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                              [LOADING]
                            </span>
                          </div>
                        ) : count > 0 ? (
                          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors group-hover:text-primary">
                            [SAVED: <AnimatedNumber value={count} />]
                          </span>
                        ) : (
                          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/30">
                            [EMPTY]
                          </span>
                        )}
                      </div>
                    </motion.a>
                  )
                })}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* ── Page nav ──────────────────────────────────────── */}
        {totalPages > 1 && (
          <div className="mt-8 flex items-center justify-center gap-4">
            <button
              onClick={goPrev}
              disabled={page === 0}
              className="rounded p-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-20"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>

            <div className="flex gap-2" role="tablist" aria-label="Tool pages">
              {Array.from({ length: totalPages }).map((_, i) => (
                <button
                  key={i}
                  role="tab"
                  aria-selected={i === page}
                  aria-label={`Page ${i + 1}`}
                  onClick={() => setPage(i)}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === page
                      ? 'w-6 bg-primary'
                      : 'w-1.5 bg-border hover:bg-muted-foreground/30'
                  }`}
                />
              ))}
            </div>

            <button
              onClick={goNext}
              disabled={page === totalPages - 1}
              className="rounded p-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-20"
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-base">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  )
}

export default function ResourcesPage() {
  return (
    <Suspense fallback={<LoadingSkeleton />}>
      <ResourcesContent />
    </Suspense>
  )
}
