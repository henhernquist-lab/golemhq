'use client'

// The "did this actually happen" panel.
//
// A status badge is the system's opinion of itself, which is the exact thing
// under question. So nothing here restates the verdict — it shows the raw
// material behind it and, where possible, a link that leaves this application
// entirely and lands on something GitHub agrees exists.
//
// The honesty rule that shapes the whole component: a commit that was never
// pushed gets NO link. Rendering `github.com/o/r/commit/<sha>` for a local
// commit would look like third-party confirmation and 404 on click, which is
// worse than showing nothing.

import { useEffect, useState } from 'react'
import { ExternalLink, FileDiff, GitCommit, ScrollText, Clock } from 'lucide-react'

import type { MissionEvent, Task, TaskResult } from '@/lib/missions/types'
import type { TaskArtifact } from '@/lib/missions/artifacts'

interface TaskEvidence {
  task: Task
  results: TaskResult[]
  events: MissionEvent[]
  worktree: { files: string[]; committed: boolean; unknown: boolean }
  artifacts: TaskArtifact[]
  hasExternalEvidence: boolean
}

const VERIFICATION_TONE: Record<TaskArtifact['verification'], string> = {
  verified: 'border-primary/50 bg-primary/10 text-primary',
  local_only: 'border-warning/40 bg-warning/10 text-warning',
  unverified: 'border-border text-muted-foreground',
}

const VERIFICATION_LABEL: Record<TaskArtifact['verification'], string> = {
  verified: 'verified on github',
  local_only: 'local only',
  unverified: 'unverified',
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function TaskEvidencePanel({ taskId }: { taskId: string }) {
  const [data, setData] = useState<TaskEvidence | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showOutput, setShowOutput] = useState(false)

  useEffect(() => {
    let live = true
    fetch(`/api/missions/task/${taskId}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json()
        if (!live) return
        if (!res.ok) setError(body.error ?? `HTTP ${res.status}`)
        else setData(body)
      })
      .catch((err) => live && setError(String(err)))
    return () => {
      live = false
    }
  }, [taskId])

  if (error) {
    return <p className="px-3 py-2 font-mono text-[10px] text-warning">could not load evidence: {error}</p>
  }
  if (!data) {
    return <p className="px-3 py-2 font-mono text-[10px] text-muted-foreground">loading evidence…</p>
  }

  const result = data.results[0] ?? null

  return (
    <div className="mt-2 space-y-3 border-t border-border pt-3">
      {/* ── External evidence ──────────────────────────────────── */}
      <section>
        <h4 className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          <GitCommit className="h-3 w-3" />
          external evidence
        </h4>
        {data.artifacts.length === 0 ? (
          // Said plainly. The alternative — an empty section, or a reassuring
          // tick — implies proof that does not exist.
          <p className="font-mono text-[10px] text-muted-foreground">
            no external artifact — this task ran locally and produced no commit, PR or comment that can be
            checked outside Golem
          </p>
        ) : (
          <ul className="space-y-1.5">
            {data.artifacts.map((a, i) => (
              <li key={`${a.kind}-${a.label}-${i}`} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] text-muted-foreground">{a.kind.replace('_', ' ')}</span>
                {a.url ? (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[10px] text-primary underline underline-offset-2 hover:opacity-80"
                  >
                    {a.label}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                ) : (
                  <span className="font-mono text-[10px] text-foreground">{a.label}</span>
                )}
                <span
                  className={`rounded border px-1 py-0.5 font-mono text-[9px] uppercase ${VERIFICATION_TONE[a.verification]}`}
                >
                  {VERIFICATION_LABEL[a.verification]}
                </span>
                {a.note && <p className="w-full font-mono text-[10px] text-muted-foreground">{a.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── What changed on disk ───────────────────────────────── */}
      <section>
        <h4 className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          <FileDiff className="h-3 w-3" />
          files changed ({data.worktree.files.length})
        </h4>
        {data.worktree.unknown ? (
          <p className="font-mono text-[10px] text-warning">
            the worktree snapshot failed, so what this task changed is genuinely unknown
          </p>
        ) : data.worktree.files.length === 0 ? (
          <p className="font-mono text-[10px] text-muted-foreground">no files recorded</p>
        ) : (
          <ul className="space-y-0.5">
            {data.worktree.files.map((f) => (
              <li key={f} className="font-mono text-[10px] text-foreground">
                {f}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── The builder's own output ───────────────────────────── */}
      {result && (
        <section>
          <button
            onClick={() => setShowOutput((v) => !v)}
            className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:text-primary"
          >
            <ScrollText className="h-3 w-3" />
            builder output ({result.output.length} chars) {showOutput ? '▾' : '▸'}
          </button>
          {showOutput && (
            <pre className="mt-1.5 max-h-72 overflow-auto rounded border border-border bg-surface-base p-2 font-mono text-[10px] whitespace-pre-wrap text-muted-foreground">
              {result.output || '(empty)'}
            </pre>
          )}
        </section>
      )}

      {/* ── The audit log ──────────────────────────────────────── */}
      <section>
        <h4 className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          <Clock className="h-3 w-3" />
          timeline ({data.events.length})
        </h4>
        <ul className="space-y-0.5">
          {/* listEvents already returns oldest-first, which is how a history
              reads. Reversing here put the timeline backwards. */}
          {data.events.map((e) => (
            <li key={e.id} className="flex gap-2 font-mono text-[10px]">
              <span className="shrink-0 text-muted-foreground">{stamp(e.ts)}</span>
              <span className="shrink-0 text-foreground">{e.type}</span>
              <span className="truncate text-muted-foreground">
                {e.type === 'task.status_changed'
                  ? `${String(e.payload.from ?? '?')} → ${String(e.payload.to ?? '?')}`
                  : JSON.stringify(e.payload).slice(0, 120)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
