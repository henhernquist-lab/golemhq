// Auto-fill Memory from real Lab activity — Evolutionary Code Generation
// runs and Overnight R&D ideas, the two Lab features that are actually
// persisted (LARP Engine queries are not — see the Batch investigation this
// shipped with). Same shape as src/lib/auto-memory.ts's chat extraction:
// one LLM call over recent real rows, at most 2 durable facts, written as
// PENDING resources rows for review — never silently trusted.
//
// Manually triggered (POST /api/memory/auto-extract/lab), not periodic. Lab
// runs are experiments, not necessarily real usage patterns, so this only
// ever runs when Henry explicitly asks for it — that's the opt-in, rather
// than a separate on/off setting nobody would remember exists.

import { generateText } from 'ai'
import { supabase } from './supabase'
import { nimClientFor, DEFAULT_MODEL_ID, parseJsonLoose } from './nim'
import { emitResourceSaved } from './resource-events'

const EXTRACTION_MODEL = DEFAULT_MODEL_ID
const MAX_FACTS = 2
const MAX_FACT_LENGTH = 300
const MIN_ROWS = 3
const ROWS_PER_SOURCE = 20

function isUsefulFact(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const fact = value.trim()
  return fact.length >= 8 && fact.length <= MAX_FACT_LENGTH
}

export interface LabExtractionResult {
  factsWritten: number
  rowsConsidered: number
  skippedReason: string | null
}

export async function extractLabMemories(resourceUserId: string): Promise<LabExtractionResult> {
  const [evoRes, ideaRes] = await Promise.all([
    supabase
      .from('evolution_runs')
      .select('prompt, status, created_at')
      .eq('user_id', resourceUserId)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(ROWS_PER_SOURCE),
    supabase
      .from('overnight_ideas')
      .select('title, description, verdict, created_at')
      .eq('user_id', resourceUserId)
      .order('created_at', { ascending: false })
      .limit(ROWS_PER_SOURCE),
  ])

  const evoRows = evoRes.data ?? []
  const ideaRows = ideaRes.data ?? []
  const rowsConsidered = evoRows.length + ideaRows.length

  if (rowsConsidered < MIN_ROWS) {
    return { factsWritten: 0, rowsConsidered, skippedReason: `only ${rowsConsidered} Lab run(s) found — need at least ${MIN_ROWS}` }
  }

  const digest = [
    ...evoRows.map((r) => `[evolution] ${(r.prompt ?? '').slice(0, 200)}`),
    ...ideaRows.map((r) => `[overnight] ${(r.title ?? '').slice(0, 100)} — ${(r.description ?? '').slice(0, 200)}${r.verdict ? ` (verdict: ${r.verdict})` : ''}`),
  ].join('\n')

  try {
    const client = nimClientFor(EXTRACTION_MODEL)
    const { text } = await generateText({
      model: client.chat(EXTRACTION_MODEL),
      system: 'You identify durable, user-specific facts from a log of coding-experiment activity. Return JSON only.',
      prompt: `Review this recent Lab activity — prompts run through Evolutionary Code Generation, and ideas dispatched to Overnight R&D. Extract at most ${MAX_FACTS} durable facts about the user's real, RECURRING interests or working patterns — something that shows up more than once, not a one-off experiment. Exclude anything that only appears in a single run, anything speculative, and anything that isn't clearly about the user's actual interests (not about the code itself). Phrase each fact as a concise standalone sentence. If nothing recurs enough to count as a pattern, return an empty list — a single try-it-once experiment is not a fact.\n\nReturn exactly: {"facts":["..."]}\n\nLAB ACTIVITY:\n${digest.slice(-6000)}`,
      maxOutputTokens: 240,
      maxRetries: 0,
    })

    const parsed = parseJsonLoose<{ facts?: unknown }>(text)
    const facts = Array.isArray(parsed?.facts)
      ? parsed.facts.filter(isUsefulFact).map((fact) => fact.trim()).slice(0, MAX_FACTS)
      : []
    if (facts.length === 0) {
      return { factsWritten: 0, rowsConsidered, skippedReason: 'no recurring pattern found in recent Lab activity' }
    }

    const { data: existing } = await supabase
      .from('resources')
      .select('payload')
      .eq('user_id', resourceUserId)
      .eq('type', 'memory')
      .limit(100)

    const existingText = (existing ?? [])
      .map((row) => {
        const payload = row.payload as { content?: unknown } | null
        return typeof payload?.content === 'string' ? payload.content.trim().toLowerCase() : ''
      })
      .filter(Boolean)

    const newFacts = facts.filter((fact) => {
      const normalized = fact.toLowerCase()
      return !existingText.some((old) => old === normalized || old.includes(normalized) || normalized.includes(old))
    })
    if (newFacts.length === 0) {
      return { factsWritten: 0, rowsConsidered, skippedReason: 'extracted facts already exist in Memory' }
    }

    const rows = newFacts.map((content) => ({
      user_id: resourceUserId,
      type: 'memory' as const,
      source: 'daily_auto' as const,
      title: content.slice(0, 80),
      payload: {
        content,
        autoCaptured: true,
        reviewState: 'pending' as const,
        activityCategory: 'lab' as const,
      },
    }))

    const { error } = await supabase.from('resources').insert(rows)
    if (error) {
      console.error('[lab-auto-memory] resource insert failed:', error)
      return { factsWritten: 0, rowsConsidered, skippedReason: `write failed: ${error.message}` }
    }
    emitResourceSaved()

    return { factsWritten: newFacts.length, rowsConsidered, skippedReason: null }
  } catch (error) {
    console.error('[lab-auto-memory] extraction failed:', error)
    return { factsWritten: 0, rowsConsidered, skippedReason: error instanceof Error ? error.message : 'extraction failed' }
  }
}
