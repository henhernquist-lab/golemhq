/**
 * /api/models/comparer — reference data for the Model Comparer tool.
 *
 * Proxies OpenRouter's public metadata endpoints and merges them into one
 * normalized list the client searches and compares side-by-side:
 *   - GET /api/v1/models           → specs (context, pricing, provider, modality)
 *   - GET /api/v1/benchmarks?source=artificial-analysis
 *                                  → intelligence/coding/agentic indices
 *   - GET /api/v1/benchmarks?source=openrouter
 *                                  → GPQA-Diamond + tau-bench accuracies
 *
 * This reads benchmark *metadata* only — no model traffic is routed through
 * OpenRouter, no OpenRouter models are added to the roster, and no credits are
 * consumed (the benchmark endpoints are rate-limited to 500 req/day per
 * account, not token-billed). Requires OPENROUTER_API_KEY (free tier works).
 *
 * No in-process caching: the data changes on upstream schedules and serverless
 * instances are ephemeral. 500 req/day is ample for an on-demand reference.
 */

import { auth } from '@/lib/auth'
import { listModels } from '@/lib/nim'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const OPENROUTER = 'https://openrouter.ai/api/v1'

/* ─── OpenRouter wire shapes (only the fields we use) ─────── */

interface ORModel {
  id: string
  name: string
  description?: string | null
  context_length?: number | null
  pricing?: { prompt?: string | null; completion?: string | null }
  architecture?: { modality?: string | null }
  top_provider?: { name?: string | null }
}

interface AABenchmark {
  model_permaslug?: string
  display_name?: string
  intelligence_index?: number | null
  coding_index?: number | null
  agentic_index?: number | null
}

interface ORBenchmark {
  model_permaslug?: string
  benchmark_type?: string
  accuracy?: number | null
  last_run_timestamp?: string | null
}

/* ─── Normalized output ─────────────────────────────────── */

export interface ComparableModel {
  slug: string
  name: string
  description: string | null
  provider: string | null
  modality: string | null
  contextLength: number | null
  /** $/1M input tokens. Null when the model has no per-token pricing. */
  promptPrice: number | null
  /** $/1M output tokens. */
  completionPrice: number | null
  /** Artificial Analysis indices, 0–100. */
  intelligenceIndex: number | null
  codingIndex: number | null
  agenticIndex: number | null
  /** OpenRouter's own evals, accuracy 0–1. */
  gpqaDiamond: number | null
  tauBench: number | null
  /** True when this OpenRouter slug matches a Golem registry model. */
  inRoster: boolean
  rosterLabel: string | null
}

/* ─── Roster matching (registry-driven, no hardcoded list) ── */

// Golem registry ids are provider ids (e.g. deepseek-ai/deepseek-v4-flash),
// OpenRouter slugs use their own prefixes (deepseek/deepseek-v4-flash). Match
// on the last path segment, stripping provider variant suffixes so Groq's
// `llama-3.3-70b-versatile` still resolves to OpenRouter's
// `meta-llama/llama-3.3-70b-instruct`. Suffixes like `-pro`/`-flash` are
// meaningful (they distinguish models) and are deliberately NOT stripped.
const VARIANT_SUFFIXES = ['-versatile', '-instruct', '-chat', '-preview', '-latest', '-thinking'] as const

function rosterTokens(id: string): string[] {
  const last = id.split('/').pop() ?? ''
  for (const suffix of VARIANT_SUFFIXES) {
    if (last.endsWith(suffix)) {
      const base = last.slice(0, -suffix.length)
      return base ? [last, base] : [last]
    }
  }
  return [last]
}

interface RosterEntry {
  tokens: string[]
  label: string
}

function buildRosterIndex(): RosterEntry[] {
  return listModels().map((m) => ({ tokens: rosterTokens(m.id), label: m.label }))
}

function matchRoster(slug: string, roster: RosterEntry[]): { inRoster: boolean; label: string | null } {
  for (const entry of roster) {
    if (entry.tokens.some((t) => t.length >= 4 && slug.includes(t))) {
      return { inRoster: true, label: entry.label }
    }
  }
  return { inRoster: false, label: null }
}

/* ─── Fetch helpers ──────────────────────────────────────── */

