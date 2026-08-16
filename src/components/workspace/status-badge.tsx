'use client'

// One status badge for the whole workspace surface.
//
// Before this, the same pill existed four times: `Badge` + TASK_TONE/
// MISSION_TONE in missions-workspace.tsx, `AuditBadge`'s inline tone ternary
// and the active/paused span in agency-workspace.tsx, and the lease pills in
// the task list. Each carried its own copy of the tone strings, so a tone
// added in one place silently didn't exist in the others.
//
// Phase 1 of the design.md build order is de-duplication with ZERO visual
// change, so every class string here is lifted verbatim from the call site it
// replaces — including the two text sizes, the uppercase/plain split, and the
// `inline-flex` that only appears when there is an icon to lay out. Do not
// "tidy" those into one shape without a deliberate visual decision.

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
  neutral: 'border-border text-muted-foreground',
  foreground: 'border-border text-foreground',
  surface: 'border-border bg-surface-elevated text-muted-foreground',
  primary: 'border-primary/40 bg-primary/10 text-primary',
  primaryStrong: 'border-primary/50 bg-primary/15 text-primary',
  primaryOutline: 'border-primary/30 text-primary',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  danger: 'border-red-500/40 bg-red-500/10 text-red-400',
}

const SIZES = {
  sm: 'text-[9px]',
  md: 'text-[10px]',
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
    'rounded border px-1.5 py-0.5 font-mono',
    SIZES[size],
    uppercase ? 'uppercase tracking-wide' : '',
    onClick ? 'transition-colors hover:border-primary/40 disabled:opacity-50' : '',
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
