import { generateText } from 'ai'
import { supabase } from './supabase'
import { nimClientFor, DEFAULT_MODEL_ID, parseJsonLoose } from './nim'
import { emitResourceSaved } from './resource-events'

const EXTRACTION_MODEL = DEFAULT_MODEL_ID
const MAX_FACTS = 2
const MAX_FACT_LENGTH = 300
const MIN_USER_TURNS = 3

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const value = message as { content?: unknown; parts?: unknown[] }
  if (typeof value.content === 'string') return value.content
  if (Array.isArray(value.parts)) {
    return value.parts
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        const p = part as { type?: string; text?: unknown }
        return p.type === 'text' && typeof p.text === 'string' ? p.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function isUsefulFact(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const fact = value.trim()
  return fact.length >= 8 && fact.length <= MAX_FACT_LENGTH
}

/**
 * Extract durable user facts only after every third user turn. This is
 * deliberately best-effort: a provider or database failure must never affect
 * the completed chat response.
 */
export async function extractAndSaveAutoMemories(
  resourceUserId: string,
  // Kept for call-site compatibility (src/app/api/chat/route.ts already
  // resolves it) even though it's unused here now — see the mirror-on-accept
  // note below for why.
  _googleId: string,
  messages: unknown[],
): Promise<void> {
  const userMessages = messages
    .filter((message) => (message as { role?: unknown } | null)?.role === 'user')
    .map(textFromMessage)
    .filter(Boolean)

  if (userMessages.length < MIN_USER_TURNS || userMessages.length % MIN_USER_TURNS !== 0) return

  const transcript = userMessages.slice(-6).join('\n')
  if (!transcript.trim()) return

  try {
    const client = nimClientFor(EXTRACTION_MODEL)
    const { text } = await generateText({
      model: client.chat(EXTRACTION_MODEL),
      system: 'You identify durable, user-specific facts from conversation. Return JSON only.',
      prompt: `Review these recent user messages. Extract at most ${MAX_FACTS} durable facts about the user that would improve future conversations. Include stable preferences, background, ongoing projects, recurring constraints, or important goals. Exclude questions, temporary plans, one-off requests, assistant claims, sensitive secrets, and anything uncertain. Phrase each fact as a concise standalone sentence. If there are no durable facts, return an empty list.\n\nReturn exactly: {"facts":["..."]}\n\nUSER MESSAGES:\n${transcript.slice(-6000)}`,
      maxOutputTokens: 240,
      maxRetries: 0,
    })

    const parsed = parseJsonLoose<{ facts?: unknown }>(text)
    const facts = Array.isArray(parsed?.facts)
      ? parsed.facts.filter(isUsefulFact).map((fact) => fact.trim()).slice(0, MAX_FACTS)
      : []
    if (facts.length === 0) return

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
    if (newFacts.length === 0) return

    const rows = newFacts.map((content) => ({
      user_id: resourceUserId,
      type: 'memory' as const,
      source: 'daily_auto' as const,
      title: content.slice(0, 80),
      payload: {
        content,
        autoCaptured: true,
        reviewState: 'pending' as const,
        activityCategory: 'chat' as const,
      },
    }))

    const { error } = await supabase.from('resources').insert(rows)
    if (error) {
      console.error('[auto-memory] resource insert failed:', error)
      return
    }
    emitResourceSaved()

    // Deliberately NOT mirrored into the legacy `memories` table (the
    // pgvector-searched recall store chat actually reads from) here. This
    // used to happen immediately on insert, which meant an unreviewed
    // "pending" fact could already be recalled in a future conversation
    // before Henry ever saw it — exactly the silent-pollution risk a review
    // gate is supposed to prevent. The mirror now happens in
    // PATCH /api/memory (action: 'accept'), once a human has actually looked
    // at it. See src/app/api/memory/route.ts.
  } catch (error) {
    console.error('[auto-memory] extraction skipped:', error)
  }
}
