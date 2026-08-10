// Prove a chat turn is a real agent doing real work, not a chat about work.
//
// The failure this is written against: a model answering "package.json has 48
// dependencies" from memory, with the UI showing a confident reply and no way
// to tell it never opened the file. So the assertions are deliberately paired —
// the answer must be RIGHT, and it must be accompanied by a tool call that
// actually read the file. Either alone proves nothing:
//
//   right answer, no tool call  -> could be recall, or luck
//   tool call, wrong answer     -> it looked and still got it wrong
//
// The expected number is computed here by parsing package.json directly, so the
// test cannot drift into agreeing with whatever the agent happens to say.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-agent-chat.mjs
//
// Env:
//   BUILDER=<agent name>   pin the agent (default: highest-reliability builder)
//   KEEP=1                 keep the chat for inspection in the UI

import { readFileSync } from 'node:fs'

import './load-env.mjs'

const { createChat, sendChatMessage, chatHistory, structuredSupport } =
  await import('../src/lib/missions/agent-chat.ts')
const { listAgents } = await import('../src/lib/missions/store.ts')
const { supabase } = await import('../src/lib/supabase.ts')

const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const EXPECTED = Object.keys(pkg.dependencies ?? {}).length
const EXPECTED_DEV = Object.keys(pkg.devDependencies ?? {}).length

let chatId = null

try {
  const builders = await listAgents(2, true)
  const wanted = process.env.BUILDER
  const agent = wanted
    ? builders.find((a) => a.name === wanted)
    : builders.filter(structuredSupport).sort((a, b) => (b.reliabilityPct ?? 0) - (a.reliabilityPct ?? 0))[0]
  if (!agent) throw new Error(wanted ? `no enabled builder named "${wanted}"` : 'no enabled builder reports tool calls')

  ok(`agent: ${agent.name} (${agent.cliCommand})`)
  info(`structured tool calls supported: ${structuredSupport(agent)}`)
  info(`package.json really has ${EXPECTED} dependencies and ${EXPECTED_DEV} devDependencies`)

  const chat = await createChat(agent, 'Verification: grounded answer')
  chatId = chat.id
  ok(`chat ${chatId.slice(0, 8)} opened`)

  console.log('\nTURN 1 — a question only a file read can answer')
  const started = Date.now()
  const turn = await sendChatMessage(
    chatId,
    agent,
    'Read package.json in this repo and tell me exactly how many entries are in "dependencies". ' +
      'Answer with the number.',
    { cwd: process.cwd(), timeoutMs: 240_000 },
  )
  info(`took ${((Date.now() - started) / 1000).toFixed(1)}s`)
  if (turn.agent.error) info(`error: ${turn.agent.error}`)

  console.log('\n  tool calls the CLI actually made:')
  for (const c of turn.agent.toolCalls) {
    console.log(`    → ${c.name}(${c.summary})`)
  }
  console.log(`\n  reply: ${turn.agent.content.slice(0, 300)}`)

  // ── Assertion 1: it really used a tool ───────────────────────────
  if (!turn.agent.toolCallsSupported) throw new Error('this agent cannot report tool calls — pick one that can')
  if (turn.agent.toolCalls.length === 0) {
    throw new Error('the agent answered with NO tool calls — the answer is unGrounded, whatever it says')
  }
  const readCall = turn.agent.toolCalls.find((c) => /package\.json/.test(c.summary))
  if (!readCall) {
    throw new Error(`no tool call touched package.json: ${turn.agent.toolCalls.map((c) => c.name).join(', ')}`)
  }
  ok(`grounded: ${readCall.name} really opened ${readCall.summary}`)
  if (readCall.result) info(`the tool returned ${readCall.result.length} chars of file content`)

  // ── Assertion 2: and it got the right answer ─────────────────────
  if (!new RegExp(`\\b${EXPECTED}\\b`).test(turn.agent.content)) {
    throw new Error(`the reply does not contain the real count ${EXPECTED}: "${turn.agent.content.slice(0, 200)}"`)
  }
  ok(`the reply states the correct count (${EXPECTED}), and it read the file to get it`)

  // ── Assertion 3: the thread persisted ────────────────────────────
  console.log('\nPERSISTENCE')
  const history = await chatHistory(chatId)
  if (history.length < 2) throw new Error(`expected at least 2 messages in history, found ${history.length}`)
  if (history[0].role !== 'user') throw new Error(`history is not oldest-first: first message is "${history[0].role}"`)
  const storedAgent = history.find((m) => m.role === 'agent')
  if (!storedAgent?.toolCalls.length) throw new Error('tool calls did not survive the round trip to the database')
  ok(`${history.length} messages reload from the event log, tool calls included`)

  console.log('\n✓ a real agent, a real tool call, and an answer grounded in it\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
} finally {
  if (chatId && process.env.KEEP !== '1') {
    await supabase.from('missions').delete().eq('id', chatId)
  } else if (chatId) {
    console.log(`    chat kept: ${chatId}`)
  }
  process.exit(process.exitCode ?? 0)
}
