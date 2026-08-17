'use client'

// The one tab-bar primitive. Replaces the two hand-rolled strips in
// src/app/forge/page.tsx: the primary Forge / Missions / Agency bar and
// Forge's Chat / Terminals sub-switcher, which were the same markup with
// slightly different numbers on each.
//
// The two sizes remain deliberate variants rather than independent strips.
// Phase 2 softens both consistently: roomier hit areas, quieter separators,
// and a restrained active highlight instead of an accent outline.
//
// Note for callers: this renders the bar only. Panels stay mounted and
// CSS-hidden at the call site so live state (terminals, chat) survives a tab
// switch — that invariant is deliberately NOT owned here.

import type { LucideIcon } from 'lucide-react'

export interface TabStripItem<T extends string> {
  id: T
  label: string
  icon: LucideIcon
  /** Hover tooltip. Optional — the primary bar leaves Forge's own tab bare. */
  title?: string
}

const SIZES = {
  primary: {
    container: 'flex h-12 flex-shrink-0 items-center gap-1 border-b border-border/50 bg-surface-secondary/70 px-5 shadow-sm',
    button: 'flex items-center gap-2 rounded-lg px-3.5 py-2 font-mono text-xs leading-5 transition-colors',
    icon: 'h-3 w-3',
  },
  sub: {
    container: 'flex items-center gap-1 rounded-xl border border-border/50 bg-surface-secondary/70 p-1 shadow-sm',
    button: 'flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-mono text-[11px] leading-4 transition-colors',
    icon: 'h-3 w-3',
  },
} as const

interface TabStripProps<T extends string> {
  items: readonly TabStripItem<T>[]
  active: T
  onSelect: (id: T) => void
  size?: keyof typeof SIZES
  /** Extra classes on the container, for layout the strip itself shouldn't own. */
  className?: string
}

export function TabStrip<T extends string>({
  items,
  active,
  onSelect,
  size = 'primary',
  className,
}: TabStripProps<T>) {
  const s = SIZES[size]
  return (
    <div className={className ? `${s.container} ${className}` : s.container}>
      {items.map((item) => {
        const Icon = item.icon
        return (
          <button
            key={item.id}
            onClick={() => onSelect(item.id)}
            title={item.title}
            className={`${s.button} ${
              active === item.id
                ? 'bg-primary/10 text-primary shadow-sm'
                : 'text-muted-foreground hover:bg-surface-elevated/60 hover:text-foreground'
            }`}
          >
            <Icon className={s.icon} /> {item.label}
          </button>
        )
      })}
    </div>
  )
}
