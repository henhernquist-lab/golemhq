'use client'

// The shared page frame for the unified workspace surfaces.
//
// Batch 8.5 left three incompatible page-chrome patterns: Forge's full-height
// column, and two byte-for-byte copies of the standalone grid background +
// back link + hero header in missions-workspace.tsx and agency-workspace.tsx,
// each with its own embedded/standalone padding ternary. This is one
// implementation of both.
//
// Phase 1 of design.md's build order is de-duplication with ZERO visual
// change, so every class string below is lifted verbatim from the call site it
// replaces — including the two padding variants and the `rgba(8,8,8,0.6)`
// radial, which is a raw colour the standalone routes already shipped. Moving
// it onto a token is a colour-pass decision, not a de-duplication one.

import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { ArrowLeft, type LucideIcon } from 'lucide-react'

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
    return <div className="flex h-screen flex-col bg-background font-sans">{children}</div>
  }

  const inner = (
    <div className={embedded ? 'mx-auto w-full max-w-6xl px-6 py-8' : 'relative z-10 mx-auto w-full max-w-6xl px-6 py-10'}>
      {!embedded && (
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-2 font-mono text-xs text-muted-foreground transition-colors hover:text-primary"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          back to golem
        </Link>
      )}

      {title && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 flex items-end justify-between gap-4"
        >
          <div className="flex items-center gap-3">
            {Icon && (
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-primary/30 bg-primary/10">
                <Icon className="h-4 w-4 text-primary" />
              </div>
            )}
            <div>
              <h1 className="font-mono text-lg text-foreground">{title}</h1>
              {subtitle && <p className="font-mono text-xs text-muted-foreground">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </motion.div>
      )}

      {children}
    </div>
  )

  if (embedded) return inner

  return (
    <div className="relative flex min-h-screen flex-col bg-transparent">
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 grid-overlay opacity-30" />
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(ellipse at center, transparent 0%, rgba(8,8,8,0.6) 100%)' }}
        />
      </div>
      {inner}
    </div>
  )
}