function perMillion(perToken: string | null | undefined): number | null {
  if (perToken == null || perToken === '') return null
  const n = Number(perToken)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 1_000_000 * 1000) / 1000
}

async function fetchOpenRouter<T>(path: string, key: string): Promise<{ json?: T; error?: string; status?: number }> {
  try {
    const res = await fetch(`${OPENROUTER}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: 'no-store',
    })
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300)
      return { error: `OpenRouter returned ${res.status}${body ? `: ${body}` : ''}`, status: res.status }
    }
    return { json: (await res.json()) as T }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/* ─── Route ──────────────────────────────────────────────── */

export async function GET() {
  const session = await auth()
  if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const key = process.env.OPENROUTER_API_KEY
  if (!key || key.trim() === '') {
    return Response.json(
      { error: 'OPENROUTER_API_KEY is not configured. Set a (free) OpenRouter key to power the Model Comparer.' },
      { status: 503 },
    )
  }

  const [modelsRes, aaRes, orRes] = await Promise.all([
    fetchOpenRouter<{ data: ORModel[] }>('/models', key),
    fetchOpenRouter<{ data: AABenchmark[] }>('/benchmarks?source=artificial-analysis', key),
    fetchOpenRouter<{ data: ORBenchmark[] }>('/benchmarks?source=openrouter', key),
  ])

  // Surface the first failure honestly — a silent empty list would render as
  // "no models found" and hide a bad key / rate-limit / upstream outage.
  const failure = [modelsRes, aaRes, orRes].find((r) => r.error)
  if (failure?.error) {
    return Response.json({ error: failure.error }, { status: failure.status ?? 502 })
  }

  const models = modelsRes.json?.data ?? []
  const aaItems = aaRes.json?.data ?? []
  const orItems = orRes.json?.data ?? []

  // Index benchmark scores by slug.
  const aaBySlug = new Map<string, AABenchmark>()
  for (const item of aaItems) {
    const slug = item.model_permaslug
    if (slug) aaBySlug.set(slug, item)
  }

  // OpenRouter's own evals may return several items per model/benchmark
  // (different runs/configs). Keep the highest accuracy per benchmark.
  const orBySlug = new Map<string, { gpqa: number | null; tau: number | null }>()
  for (const item of orItems) {
    const slug = item.model_permaslug
    if (!slug || typeof item.accuracy !== 'number') continue
    const cur = orBySlug.get(slug) ?? { gpqa: null, tau: null }
    if (item.benchmark_type === 'gpqa_diamond') {
      cur.gpqa = Math.max(cur.gpqa ?? -1, item.accuracy)
    } else if (item.benchmark_type === 'tau_bench_verified_airline') {
      cur.tau = Math.max(cur.tau ?? -1, item.accuracy)
    }
    orBySlug.set(slug, cur)
  }

  const roster = buildRosterIndex()

  const out: ComparableModel[] = models.map((m) => {
    const aa = aaBySlug.get(m.id)
    const or = orBySlug.get(m.id)
    const rosterMatch = matchRoster(m.id, roster)
    return {
      slug: m.id,
      name: m.name || m.id,
      description: m.description ?? null,
      // OpenRouter's docs show top_provider without a name field, but the
      // live API includes it; fall back to the slug's org prefix so the
      // provider column is never blank for a model that lacks it.
      provider: m.top_provider?.name ?? m.id.split('/')[0] ?? null,
      modality: m.architecture?.modality ?? null,
      contextLength: typeof m.context_length === 'number' ? m.context_length : null,
      promptPrice: perMillion(m.pricing?.prompt),
      completionPrice: perMillion(m.pricing?.completion),
      intelligenceIndex: aa?.intelligence_index ?? null,
      codingIndex: aa?.coding_index ?? null,
      agenticIndex: aa?.agentic_index ?? null,
      gpqaDiamond: or?.gpqa ?? null,
      tauBench: or?.tau ?? null,
      inRoster: rosterMatch.inRoster,
      rosterLabel: rosterMatch.label,
    }
  })

  // Most-useful default ordering: best intelligence first, unknown last.
  out.sort((a, b) => (b.intelligenceIndex ?? -1) - (a.intelligenceIndex ?? -1))

  return Response.json({ models: out, count: out.length })
}
