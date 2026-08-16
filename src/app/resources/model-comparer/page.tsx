'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { AlertCircle, ArrowLeft, BarChart3, Loader2, Search, X } from 'lucide-react'

/* Mirrors the normalized shape returned by /api/models/comparer. */
interface ComparableModel {
  slug: string
  name: string
  description: string | null
  provider: string | null
  modality: string | null
  contextLength: number | null
  promptPrice: number | null
  completionPrice: number | null
  intelligenceIndex: number | null
  codingIndex: number | null
  agenticIndex: number | null
  gpqaDiamond: number | null
  tauBench: number | null
  inRoster: boolean
  rosterLabel: string | null
}

const MAX_SELECTED = 3

/* ─── Axis definitions ─────────────────────────────────── */

interface Axis {
  key: string
  label: string
  hint?: string
  get: (m: ComparableModel) => number | string | null
  /** 0–1 fraction for the bar; null = no bar. */
  fraction?: (m: ComparableModel) => number | null
  format: (m: ComparableModel) => string
}

const AXES: Axis[] = [
  { key: 'provider', label: 'Provider', get: (m) => m.provider, format: (m) => m.provider ?? '—' },
  { key: 'modality', label: 'Modality', get: (m) => m.modality, format: (m) => m.modality ?? '—' },
  {
    key: 'context',
    label: 'Context window',
    get: (m) => m.contextLength,
    format: (m) => formatContext(m.contextLength),
  },
  {
    key: 'price-in',
    label: 'Price · input',
    hint: '$ per 1M tokens',
    get: (m) => m.promptPrice,
    format: (m) => (m.promptPrice == null ? '—' : `$${m.promptPrice.toFixed(2)}`),
  },
  {
    key: 'price-out',
    label: 'Price · output',
    hint: '$ per 1M tokens',
    get: (m) => m.completionPrice,
    format: (m) => (m.completionPrice == null ? '—' : `$${m.completionPrice.toFixed(2)}`),
  },
  {
    key: 'intelligence',
    label: 'Intelligence',
    hint: 'Artificial Analysis index',
    get: (m) => m.intelligenceIndex,
    fraction: (m) => (m.intelligenceIndex == null ? null : m.intelligenceIndex / 100),
    format: (m) => (m.intelligenceIndex == null ? '—' : String(m.intelligenceIndex)),
  },
  {
    key: 'coding',
    label: 'Coding',
    hint: 'Artificial Analysis index',
    get: (m) => m.codingIndex,
    fraction: (m) => (m.codingIndex == null ? null : m.codingIndex / 100),
    format: (m) => (m.codingIndex == null ? '—' : String(m.codingIndex)),
  },
  {
    key: 'agentic',
    label: 'Agentic',
    hint: 'Artificial Analysis index',
    get: (m) => m.agenticIndex,
    fraction: (m) => (m.agenticIndex == null ? null : m.agenticIndex / 100),
    format: (m) => (m.agenticIndex == null ? '—' : String(m.agenticIndex)),
  },
  {
    key: 'gpqa',
    label: 'GPQA-Diamond',
    hint: 'OpenRouter eval · accuracy',
    get: (m) => m.gpqaDiamond,
    fraction: (m) => (m.gpqaDiamond == null ? null : m.gpqaDiamond),
    format: (m) => (m.gpqaDiamond == null ? '—' : `${(m.gpqaDiamond * 100).toFixed(0)}%`),
  },
  {
    key: 'tau-bench',
    label: 'Tau-bench (airline)',
    hint: 'OpenRouter eval · accuracy',
    get: (m) => m.tauBench,
    fraction: (m) => (m.tauBench == null ? null : m.tauBench),
    format: (m) => (m.tauBench == null ? '—' : `${(m.tauBench * 100).toFixed(0)}%`),
  },
]

