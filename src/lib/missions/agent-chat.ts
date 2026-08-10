// Live, human-driven conversation with one agent.
//
// ─── Why this needs no new tables ─────────────────────────────────────
// A chat here is exactly what the mission spine already models: a human
// driving one specific agent through a sequence of turns, where every turn
// should be recoverable afterwards. So a chat IS a mission row, and each
// message is a mission_event. That is not a shortcut around a migration — it
// means chat history lands in the same append-only log as everything else, and
// the audit trail built for tasks reads chats for free.
//
// ─── Why it reuses runHeadless ────────────────────────────────────────
// The builder adapter already knows how to run an agent's registered CLI on
// whichever host has the checkout and the credentials. A second execution path
// would need its own auth, its own host selection and its own Sprite handling,
// and would drift from the one the missions actually use.
//
// ─── Tool calls are real, or absent ───────────────────────────────────
// `claude -p --output-format stream-json --verbose` emits one JSON object per
// line, including every tool_use with its input and every tool_result. Those
// are the actual calls the CLI made — not a summary the model wrote about
// itself, which is the thing that could be hallucinated. CLIs without that
// flag get their plain text and an explicit "this CLI does not report tool
// calls" rather than an empty list that reads as "it used no tools".

import { randomUUID } from 'node:crypto'

import { base64Arg, runHeadless } from '@/lib/terminal/headless-run'
import { createMission, getMission, listEvents, recordEvent, updateMissionStatus } from './store'
import type { Agent } from './types'

export const CHAT_REPO_PREFIX = 'chat/'
export const CHAT_MESSAGE_EVENT = 'chat.message'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export class AgentChatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentChatError'
  }
}

export interface ToolCall {
  name: string
  /** One-line summary of the arguments, for the thread. */
  summary: string
  /** Truncated result text, when the CLI reported one. */
  result: string | null
}

export interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  content: string
  toolCalls: ToolCall[]
  /** False when the CLI cannot report tool calls at all — see below. */
  toolCallsSupported: boolean
  error: string | null
  ts: string
}

// ─── CLI capabilities ──────────────────────────────────────────────────

/**
 * Which CLIs can stream structured events, keyed by executable.
 *
 * Deliberately an allowlist of CLIs whose flags have been checked by running
 * them, not a guess from their name. Adding `--output-format stream-json` to a
 * CLI that does not understand it makes the whole invocation fail, so an
 * optimistic default would break chat for every agent it guessed wrong about.
 */
const STRUCTURED: Record<string, { args: string; resume: (id: string) => string }> = {
  claude: {
    args: '--output-format stream-json --verbose',
    resume: (id) => `--resume ${id}`,
  },
}

function executableOf(cliCommand: string): string {
  return cliCommand.trim().split(/\s+/)[0] ?? ''
}

export function structuredSupport(agent: Agent): boolean {
  return !!STRUCTURED[executableOf(agent.cliCommand ?? '')]
}

// ─── Parsing the stream ────────────────────────────────────────────────

interface ParsedStream {
  text: string
  toolCalls: ToolCall[]
  sessionId: string | null
}

/** Arguments vary wildly per tool; show the one field a human cares about. */
function summariseInput(name: string, input: Record<string, unknown>): string {
  const first =
    input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.prompt
  if (typeof first === 'string') return first.length > 120 ? `${first.slice(0, 120)}…` : first
  const json = JSON.stringify(input ?? {})
  return json.length > 120 ? `${json.slice(0, 120)}…` : json
}

/**
 * Pull tool calls, the final answer and the CLI's session id out of the
 * newline-delimited JSON stream.
 *
 * Tolerant of non-JSON lines by design: the shell echoes the command, hooks
 * print warnings, and a strict parser would throw away a perfectly good
 * transcript because a SessionEnd hook complained about a missing module.
 */
export function parseStructuredStream(raw: string): ParsedStream {
  const calls = new Map<string, ToolCall>()
  const order: string[] = []
  let text = ''
  let sessionId: string | null = null

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (typeof event.session_id === 'string') sessionId = event.session_id

    if (event.type === 'assistant') {
      const message = event.message as { content?: unknown[] } | undefined
      for (const block of message?.content ?? []) {
        const b = block as { type?: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> }
        if (b.type === 'tool_use' && b.name && b.id) {
          calls.set(b.id, { name: b.name, summary: summariseInput(b.name, b.input ?? {}), result: null })
          order.push(b.id)
        }
      }
      continue
    }

    // Tool results arrive as a synthetic user turn referencing the call id.
    if (event.type === 'user') {
      const message = event.message as { content?: unknown[] } | undefined
      for (const block of message?.content ?? []) {
        const b = block as { type?: string; tool_use_id?: string; content?: unknown }
        if (b.type === 'tool_result' && b.tool_use_id) {
          const call = calls.get(b.tool_use_id)
          if (call) {
            const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
            call.result = body.length > 400 ? `${body.slice(0, 400)}…` : body
          }
        }
      }
      continue
    }

    // The `result` event carries the final answer verbatim, which is more
    // reliable than stitching together streamed text blocks.
    if (event.type === 'result' && typeof event.result === 'string') text = event.result
  }

  return { text, toolCalls: order.map((id) => calls.get(id)!).filter(Boolean), sessionId }
}

