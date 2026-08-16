'use client'

// The one tab-bar primitive. Replaces the two hand-rolled strips in
// src/app/forge/page.tsx: the primary Forge / Missions / Agency bar and
// Forge's Chat / Terminals sub-switcher, which were the same markup with
// slightly different numbers on each.
//
// The two sizes are now deliberate variants rather than two independent sets
// of magic values. Phase 1 ships no visual change, so `primary` and `sub`
// reproduce the existing pixel values exactly (11px/px-2.5/gap-1.5 vs
// 10px/px-2/gap-1) — collapsing them to one size is a visual decision for the
// later colour/motion pass, not a de-duplication one.
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
    container: 'flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-border bg-surface-secondary px-3',
    button: 'flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[11px] transition-colors',
    icon: 'h-3 w-3',
  },
  sub: {
    container: 'flex items-center gap-0.5 rounded border border-border bg-surface-secondary p-0.5',
    button: 'flex items-center gap-1 rounded px-2 py-1 font-mono text-[10px] transition-colors',
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
              active === item.id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className={s.icon} /> {item.label}
          </button>
        )
      })}
    </div>
  )
}
