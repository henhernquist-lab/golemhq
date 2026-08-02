'use client'

import { motion } from 'framer-motion'
import { AlertTriangle, CornerDownRight, RotateCcw } from 'lucide-react'

// ───────────────────────────────────────────────────────────────────
// InterruptedNotice — the visible "this stopped early" state.
//
// Rendered directly beneath the assistant bubble whose stream ended
// before the model was finished. This is the guarantee that a cutoff is
// never silent: it does not depend on an error being thrown, only on the
// finish metadata the route stamps on every message.
//
// The partial text above it is left untouched — a truncated answer is
// still usually most of an answer, and discarding it to show an error
// would be worse than the bug. "Continue" asks the model to resume from
// where it stopped; "Retry" regenerates the turn from scratch.
//
// Dark/mono aesthetic to match the rest of the panel — a muted warning
// row, not a modal or a red alert box.
// ───────────────────────────────────────────────────────────────────

interface InterruptedNoticeProps {
  /** Why the stream stopped, already phrased for display. */
  label: string
  /** Resume from the partial output. Omitted when there's nothing to resume from. */
  onContinue?: () => void
  /** Regenerate the whole turn. */
  onRetry?: () => void
  /** Disables both actions while another request is in flight. */
  busy?: boolean
}

export function InterruptedNotice({ label, onContinue, onRetry, busy }: InterruptedNoticeProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      role="status"
      aria-live="polite"
      className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2"
    >
      <AlertTriangle className="h-3 w-3 shrink-0 text-warning" />
      <span className="font-mono text-[11px] text-warning/90">{label}</span>

      {onContinue && (
        <button
          onClick={onContinue}
          disabled={busy}
          className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <CornerDownRight className="h-2.5 w-2.5" />
          Continue
        </button>
      )}

      {onRetry && (
        <button
          onClick={onRetry}
          disabled={busy}
          className={`flex items-center gap-1 rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 ${onContinue ? '' : 'ml-auto'}`}
        >
          <RotateCcw className="h-2.5 w-2.5" />
          Retry
        </button>
      )}
    </motion.div>
  )
}
