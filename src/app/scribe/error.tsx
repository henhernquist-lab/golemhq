'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowLeft, RotateCcw } from 'lucide-react'

export default function ScribeError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[scribe] page error boundary:', error)
  }, [error])

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-lg rounded-lg border border-border bg-surface-secondary p-8 shadow-2xl shadow-black/20">
        <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-full border border-destructive/30 bg-destructive/10 text-destructive">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        </div>
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-destructive/70">
          Scribe unavailable
        </p>
        <h1 className="mb-3 font-serif text-2xl text-foreground">The prompt room hit an error.</h1>
        <p className="mb-7 text-sm leading-relaxed text-muted-foreground">
          Your saved prompts are safe. Reload this room or return to Golem and try again.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 rounded border border-primary/40 bg-primary/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-primary transition-colors hover:bg-primary/20"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded border border-border bg-background px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back to Golem
          </Link>
        </div>
      </section>
    </main>
  )
}
