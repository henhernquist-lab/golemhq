'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import type { UIMessage, TextUIPart, SourceUrlUIPart } from 'ai'
import {
  Send,
  Paperclip,
  Command,
  ChevronDown,
  Copy,
  Check,
  RotateCcw,
  ExternalLink,
  AlertTriangle,
  Search,
  Link,
  Code,
  Zap,
  Clock,
  Cpu,
  Database,
  Brain,
  Globe,
  Folder,
  Eraser,
} from 'lucide-react'
import { GolemLogo } from './golem-logo'
import { StatusIndicator } from './status-indicator'
import { TypingText } from './typing-text'
import { MarkdownMessage } from './markdown-message'
import { FileAttachmentChip, type PendingUpload } from './file-attachment-chip'
import { FileAttachmentCard } from './file-attachment-card'
import { detectFileType, MAX_FILE_SIZE, SUPPORTED_EXTENSIONS } from '@/lib/uploads'
import { buildMessageText, parseMessageText, type AttachmentMeta } from '@/lib/attachment-marker'
import { parseJsonResponse } from '@/lib/fetch-json'

import { setAgentBusy } from '@/lib/agent-presence'
import { GolemInline } from './golem/golem-inline'
import { onGolemQuickAction, pulseGolem, setGolemModel, setGolemSeekTarget } from '@/lib/golem-signals'
import { getDailySuggestionCards, type SuggestionCard } from '@/lib/suggestion-cards'
import { RecoveryBanner } from './recovery-banner'
import { InterruptedNotice } from './interrupted-notice'
import { RecoveryState } from '@/lib/recovery/types'
import { readFinishMetadata } from '@/lib/recovery/finish-metadata'
import { SkillBanner } from './skill-banner'
import { CompactionIndicator } from './compaction-indicator'
import { ThinkingTrace } from './thinking-trace'
import { ChatToolSteps } from './chat-tool-steps'
import { SkillFeedbackBar } from './skill-feedback-bar'
import { parseReasoningTrace, parseStreamingReasoning, modelSupportsReasoning } from '@/lib/reasoning-trace'
import { detectSkillInvocation, SKILLS, filterSkillsByDomain } from '@/lib/skills/registry'
import { detectRelevantSkills } from '@/lib/skills/auto-trigger'
import { listModels, DEFAULT_MODEL_ID } from '@/lib/nim'
import type { SkillDefinition } from '@/lib/skills/types'
import { useMessageQueue } from '@/lib/message-queue'
import { QueuedMessageBanner } from '@/components/queued-message-banner'
import type { ActivityEvent } from '@/lib/chat-history'
import {
  parseSessionFocusId,
  serializeSessionFocus,
  sessionFocusLabel,
  SESSION_FOCUS_META,
  type SessionFocus,
} from '@/lib/focus-mode'

type ChatQueueItem = {
  text: string
  files?: { type: 'file'; mediaType: string; filename: string; url: string }[]
  body: Record<string, unknown>
}

interface CenterPanelProps {
  /** Unique id for localStorage namespacing (e.g. 'left' | 'right' for split view). */
  paneId?: string
  agentStatus: 'online' | 'thinking' | 'streaming' | 'idle'
  setAgentStatus: (status: 'online' | 'thinking' | 'streaming' | 'idle') => void
  initialMessages?: UIMessage[]
  conversationCount: number
  lastResponseMs: number | null
  onSaveMessages: (messages: UIMessage[], model: string) => void
  onActivity: (event: Omit<ActivityEvent, 'id'>) => void
  onStreamUpdate: (text: string) => void
  onModelChange: (model: string) => void
}

const SESSION_START = Date.now()

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