// ─── Chats ─────────────────────────────────────────────────────────────

export interface ChatSummary {
  id: string
  agentId: string
  title: string
  createdAt: string
  updatedAt: string
}

function chatRepo(agentId: string): string {
  // Unique per chat: createMission refuses a second active mission for a repo,
  // and a human should be able to keep several conversations with one agent.
  return `${CHAT_REPO_PREFIX}${agentId}/${Date.now()}`
}

export async function createChat(agent: Agent, title: string): Promise<ChatSummary> {
  const mission = await createMission(chatRepo(agent.id), title || `Chat with ${agent.name}`)
  // 'running' so the row reads as live rather than perpetually 'planning'.
  await updateMissionStatus(mission.id, 'running')
  await recordEvent(mission.id, 'chat.opened', { agentId: agent.id, agentName: agent.name })
  return {
    id: mission.id,
    agentId: agent.id,
    title: mission.goal,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  }
}

export async function chatHistory(chatId: string): Promise<ChatMessage[]> {
  const events = await listEvents(chatId, 500)
  return events
    .filter((e) => e.type === CHAT_MESSAGE_EVENT)
    .map((e) => ({
      id: e.id,
      role: e.payload.role === 'user' ? 'user' : 'agent',
      content: typeof e.payload.content === 'string' ? e.payload.content : '',
      toolCalls: Array.isArray(e.payload.toolCalls) ? (e.payload.toolCalls as ToolCall[]) : [],
      toolCallsSupported: e.payload.toolCallsSupported !== false,
      error: typeof e.payload.error === 'string' ? e.payload.error : null,
      ts: e.ts,
    }))
  // listEvents is already oldest-first, which is how a conversation reads.
}

/**
 * The CLI session id from the MOST RECENT agent turn, for `--resume`.
 *
 * Walked backwards because listEvents returns oldest-first: taking the first
 * match would resume the conversation from its opening turn every time,
 * quietly discarding everything said since.
 */
async function lastCliSession(chatId: string): Promise<string | null> {
  const events = await listEvents(chatId, 500)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === CHAT_MESSAGE_EVENT && typeof e.payload.cliSessionId === 'string') {
      return e.payload.cliSessionId
    }
  }
  return null
}

export interface SendMessageResult {
  user: ChatMessage
  agent: ChatMessage
}

/**
 * Send one turn and record both sides.
 *
 * The user's message is recorded BEFORE the CLI runs. A five-minute agent turn
 * that dies partway through would otherwise lose the thing the human typed,
 * which is the one part of the exchange they cannot reproduce.
 */
export async function sendChatMessage(
  chatId: string,
  agent: Agent,
  content: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<SendMessageResult> {
  const mission = await getMission(chatId)
  if (!mission) throw new AgentChatError(`chat ${chatId} not found`)
  if (!agent.cliCommand) throw new AgentChatError(`${agent.name} has no cli_command to talk to`)

  // recordEvent returns void, so ids are minted here. They only have to be
  // stable within one response — the thread re-reads from the log on reload.
  const userMessageId = randomUUID()
  await recordEvent(chatId, CHAT_MESSAGE_EVENT, { role: 'user', content })

  const structured = STRUCTURED[executableOf(agent.cliCommand)]
  const previous = structured ? await lastCliSession(chatId) : null

  // cli_command ends immediately before the prompt (see the Batch 4 migration),
  // so extra flags go between it and the prompt.
  const flags = [structured?.args, previous && structured ? structured.resume(previous) : null]
    .filter(Boolean)
    .join(' ')
  const command = `${agent.cliCommand} ${flags} ${base64Arg(content)}`.replace(/\s+/g, ' ')

  const run = await runHeadless(command, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    runId: `chat-${randomUUID().slice(0, 8)}`,
    cwd: options.cwd,
  })

  let text: string
  let toolCalls: ToolCall[] = []
  let cliSessionId: string | null = null

  if (structured) {
    const parsed = parseStructuredStream(run.output)
    text = parsed.text
    toolCalls = parsed.toolCalls
    cliSessionId = parsed.sessionId
    // A structured run that produced no `result` event still said something —
    // falling back to the raw stream beats showing the human a blank reply.
    if (!text) text = run.output.trim().slice(-2000)
  } else {
    text = run.output.trim()
  }

  const error = run.failure
    ? run.failure
    : run.timedOut
      ? `${agent.name} timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : run.exitCode !== 0
        ? `${agent.cliCommand} exited ${run.exitCode ?? 'without an end marker'}`
        : null

  const agentMessageId = randomUUID()
  await recordEvent(chatId, CHAT_MESSAGE_EVENT, {
    role: 'agent',
    content: text,
    toolCalls,
    toolCallsSupported: !!structured,
    agentName: agent.name,
    cliSessionId,
    error,
  })

  const toMessage = (id: string, role: 'user' | 'agent', body: string, calls: ToolCall[]): ChatMessage => ({
    id,
    role,
    content: body,
    toolCalls: calls,
    toolCallsSupported: !!structured,
    error: role === 'agent' ? error : null,
    ts: new Date().toISOString(),
  })

  return {
    user: toMessage(userMessageId, 'user', content, []),
    agent: toMessage(agentMessageId, 'agent', text, toolCalls),
  }
}
