'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { motion, AnimatePresence } from 'framer-motion'
import { Send, ChevronDown, MessageCircle, Clock, X } from 'lucide-react'
import { BottomSheet } from '@/components/mobile/BottomSheet'
import { TypingText } from '@/components/typing-text'
import type { UIMessage, TextUIPart } from 'ai'
import { listModels } from '@/lib/nim'

function getTextContent(message: UIMessage): string {
  return message.parts
    .filter((p): p is TextUIPart => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

// Lite-specific model list — reads the shared registry in src/lib/nim.ts
// (MODEL_LIST), filters to 'lite' scope, then narrows to just GPT-4o per
// the lite product direction (minimal phone-sized surface). Anyone adding
// another lite-scoped model must update this filter explicitly — the
// registry alone does NOT control what lite shows.
const LITE_MODELS = listModels('lite').filter((m) => m.id === 'gpt-4o')
const LITE_MODEL_LABEL = LITE_MODELS[0]?.label ?? 'GPT-4o'
const LITE_MODEL_DESC = LITE_MODELS[0]?.description ?? 'Versatile multimodal standard.'

export default function MobileChatPage() {
  const [model, setModel] = useState(LITE_MODELS[0]?.id ?? 'gpt-4o')
  const [input, setInput] = useState('')
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  const [historySheetOpen, setHistorySheetOpen] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const inputContainerRef = useRef<HTMLDivElement>(null)

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
    onError: (err) => console.error('[m/chat] error:', err),
  })

  const isStreaming = status === 'streaming' || status === 'submitted'

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-resize textarea and handle keyboard
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }, [input])

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || isStreaming) return
    sendMessage({ text }, { body: { model } })
    setInput('')
  }, [input, isStreaming, sendMessage, model])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const currentModel =
    LITE_MODELS.find((m) => m.id === model) ??
    LITE_MODELS[0] ??
    { id: model, label: LITE_MODEL_LABEL, description: LITE_MODEL_DESC }

  return (
    <div className="flex h-dvh flex-col bg-background">
      {/* Header */}
      <header
        className="flex-shrink-0 border-b border-border bg-surface-secondary px-4 py-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold uppercase tracking-wider text-foreground">
              Shard
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setModelSheetOpen(true)}
              className="flex items-center gap-1 rounded border border-border bg-surface-elevated px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
            >
              {currentModel?.label ?? 'Model'}
              <ChevronDown className="h-3 w-3" />
            </button>
            <button
              onClick={() => setHistorySheetOpen(true)}
              className="rounded border border-border p-1.5 text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
              style={{ minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              aria-label="Conversation history"
            >
              <Clock className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Messages — takes remaining space */}
      <div className="flex-1 overflow-y-auto px-4 py-4 scrollbar-hidden">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-center"
            >
              <MessageCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
              <p className="font-mono text-sm text-muted-foreground">Shard</p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                Type a message to start
              </p>
            </motion.div>
          </div>
        ) : (
          <div className="space-y-4">
            <AnimatePresence>
              {messages.map((msg, i) => {
                const text = getTextContent(msg)
                const isUser = msg.role === 'user'
                const isStreamingMsg = isStreaming && i === messages.length - 1 && !isUser

                return (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.02, 0.2) }}
                    className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
                        isUser
                          ? 'bg-primary/15 text-foreground border border-primary/20'
                          : 'bg-surface-secondary text-foreground border border-border'
                      }`}
                    >
                      <div className="whitespace-pre-wrap text-sm leading-relaxed">
                        {isStreamingMsg ? (
                          <TypingText text={text} isStreaming />
                        ) : (
                          text
                        )}
                      </div>
                    </div>
                  </motion.div>
                )
              })}
            </AnimatePresence>

            {error && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-2.5"
              >
                <p className="text-xs text-destructive">{error.message || 'Something went wrong'}</p>
              </motion.div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input bar — pinned to bottom, keyboard-aware */}
      <div
        ref={inputContainerRef}
        className="flex-shrink-0 border-t border-border bg-surface-secondary px-3 py-2"
      >
        <div className="flex items-end gap-2">
          {/* Text input */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Golem…"
            rows={1}
            disabled={isStreaming}
            className="flex-1 resize-none rounded-2xl border border-border bg-surface-elevated px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground/50 focus:border-primary/30 focus:outline-none disabled:opacity-40"
            style={{ maxHeight: 120 }}
          />

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="flex-shrink-0 rounded-full border border-primary bg-primary p-2.5 text-primary-foreground transition-colors hover:bg-primary/90 disabled:border-border disabled:bg-surface-elevated disabled:text-muted-foreground"
            style={{ minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            aria-label="Send"
          >
            <Send className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Model picker bottom sheet — only GPT-4o per lite's minimal-surface
          product direction. The filter intentionally hardcodes just one id
          instead of "all lite-scoped models" so adding more entries to
          MODEL_LIST under scope: 'lite' does NOT silently expand lite. */}
      <BottomSheet open={modelSheetOpen} onClose={() => setModelSheetOpen(false)} title="Model" height="40dvh">
        <div className="divide-y divide-border/40">
          {LITE_MODELS.map((m) => (
            <button
              key={m.id}
              onClick={() => { setModel(m.id); setModelSheetOpen(false) }}
              className={`flex w-full flex-col px-4 py-3 text-left transition-colors hover:bg-surface-elevated ${
                model === m.id ? 'text-primary' : 'text-foreground'
              }`}
              style={{ minHeight: 44 }}
            >
              <span className="font-mono text-xs font-semibold">{m.label}</span>
              <span className="font-sans text-[11px] text-muted-foreground">{m.description}</span>
            </button>
          ))}
          {LITE_MODELS.length === 0 && (
            <div className="px-4 py-6 text-center">
              <p className="font-mono text-xs text-muted-foreground">
                GPT-4o not currently available — check GITHUB_MODELS_TOKEN (or GITHUB_MODELS_API_KEY).
              </p>
            </div>
          )}
        </div>
      </BottomSheet>

      {/* Conversation history bottom sheet */}
      <BottomSheet open={historySheetOpen} onClose={() => setHistorySheetOpen(false)} title="History" height="60dvh">
        <div className="p-4">
          <p className="text-xs text-muted-foreground">
            Conversation history saves here — recent threads appear below. Open on desktop for full history.
          </p>
          {/* Simple thread list — shows last few chats from this session */}
          <div className="mt-4 space-y-1">
            {messages.filter((m) => m.role === 'user').slice(-10).reverse().map((msg) => (
              <div key={msg.id} className="rounded border border-border px-3 py-2 font-mono text-[11px] text-muted-foreground">
                {getTextContent(msg).slice(0, 80)}{getTextContent(msg).length > 80 ? '…' : ''}
              </div>
            ))}
            {messages.filter((m) => m.role === 'user').length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground/50">No messages yet</p>
            )}
          </div>
        </div>
      </BottomSheet>
    </div>
  )
}
