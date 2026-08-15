'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Search, Globe, Moon, Activity, Settings, ChevronRight, Check, Sun, Zap } from 'lucide-react'

interface Crumb {
  label: string
  href?: string
}

const CRUMBS: Record<string, Crumb[]> = {
  '/': [{ label: 'Home', href: '/' }],
  '/chat': [{ label: 'Workspace', href: '/' }, { label: 'Chat' }],
  '/forge': [{ label: 'Workspace', href: '/' }, { label: 'The Forge' }],
  '/scribe': [{ label: 'Workspace', href: '/' }, { label: 'Prompt Engineer' }],
  '/lab': [{ label: 'Workspace', href: '/' }, { label: 'Lab' }],
  '/resources': [{ label: 'Library', href: '/' }, { label: 'Tools' }],
  '/prompts': [{ label: 'Library', href: '/' }, { label: 'Prompts' }],
  '/resources/memory': [{ label: 'Library', href: '/' }, { label: 'Memory' }],
  '/atelier': [{ label: 'Library', href: '/' }, { label: 'The Atelier' }],
  '/usage': [{ label: 'Platform', href: '/' }, { label: 'Usage' }],
  '/missions': [{ label: 'Workspace', href: '/' }, { label: 'Missions' }],
  '/settings': [{ label: 'System', href: '/' }, { label: 'Settings' }],
}

const DESCRIPTIONS: Record<string, string> = {
  '/': 'Dashboard overview',
  '/chat': 'Ask Golem anything',
  '/forge': 'Autonomous coding agent',
  '/scribe': 'Prompt engineering lab',
  '/lab': 'Experiments and overnight runs',
  '/resources': 'Built-in tools and resources',
  '/prompts': 'Saved prompts and recipes',
  '/resources/memory': 'Saved facts and context',
  '/atelier': '3D headquarters view',
  '/usage': 'Track tokens, cost, and alerts',
  '/missions': 'Mission, task and agent state',
  '/settings': 'Manage your account and integrations',
}

type Theme = 'og' | 'midnight' | 'light'

function openCommandPalette() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
}

function setTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'og') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', theme)
  }
  try { localStorage.setItem('enry-theme', theme) } catch { /* noop */ }
}

export function TopBar() {
  const pathname = usePathname()
  const crumbs = CRUMBS[pathname] ?? [{ label: 'Home', href: '/' }]
  const description = DESCRIPTIONS[pathname] ?? 'Golem dashboard'

  const [langOpen, setLangOpen] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const [theme, setThemeState] = useState<Theme>('og')
  const langRef = useRef<HTMLDivElement>(null)
  const themeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const saved = localStorage.getItem('enry-theme') as Theme | null
      if (saved && ['og', 'midnight', 'light'].includes(saved)) {
        setThemeState(saved)
        setTheme(saved)
      }
    } catch { /* noop */ }
  }, [])

  useEffect(() => {
    if (!langOpen && !themeOpen) return
    const handler = (e: MouseEvent) => {
      if (!langRef.current?.contains(e.target as Node)) setLangOpen(false)
      if (!themeRef.current?.contains(e.target as Node)) setThemeOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [langOpen, themeOpen])

  const handleTheme = (next: Theme) => {
    setThemeState(next)
    setTheme(next)
    setThemeOpen(false)
  }

  const iconButton = (
    props: {
      label: string
      children: React.ReactNode
      onClick?: () => void
      href?: string
    }
  ) => {
    const className = "flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-elevated hover:text-foreground"
    if (props.href) {
      return (
        <Link href={props.href} className={className} aria-label={props.label}>
          {props.children}
        </Link>
      )
    }
    return (
      <button type="button" onClick={props.onClick} className={className} aria-label={props.label}>
        {props.children}
      </button>
    )
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-surface-secondary/80 px-4 backdrop-blur">
      {/* Left: breadcrumb + description */}
      <div className="flex flex-col justify-center">
        <nav className="flex items-center gap-1 text-xs text-muted-foreground">
          {crumbs.map((crumb, idx) => (
            <span key={crumb.label} className="flex items-center gap-1">
              {idx > 0 && <ChevronRight className="h-3 w-3 text-border" />}
              {crumb.href ? (
                <Link href={crumb.href} className="hover:text-foreground transition-colors">
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-foreground font-medium">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
        <p className="text-[11px] text-muted-foreground/70">{description}</p>
      </div>

      {/* Right: utility icons */}
      <div className="flex items-center gap-1">
        {iconButton({ label: 'Search', children: <Search className="h-4 w-4" />, onClick: openCommandPalette })}

        <div ref={langRef} className="relative">
          <button
            type="button"
            onClick={() => setLangOpen((o) => !o)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-elevated hover:text-foreground"
            aria-label="Language"
          >
            <Globe className="h-4 w-4" />
          </button>
          {langOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-md border border-border bg-surface-secondary shadow-xl">
              <div className="border-b border-border px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Language
              </div>
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-foreground hover:bg-surface-elevated"
              >
                <span>English (US)</span>
                <Check className="h-3.5 w-3.5 text-primary" />
              </button>
            </div>
          )}
        </div>

        <div ref={themeRef} className="relative">
          <button
            type="button"
            onClick={() => setThemeOpen((o) => !o)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-elevated hover:text-foreground"
            aria-label="Theme"
          >
            <Moon className="h-4 w-4" />
          </button>
          {themeOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-md border border-border bg-surface-secondary shadow-xl">
              <div className="border-b border-border px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Theme
              </div>
              {([
                { id: 'og', label: 'OG', icon: Zap },
                { id: 'midnight', label: 'Midnight', icon: Moon },
                { id: 'light', label: 'Light', icon: Sun },
              ] as const).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleTheme(t.id)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-foreground hover:bg-surface-elevated"
                >
                  <span className="flex items-center gap-2">
                    <t.icon className="h-3.5 w-3.5" />
                    {t.label}
                  </span>
                  {theme === t.id && <Check className="h-3.5 w-3.5 text-primary" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {iconButton({ label: 'Activity', children: <Activity className="h-4 w-4" />, href: '/usage' })}

        <Link
          href="/settings"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-elevated hover:text-foreground"
          aria-label="Settings"
        >
          <Settings className="h-4 w-4" />
        </Link>
      </div>
    </header>
  )
}
