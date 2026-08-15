'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Command } from 'cmdk'
import {
  Home,
  LayoutGrid,
  Archive,
  Settings,
  Search,
  Calculator,

  GitBranch,
  BookMarked,
  Timer,
  Brain,
  StickyNote,
  Bell,
  Loader2,
  Aperture,
  Briefcase,
  Waypoints,
  TerminalSquare,
  AlertOctagon,
  Ghost,
  FlaskConical,
} from 'lucide-react'

interface NavItem {
  label: string
  path: string
  icon: typeof Home
  keywords?: string
}

const MAIN_ROUTES: NavItem[] = [
  { label: 'Home', path: '/', icon: Home },
  { label: 'Tools & Resources', path: '/resources', icon: LayoutGrid },
  { label: 'Saved Items', path: '/resources/saved', icon: Archive },
  { label: 'Prompt Library', path: '/prompts', icon: BookMarked, keywords: 'prompts' },
  { label: 'Memory', path: '/resources/memory', icon: Brain, keywords: 'memory memories preferences context' },
  { label: 'Golem Lab', path: '/lab', icon: FlaskConical, keywords: 'lab experiments skills revisions' },
  { label: 'Settings', path: '/settings', icon: Settings },
]

// Flashcard Generator + Article Notes migrated into Golem Learn (flashcards →
// `learn`; Article Notes → Learn's Sources tab). Their routes stay in the repo
// but are unlinked here.
//
// Meal Logger, Workout Logger, Habit Streaks, Daily Check-in, and Countdown
// are retired from discoverability (dark-not-deleted). Routes/components stay.
// Repo Reviewer merged into Repo Scanner as its "Code Review" mode.
const TOOL_ROUTES: NavItem[] = [
  { label: 'Grade Calculator', path: '/resources/grade-calculator', icon: Calculator, keywords: 'gpa grades' },
  { label: 'Repo Scanner', path: '/resources/repo-scanner', icon: GitBranch, keywords: 'github code review scan' },
  { label: 'Race Pace Calculator', path: '/resources/race-pace', icon: Timer, keywords: 'race running splits' },
  { label: 'The Grimoire', path: '/grimoire', icon: StickyNote, keywords: 'note memo' },
  { label: 'Bell Schedule', path: '/resources/schedule', icon: Bell, keywords: 'periods class schedule' },
  { label: 'Chief of Staff', path: '/resources/briefing', icon: Briefcase, keywords: 'briefing daily observations actions' },
  { label: 'The Oculus', path: '/resources/aperture', icon: Aperture, keywords: 'question daily reflection thinking' },
  { label: 'The Root Cause', path: '/resources/root-cause', icon: Waypoints, keywords: 'failure investigation 5 whys' },
  { label: 'Coding Agent', path: '/agent', icon: TerminalSquare, keywords: 'coding agent terminal shell command repo git edit diff pr' },
  { label: 'Ghost Mode', path: '/resources/ghost', icon: Ghost, keywords: 'past henry time window persona ghost' },
]

interface QuickResult {
  id: string
  title: string
  type: 'prompt' | 'article_note'
}

interface ActionItem {
  label: string
  icon: typeof Home
  run: (router: ReturnType<typeof useRouter>) => void
}

const ACTIONS: ActionItem[] = [
  { label: 'New note', icon: StickyNote, run: (router) => router.push('/grimoire') },
  { label: 'Log a race result', icon: Timer, run: (router) => router.push('/resources/race-pace?tab=log') },
  { label: 'Scan a repo', icon: GitBranch, run: (router) => router.push('/resources/repo-scanner') },
  { label: 'Something went wrong', icon: AlertOctagon, run: (router) => router.push('/resources/root-cause?start=1') },
  { label: 'Talk to Past Henry', icon: Ghost, run: (router) => router.push('/resources/ghost') },
  { label: 'Open terminal', icon: TerminalSquare, run: () => window.dispatchEvent(new Event('enry:open-terminal')) },
  { label: 'View saved items', icon: Archive, run: (router) => router.push('/resources/saved') },
]

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<QuickResult[]>([])
  const [searching, setSearching] = useState(false)
  const router = useRouter()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    if (!open) { setSearch(''); setResults([]) }
  }, [open])

  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) { setResults([]); setSearching(false); return }
    setSearching(true)
    const timeout = setTimeout(async () => {
      try {
        const res = await fetch('/api/search/quick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q }),
        })
        const data = await res.json()
        setResults(data.results ?? [])
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => clearTimeout(timeout)
  }, [search])

  const go = useCallback((path: string) => {
    setOpen(false)
    router.push(path)
  }, [router])

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      shouldFilter={true}
      overlayClassName="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-150"
      contentClassName="fixed left-1/2 top-[18%] z-[101] w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface-secondary shadow-2xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-150"
    >
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder="Search tools, resources, or run a command…"
          className="w-full bg-transparent py-3 text-sm text-foreground placeholder-muted-foreground/50 outline-none"
        />
        {searching && <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" />}
      </div>

      <Command.List className="max-h-[420px] overflow-y-auto p-2 scrollbar-hidden">
        <Command.Empty className="py-8 text-center text-xs text-muted-foreground">
          No matches.
        </Command.Empty>

        <Command.Group heading="Navigate" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground">
          {[...MAIN_ROUTES, ...TOOL_ROUTES].map((item) => (
            <Command.Item
              key={item.path}
              value={`${item.label} ${item.keywords ?? ''}`}
              onSelect={() => go(item.path)}
              className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-sm text-foreground data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary"
            >
              <item.icon className="h-3.5 w-3.5 flex-shrink-0" />
              {item.label}
            </Command.Item>
          ))}
        </Command.Group>

        {search.trim().length >= 2 && (
          <Command.Group heading="Search Resources" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground">
            {results.map((r) => (
              <Command.Item
                key={r.id}
                value={`resource-${r.id} ${r.title}`}
                onSelect={() => go(`/resources/saved?tab=${r.type}`)}
                className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-sm text-foreground data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary"
              >
                <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  {r.type === 'prompt' ? 'prompt' : 'article'}
                </span>
                <span className="truncate">{r.title}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground">
          {ACTIONS.map((action) => (
            <Command.Item
              key={action.label}
              value={action.label}
              onSelect={() => { setOpen(false); action.run(router) }}
              className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-sm text-foreground data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary"
            >
              <action.icon className="h-3.5 w-3.5 flex-shrink-0" />
              {action.label}
            </Command.Item>
          ))}
        </Command.Group>
      </Command.List>

      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <div className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
          <kbd className="rounded border border-border bg-surface-elevated px-1 py-0.5">↑↓</kbd> navigate
          <kbd className="ml-2 rounded border border-border bg-surface-elevated px-1 py-0.5">↵</kbd> select
          <kbd className="ml-2 rounded border border-border bg-surface-elevated px-1 py-0.5">esc</kbd> close
        </div>
      </div>
    </Command.Dialog>
  )
}

// Small discoverability hint, fixed to a corner so it shows on every route
// without needing to touch each page's own header.
export function CommandPaletteHint() {
  const pathname = usePathname()
  if (pathname === '/login') return null

  return (
    <button
      onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
      className="pointer-events-auto fixed bottom-5 right-16 z-40 hidden items-center gap-1 rounded border border-border bg-surface-elevated px-1.5 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary sm:flex"
      aria-label="Open command palette"
    >
      <kbd className="font-mono">⌘K</kbd>
    </button>
  )
}
