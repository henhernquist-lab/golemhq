'use client'

// A live conversation with one agent, driven by its real CLI.
//
// The design pressure here is proving the agent is DOING something rather than
// describing something. So tool calls render as their own inline events —
// visually distinct from the reply text — because "I read package.json" in
// prose is a claim, while a Read row emitted by the CLI's own event stream is
// a record. A CLI that cannot report tool calls says so once, up front, rather
// than showing an empty list that reads as "used no tools".

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Send, Terminal, Wrench, X } from 'lucide-react'

import type { ChatMessage, ToolCall } from '@/lib/missions/agent-chat'

interface ChatAgent {
  id: string
  name: string
  cliCommand: string | null
}

function ToolCallRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded border border-border/60 bg-surface-base px-2 py-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-1.5 text-left font-mono text-[10px] text-muted-foreground transition-colors hover:text-primary"
        disabled={!call.result}
      >
        <Wrench className="mt-0.5 h-2.5 w-2.5 shrink-0 text-primary" />
        <span className="text-primary">{call.name}</span>
        <span className="truncate">{call.summary}</span>
        {call.result && <span className="ml-auto shrink-0">{open ? '▾' : '▸'}</span>}
      </button>
      {open && call.result && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
          {call.result}
        </pre>
      )}
    </div>
  )
}

export function AgentChatPanel({ agent, onClose }: { agent: ChatAgent; onClose: () => void }) {
  const [chatId, setChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [toolCallsSupported, setToolCallsSupported] = useState(true)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  // Reuse the most recent conversation with this agent, so reopening the panel
  // continues where it left off instead of starting a blank thread each time.
  const open = useCallback(async () => {
    setError(null)
    try {
      const list = await fetch(`/api/missions/chats?agentId=${agent.id}`, { cache: 'no-store' })
      const listBody = await list.json()
      if (!list.ok) throw new Error(listBody.error ?? `HTTP ${list.status}`)

      let id: string | null = listBody.chats?.[0]?.id ?? null
      if (!id) {
        const created = await fetch('/api/missions/chats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: agent.id, title: `Chat with ${agent.name}` }),
        })
        const body = await created.json()
        if (!created.ok) throw new Error(body.error ?? `HTTP ${created.status}`)
        id = body.chat.id
      }
      setChatId(id)

      const thread = await fetch(`/api/missions/chats/${id}`, { cache: 'no-store' })
      const threadBody = await thread.json()
      if (thread.ok) {
        setMessages(threadBody.messages ?? [])
        setToolCallsSupported(threadBody.toolCallsSupported !== false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [agent.id, agent.name])

  useEffect(() => {
    open()
  }, [open])

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  async function send() {
    const content = input.trim()
    if (!content || !chatId || sending) return
    setInput('')
    setError(null)
    // Show the human's own message immediately. A turn takes tens of seconds,
    // and a message that vanishes into a spinner feels like it was dropped.
    setMessages((prev) => [
      ...prev,
      { id: `pending-${Date.now()}`, role: 'user', content, toolCalls: [], toolCallsSupported, error: null, ts: new Date().toISOString() },
    ])
    setSending(true)
    try {
      const res = await fetch(`/api/missions/chats/${chatId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setMessages((prev) => [...prev, body.agent])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mb-4 flex h-[32rem] flex-col rounded-lg border border-primary/30 bg-surface-secondary">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Terminal className="h-3.5 w-3.5 text-primary" />
          <span className="font-mono text-xs text-foreground">{agent.name}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{agent.cliCommand}</span>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-primary">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {!toolCallsSupported && (
        // Stated once, up front. Silence here would let an empty tool list read
        // as "this agent used no tools", which is a different claim entirely.
        <p className="border-b border-border px-3 py-1.5 font-mono text-[10px] text-warning">
          this CLI does not report tool calls — replies will show text only, even when it uses tools
        </p>
      )}

      <div ref={threadRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <p className="font-mono text-[10px] text-muted-foreground">
            no messages yet — ask it something about this repo
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'pl-8' : ''}>
            <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {m.role === 'user' ? 'henry' : agent.name}
            </p>

            {/* Tool calls come BEFORE the reply, which is the order they
                happened in — the agent worked, then answered. */}
            {m.toolCalls.length > 0 && (
              <div className="mb-1.5 space-y-1">
                {m.toolCalls.map((c, i) => (
                  <ToolCallRow key={`${m.id}-${i}`} call={c} />
                ))}
              </div>
            )}

            <div
              className={`rounded-lg border px-2.5 py-2 text-xs whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'border-primary/30 bg-primary/5 text-foreground'
                  : 'border-border bg-surface-base text-foreground'
              }`}
            >
              {m.content || <span className="text-muted-foreground">(no reply text)</span>}
            </div>
            {m.error && <p className="mt-1 font-mono text-[10px] text-red-400">{m.error}</p>}
          </div>
        ))}

        {sending && (
          <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {agent.name} is working — this runs the real CLI, so it can take a minute
          </p>
        )}
      </div>

      {error && <p className="px-3 pb-1 font-mono text-[10px] text-red-400">{error}</p>}

      <div className="flex gap-2 border-t border-border p-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={chatId ? 'ask it something…' : 'opening chat…'}
          disabled={!chatId || sending}
          className="flex-1 rounded border border-border bg-surface-base px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary/50 disabled:opacity-50"
        />
        <button
          onClick={() => send()}
          disabled={!chatId || sending || !input.trim()}
          className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
        >
          <Send className="h-3 w-3" />
          send
        </button>
      </div>
    </div>
  )
}
