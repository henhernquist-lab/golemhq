'use client'

// The shared page frame for the unified workspace surfaces.
//
// Batch 8.5 left three incompatible page-chrome patterns: Forge's full-height
// column, and two byte-for-byte copies of the standalone grid background +
// back link + hero header in missions-workspace.tsx and agency-workspace.tsx,
// each with its own embedded/standalone padding ternary. This is one
// implementation of both.
//
// Phase 1 established this as the shared frame. Phase 2 keeps that structure
// and intentionally applies the first visual pass here: more breathing room,
// softer elevation, and a quieter grid so the treatment propagates to every
// embedded workspace without changing its mounted-panel behavior.

import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { ArrowLeft, type LucideIcon } from 'lucide-react'

// Shared surface treatment for the unified workspace. It deliberately uses
// existing surface/foreground tokens: elevation and generous radius carry the
// hierarchy, while the accent remains reserved for active/status emphasis.
export const WORKSPACE_CARD_CLASS = 'rounded-xl bg-surface-secondary shadow-lg ring-1 ring-foreground/5'
export const WORKSPACE_INSET_CLASS = 'rounded-xl bg-surface-elevated/70 shadow-sm ring-1 ring-foreground/5'

interface WorkspaceShellProps {
  children: ReactNode
  /**
   * grid — the standalone deep-link routes (/missions, /agency): fixed grid
   *   overlay behind a centered max-w-6xl column.
   * fullscreen — Forge's own route: a full-height flex column that manages its
   *   own internal scrolling, with no background layer.
   */
  variant?: 'grid' | 'fullscreen'
  /**
   * grid variant only. Drops the background and back link and tightens the
   * padding, for when a parent shell (the /forge tab panel) already provides
   * navigation and framing.
   */
  embedded?: boolean
  icon?: LucideIcon
  title?: string
  subtitle?: ReactNode
  /** Right-aligned header controls (refresh, hire worker, …). */
  actions?: ReactNode
}

export function WorkspaceShell({
  children,
  variant = 'grid',
  embedded = false,
  icon: Icon,
  title,
  subtitle,
  actions,
}: WorkspaceShellProps) {
  if (variant === 'fullscreen') {
    return <div className="flex h-screen flex-col bg-surface-base font-sans">{children}</div>
  }

  const inner = (
    <div className={embedded ? 'mx-auto w-full max-w-6xl px-8 py-10' : 'relative z-10 mx-auto w-full max-w-6xl px-8 py-12'}>
      {!embedded && (
        <Link
          href="/"
          className="mb-10 inline-flex items-center gap-2 rounded-lg px-1 py-1 font-mono text-xs leading-5 text-muted-foreground transition-colors hover:bg-surface-secondary/70 hover:text-primary"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          back to golem
        </Link>
      )}

      {title && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-10 flex items-end justify-between gap-6"
        >
          <div className="flex items-center gap-3">
            {Icon && (
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 shadow-sm ring-1 ring-primary/15">
                <Icon className="h-4 w-4 text-primary" />
              </div>
            )}
            <div>
              <h1 className="font-mono text-xl leading-7 text-foreground">{title}</h1>
              {subtitle && <p className="font-mono text-xs leading-5 text-muted-foreground">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-3">{actions}</div>}
        </motion.div>
      )}

      {children}
    </div>
  )

  if (embedded) return inner

  return (
    <div className="relative flex min-h-screen flex-col bg-transparent">
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 grid-overlay opacity-15" />
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(ellipse at center, transparent 0%, rgba(8,8,8,0.3) 100%)' }}
        />
      </div>
      {inner}
    </div>
  )
}