function formatContext(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

/* ─── Bar cell (indices + accuracies) ──────────────────── */

function BarCell({ fraction, text }: { fraction: number | null; text: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 flex-shrink-0 overflow-hidden rounded-full bg-surface-elevated">
        {fraction != null && (
          <div
            className="h-full rounded-full bg-primary/70"
            style={{ width: `${Math.min(100, Math.max(0, fraction * 100))}%` }}
          />
        )}
      </div>
      <span className="font-mono text-xs text-foreground">{text}</span>
    </div>
  )
}

/* ─── Page ─────────────────────────────────────────────── */

export default function ModelComparerPage() {
  const { status } = useSession()
  const router = useRouter()
  const [models, setModels] = useState<ComparableModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ComparableModel[]>([])
  const [query, setQuery] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    let cancelled = false
    fetch('/api/models/comparer')
      .then(async (res) => {
        const ct = res.headers.get('content-type') ?? ''
        if (!ct.includes('application/json')) throw new Error(`Unexpected response (${res.status})`)
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
        return body as { models: ComparableModel[] }
      })
      .then((body) => {
        if (!cancelled) setModels(body.models ?? [])
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const selectedSlugs = useMemo(() => new Set(selected.map((m) => m.slug)), [selected])

  const rosterModels = useMemo(() => models.filter((m) => m.inRoster), [models])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return models
      .filter((m) => !selectedSlugs.has(m.slug))
      .filter((m) => m.name.toLowerCase().includes(q) || m.slug.toLowerCase().includes(q))
      .slice(0, 25)
  }, [query, models, selectedSlugs])

  const addModel = (m: ComparableModel) => {
    if (selectedSlugs.has(m.slug) || selected.length >= MAX_SELECTED) return
    setSelected((prev) => [...prev, m])
    setQuery('')
    setDropdownOpen(false)
    inputRef.current?.blur()
  }

  const removeModel = (slug: string) => setSelected((prev) => prev.filter((m) => m.slug !== slug))

  return (
    <div className="min-h-screen bg-transparent">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-border bg-surface-secondary/95 backdrop-blur">
        <div className="flex h-11 items-center justify-between px-4">
          <Link href="/resources" className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" />
            Resources
          </Link>
          <div className="flex items-center gap-2">
            <BarChart3 className="h-3.5 w-3.5 text-primary" />
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Model Comparer</span>
          </div>
          <span className="font-mono text-[10px] text-muted-foreground/40">REFERENCE</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-8 px-4 py-6">
        <div>
          <h1 className="font-display text-xl font-bold tracking-tight text-foreground">Model Comparer</h1>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Pick 2–3 models · compare capability &amp; benchmarks
          </p>
        </div>

        {/* Loading / error */}
        {loading && (
          <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="font-mono text-xs">Loading model data…</span>
          </div>
        )}

        {!loading && error && (
          <div className="flex items-start gap-2 rounded border border-[#ff4d4d]/30 bg-[#ff4d4d]/8 px-3 py-2.5 text-xs text-[#ff4d4d]">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <div>
              <p className="font-medium">Couldn&apos;t load model data.</p>
              <p className="mt-0.5 text-[#ff4d4d]/80">{error}</p>
            </div>
          </div>
        )}

        {!loading && !error && (
          <>
            {/* Search + selection */}
            <div className="space-y-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setDropdownOpen(true) }}
                  onFocus={() => setDropdownOpen(true)}
                  onBlur={() => setTimeout(() => setDropdownOpen(false), 150)}
                  placeholder={selected.length >= MAX_SELECTED ? `${MAX_SELECTED} models selected (max)` : 'Search any model (e.g. GPT-5.6, DeepSeek V4, Claude)…'}
                  disabled={selected.length >= MAX_SELECTED}
                  className="w-full rounded border border-border bg-surface-elevated py-2 pl-9 pr-3 text-sm text-foreground placeholder-muted-foreground/50 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-40"
                />
                {dropdownOpen && filtered.length > 0 && (
                  <div className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded border border-border bg-surface-secondary shadow-xl scrollbar-hidden">
                    {filtered.map((m) => (
                      <button
                        key={m.slug}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => addModel(m)}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-elevated"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-foreground">{m.name}</span>
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">{m.slug}</span>
                        </span>
                        {m.inRoster && (
                          <span className="flex-shrink-0 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary">
                            Golem
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Golem roster quick-picks */}
              {rosterModels.length > 0 && (
                <div>
                  <p className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/50">
                    Golem roster
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {rosterModels.map((m) => {
                      const active = selectedSlugs.has(m.slug)
                      return (
                        <button
                          key={m.slug}
                          onClick={() => (active ? removeModel(m.slug) : addModel(m))}
                          disabled={!active && selected.length >= MAX_SELECTED}
                          className={`rounded border px-2 py-1 font-mono text-[10px] transition-colors disabled:opacity-30 ${
                            active
                              ? 'border-primary/40 bg-primary/15 text-primary'
                              : 'border-border bg-surface-elevated text-muted-foreground hover:border-primary/30 hover:text-foreground'
                          }`}
                        >
                          {active && <X className="mr-1 inline h-2.5 w-2.5" />}
                          {m.rosterLabel ?? m.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Selected chips */}
              {selected.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {selected.map((m) => (
                    <span
                      key={m.slug}
                      className="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-[10px] text-primary"
                    >
                      {m.name}
                      <button onClick={() => removeModel(m.slug)} aria-label={`Remove ${m.name}`} className="text-primary/70 hover:text-primary">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Comparison */}
            {selected.length < 2 ? (
              <div className="rounded border border-dashed border-border bg-surface-secondary/40 py-12 text-center">
                <p className="font-mono text-xs text-muted-foreground">
                  {selected.length === 0
                    ? 'Select 2–3 models to see them compared side by side.'
                    : 'Select at least one more model to compare.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded border border-border bg-surface-secondary">
                <table className="w-full min-w-[560px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="w-40 px-4 py-3 text-left font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                        Metric
                      </th>
                      {selected.map((m) => (
                        <th key={m.slug} className="px-4 py-3 text-left">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-foreground">{m.name}</span>
                            {m.inRoster && (
                              <span className="rounded border border-primary/30 bg-primary/10 px-1 font-mono text-[8px] uppercase tracking-wider text-primary">
                                Golem
                              </span>
                            )}
                          </div>
                          <span className="block truncate font-mono text-[10px] font-normal text-muted-foreground">
                            {m.slug}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {AXES.map((axis) => (
                      <tr key={axis.key} className="border-b border-border/50 last:border-b-0">
                        <td className="px-4 py-2.5 align-middle">
                          <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{axis.label}</p>
                          {axis.hint && <p className="mt-0.5 text-[9px] text-muted-foreground/50">{axis.hint}</p>}
                        </td>
                        {selected.map((m) => (
                          <td key={m.slug} className="px-4 py-2.5 align-middle">
                            {axis.fraction ? (
                              <BarCell fraction={axis.fraction(m)} text={axis.format(m)} />
                            ) : (
                              <span className="font-mono text-xs text-foreground">{axis.format(m)}</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="font-mono text-[10px] leading-relaxed text-muted-foreground/60">
              Benchmark scores via OpenRouter&apos;s public metadata (Artificial Analysis indices + OpenRouter&apos;s
              own evals). Indices are 0–100; GPQA-Diamond and Tau-bench are accuracy. Prices are $ per 1M tokens.
              Models without a score for an axis show —.
            </p>
          </>
        )}
      </main>
    </div>
  )
}
