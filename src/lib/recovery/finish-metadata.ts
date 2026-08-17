// ───────────────────────────────────────────────────────────────────
// Finish metadata — the signal that turns a silent truncation into a
// visible one.
//
// The bug this exists to fix: `streamText` only invokes `onError` when
// the request *throws*. A response that hits `maxOutputTokens` (very
// reachable here — tool turns reserve as little as 1024 output tokens,
// see `maxOutputTokensWithTools` in src/lib/nim.ts) finishes with
// `finishReason: 'length'`, which the SDK treats as a perfectly normal
// completion. No error, no `onError`, `useChat` goes straight to
// `status: 'ready'` — and the user is left with a sentence that stops
// mid-word and no indication anything went wrong. Same for
// 'content-filter' and provider-side 'error' finishes.
//
// So the server stamps every assistant message with the finish reason,
// and the client decides from that whether the turn actually completed.
// The absence of this metadata is itself meaningful: both /api/chat
// stream paths attach it, so a message that arrives without it came
// from a stream that closed before its finish chunk — a dropped
// connection — which is equally an interruption.
// ───────────────────────────────────────────────────────────────────

/** Metadata attached to every assistant message produced by /api/chat. */
export interface ChatMessageMetadata {
  /** The provider's finish reason, as reported on the stream's finish chunk. */
  finishReason?: string
  /** True when the stream stopped before the model was done talking. */
  interrupted?: boolean
  /** Why it stopped, in words the UI can show directly. */
  interruptionLabel?: string
}

/** Finish reasons that mean the model said everything it meant to say. */
const CLEAN_FINISH_REASONS = new Set(['stop', 'tool-calls', 'tool_calls'])

/** Human-readable cause for each non-clean finish reason. */
const INTERRUPTION_LABELS: Record<string, string> = {
  length: 'Response was cut off — it hit this model\u2019s output limit.',
  'content-filter': 'Response was cut off by the model\u2019s content filter.',
  error: 'Response was cut off — the model provider errored mid-stream.',
  other: 'Response was cut off before it finished.',
  unknown: 'Response was cut off before it finished.',
}

/**
 * Build the metadata object for a finish chunk. Returned straight from
 * `toUIMessageStreamResponse({ messageMetadata })`.
 */
export function buildFinishMetadata(finishReason: string | undefined): ChatMessageMetadata {
  const reason = finishReason ?? 'unknown'
  const interrupted = !CLEAN_FINISH_REASONS.has(reason)
  return {
    finishReason: reason,
    interrupted,
    ...(interrupted ? { interruptionLabel: INTERRUPTION_LABELS[reason] ?? INTERRUPTION_LABELS.unknown } : {}),
  }
}

/**
 * Client-side read of the metadata. `hasContent` distinguishes an
 * interrupted turn (partial text worth continuing from) from a turn that
 * produced nothing at all.
 *
 * A message with content but no metadata at all is treated as
 * interrupted: every /api/chat path stamps metadata on finish, so its
 * absence means the stream never reached its finish chunk.
 */
export function readFinishMetadata(
  metadata: unknown,
  hasContent: boolean,
): { interrupted: boolean; label: string } {
  const meta = (metadata ?? null) as ChatMessageMetadata | null

  if (!meta || typeof meta !== 'object' || meta.finishReason === undefined) {
    return hasContent
      ? { interrupted: true, label: 'Response was cut off — the connection dropped before it finished.' }
      : { interrupted: false, label: '' }
  }

  if (!meta.interrupted) return { interrupted: false, label: '' }

  return {
    interrupted: true,
    label: meta.interruptionLabel ?? INTERRUPTION_LABELS.unknown,
  }
}
