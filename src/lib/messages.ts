/**
 * Normalize incoming chat messages to the AI SDK v6 UIMessage shape that
 * `convertToModelMessages` requires.
 *
 * Why this exists: `convertToModelMessages` (ai v6) reads `message.parts`
 * for every role and calls `.map()` / `.filter()` on it. It NEVER falls back
 * to a legacy `message.content` string. A client that still sends the v4
 * shape — `{ role, content }` — produces `message.parts === undefined`, so the
 * conversion throws `TypeError: Cannot read properties of undefined (reading
 * 'map')`. That throw is uncaught inside the route handler, escapes to the
 * framework, and surfaces as a raw HTML 500 — the exact failure mode the
 * client-side guard in `lib/fetch-json` was built to shield users from.
 *
 * The Architect/Scribe UI (`scribe/page.tsx`) and any third-party/legacy
 * caller send `{role, content}`. Normalize here so both wire shapes work.
 *
 * Returns a new array; never mutates the input. Messages that already have a
 * `parts` array pass through unchanged. Messages with a string `content` are
 * upgraded to a single text part. Anything else is dropped (defensive — we
 * refuse to forward a shape that would 500 the conversion).
 */

export interface UIMessageLike {
  role: 'system' | 'user' | 'assistant' | string
  // v6 shape
  parts?: Array<{ type: string; text?: string; [k: string]: unknown }>
  // legacy v4 shape
  content?: string
  [k: string]: unknown
}

export function toUIMessages(
  messages: unknown,
): Array<{ role: 'system' | 'user' | 'assistant'; parts: Array<{ type: 'text'; text: string }> }> {
  if (!Array.isArray(messages)) return []
  const out: Array<{ role: 'system' | 'user' | 'assistant'; parts: Array<{ type: 'text'; text: string }> }> = []
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const msg = m as UIMessageLike
    const role = msg.role
    // Only system/user/assistant are valid chat roles; drop anything else.
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue
    if (Array.isArray(msg.parts) && msg.parts.length > 0) {
      // Already v6-shaped. Pass through, but guarantee text parts have `text`.
      out.push({
        role,
        parts: msg.parts.map((p) => ({
          type: 'text' as const,
          text: typeof p.text === 'string' ? p.text : '',
        })),
      })
      continue
    }
    if (typeof msg.content === 'string') {
      out.push({ role, parts: [{ type: 'text', text: msg.content }] })
      continue
    }
    // Neither shape we understand — skip rather than 500.
  }
  return out
}
