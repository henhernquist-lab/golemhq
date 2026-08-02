// Verification harness for TASK 3 — forces early stream stops and asserts
// the pipeline turns each one into a *visible* interrupted state rather
// than a silent truncation.
//
// Run: node --experimental-strip-types scripts/verify-midstream-stops.ts
//
// This exercises the real code path end to end without the dev server:
//   1. A real `streamText` against a mock model with maxOutputTokens set
//      low enough to force finishReason 'length' — the exact silent-cutoff
//      case from the bug report.
//   2. The real `toUIMessageStreamResponse({ messageMetadata })` wiring
//      from the route, so the finish chunk is produced by the SDK.
//   3. The real `readFinishMetadata` the UI uses to decide whether to
//      render InterruptedNotice.

import { streamText } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { buildFinishMetadata, readFinishMetadata } from '../src/lib/recovery/finish-metadata.ts'

function mockModel(finishReason: string, chunks: string[]) {
  // NOTE for future edits: in @ai-sdk/provider v3 the provider-level finish
  // chunk carries `finishReason: { unified, raw }` (an object) and a
  // structured `usage` shape. Passing the old flat string/usage silently
  // yields finishReason 'other' with no error — which looks exactly like a
  // bug in the code under test. Keep these shapes in sync with
  // LanguageModelV3FinishReason / LanguageModelV3Usage.
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheReads: undefined, cacheWrites: undefined },
    outputTokens: { total: 20, text: 20, reasoning: undefined, prediction: undefined },
    totalTokens: 30,
  }
  const parts = [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: '0' },
    ...chunks.map((delta) => ({ type: 'text-delta' as const, id: '0', delta })),
    { type: 'text-end' as const, id: '0' },
    {
      type: 'finish' as const,
      finishReason: { unified: finishReason, raw: finishReason },
      usage,
    },
  ]
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        start(c) { for (const p of parts) c.enqueue(p as any); c.close() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    }),
  })
}

/** Drive a scenario through the real route wiring and read what the UI would see. */
async function run(name: string, finishReason: string, chunks: string[]) {
  const result = streamText({ model: mockModel(finishReason, chunks), prompt: 'x' })

  // Exactly the call the route makes.
  const response = result.toUIMessageStreamResponse({
    messageMetadata: ({ part }) =>
      part.type === 'finish' ? buildFinishMetadata(part.finishReason) : undefined,
  })

  // Parse the SSE stream the browser would receive.
  const body = await response.text()
  let text = ''
  let metadata: unknown = null
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (payload === '[DONE]') continue
    const chunk = JSON.parse(payload)
    if (chunk.type === 'text-delta') text += chunk.delta ?? ''
    if (chunk.messageMetadata) metadata = chunk.messageMetadata
  }

  // Exactly what center-panel.tsx computes per message.
  const verdict = readFinishMetadata(metadata, text.trim().length > 0)

  console.log(`\n── ${name}`)
  console.log(`   finishReason from provider : ${finishReason}`)
  console.log(`   partial text preserved     : ${JSON.stringify(text)}`)
  console.log(`   metadata on message        : ${JSON.stringify(metadata)}`)
  console.log(`   UI renders interrupted?    : ${verdict.interrupted}`)
  if (verdict.interrupted) console.log(`   user-visible label         : "${verdict.label}"`)
  return verdict
}

const failures: string[] = []
function expect(cond: boolean, msg: string) {
  if (!cond) failures.push(msg)
}

// ── Scenario 1: hit maxOutputTokens (the reported silent truncation) ──
const cutoff = await run(
  'Hit output ceiling (finishReason=length)',
  'length',
  ['The three main causes are, first, ', 'the connection dropping mid-'],
)
expect(cutoff.interrupted, 'length finish must render an interrupted state')
expect(cutoff.label.includes('cut off'), 'length finish must say the response was cut off')

// ── Scenario 2: provider errored mid-stream ───────────────────────────
const errored = await run('Provider error mid-stream', 'error', ['Partial answer'])
expect(errored.interrupted, 'error finish must render an interrupted state')

// ── Scenario 3: content filter ────────────────────────────────────────
const filtered = await run('Content filter', 'content-filter', ['Beginning of an answer'])
expect(filtered.interrupted, 'content-filter finish must render an interrupted state')

// ── Scenario 4: normal completion must NOT show the notice ────────────
const clean = await run('Clean completion', 'stop', ['A complete answer.'])
expect(!clean.interrupted, 'a clean stop must NOT be flagged as interrupted (no false positives)')

// ── Scenario 5: connection dropped — stream dies with no finish chunk,
// so no metadata ever arrives. The old code showed nothing at all.
const dropped = readFinishMetadata(undefined, true)
console.log('\n── Dropped connection (no finish chunk, no metadata)')
console.log(`   UI renders interrupted?    : ${dropped.interrupted}`)
console.log(`   user-visible label         : "${dropped.label}"`)
expect(dropped.interrupted, 'a message with content but no finish metadata must be flagged interrupted')

// Empty + no metadata is the not-yet-started case, not a cutoff.
expect(!readFinishMetadata(undefined, false).interrupted, 'empty message with no metadata must not be flagged')

console.log('\n' + '─'.repeat(60))
if (failures.length) {
  console.log(`FAIL (${failures.length})`)
  failures.forEach((f) => console.log(`  ✗ ${f}`))
  process.exit(1)
}
console.log('PASS — every early stop produces a visible interrupted state; clean stops do not.')