function getTextContent(message: UIMessage): string {
  return message.parts
    .filter((p): p is TextUIPart => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/**
 * How many times the client auto-retries a continuation before giving up
 * and showing the user a Retry button instead of a spinner.
 */
const MAX_AUTO_RECOVERIES = 2

function getSources(message: UIMessage): SourceUrlUIPart[] {
  return message.parts.filter((p): p is SourceUrlUIPart => p.type === 'source-url')
}

function getDisplayInfo(message: UIMessage): { attachment: AttachmentMeta | null; displayText: string } {
  return parseMessageText(getTextContent(message))
}

// Model registry is the single source of truth — see src/lib/nim.ts.
// Homepage picker draws from the 'chat' scope: Gemini 3.5 Flash, GPT-4o, and
// all NIM-hosted models. Kimi K2.7 Code is intentionally NOT listed here
// because its scope is 'drive' only (coding-agent model).
const VISION_MODELS = new Set<string>(listModels('chat').filter((m) => m.supportsVision).map((m) => m.id))

const MODELS = listModels('chat').map((m) => ({
  id: m.id,
  label: m.label,
  company: m.company,
  desc: m.description,
  community: false,
  degraded: m.degraded,
}))

// Community ids are dynamic (community:<hfId>:<provider>), so the model id is
// a plain string, not a fixed union.
type ModelId = string
type PickerModel = { id: string; label: string; company: string; desc: string; community: boolean; degraded?: string }

// ─── Chatbot effort (3 levels, separate from coding agent's 5) ───

const CHAT_EFFORTS = [
  { id: 'low' as const,    label: 'Low',    desc: 'Short, direct answers only' },
  { id: 'medium' as const,  label: 'Medium', desc: 'Length matches the question (default)' },
  { id: 'high' as const,    label: 'High',   desc: 'Allows full depth on complex asks' },
]

type ChatEffortId = typeof CHAT_EFFORTS[number]['id']

// Default chat effort per model. New/unproven models default to Medium
// until we have real testing data on them; flip the flag in MODEL_LIST to
// override. Same source-of-truth principle as MODELS above.
const CHAT_MODEL_DEFAULTS: Record<string, ChatEffortId> = Object.fromEntries(
  listModels('chat')
    .filter((m): m is typeof m & { defaultEffort: ChatEffortId } => Boolean(m.defaultEffort))
    .map((m) => [m.id, m.defaultEffort]),
) as Record<string, ChatEffortId>

const QUICK_ACTIONS = [
  { label: 'Search the web', glyph: '/', prompt: 'Search the web for ' },
  { label: 'Summarize a URL', glyph: '↗', prompt: 'Summarize the content at this URL: ' },
  { label: 'Write code', glyph: '<>', prompt: 'Write code to ' },
  { label: 'Check my email', glyph: '@', prompt: 'Check my email for new messages' },
]

// SuggestionCard + the 28-card pool now live in @/lib/suggestion-cards so the
// mascot's click-to-fire draws from the same deck this rotation does.



export function CenterPanel({
  paneId,
  agentStatus,
  setAgentStatus,
  initialMessages,
  conversationCount,
  lastResponseMs,
  onSaveMessages,
  onActivity,
  onStreamUpdate,
  onModelChange,
}: CenterPanelProps) {
  const [model, setModel] = useState<ModelId>(DEFAULT_MODEL_ID)
  const [chatEffort, setChatEffort] = useState<ChatEffortId>(() => CHAT_MODEL_DEFAULTS[DEFAULT_MODEL_ID] ?? 'medium')

  // Community models added from The Foundry. Fetched at mount and merged
  // into the picker below the first-party models, visibly badged.
  const [communityModels, setCommunityModels] = useState<PickerModel[]>([])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/models/community')
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        // Defensive: this list is an optional enhancement to the picker. Any
        // shape surprise (missing field, non-array, malformed row) must drop
        // the bad rows, never throw — first-party models stay selectable.
        const rows: unknown[] = Array.isArray(data?.models) ? data.models : []
        setCommunityModels(
          rows
            .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object')
            .filter((m) => typeof m.modelId === 'string' && m.modelId.length > 0)
            .map((m) => ({
              id: m.modelId as string,
              label: typeof m.label === 'string' && m.label ? m.label : (m.modelId as string),
              company: typeof m.company === 'string' ? m.company : 'Community',
              desc: typeof m.description === 'string' ? m.description : 'Experimental community model.',
              community: true,
            })),
        )
      } catch {
        /* non-fatal — picker just shows first-party models */
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Daily token budget per Groq model. Groq publishes no tokens-per-day
  // header, so a model can look healthy right up to the moment it goes dark
  // for hours. Fetched once at mount and shown as a badge — same defensive
  // shape handling as the community list: a surprise here must never take the
  // picker down with it.
  const [tpdByModel, setTpdByModel] = useState<Record<string, { state: string; remaining: number }>>({})
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/models/tpd')
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        const rows: unknown[] = Array.isArray(data?.tpd) ? data.tpd : []
        const next: Record<string, { state: string; remaining: number }> = {}
        for (const r of rows) {
          if (!r || typeof r !== 'object') continue
          const row = r as Record<string, unknown>
          if (typeof row.modelId !== 'string' || typeof row.state !== 'string') continue
          next[row.modelId] = { state: row.state, remaining: Number(row.remaining) || 0 }
        }
        setTpdByModel(next)
      } catch {
        /* non-fatal — picker just omits the daily-budget badge */
      }
    })()
    return () => { cancelled = true }
  }, [])

  const pickerModels: PickerModel[] = [...MODELS, ...communityModels]
  const findModel = (id: string) => pickerModels.find((m) => m.id === id)
  const [effortMenuOpen, setEffortMenuOpen] = useState(false)

  // Focus mode (source scope) — controls which DRAWERS the agent reads from
  type FocusMode = 'all' | 'memory_only' | 'web_only' | 'repo_only'
  const [focusMode, setFocusMode] = useState<FocusMode>('all')
  const [focusMenuOpen, setFocusMenuOpen] = useState(false)
  const focusDropdownRef = useRef<HTMLDivElement>(null)

  // Session focus (domain scope) — what work I'm doing right now. Hybrid:
  // built-in seeds (Drive / Learn / School) + user-named custom focuses that
  // persist to localStorage and surface as additional chips. Orthogonal to
  // `focusMode` above — same session can be "The Forge" (domain) + "repo_only"
  // (source). Mid-session swap is live: change the pill, the next chat POST
  // carries the new value; prior messages keep their old context.
  const ns = paneId ? `.${paneId}` : ''
  const SESSION_FOCUS_STORAGE_KEY = `enry.sessionFocus.v1${ns}`
  const CUSTOM_FOCUSES_STORAGE_KEY = `enry.customFocuses.v1${ns}`
  const [sessionFocus, setSessionFocus] = useState<SessionFocus>({ kind: 'none' })
  const [sessionFocusMenuOpen, setSessionFocusMenuOpen] = useState(false)
  const sessionFocusDropdownRef = useRef<HTMLDivElement>(null)
  const [customFocuses, setCustomFocuses] = useState<string[]>([])
  const [customFocusInput, setCustomFocusInput] = useState('')

  // Load persisted focus + custom list on mount. localStorage is the only
  // place this lives for now — no server round-trip on swap (live mid-session
  // would lag the user with a full POST on every chip click).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_FOCUS_STORAGE_KEY)
      if (raw) setSessionFocus(parseSessionFocusId(raw))
      const customsRaw = localStorage.getItem(CUSTOM_FOCUSES_STORAGE_KEY)
      if (customsRaw) {
        const list = JSON.parse(customsRaw)
        if (Array.isArray(list)) {
          setCustomFocuses(list.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 32))
        }
      }
    } catch { /* localStorage unavailable; fall back to defaults */ }
  }, [])

  const selectSessionFocus = (next: SessionFocus) => {
    setSessionFocus(next)
    try { localStorage.setItem(SESSION_FOCUS_STORAGE_KEY, serializeSessionFocus(next)) } catch { /* noop */ }
    setSessionFocusMenuOpen(false)
  }

  const addCustomFocus = () => {
    const id = customFocusInput.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32)
    if (!id) return
    if (customFocuses.includes(id)) {
      // Already exists — just select it.
      selectSessionFocus({ kind: 'custom', id })
      setCustomFocusInput('')
      return
    }
    const updated = [...customFocuses, id]
    setCustomFocuses(updated)
    try { localStorage.setItem(CUSTOM_FOCUSES_STORAGE_KEY, JSON.stringify(updated)) } catch { /* noop */ }
    selectSessionFocus({ kind: 'custom', id })
    setCustomFocusInput('')
  }

  const FOCUS_MODES = [
    { id: 'all' as const, label: 'All', icon: Zap, desc: 'No restrictions — web, memory, repo' },
    { id: 'memory_only' as const, label: 'Memory', icon: Brain, desc: 'Only stored memories/notes' },
    { id: 'web_only' as const, label: 'Web', icon: Globe, desc: 'Web search only' },
    { id: 'repo_only' as const, label: 'Repo', icon: Folder, desc: 'Only repo files' },
  ]
  const currentFocus = FOCUS_MODES.find((f) => f.id === focusMode)!

  // Reasoning trace visibility — on/off only. Was a 3-state off/summary/full
  // dropdown, but summary vs full sent an identical upstream request
  // (enable_thinking:true either way) — "summary" was purely a client-side
  // 300-char truncation of the same trace, not a real depth control. Collapsed
  // to the two states that actually differ. Only meaningful for models with
  // supportsReasoning: true (see modelSupportsReasoning below) — the button is
  // hidden entirely for the rest so it can't be toggled into a dead param.
  // ─── Per-instance transport + response-header bridge ───────────
  // Was module-scoped — two panes sharing the same transport and
  // header-intercepting variables would clobber each other mid-stream.
  // Now scoped to the component instance via useMemo + useRef.
  const pendingCompactionRef = useRef<{ compacted: boolean; summary: string | null } | null>(null)
  const pendingSkillIdRef = useRef<string | null>(null)

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        fetch: async (url, options) => {
          const response = await fetch(url, options)
          const compacted = response.headers.get('X-Context-Compacted')
          if (compacted === 'true') {
            const summary = response.headers.get('X-Context-Compacted-Summary')
            pendingCompactionRef.current = { compacted: true, summary: summary ? decodeURIComponent(summary) : null }
          }
          const skillInvocationId = response.headers.get('X-Skill-Invocation-Id')
          if (skillInvocationId) {
            pendingSkillIdRef.current = skillInvocationId
          }
          return response
        },
      }),
    [],
  )

  const [reasoningDepth, setReasoningDepth] = useState<'off' | 'full'>('off')
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false)
  const reasoningDropdownRef = useRef<HTMLDivElement>(null)
  const reasoningSupported = modelSupportsReasoning(model)

  // Context compaction state — set from X-Context-Compacted response header
  // Populated by the custom fetch in the transport, synced after useChat below
  const [contextCompacted, setContextCompacted] = useState(false)
  const [compactionSummary, setCompactionSummary] = useState<string | null>(null)

  const REASONING_DEPTHS = [
    { id: 'off' as const, label: 'Think: Off', desc: 'Show only the final answer' },
    { id: 'full' as const, label: 'Think: On', desc: 'Show the reasoning trace' },
  ]
  const currentReasoning = REASONING_DEPTHS.find((r) => r.id === reasoningDepth)!

  // onError only receives the Error, not the message list — a plain closure
  // over `messages` in the useChat config below would be stale (the SDK
  // invokes these callbacks against its own internal state, not a fresh React
  // render), so this ref is kept current via the effect after the hook and is
  // what onError actually reads.
  // ─── Recovery state ────────────────────────────────────────────
  // Tracks the recovery lifecycle: Interrupted → Recovering → Recovered | Failed
  const [recoveryState, setRecoveryState] = useState<RecoveryState | null>(null)
  const recoveryStateRef = useRef<RecoveryState | null>(null)
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Bounds the auto-recovery loop in onError — see the comment there.
  const recoveryAttemptsRef = useRef(0)

  // Keep ref in sync — useChat callbacks see stale closures
  useEffect(() => { recoveryStateRef.current = recoveryState }, [recoveryState])

  // ─── Scratch mode (ephemeral chat) ─────────────────────────────
  // When on, messages live only in React state — never persisted to
  // Supabase. Refreshing the page or toggling off clears everything.
  const [scratchMode, setScratchMode] = useState(false)
  const scratchModeRef = useRef(false)
  useEffect(() => { scratchModeRef.current = scratchMode }, [scratchMode])

  // Auto-hide "Recovered" banner after 3s
  useEffect(() => {
    if (recoveryState === RecoveryState.Recovered) {
      recoveryTimerRef.current = setTimeout(() => setRecoveryState(null), 3000)
      return () => { if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current) }
    }
  }, [recoveryState])

  const messagesRef = useRef<UIMessage[]>(initialMessages ?? [])
  const { messages, sendMessage, status, error } = useChat({
    transport,
    messages: initialMessages,
    onFinish: ({ messages: finalMessages }) => {
      if (!scratchModeRef.current) onSaveMessages(finalMessages, model)
      onActivity({ type: 'assistant-complete', content: '', at: Date.now() })
      // Clear recovery state on successful completion
      if (recoveryStateRef.current === RecoveryState.Recovering) {
        setRecoveryState(RecoveryState.Recovered)
      }
      // A clean finish means the failure streak is over.
      recoveryAttemptsRef.current = 0
    },
    onError: (err) => {
      console.error('[chat] streamText error:', err)
      if (messagesRef.current.length > 0 && !scratchModeRef.current) onSaveMessages(messagesRef.current, model)
      /* eslint-disable-next-line react-hooks/purity */
      onActivity({ type: 'error', content: (err as Error).message, at: Date.now() })

      // ── Auto-recovery ──────────────────────────────────────────
      // If the last message is an incomplete assistant response,
      // attempt to recover by sending a continuation request.
      //
      // Bounded: previously this re-sent on every onError, so an error
      // that reproduces on the continuation request (a persistently
      // failing provider) recovered → errored → recovered forever, and
      // the user saw a permanent "Recovering…" spinner instead of being
      // told the response was cut off. After MAX_AUTO_RECOVERIES the
      // state goes to Failed, which renders a Retry button.
      const lastMsg = messagesRef.current[messagesRef.current.length - 1]
      if (lastMsg?.role === 'assistant') {
        const partialContent = getTextContent(lastMsg)
        if (partialContent && partialContent.length > 0) {
          if (recoveryAttemptsRef.current >= MAX_AUTO_RECOVERIES) {
            setRecoveryState(RecoveryState.Failed)
            return
          }
          recoveryAttemptsRef.current += 1
          setRecoveryState(RecoveryState.Recovering)
          // Re-send with recovery flag + partial content for continuation
          sendMessage({ text: '' }, {
            body: {
              model,
              effort: chatEffort,
              focusMode,
              sessionFocus: serializeSessionFocus(sessionFocus),
              reasoningDepth,
              recovery: true,
              partialContent,
            },
          })
        } else {
          // Nothing partial to continue from — the turn produced no text
          // at all. Surface it rather than silently doing nothing.
          setRecoveryState(RecoveryState.Failed)
        }
      }
    },
  })
  useEffect(() => { messagesRef.current = messages }, [messages])

  const [skillInvocationIds, setSkillInvocationIds] = useState<Record<number, string>>({})

  // Sync compaction state after each response (written by transport's custom fetch)
  useEffect(() => {
    if (status === 'ready' && pendingCompactionRef.current) {
      const pending = pendingCompactionRef.current
      pendingCompactionRef.current = null
      setTimeout(() => {
        setContextCompacted(pending.compacted)
        setCompactionSummary(pending.summary)
      }, 0)
    }
    // Sync skill invocation ID for the latest assistant message
    /* eslint-disable react-hooks/purity */
    if (status === 'ready' && pendingSkillIdRef.current) {
      const invocationId = pendingSkillIdRef.current
      pendingSkillIdRef.current = null
      setSkillInvocationIds((prev) => ({
        ...prev,
        [messages.length - 1]: invocationId, // Last message is the assistant response
      }))
    }
    /* eslint-enable react-hooks/purity */
  }, [status, messages.length])

  const [input, setInput] = useState('')
  // ─── Skill mode ───────────────────────────────────────────────
  // activeSkill is the current conversation mode (null = normal chat).
  // skillStartIndex marks where in the message list the skill began, so
  // assistant-turn counting (which drives the phase indicator and the
  // automatic exit) ignores any pre-skill history.
  const [activeSkill, setActiveSkill] = useState<SkillDefinition | null>(null)
  const [skillStartIndex, setSkillStartIndex] = useState(0)
  const [modelOpen, setModelOpen] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [uptimeMs, setUptimeMs] = useState(0)
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null)
  const [uploadResult, setUploadResult] = useState<AttachmentMeta | null>(null)
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const modelDropdownRef = useRef<HTMLDivElement>(null)
  const effortDropdownRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Message queue — lets the user queue a message while a response is still
  // streaming, instead of blocking the input.
  const { queue, enqueue, dequeue, remove } = useMessageQueue<ChatQueueItem>()

  // briefingEnabled initialized lazily; no mount-time setState required.

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (status === 'submitted') setAgentStatus('thinking')
    else if (status === 'streaming') setAgentStatus('streaming')
    else setAgentStatus('online')
  }, [status, setAgentStatus])

  // Report chat activity to the global presence indicator. busyRef guards
  // against double-counting setAgentBusy's increment/decrement across the
  // 'submitted' -> 'streaming' transition, which is busy=true both times.
  const busyRef = useRef(false)
  useEffect(() => {
    const nowBusy = status === 'submitted' || status === 'streaming'
    if (nowBusy !== busyRef.current) {
      setAgentBusy(nowBusy)
      busyRef.current = nowBusy
    }
  }, [status])

  // True unmount-only cleanup — releases the busy count if the component
  // goes away mid-stream (e.g. navigating away).
  useEffect(() => () => {
    if (busyRef.current) setAgentBusy(false)
    setGolemSeekTarget(null)
  }, [])

  // Tell the mascot which model is active so it can tint itself.
  useEffect(() => { setGolemModel(model) }, [model])

  // A failed request makes Golem flinch.
  useEffect(() => { if (error) pulseGolem('error') }, [error])

  useEffect(() => {
    if (status !== 'streaming') return
    const last = messages[messages.length - 1]
    if (last?.role === 'assistant') {
      onStreamUpdate(getTextContent(last))
    }
  }, [messages, status, onStreamUpdate])

  useEffect(() => {
    const tick = () => setUptimeMs(Date.now() - SESSION_START)
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!modelOpen) return
    const handler = (e: MouseEvent) => {
      if (!modelDropdownRef.current?.contains(e.target as Node)) setModelOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [modelOpen])

  useEffect(() => {
    if (!effortMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (!effortDropdownRef.current?.contains(e.target as Node)) setEffortMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [effortMenuOpen])

  useEffect(() => {
    if (!sessionFocusMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (!sessionFocusDropdownRef.current?.contains(e.target as Node)) setSessionFocusMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [sessionFocusMenuOpen])

  useEffect(() => {
    if (!reasoningMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (!reasoningDropdownRef.current?.contains(e.target as Node)) setReasoningMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [reasoningMenuOpen])

  // Assistant turns produced since the active skill began — source of truth for
  // the phase indicator and the automatic exit.
  const skillTurnsCompleted = activeSkill
    ? messages.slice(skillStartIndex).filter((m) => m.role === 'assistant').length
    : 0

  const exitSkill = useCallback(() => {
    setActiveSkill(null)
    setSkillStartIndex(0)
  }, [])

  // Automatic exit: once the skill has produced all its assistant turns (e.g.
  // Devil's Advocate's verdict) and the stream has settled, drop back to normal
  // chat. The final turn's message stays in the transcript; only the mode clears.
  useEffect(() => {
    if (!activeSkill) return
    const done = skillTurnsCompleted >= activeSkill.structure.assistantTurns
    if (done && status !== 'streaming' && status !== 'submitted') {
      setTimeout(() => exitSkill(), 0)
    }
  }, [activeSkill, skillTurnsCompleted, status, exitSkill])

  // Send a message while a skill is active — injects the skill slug and the
  // turn number about to be generated so the server drives the right phase.
  const sendSkillTurn = (skill: SkillDefinition, text: string, startIndex: number) => {
    const turnsSoFar = messages.slice(startIndex).filter((m) => m.role === 'assistant').length
    onActivity({ type: 'user-sent', content: text, at: Date.now() })
    onActivity({ type: 'assistant-start', content: '', at: Date.now(), model })
    sendMessage({ text }, { body: { model, effort: chatEffort, skill: skill.slug, skillTurn: turnsSoFar + 1, focusMode, sessionFocus: serializeSessionFocus(sessionFocus), reasoningDepth } })
  }

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    const text = input.trim()
    if (pendingUpload?.status === 'uploading') return

    // ── Skill mode is active ──────────────────────────────────────
    if (activeSkill) {
      if (!text) return
      // Explicit early exit.
      if (/^\/(exit|end)$/i.test(text)) {
        exitSkill()
        setInput('')
        return
      }
      sendSkillTurn(activeSkill, text, skillStartIndex)
      setInput('')
      return
    }

    if (!text && !uploadResult) return      // ── Relevance-based skill detection ──
      // Scan the message against ALL skills' trigger phrases (same matching
      // logic as /skill). Multiple matching skills fire simultaneously via
      // the multi-skill path in the chat route.
      if (text && !uploadResult && !activeSkill) {
        const relevant = detectRelevantSkills(text)
        if (relevant.length > 0) {
          const startIndex = messages.length
          const slugs = relevant.map((r) => r.skill.slug)
          // For the SkillBanner: show all skill names
          const multiNames = relevant.map((r) => r.skill.name)
          // Use the first skill as activeSkill for state tracking;
          // the banner receives `names` for multi-skill display.
          setActiveSkill(relevant[0].skill)
          setSkillStartIndex(startIndex)
          setInput('')
          // Fire all skills at once via the multi-skill path
          const topic = relevant[0].topic
          onActivity({ type: 'user-sent', content: text, at: Date.now() })
          onActivity({ type: 'assistant-start', content: '', at: Date.now(), model })
          sendMessage({ text: topic || text }, { body: { model, effort: chatEffort, skills: slugs, focusMode, sessionFocus: serializeSessionFocus(sessionFocus), reasoningDepth } })
          return
        }
      }

      // ── Skill invocation from normal chat (command or natural language) ──
      // Only when there's no attachment in flight — skills are text-only modes.
      if (text && !uploadResult) {
        const inv = detectSkillInvocation(text)
      if (inv) {
        const startIndex = messages.length
        setActiveSkill(inv.skill)
        setSkillStartIndex(startIndex)
        setInput('')
        // Topic supplied inline → run the first turn now. Otherwise arm the
        // skill and let the banner prompt for the opening input.
        if (inv.topic) {
          sendSkillTurn(inv.skill, inv.topic, startIndex)
        }
        return
      }
    }

    const attachment = uploadResult
    const finalText = attachment ? buildMessageText(attachment, text) : text

    onActivity({ type: 'user-sent', content: text || `[Attached: ${attachment?.filename}]`, at: Date.now() })
    onActivity({ type: 'assistant-start', content: '', at: Date.now(), model })
    const body: Record<string, unknown> = { model, effort: chatEffort, focusMode, sessionFocus: serializeSessionFocus(sessionFocus), reasoningDepth }

    // Only attach the raw image to the model when the selected model actually
    // supports vision — otherwise the text description in finalText is the
    // fallback that always works regardless of model.
    const files = attachment && attachment.file_type === 'image' && attachment.image_url && VISION_MODELS.has(model)
      ? [{ type: 'file' as const, mediaType: attachment.mime_type, filename: attachment.filename, url: attachment.image_url }]
      : undefined

    sendMessage({ text: finalText, ...(files ? { files } : {}) }, { body })
    setInput('')
    setPendingUpload(null)
    setUploadResult(null)
  }

  const handleFileSelected = async (file: File) => {
    if (file.size > MAX_FILE_SIZE) {
      setPendingUpload({ file, status: 'error', error: `Too large — max 10MB (${(file.size / (1024 * 1024)).toFixed(1)}MB)` })
      return
    }
    const fileType = detectFileType(file.name)
    if (!fileType) {
      setPendingUpload({ file, status: 'error', error: `Unsupported type — use ${SUPPORTED_EXTENSIONS.slice(0, 6).join(', ')}...` })
      return
    }

    setPendingUpload({ file, status: 'uploading', fileType })
    setUploadResult(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/upload', { method: 'POST', body: form })
      const parsed = await parseJsonResponse<AttachmentMeta>(res)
      if (!parsed.ok) {
        setPendingUpload({ file, status: 'error', error: parsed.message, fileType })
        return
      }
      const data = parsed.data
      setPendingUpload({ file, status: 'ready', fileType })
      setUploadResult({
        filename: data.filename,
        file_type: data.file_type,
        mime_type: data.mime_type,
        size: data.size,
        storage_path: data.storage_path,
        extracted_summary: data.extracted_summary,
        truncated: data.truncated,
        image_url: data.image_url,
      })
    } catch {
      setPendingUpload({ file, status: 'error', error: 'Network error — try again', fileType })
    }
  }

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) handleFileSelected(file)
  }

  const handleRemoveUpload = () => {
    setPendingUpload(null)
    setUploadResult(null)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDraggingFile(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFileSelected(file)
  }

  const router = useRouter()

  // Daily card rotation — pick a different set of 4 each day
  const dailyCards = useMemo(() => getDailySuggestionCards(), [])

  const handlePrefillPrompt = useCallback((prompt: string) => {
    setInput(prompt)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [])

  // Clicking the mascot fires a random card from the same pool.
  useEffect(() => {
    return onGolemQuickAction((card: SuggestionCard) => {
      if (card.label === 'Write code') router.push('/agent')
      else handlePrefillPrompt(card.prompt)
    })
  }, [handlePrefillPrompt, router])

  const handleModelSelect = (id: ModelId) => {
    setModel(id)
    setChatEffort(CHAT_MODEL_DEFAULTS[id] ?? 'medium')
    if (!modelSupportsReasoning(id)) setReasoningDepth('off')
    onModelChange(id)
    setModelOpen(false)
  }

  // Typing pulls Golem over toward the composer. The target expires on its own
  // a few seconds after the last keystroke, so there's nothing to clear here.
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const rect = textareaRef.current?.getBoundingClientRect()
    // Aim above the composer, not at it — combined with the engine's hover
    // distance that keeps him near the input without sitting on top of it.
    if (rect) setGolemSeekTarget({ x: rect.left + rect.width / 2, y: rect.top - 40 })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleCopy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const currentChatEffort = CHAT_EFFORTS.find((e) => e.id === chatEffort)
  const isStreaming = status === 'streaming' || status === 'submitted'

  // ── Interrupted-stream recovery actions ──────────────────────────
  // `continueFrom` resumes: the partial text is handed back to the route,
  // which prepends a continuation directive so the model picks up mid-
  // sentence rather than restarting. The partial output stays on screen —
  // a truncated answer is usually most of an answer, and throwing it away
  // to show an error would be a worse outcome than the bug being fixed.
  const continueFrom = useCallback((partialContent: string) => {
    if (!partialContent) return
    sendMessage({ text: '' }, {
      body: {
        model,
        effort: chatEffort,
        focusMode,
        sessionFocus: serializeSessionFocus(sessionFocus),
        reasoningDepth,
        recovery: true,
        partialContent,
      },
    })
  }, [sendMessage, model, chatEffort, focusMode, sessionFocus, reasoningDepth])

  // `retryTurn` regenerates from scratch — used when the interrupted turn
  // produced nothing usable, or the user would rather have a fresh answer.
  const retryTurn = useCallback(() => {
    const lastUser = [...messagesRef.current].reverse().find((m) => m.role === 'user')
    if (!lastUser) return
    const text = getTextContent(lastUser)
    if (!text) return
    sendMessage({ text }, {
      body: {
        model,
        effort: chatEffort,
        focusMode,
        sessionFocus: serializeSessionFocus(sessionFocus),
        reasoningDepth,
      },
    })
  }, [sendMessage, model, chatEffort, focusMode, sessionFocus, reasoningDepth])

  // Auto-flush queued messages when the stream settles back to ready.
  // sendMessage is stable per the AI SDK, safe as a dep.
  const sendMessageRef = useRef(sendMessage)
  /* eslint-disable-next-line react-hooks/refs */
  sendMessageRef.current = sendMessage
  useEffect(() => {
    if (status === 'ready' && queue.length > 0) {
      const next = dequeue()
      if (next) {
        sendMessageRef.current(
          { text: next.text, ...(next.files ? { files: next.files } : {}) },
          { body: next.body },
        )
        onActivity({ type: 'user-sent', content: next.text, at: Date.now() })
        onActivity({ type: 'assistant-start', content: '', at: Date.now(), model })
      }
    }
  }, [status, queue.length]) // eslint-disable-line react-hooks/exhaustive-deps



  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-surface-base">
      {/* Status Bar */}
      <div className="relative border-b border-border bg-surface-secondary">
        <div className="pointer-events-none absolute inset-0 grid-overlay opacity-20" />
        <div className="relative z-10 mx-auto max-w-3xl px-8 py-3">
          <div className="flex items-center justify-between">
            {/* Left: Logo + Status */}
            <div className="flex items-center gap-3">
              <GolemLogo size="sm" />
              <div className="h-4 w-px bg-border" />
              <StatusIndicator status={agentStatus} />
            </div>

            {/* Right: Live Stats */}
            <div className="flex items-center gap-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-1.5"
              >
                <Cpu className="h-3 w-3 text-primary" />
                <span className="font-mono text-[11px] font-medium text-foreground">
                  {(() => { const m = findModel(model); return m ? `${m.company} ${m.label}` : ''; })()}
                </span>
              </motion.div>

              <div className="h-3 w-px bg-border" />

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.1 }}
                className="flex items-center gap-1.5"
              >
                <Zap className="h-3 w-3 text-accent" />
                <span className="font-mono text-[11px] text-muted-foreground">
                  {lastResponseMs !== null ? (
                    <span className="text-accent">{formatDuration(lastResponseMs)}</span>
                  ) : (
                    <span>—</span>
                  )}
                </span>
              </motion.div>

              <div className="h-3 w-px bg-border" />

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
                className="flex items-center gap-1.5"
              >
                <Clock className="h-3 w-3 text-warning" />
                <span className="font-mono text-[11px] text-muted-foreground">
                  {formatUptime(uptimeMs)}
                </span>
              </motion.div>
            </div>
          </div>
        </div>
      </div>

      {/* Scratch mode banner */}
      <AnimatePresence>
        {scratchMode && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="border-b border-accent/30 bg-accent/10"
          >
            <div className="mx-auto max-w-3xl px-8 py-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Eraser className="h-3.5 w-3.5 text-accent" />
                  <span className="font-mono text-[11px] text-accent font-semibold uppercase tracking-wider">
                    Scratch
                  </span>
                  <span className="font-sans text-[11px] text-muted-foreground">
                    ephemeral — nothing is saved, messages lost on refresh
                  </span>
                </div>
                <button
                  onClick={() => setScratchMode(false)}
                  className="font-mono text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  exit scratch
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Skill mode banner */}
      <AnimatePresence>
        {activeSkill && (
          <SkillBanner
            key={activeSkill.slug}
            name={activeSkill.name}
            phaseLabel={activeSkill.structure.turnLabels[Math.min(skillTurnsCompleted, activeSkill.structure.assistantTurns - 1)]}
            completed={skillTurnsCompleted}
            total={activeSkill.structure.assistantTurns}
            waitingForInput={messages.slice(skillStartIndex).length === 0}
            hint={activeSkill.structure.openingInputHint}
            onExit={exitSkill}
          />
        )}
      </AnimatePresence>

      {/* Messages Area */}
      <div className="relative flex-1 overflow-y-auto px-8 py-6 scrollbar-hidden">
        <div className="mx-auto max-w-3xl space-y-6">
          {/* Compaction indicator — shown after server-side compaction */}
          <CompactionIndicator compacted={contextCompacted} summary={compactionSummary} messageCount={messages.length} />
          {/* Recovery banner — shown when stream is interrupted and recovery is attempted */}
          <RecoveryBanner
            state={recoveryState}
            onRetry={() => {
              // Manual retry: re-send the recovery request with the last partial content
              const lastMsg = messages[messages.length - 1]
              if (lastMsg?.role === 'assistant') {
                const partialContent = getTextContent(lastMsg)
                if (partialContent) {
                  setRecoveryState(RecoveryState.Recovering)
                  sendMessage({ text: '' }, {
                    body: {
                      model, effort: chatEffort, focusMode,
                      sessionFocus: serializeSessionFocus(sessionFocus),
                      reasoningDepth,
                      recovery: true, partialContent,
                    },
                  })
                }
              }
            }}
          />
          {/* Welcome Section - shown when no messages */}
          {messages.length === 0 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center justify-center py-12"
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.1, type: 'spring', stiffness: 300, damping: 28 }}
                className="mb-6 flex flex-col items-center gap-4"
              >
                <GolemInline size={96} slow />
                <GolemLogo size="lg" />
              </motion.div>

              <motion.h2
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="mb-2 text-center font-display text-2xl font-bold text-foreground"
              >
                What can I help you with?
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className="mb-8 max-w-md text-center text-sm text-muted-foreground"
              >
                I can search the web, write code, analyze data, and automate complex tasks. Pick a suggestion or just start typing.
              </motion.p>

              {/* Suggestion Cards */}
              <div className="grid w-full grid-cols-2 gap-3">
                {dailyCards.map((card, index) => (
                  <motion.button
                    key={card.label}
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 + index * 0.08 }}
                    whileHover={{ scale: 1.02, borderColor: 'rgba(0, 255, 102, 0.3)' }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => {
                      if (card.label === 'Write code') router.push('/agent')
                      else handlePrefillPrompt(card.prompt)
                    }}
                    aria-label={`${card.label} - ${card.description}`}
                    className="group relative flex cursor-pointer items-start gap-3 border border-border bg-surface-secondary p-4 text-left transition-all duration-200 hover:border-primary/30 hover:bg-surface-elevated hover:shadow-[0_0_20px_rgba(0,255,102,0.05)]"
                  >
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center border border-primary/30 font-mono text-base font-bold text-primary group-hover:border-primary/60">
                      {card.glyph}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium text-foreground">{card.label}</p>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{card.description}</p>
                    </div>
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}

          {/* Messages */}
          <AnimatePresence>
            {messages.map((message, index) => {
              const { attachment, displayText: text } = getDisplayInfo(message)
              const sources = getSources(message)
              const inSkillRange = activeSkill !== null && index >= skillStartIndex
              const isCurrentStream =
                isStreaming &&
                index === messages.length - 1 &&
                message.role === 'assistant'
              // Parse reasoning trace — streaming uses a partial-tag aware parser so
              // the thinking block renders live token-by-token, not just on completion.
              const isAssistant = message.role === 'assistant'
              const { reasoning: rawTrace, answer: cleanAnswer, isThinking } = isAssistant
                ? (isCurrentStream
                    ? parseStreamingReasoning(text)
                    : { ...parseReasoningTrace(text), isThinking: false })
                : { reasoning: null, answer: text, isThinking: false }
              const displayAnswer = isAssistant ? cleanAnswer : text
              // ── Interrupted-stream detection ─────────────────────
              // Reads the finish metadata the /api/chat route stamps on
              // every assistant message. This is deliberately independent
              // of the error path: the common silent cutoff (hitting
              // maxOutputTokens) never throws, so `error`/onError see
              // nothing. Skipped for the message still streaming — it
              // hasn't got a finish chunk yet and isn't cut off, just
              // unfinished.
              const interruption = isAssistant && !isCurrentStream
                ? readFinishMetadata(message.metadata, displayAnswer.trim().length > 0)
                : { interrupted: false, label: '' }
              const isLastMessage = index === messages.length - 1
              return (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(index * 0.03, 0.3) }}
                  className={`flex gap-4 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}
                >
                                    <div className={`group max-w-[85%] ${message.role === 'user' ? 'text-right' : ''}`}>
                    {message.role === 'user' && attachment && (
                      <div className="text-left">
                        <FileAttachmentCard attachment={attachment} />
                      </div>
                    )}
                    {isAssistant && rawTrace && (
                      <ThinkingTrace reasoning={rawTrace} depth={reasoningDepth} isLive={isCurrentStream && isThinking} />
                    )}
                    {/* Clean live tool-call steps — the model's web_search /
                        github / composio calls, which were previously invisible
                        (getTextContent drops tool parts). */}
                    {isAssistant && <ChatToolSteps parts={message.parts} />}
                    <div
                      className={`rounded border px-4 py-3 transition-colors duration-300 ${
                        message.role === 'assistant'
                          ? isCurrentStream
                            ? 'border-primary/40 bg-surface-secondary text-left shadow-[0_0_18px_rgba(0,255,102,0.07)]'
                            : 'border-border bg-surface-secondary text-left'
                          : 'border-primary/20 bg-primary/5 text-left'
                      } ${inSkillRange && message.role === 'assistant' ? 'border-l-2 border-l-warning/60' : ''}`}
                    >
                      {message.role === 'assistant' ? (
                        <MarkdownMessage content={displayAnswer} isStreaming={isCurrentStream} />
                      ) : (
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                          {displayAnswer}
                        </p>
                      )}
                    </div>
                    {/* Visible interrupted state — the guarantee that a
                        stream ending early is never silent. Continue is only
                        offered on the newest message (resuming an older turn
                        would append to the wrong place) and only when there
                        is partial text worth resuming from. */}
                    {interruption.interrupted && (
                      <InterruptedNotice
                        label={interruption.label}
                        busy={isStreaming}
                        onContinue={
                          isLastMessage && displayAnswer.trim().length > 0
                            ? () => continueFrom(displayAnswer)
                            : undefined
                        }
                        onRetry={isLastMessage ? retryTurn : undefined}
                      />
                    )}
                    {message.role === 'assistant' && sources.length > 0 && (
                      <div className="mt-2">
                        <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          <span className="text-primary">▸</span>
                          <span>Sources</span>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                          {sources.map((s) => (
                            <a
                              key={s.sourceId}
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-start gap-1.5 border border-border bg-surface-elevated px-2.5 py-2 text-xs hover:border-primary/30 hover:bg-surface-elevated transition-colors"
                            >
                              <ExternalLink className="mt-0.5 h-3 w-3 flex-shrink-0 text-accent" />
                              <div className="min-w-0">
                                <p className="truncate font-medium text-foreground">{s.title ?? new URL(s.url).hostname}</p>
                                <p className="truncate text-muted-foreground">{new URL(s.url).hostname}</p>
                              </div>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                    {message.role === 'assistant' && (
                      <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={() => handleCopy(displayAnswer, message.id)}
                          className="rounded p-1 hover:bg-surface-elevated"
                        >
                          {copiedId === message.id ? (
                            <Check className="h-3 w-3 text-primary" />
                          ) : (
                            <Copy className="h-3 w-3 text-muted-foreground" />
                          )}
                        </button>
                        <button className="rounded p-1 hover:bg-surface-elevated">
                          <RotateCcw className="h-3 w-3 text-muted-foreground" />
                        </button>
                      </div>
                    )}
                    {/* Skill feedback bar for skill invocations with invocationId */}
                    {message.role === 'assistant' && inSkillRange && skillInvocationIds[index] && (
                      <SkillFeedbackBar
                        key={`feedback-${message.id}`}
                        invocationId={skillInvocationIds[index]}
                        skillName={activeSkill?.name}
                      />
                    )}


                  </div>
                </motion.div>
              )
            })}
          </AnimatePresence>

          {/* Typing indicator */}
          {isStreaming && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex gap-4"
            >
              <div className="flex items-center gap-3 rounded border border-primary/30 bg-surface-secondary px-4 py-2 shadow-[0_0_18px_rgba(0,255,102,0.07)]">
                <GolemInline state="thinking" size={40} />
                <div className="flex items-center gap-1.5">
                  {[0, 0.2, 0.4].map((delay) => (
                    <motion.div
                      key={delay}
                      className="h-1.5 w-1.5 rounded-full bg-primary"
                      animate={{ scale: [1, 1.2, 1], opacity: [0.6, 1, 0.6] }}
                      transition={{ duration: 0.6, repeat: Infinity, delay }}
                    />
                  ))}
                </div>
              </div>
            </motion.div>
          )}

          {error && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-4 py-3"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" />
              <p className="text-sm text-foreground">{error.message || 'Something went wrong. Try a different model or retry.'}</p>
            </motion.div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="border-t border-border bg-surface-secondary">
        {/* Quick Action Buttons */}
        <div className="mx-auto max-w-3xl px-4 pt-3">
          <div className="flex items-center gap-2">              {QUICK_ACTIONS.map((action) => (
                <motion.button
                  key={action.label}
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => {
                    if (action.label === 'Write code') router.push('/agent')
                    else handlePrefillPrompt(action.prompt)
                  }}
                  aria-label={action.label}
                  className="flex cursor-pointer items-center gap-1.5 border border-primary/20 bg-primary/5 px-3 py-1.5 text-[11px] font-medium text-primary transition-all duration-200 hover:border-primary/40 hover:bg-primary/10 hover:shadow-[0_0_12px_rgba(0,255,102,0.08)]"
                >
                  <span className="font-mono text-xs text-primary opacity-80">{action.glyph}</span>
                  {action.label}
                </motion.button>
            ))}
          </div>
        </div>

        {/* Pending attachment chip */}
        {pendingUpload && (
          <div className="mx-auto max-w-3xl px-4 pt-2">
            <FileAttachmentChip upload={pendingUpload} onRemove={handleRemoveUpload} />
          </div>
        )}

        {/* /skill discoverability — lists available conversation modes */}
        {!activeSkill && /^\/skill\b/i.test(input) && (
          <div className="mx-auto max-w-3xl px-4 pt-2">
            <div className="overflow-hidden rounded border border-border bg-surface-secondary">
              <div className="border-b border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                skills
              </div>
              {(() => {
                const filtered = filterSkillsByDomain(SKILLS, ['coding', 'general', 'learning']).skills
                const typed = filtered.filter((s) => {
                  const q = input.trim().replace(/^\/skill\s*/i, '').toLowerCase()
                  return !q || s.slug.includes(q) || s.name.toLowerCase().includes(q)
                })
                if (typed.length === 0) {
                  const filtersAll = ['coding', 'general', 'learning']
                  if (filtersAll.length === 0) {
                    return (
                      <div className="px-3 py-2 font-mono text-[11px] text-muted-foreground leading-relaxed">
                        Learn skills live in /learn. Switch focus off to see all chat skills, or pick one from /learn.
                      </div>
                    )
                  }
                  if (filtersAll.length === 1 && filtersAll[0] === 'coding') {
                    return (
                      <div className="px-3 py-2 font-mono text-[11px] text-muted-foreground leading-relaxed">
                        No general/multi-domain skills in The Forge focus. Switch to “None” for reasoning modes.
                      </div>
                    )
                  }
                  return null
                }
                return typed.map((s) => (
                  <button
                    key={s.slug}
                    type="button"
                    onClick={() => { setInput(`/skill ${s.slug} `); textareaRef.current?.focus() }}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-surface-elevated"
                  >
                    <span className="font-mono text-[11px] text-primary">/skill {s.slug}</span>
                    <span className="text-[11px] text-muted-foreground">{s.description}</span>
                  </button>
                ))
              })()}
            </div>
          </div>
        )}

        {/* Controls Row — model primary, toggles secondary */}
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-1.5 px-4 pt-2">
          {/* Left group: model */}
          <div className="flex items-center gap-1.5">
            <div ref={modelDropdownRef} className="relative flex-shrink-0">
              <button
                type="button"
                onClick={() => setModelOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={modelOpen}
                className="flex h-10 items-center gap-1.5 rounded border border-border bg-surface-elevated px-3 font-mono text-xs text-foreground transition-colors hover:border-primary/40 hover:text-primary"
              >
                <span className="text-muted-foreground/60 text-[10px]">
                  {findModel(model)?.company}
                </span>
                <span className="text-primary font-semibold">
                  {findModel(model)?.label}
                </span>
                <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${modelOpen ? 'rotate-180' : ''}`} />
              </button>
              {modelOpen && (
                // Opens upward: this control sits in the bottom input bar, so
                // top-full would push a long model list off the bottom of the
                // viewport with nothing able to scroll it back into view.
                <div className="absolute bottom-full left-0 z-50 mb-1 w-80 max-h-[50vh] overflow-y-auto border border-border bg-surface-secondary shadow-xl scrollbar-hidden">
                  {pickerModels.map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      role="option"
                      aria-selected={model === m.id}
                      onClick={() => handleModelSelect(m.id)}
                      className={`flex w-full items-start gap-2 px-3 py-2.5 text-left font-mono text-xs transition-colors hover:bg-surface-elevated ${
                        model === m.id ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span className="mt-0.5 flex-shrink-0">
                        {model === m.id ? (
                          <span className="block h-1.5 w-1.5 rounded-full bg-primary" />
                        ) : (
                          <span className="block h-1.5 w-1.5 rounded-full border border-border" />
                        )}
                      </span>
                      <span className="flex flex-col">
                        <span className="flex items-center gap-1.5">
                          <span>
                            <span className="text-muted-foreground/60 text-[10px]">{m.company}</span>{' '}
                            <span>{m.label}</span>
                          </span>
                          {m.community && (
                            <span className="rounded border border-warning/30 bg-warning/10 px-1 py-0 font-mono text-[8px] uppercase tracking-wider text-warning">
                              Community
                            </span>
                          )}
                          {m.degraded && (
                            <span className="rounded border border-destructive/30 bg-destructive/10 px-1 py-0 font-mono text-[8px] uppercase tracking-wider text-destructive">
                              Degraded
                            </span>
                          )}
                          {(() => {
                            const t = tpdByModel[m.id]
                            if (!t || t.state === 'ok' || t.state === 'unknown') return null
                            const exhausted = t.state === 'exhausted'
                            const critical = exhausted || t.state === 'critical'
                            return (
                              <span
                                title={`Roughly ${t.remaining.toLocaleString()} tokens left of this model's daily allowance at the provider.`}
                                className={`rounded border px-1 py-0 font-mono text-[8px] uppercase tracking-wider ${
                                  critical
                                    ? 'border-destructive/30 bg-destructive/10 text-destructive'
                                    : 'border-warning/30 bg-warning/10 text-warning'
                                }`}
                              >
                                {exhausted ? 'Daily cap' : `${Math.round(t.remaining / 1000)}k left`}
                              </span>
                            )
                          })()}
                        </span>
                        <span className="font-normal text-[10px] text-muted-foreground leading-tight mt-0.5">
                          {m.desc}
                        </span>
                        {/* Still selectable — the badge states the risk rather than hiding the model. */}
                        {m.degraded && (
                          <span className="font-normal text-[10px] text-destructive/80 leading-tight mt-0.5">
                            {m.degraded}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Scratch toggle */}
          <button
            type="button"
            onClick={() => setScratchMode((p) => !p)}
            className={`flex h-10 items-center gap-1 rounded border px-2.5 font-mono text-[10px] transition-colors hover:border-accent/30 hover:text-foreground ${
              scratchMode ? 'border-accent/30 bg-accent/5 text-accent' : 'border-border bg-surface-elevated text-muted-foreground'
            }`}
            title={scratchMode ? 'Scratch mode on — click to exit' : 'Start an ephemeral scratch session'}
          >
            <Eraser className="h-3 w-3" />
            Scratch
          </button>

          {/* Flex spacer */}
          <div className="flex-1" />

          {/* Right group: Think · Focus · Effort */}
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Reasoning Depth — only rendered for models that actually honor it
                (route.ts gates the upstream param on the same check); hidden
                rather than disabled so there's no dead control to notice. */}
            {reasoningSupported && (
              <div ref={reasoningDropdownRef} className="relative flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setReasoningMenuOpen((o) => !o)}
                  className={`flex h-10 items-center gap-1 rounded border px-2.5 font-mono text-[10px] transition-colors hover:border-primary/30 hover:text-foreground ${
                    reasoningDepth !== 'off' ? 'border-primary/30 bg-primary/5 text-primary' : 'border-border bg-surface-elevated text-muted-foreground'
                  }`}
                  title={currentReasoning.desc}
                >
                  <Brain className="h-3 w-3" />
                  {reasoningDepth === 'off' ? 'Think' : currentReasoning.label.replace('Think: ', '')}
                </button>
                {reasoningMenuOpen && (
                  <div className="absolute top-full right-0 z-50 mt-1 w-48 border border-border bg-surface-secondary shadow-xl">
                    {REASONING_DEPTHS.map((r) => (
                      <button
                        type="button"
                        key={r.id}
                        onClick={() => { setReasoningDepth(r.id); setReasoningMenuOpen(false) }}
                        className={`flex w-full flex-col px-3 py-1.5 text-left transition-colors hover:bg-surface-elevated ${
                          reasoningDepth === r.id ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <span className="font-mono text-[10px] font-semibold">{r.label}</span>
                        <span className="font-sans text-[9px] text-muted-foreground leading-tight">{r.desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Focus Mode */}
            <div ref={focusDropdownRef} className="relative flex-shrink-0">
              <button
                type="button"
                onClick={() => setFocusMenuOpen((o) => !o)}
                className={`flex h-10 items-center gap-1 rounded border px-2.5 font-mono text-[10px] transition-colors hover:border-primary/30 hover:text-foreground ${
                  focusMode !== 'all' ? 'border-primary/30 bg-primary/5 text-primary' : 'border-border bg-surface-elevated text-muted-foreground'
                }`}
                title={`Focus: ${currentFocus.desc}`}
              >
                {currentFocus.icon && <currentFocus.icon className="h-3 w-3" />}
                {currentFocus.label}
              </button>
              {focusMenuOpen && (
                // Opens upward — same reasoning as the model dropdown above:
                // this control lives in the bottom input bar.
                <div className="absolute bottom-full right-0 z-50 mb-1 w-44 max-h-[50vh] overflow-y-auto border border-border bg-surface-secondary shadow-xl scrollbar-hidden">
                  {FOCUS_MODES.map((f) => (
                    <button
                      type="button"
                      key={f.id}
                      onClick={() => { setFocusMode(f.id); setFocusMenuOpen(false) }}
                      className={`flex w-full flex-col px-3 py-1.5 text-left transition-colors hover:bg-surface-elevated ${
                        focusMode === f.id ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span className="font-mono text-[10px] font-semibold">{f.label}</span>
                      <span className="font-sans text-[9px] text-muted-foreground leading-tight">{f.desc}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Session Focus (domain scope) */}
            <div ref={sessionFocusDropdownRef} className="relative flex-shrink-0">
              <button
                type="button"
                onClick={() => setSessionFocusMenuOpen((o) => !o)}
                className={`flex h-10 items-center gap-1 rounded border px-2.5 font-mono text-xs font-semibold uppercase tracking-wide transition-colors hover:border-primary/30 hover:text-foreground ${
                  sessionFocus.kind !== 'none' ? 'border-primary/30 bg-primary/5 text-primary' : 'border-border bg-surface-elevated text-muted-foreground'
                }`}
                title={`Session Focus (Focus Modes): ${sessionFocus.kind !== 'none' ? sessionFocusLabel(sessionFocus) : 'None — no domain scoping'}`}
              >
                <Globe className="h-3 w-3" />
                {sessionFocus.kind === 'none' ? 'Focus' : sessionFocusLabel(sessionFocus)}
              </button>
              {sessionFocusMenuOpen && (
                // Opens upward — same reasoning as the model and Focus Mode
                // dropdowns above: this control sits in the bottom input bar,
                // so top-full pushes the stance-mode list (Brainstorm/Ship/
                // Teacher/Focus + None + custom) off the bottom of the
                // viewport with no way to scroll it back into view.
                <div className="absolute bottom-full right-0 z-50 mb-1 w-56 max-h-[50vh] overflow-y-auto border border-border bg-surface-secondary shadow-xl scrollbar-hidden">
                  {/* None: opt out of session scoping entirely */}
                  <button
                    type="button"
                    onClick={() => selectSessionFocus({ kind: 'none' })}
                    className={`flex w-full flex-col px-3 py-1.5 text-left transition-colors hover:bg-surface-elevated ${
                      sessionFocus.kind === 'none' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span className="font-mono text-[10px] font-semibold">None</span>
                    <span className="font-sans text-[9px] text-muted-foreground leading-tight">No scoping — every skill reachable.</span>
                  </button>
                  <div className="border-t border-border" />
                  {/* Seeds: Drive / Learn / School */}
                  <div className="px-3 pt-1.5 pb-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
                    presets
                  </div>
                  {(['brainstorm', 'ship', 'teacher', 'focus'] as const).map((id) => {
                    const meta = SESSION_FOCUS_META[id]
                    const isActive = sessionFocus.kind === 'seed' && sessionFocus.id === id
                    return (
                      <button
                        type="button"
                        key={id}
                        onClick={() => selectSessionFocus({ kind: 'seed', id })}
                        className={`flex w-full flex-col px-3 py-1.5 text-left transition-colors hover:bg-surface-elevated ${
                          isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <span className="font-mono text-[10px] font-semibold">{meta.label}</span>
                        <span className="font-sans text-[9px] text-muted-foreground leading-tight">{meta.description}</span>
                      </button>
                    )
                  })}
                  {customFocuses.length > 0 && (
                    <>
                      <div className="border-t border-border" />
                      <div className="px-3 pt-1.5 pb-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
                        custom
                      </div>
                      {customFocuses.map((id) => {
                        const isActive = sessionFocus.kind === 'custom' && sessionFocus.id === id
                        return (
                          <button
                            type="button"
                            key={id}
                            onClick={() => selectSessionFocus({ kind: 'custom', id })}
                            className={`flex w-full flex-col px-3 py-1.5 text-left transition-colors hover:bg-surface-elevated ${
                              isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            <span className="font-mono text-[10px] font-semibold">{id}</span>
                          </button>
                        )
                      })}
                    </>
                  )}
                  <div className="border-t border-border" />
                  {/* Custom slot — inline input, commits on Enter or button click */}
                  <div className="flex items-center gap-1 px-3 py-2">
                    <input
                      type="text"
                      value={customFocusInput}
                      onChange={(e) => setCustomFocusInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomFocus() } }}
                      placeholder="+ Custom…"
                      maxLength={32}
                      className="flex-1 rounded border border-border bg-surface-elevated px-2 py-1 font-mono text-[10px] text-foreground placeholder-muted-foreground focus:border-primary/40 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={addCustomFocus}
                      disabled={!customFocusInput.trim()}
                      className="rounded border border-primary/30 bg-primary/5 px-2 py-1 font-mono text-[10px] text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-elevated disabled:text-muted-foreground"
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Effort */}
            <div ref={effortDropdownRef} className="relative flex-shrink-0">
              <button
                type="button"
                onClick={() => setEffortMenuOpen((o) => !o)}
                className="flex h-10 items-center gap-1 rounded border border-border bg-surface-elevated px-2.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
              >
                <Zap className="h-3 w-3" />{currentChatEffort?.label}
                <ChevronDown className={`h-2.5 w-2.5 transition-transform ${effortMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {effortMenuOpen && (
                <div className="absolute top-full right-0 z-50 mt-1 w-40 border border-border bg-surface-secondary shadow-xl">
                  {CHAT_EFFORTS.map((e) => (
                    <button
                      type="button"
                      key={e.id}
                      onClick={() => { setChatEffort(e.id); setEffortMenuOpen(false) }}
                      className={`flex w-full flex-col px-3 py-1.5 text-left transition-colors hover:bg-surface-elevated ${
                        chatEffort === e.id ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span className="font-mono text-[10px] font-semibold">{e.label}</span>
                      <span className="font-sans text-[9px] text-muted-foreground leading-tight">{e.desc}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Main Input */}
        <form
          onSubmit={handleSubmit}
          onDragOver={(e) => { e.preventDefault(); setIsDraggingFile(true) }}
          onDragLeave={() => setIsDraggingFile(false)}
          onDrop={handleDrop}
          className={`mx-auto flex max-w-3xl items-end gap-2 rounded px-4 pt-2 pb-3 transition-colors ${isDraggingFile ? 'bg-primary/5 ring-1 ring-primary/40' : ''}`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(',')}
            onChange={handleFileInputChange}
            className="hidden"
          />
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={
                isDraggingFile
                  ? 'Drop file to attach…'
                  : activeSkill
                    ? messages.slice(skillStartIndex).length === 0
                      ? activeSkill.structure.openingInputHint ?? 'Respond to continue…'
                      : `${activeSkill.name} — respond, or /exit to leave`
                    : 'Enter a command or ask anything, or /skill to run a mode…'
              }
              rows={3}
              disabled={isStreaming}
              className="w-full resize-none rounded border border-border bg-surface-elevated px-4 py-3 pr-12 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
              style={{ minHeight: '80px', maxHeight: '320px' }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="absolute bottom-3 right-3 rounded p-1 text-muted-foreground hover:bg-surface-secondary hover:text-foreground"
            >
              <Paperclip className="h-4 w-4" />
            </button>
          </div>

          <button
            type="submit"
            disabled={(!input.trim() && !uploadResult) || isStreaming || pendingUpload?.status === 'uploading'}
            className="flex h-10 w-12 flex-shrink-0 items-center justify-center rounded border border-primary bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-elevated disabled:text-muted-foreground"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>

        {/* Footer */}
        <div className="mx-auto max-w-3xl px-4 pb-3">
          <div className="flex items-center justify-end">
            {/* Keyboard hints */}
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">
                <kbd className="rounded border border-border bg-surface-elevated px-1.5 py-0.5 font-mono text-[10px]">
                  Enter
                </kbd>{' '}
                to send,{' '}
                <kbd className="rounded border border-border bg-surface-elevated px-1.5 py-0.5 font-mono text-[10px]">
                  Shift + Enter
                </kbd>{' '}
                for new line
              </p>
              <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                <Command className="h-3 w-3" />
                Command Palette
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
