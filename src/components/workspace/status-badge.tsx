'use client'

// One status badge for the whole workspace surface.
//
// Before this, the same pill existed four times: `Badge` + TASK_TONE/
// MISSION_TONE in missions-workspace.tsx, `AuditBadge`'s inline tone ternary
// and the active/paused span in agency-workspace.tsx, and the lease pills in
// the task list. Each carried its own copy of the tone strings, so a tone
// added in one place silently didn't exist in the others.
//
// Phase 2 keeps one tone map and applies the smooth treatment once: softer
// boundaries, pill geometry, a little more line-height, and elevation that
// does not turn every status into a bright accent outline.

import type { LucideIcon } from 'lucide-react'

// Tokens only — raw Tailwind colours would drift from the rest of the app.
// (`danger` is the one exception, kept byte-identical to the red-500 the
// mission/task badges already used; changing it is a colour-pass decision,
// not a de-duplication one.)
export type BadgeTone =
  | 'neutral'
  | 'foreground'
  | 'surface'
  | 'primary'
  | 'primaryStrong'
  | 'primaryOutline'
  | 'warning'
  | 'danger'

export const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-border/40 bg-surface-secondary/50 text-muted-foreground shadow-sm',
  foreground: 'border-border/40 bg-surface-secondary/50 text-foreground shadow-sm',
  surface: 'border-border/40 bg-surface-elevated/80 text-muted-foreground shadow-sm',
  primary: 'border-primary/20 bg-primary/10 text-primary shadow-sm',
  primaryStrong: 'border-primary/25 bg-primary/15 text-primary shadow-sm',
  primaryOutline: 'border-primary/20 bg-primary/5 text-primary shadow-sm',
  warning: 'border-warning/25 bg-warning/10 text-warning shadow-sm',
  danger: 'border-red-500/25 bg-red-500/10 text-red-400 shadow-sm',
}

const SIZES = {
  sm: 'text-[10px] leading-4',
  md: 'text-[11px] leading-4',
} as const

interface StatusBadgeProps {
  label: string
  tone: BadgeTone
  /** sm = 9px (agency cards, lease pills); md = 10px (mission/task status). */
  size?: keyof typeof SIZES
  /** Status words are uppercased; free-form pills (lease globs) are not. */
  uppercase?: boolean
  icon?: LucideIcon
  /** Spins in place of `icon` — the audit badge's in-flight state. */
  busy?: boolean
  busyIcon?: LucideIcon
  title?: string
  /** Present ⇒ renders a button with the interactive hover/disabled classes. */
  onClick?: () => void
  disabled?: boolean
}

export function StatusBadge({
  label,
  tone,
  size = 'md',
  uppercase = true,
  icon: Icon,
  busy = false,
  busyIcon: BusyIcon,
  title,
  onClick,
  disabled,
}: StatusBadgeProps) {
  const RenderIcon = busy ? BusyIcon : Icon
  const base = [
    RenderIcon ? 'inline-flex items-center gap-1' : '',
    'rounded-full border px-2 py-1 font-mono',
    SIZES[size],
    uppercase ? 'uppercase tracking-wide' : '',
    onClick ? 'transition-colors hover:border-primary/30 hover:bg-primary/10 disabled:opacity-50' : '',
    BADGE_TONES[tone],
  ]
    .filter(Boolean)
    .join(' ')

  const content = (
    <>
      {RenderIcon && <RenderIcon className={`h-2.5 w-2.5${busy ? ' animate-spin' : ''}`} />}
      {label}
    </>
  )

  if (onClick) {
    return (
      <button onClick={onClick} disabled={disabled} title={title} className={base}>
        {content}
      </button>
    )
  }
  return (
    <span title={title} className={base}>
      {content}
    </span>
  )
}
