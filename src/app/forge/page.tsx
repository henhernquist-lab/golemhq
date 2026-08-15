'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import Link from 'next/link'
import {
  ArrowLeft, ChevronDown, ChevronRight, Check, X, Send, Loader2,
  GitBranch, Folder, File, Lock, Sliders, Zap, TerminalSquare, Eye, Play,
  Swords, FileText, Pencil, Brain, Globe, Plus, MessageSquare,
} from 'lucide-react'
import { MissionsPanel } from '@/components/agent/missions-panel'
import { DriveTerminalWorkspace, type DriveTerminalWorkspaceHandle } from '@/components/terminal/drive-terminal-workspace'
import { SkillFeedbackBar } from '@/components/skill-feedback-bar'
import { ThinkingTrace } from '@/components/thinking-trace'
import { CompactionIndicator } from '@/components/compaction-indicator'
import { SKILLS as ALL_SKILLS, detectSkillInvocation, detectSkillInvocations, buildMultiSkillPrompt } from '@/lib/skills/registry'
import { classifyTaskComplexity, autoSelectForComplexity } from '@/lib/drive/auto-select'
import { DriveSteps, type DriveStep } from '@/components/drive-steps'
import { RouterExplanation } from '@/components/router/router-explanation'
import { buildRoutingDecision } from '@/lib/router/explain'
import type { RoutingDecision } from '@/lib/router/types'

// ─── Types ──────────────────────────────────────────────────

interface RepoOption {
  full_name: string
  default_branch: string
  private: boolean
}

type ChatLine =
  | { kind: 'prompt'; text: string }
  | { kind: 'system'; text: string }
  | { kind: 'thinking' }
  | { kind: 'plan'; text: string; targetFile: string; isNewFile: boolean } // plan-first phase 1 plan
  | { kind: 'proposal'; file: string; diff: string; isNewFile: boolean }
  | { kind: 'applied'; text: string }
  | { kind: 'committed'; text: string }
  | { kind: 'pr'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'filePreview'; path: string; content: string }
  | { kind: 'question'; questionText: string; options: string[] }
  | { kind: 'skill'; text: string; invocationId?: string; skillName?: string; reasoningTrace?: string | null }
  // A plain-edit reasoning pass (Think, on a code edit — no skill active).
  // `pending` is true while the follow-up generation hop is still in flight
  // (the trace itself is already fully generated and final by the time this
  // line exists — only the diff that comes after is still pending). `deep`
  // gets the distinct effort='deep' treatment.
  | { kind: 'reasoning'; id: string; text: string; targetFile: string; pending: boolean; deep: boolean }
  // Compact live progress tracker for the current turn — one line, updated in
  // place as Drive advances (classify -> reason -> write -> propose, or
  // apply/commit/PR). See src/components/drive-steps.tsx.
  | { kind: 'steps'; id: string; steps: DriveStep[] }
  // Thinking indicator — shown while a skill invocation is generating before
  // the first response content arrives. Removed automatically when any real
  // content line appears.
  | { kind: 'thinking' }

// Manual vs Auto — who decides model, Think, effort, and skill for a request.
//   Manual: the user's explicit picker/toggle values are used exactly as set.
//     Nothing gets auto-selected — this includes disabling natural-language
//     skill auto-detection, which otherwise silently activates a skill.
//   Auto: Golem classifies the request (see src/lib/drive/auto-select.ts) and
//     picks model + effort + Think + skill together, before the call starts.
//     The picks are written into the same state the pickers show (so the
//     pills reflect exactly what ran) plus a transcript line explaining why.
// This is intentionally a DIFFERENT axis from `planFirst` below — showing a
// plan before acting is a review/safety step, not a decision about who
// picks model/effort/Think/skill. The two used to be the same toggle; they
// were split apart so each has one clear meaning.
type Mode = 'auto' | 'manual'

// ─── Model & effort definitions ─────────────────────────────// Drive picker draws from the 'drive' scope of the registry (see
// src/lib/nim.ts). 'drive' is the most permissive scope — it includes every
// model exposed to coding-agent calls, including Kimi K2.7 Code (the
// intentional Drive-only entry). New models become available here the
// instant they're added to the registry with `scopes: ['drive']`.
import { listModels, DEFAULT_MODEL_ID } from '@/lib/nim'

const MODELS = listModels('drive').map((m) => ({
  id: m.id,
  label: m.label,
  desc: m.description,
  degraded: m.degraded,
}))

// Drive skills (coding-focused) — pulled from the shared registry.
const DRIVE_SKILL_SLUGS = [
  // Original 7
  'cartographer', 'ghost-hunter', 'bisector', 'build-vs-buy-vs-skip',
  'estimator', 'scope-cutter', 'failure-mode-mapper',
  // Ported from homepage (5)
  'drive-devil-advocate', 'drive-assumption-excavator', 'drive-pre-mortem',
  'drive-interrogator', 'drive-eli-expert',
  // New coding skills (6)
  'code-reviewer', 'code-council', 'simplifier', 'architect',
  'rubber-duck', 'explainer',
  // Execution booster skills (8)
  'show-your-work', 'test-first', 'slow-down', 'prove-it-works',
  'first-principles', 'adversarial-coding', 'two-model-consensus',
  'codebase-grounded',
  'monid',
]
const DRIVE_SKILLS = ALL_SKILLS.filter((s) => DRIVE_SKILL_SLUGS.includes(s.slug))

const EFFORTS = [
  { id: 'none' as const,    label: 'Auto',     desc: 'Default reasoning' },
  { id: 'low' as const,     label: 'Quick',    desc: 'Minimal reasoning, fast' },
  { id: 'medium' as const,  label: 'Balanced', desc: 'Moderate reasoning depth' },
  { id: 'high' as const,    label: 'Deep',     desc: 'Maximum reasoning, slower' },
  { id: 'deep' as const,    label: 'Extended', desc: 'Full codebase context, multi-step plan, thorough review' },
]

// Per-model default effort levels for the coding agent.
const MODEL_DEFAULTS: Record<string, EffortId> = {
  'deepseek-ai/deepseek-v4-flash': 'none',
  'z-ai/glm-5.2': 'medium',
  'gemini-3.5-flash': 'medium',
  'llama-3.3-70b-versatile': 'medium',
  'openai/gpt-oss-120b': 'high',
}

type EffortId = typeof EFFORTS[number]['id']

// ─── File tree helpers ──────────────────────────────────────

interface TreeNode {
  name: string
  isDir: boolean
  children: TreeNode[]
  path: string
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = []
  for (const p of paths) {
    const parts = p.split('/')
    let level = root
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1
      const name = parts[i]
      let node = level.find((n) => n.name === name)
      if (!node) {
        node = { name, isDir: !isLast, children: [], path: parts.slice(0, i + 1).join('/') }
        level.push(node)
      }
      level = node.children
    }
  }
  // Sort: directories first, then alphabetically
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const n of nodes) if (n.isDir) sort(n.children)
  }
  sort(root)
  return root
}

// ─── Diff block ─────────────────────────────────────────────

function DiffBlock({ diffText }: { diffText: string }) {
  const lines = diffText.split('\n')
  const fileLine = lines.find((l) => l.startsWith('+++ ') || l.startsWith('--- '))
  const fileName = fileLine
    ? fileLine.replace(/^(\+\+\+ |--- )/, '').replace(/^[ab]\//, '')
    : null

  let adds = 0
  let dels = 0
  for (const l of lines) {
    if (l.startsWith('+') && !l.startsWith('+++')) adds++
    else if (l.startsWith('-') && !l.startsWith('---')) dels++
  }

  return (
    <div className="overflow-hidden rounded-md border border-border">
      {fileName && (
        <div className="flex items-center justify-between border-b border-border bg-surface-secondary px-3 py-1.5">
          <span className="font-mono text-[11px] text-foreground">{fileName}</span>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            <span className="text-primary">+{adds}</span>
            {' '}
            <span className="text-destructive">{'\u2212'}{dels}</span>
          </span>
        </div>
      )}
      <div className="overflow-x-auto bg-[#080808] text-[12px] leading-[1.6]">
        {lines.map((line, i) => {
          let bg = ''
          let fg = 'text-muted-foreground'
          if (line.startsWith('+++') || line.startsWith('---')) {
            fg = 'text-muted-foreground/50'
          } else if (line.startsWith('@@')) {
            bg = 'bg-accent/5'
            fg = 'text-accent'
          } else if (line.startsWith('+')) {
            bg = 'bg-primary/5'
            fg = 'text-primary'
          } else if (line.startsWith('-')) {
            bg = 'bg-destructive/5'
            fg = 'text-destructive'
          } else {
            fg = 'text-foreground/70'
          }
          return (
            <div key={i} className={`flex ${bg}`}>
              <span className="inline-block w-[44px] flex-shrink-0 select-none border-r border-border/30 px-2 text-right font-mono text-[10px] tabular-nums text-muted-foreground/40">
                {i + 1}
              </span>
              <span className={`whitespace-pre px-3 font-mono ${fg}`}>
                {line || ' '}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Deep reasoning step list ───────────────────────────────

function DeepReasoningIndicator({ running }: { running: boolean }) {
  const steps = ['Reading file', 'Analyzing structure', 'Considering approaches', 'Planning changes', 'Generating diff']
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (!running) { setStep(0); return }
    const i = setInterval(() => setStep((s) => (s + 1) % steps.length), 1800)
    return () => clearInterval(i)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  if (!running) return null

  return (
    <div className="mb-4 border-l-2 border-primary/20 pl-4">
      <div className="mb-1 flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin text-primary/40" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-primary/50">Extended reasoning</span>
      </div>
      <div className="space-y-1 mt-2">
        {steps.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <span className={`font-mono text-[9px] ${
              i < step ? 'text-primary' : i === step ? 'text-muted-foreground/60' : 'text-muted-foreground/25'
            }`}>
              {i < step ? <Check className="h-2.5 w-2.5 inline" /> : i === step ? '\u25b8' : '\u00b7'}
            </span>
            <span className={`font-mono text-[10px] ${
              i < step ? 'text-primary/60' : i === step ? 'text-muted-foreground' : 'text-muted-foreground/30'
            }`}>
              {s}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Page component ─────────────────────────────────────────

export default function AgentPage() {
  const { status } = useSession()
  const router = useRouter()

  const [repos, setRepos] = useState<RepoOption[]>([])
  const [repo, setRepo] = useState<string>('')
  const [repoMenuOpen, setRepoMenuOpen] = useState(false)
  // Optional-chained on purpose: an empty MODELS list must degrade to a
  // disabled picker, never crash the page. `MODELS[0].id` here previously took
  // the whole /agent route down whenever the registry resolved empty.
  const [model, setModel] = useState<string>(MODELS[0]?.id ?? DEFAULT_MODEL_ID)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [effort, setEffort] = useState<EffortId>(MODEL_DEFAULTS[MODELS[0]?.id ?? ''] ?? 'none')
  const [effortMenuOpen, setEffortMenuOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('auto')
  // Plan-first review step — was previously bundled into `mode` (manual mode
  // used to always plan-first; auto mode never did). Split out so it's an
  // independent choice: show a text plan before generating a diff, whichever
  // way model/effort/Think/skill got picked. Default false preserves today's
  // default behavior (mode defaulted to 'auto', which never planned first).
  const [planFirst, setPlanFirst] = useState(false)
  // Auto mode's most recent pick, for the transcript line + brief pill
  // emphasis — cleared once a new request starts.
  const [lastAutoPick, setLastAutoPick] = useState<string | null>(null)
  // Structured routing decision for the "Why this route?" explanation — the
  // auto-select pick relabeled into the profile vocabulary (see
  // src/lib/router/explain.ts). Replaces the plain lastAutoPick one-liner in
  // the transient UI; the transcript system-line remains the permanent record.
  const [lastRoutingDecision, setLastRoutingDecision] = useState<RoutingDecision | null>(null)
  const [routerExpanded, setRouterExpanded] = useState(false)
  // Workspace mode: 'chat' (conversation only) vs 'missions' (read-only
  // mission/task list) vs 'command' (IDE terminals only). All three stay
  // mounted so each view preserves its state across switches.
  const [workspaceMode, setWorkspaceMode] = useState<'chat' | 'missions' | 'command'>(
    () => {
      if (typeof window === 'undefined') return 'chat'
      const saved = localStorage.getItem('golem.drive.mode')
      return saved === 'missions' || saved === 'command' ? saved : 'chat'
    },
  )
  useEffect(() => {
    try { localStorage.setItem('golem.drive.mode', workspaceMode) } catch { /* optional */ }
  }, [workspaceMode])
  const [lines, setLines] = useState<ChatLine[]>([
    { kind: 'system', text: 'coding agent \u2014 select a repository to begin.' },
  ])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [hasPendingDiff, setHasPendingDiff] = useState(false)
  const [thinkingCollapsed, setThinkingCollapsed] = useState(false)

  // File tree state
  const [filePaths, setFilePaths] = useState<string[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [loadingTree, setLoadingTree] = useState(false)

  // Manual mode plan context
  const [planContext, setPlanContext] = useState<{ targetFile: string; isNewFile: boolean; instruction: string } | null>(null)
  const [activeSkillSlugs, setActiveSkillSlugs] = useState<string[]>([])
  const [skillMenuOpen, setSkillMenuOpen] = useState(false)

  // Focus mode — limits what context the agent draws from
  type FocusMode = 'all' | 'memory_only' | 'web_only' | 'repo_only'
  const [focusMode, setFocusMode] = useState<FocusMode>('all')
  const [focusMenuOpen, setFocusMenuOpen] = useState(false)
  const focusMenuRef = useRef<HTMLDivElement>(null)

  // Context compaction — collapse older lines when conversation grows large
  const DRIVE_COMPACT_THRESHOLD = 50
  const DRIVE_KEEP_RECENT = 15
  const [compactionExpanded, setCompactionExpanded] = useState(false)

  // .enryrules state
  const [hasEnryRules, setHasEnryRules] = useState(false)
  const [enryRulesContent, setEnryRulesContent] = useState('')
  const [enryRulesEditing, setEnryRulesEditing] = useState(false)
  const [enryRulesSaving, setEnryRulesSaving] = useState(false)

  // ─── Terminal workspace ─────────────────────────────────
  // The terminal workspace owns its PTY metadata, layout, reconnection, and
  // lifecycle. Keep only a small bridge here so Drive's header can create the
  // first shell without coupling the two state machines.
  const terminalWorkspaceRef = useRef<DriveTerminalWorkspaceHandle>(null)
  const [terminalCount, setTerminalCount] = useState(0) // workspace bridge
// (Drive workspace is rendered below in the main layout)

  // Auto mode's pick stays in the transcript permanently (the system line in
  // handleSend) but also gets a brief badge near the toggle — same
  // auto-dismiss pattern as terminalNotice above, so the "why" is visible
  // right where the decision was made without permanently cluttering the
  // controls row.
  useEffect(() => {
    if (!lastAutoPick) return
    // Keep the explanation visible while it's expanded (the user is reading
    // the full "why this route?" detail) — auto-clear resumes once collapsed.
    if (routerExpanded) return
    const t = setTimeout(() => {
      setLastAutoPick(null)
      setLastRoutingDecision(null)
    }, 8000)
    return () => clearTimeout(t)
  }, [lastAutoPick, routerExpanded])

  // PTYs intentionally remain alive across route remounts where the backend
  // supports reconnection; the workspace reaps them explicitly on close.

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const repoMenuRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const effortMenuRef = useRef<HTMLDivElement>(null)
  const skillMenuRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const FOCUS_MODES = [
    { id: 'all' as const, label: 'All', icon: null, desc: 'No restrictions — web, memory, and repo' },
    { id: 'memory_only' as const, label: 'Memory', icon: Brain, desc: 'Only stored memories/notes, no web or repo' },
    { id: 'web_only' as const, label: 'Web', icon: Globe, desc: 'Web search only, no memory or repo context' },
    { id: 'repo_only' as const, label: 'Repo', icon: File, desc: 'Only current repo files, no memory or web' },
  ]
  const currentFocusMode = FOCUS_MODES.find((f) => f.id === focusMode)!

  // Reasoning trace — how much of the model's thinking to surface
  type ReasoningDepth = 'off' | 'summary' | 'full'
  const [reasoningDepth, setReasoningDepth] = useState<ReasoningDepth>('off')
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false)
  const reasoningMenuRef = useRef<HTMLDivElement>(null)

  const REASONING_DEPTHS = [
    { id: 'off' as const, label: 'Think: Off', desc: 'Show only the final answer' },
    { id: 'summary' as const, label: 'Think: Brief', desc: 'Condensed reasoning summary' },
    { id: 'full' as const, label: 'Think: Full', desc: 'Complete reasoning trace' },
  ]
  const currentReasoningDepth = REASONING_DEPTHS.find((r) => r.id === reasoningDepth)!

  const tree = useMemo(() => buildTree(filePaths), [filePaths])

  // Drive context compaction — collapses older lines when conversation exceeds threshold
  const driveCompaction = useMemo(() => {
    if (lines.length <= DRIVE_COMPACT_THRESHOLD) {
      return { isCompacted: false, summary: null, compactedCount: 0, visibleLines: lines }
    }
    const compactedCount = lines.length - DRIVE_KEEP_RECENT
    const older = lines.slice(0, compactedCount)
    const files = new Set<string>()
    const skills = new Set<string>()
    const errs: string[] = []
    const topics: string[] = []
    for (const l of older) {
      if (l.kind === 'proposal' && 'file' in l) files.add(l.file)
      if (l.kind === 'applied' && l.text) files.add(l.text.split(' ').slice(0, 3).join(' '))
      if (l.kind === 'skill' && l.skillName) skills.add(l.skillName)
      if (l.kind === 'error') errs.push(l.text.slice(0, 100))
      if (l.kind === 'prompt') {
        const s = l.text.split('\n')[0].slice(0, 100)
        if (s) topics.push(s)
      }
    }
    const parts: string[] = []
    if (files.size > 0) parts.push(`Files: ${[...files].slice(0, 5).join(', ')}`)
    if (skills.size > 0) parts.push(`Skills: ${[...skills].join(', ')}`)
    if (errs.length > 0) parts.push(`Errors: ${errs.slice(0, 3).join(' | ')}`)
    if (topics.length > 0) parts.push(`Topics: ${topics.slice(-5).join(' → ')}`)
    const summary = parts.join('\n') || `${compactedCount} earlier messages summarized`
    return { isCompacted: true, summary, compactedCount, visibleLines: lines.slice(compactedCount) }
  }, [lines])
  const selectedRepo = repos.find((r) => r.full_name === repo)
  const currentModel = MODELS.find((m) => m.id === model)
  const currentEffort = EFFORTS.find((e) => e.id === effort)
  const activeSkills = DRIVE_SKILLS.filter((s) => activeSkillSlugs.includes(s.slug))
  const activeSkill = activeSkills.length === 1 ? activeSkills[0] : null
  const isDeep = effort === 'deep'

  // Auth guard
  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  // Load .enryrules when repo changes
  useEffect(() => {
    if (!repo) return
    fetch(`/api/terminal/enryrules?repo=${encodeURIComponent(repo)}`)
      .then((r) => r.json())
      .then((d) => {
        setHasEnryRules(d.exists ?? false)
        setEnryRulesContent(d.content ?? '')
      })
      .catch(() => {})
  }, [repo])

  // Load repos
  useEffect(() => {
    fetch('/api/terminal/repos')
      .then((r) => r.json())
      .then((d) => {
        const list = (d.repos ?? []) as RepoOption[]
        setRepos(list)
        if (list.length && !repo) setRepo(list[0].full_name)
        if (d.error) setLines((l) => [...l, { kind: 'system', text: `GitHub: ${d.error}` }])
      })
      .catch(() => setLines((l) => [...l, { kind: 'system', text: 'could not load repositories' }]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load file tree when repo changes
  useEffect(() => {
    if (!repo || !selectedRepo) return
    setLoadingTree(true)
    setFilePaths([])
    setExpandedDirs(new Set())
    fetch('/api/terminal/tree', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, branch: currentBranch ?? selectedRepo.default_branch }),
    })
      .then((r) => r.json())
      .then((d) => {
        setFilePaths(d.paths ?? [])
        setLoadingTree(false)
      })
      .catch(() => setLoadingTree(false))
  }, [repo, selectedRepo, currentBranch])

  // Close menus on outside click
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (repoMenuRef.current && !repoMenuRef.current.contains(e.target as Node)) setRepoMenuOpen(false)
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) setModelMenuOpen(false)
      if (effortMenuRef.current && !effortMenuRef.current.contains(e.target as Node)) setEffortMenuOpen(false)
      if (skillMenuRef.current && !skillMenuRef.current.contains(e.target as Node)) setSkillMenuOpen(false)
      if (focusMenuRef.current && !focusMenuRef.current.contains(e.target as Node)) setFocusMenuOpen(false)
      if (reasoningMenuRef.current && !reasoningMenuRef.current.contains(e.target as Node)) setReasoningMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [lines])

  const selectRepo = useCallback((full: string) => {
    setRepo(full)
    setSessionId(null)
    setCurrentBranch(null)
    setHasPendingDiff(false)
    setPlanContext(null)
    setRepoMenuOpen(false)
    setLines([{ kind: 'system', text: `selected ${full}. describe what you want to change.` }])
    inputRef.current?.focus()
  }, [])

  const fetchFileContent = useCallback(async (path: string) => {
    // Read the file via the terminal exec endpoint
    const res = await fetch('/api/terminal/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, command: `cat ${path}`, session_id: sessionId }),
    })
    const data = await res.json()
    const content = (data.output ?? '').toString()
    setLines((l) => [...l, { kind: 'filePreview', path, content }])
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [repo, sessionId])

  // \u2500\u2500\u2500 Live step tracker \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // A single 'steps' ChatLine per turn, updated in place as Drive advances.
  // stepsLineIdRef points at the current turn's line so the exec chain (which
  // recurses across hops) can keep mutating the same tracker.
  const stepsLineIdRef = useRef<string | null>(null)

  const beginSteps = useCallback((first: DriveStep) => {
    const id = `steps-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    stepsLineIdRef.current = id
    setLines((l) => [...l, { kind: 'steps', id, steps: [first] }])
  }, [])

  // Mark the current active step done (optionally relabel it) and, if given,
  // append the next active step. No-op if no tracker is active.
  const advanceSteps = useCallback((opts: { doneLabel?: string; next?: DriveStep }) => {
    const id = stepsLineIdRef.current
    if (!id) return
    setLines((l) => l.map((line) => {
      if (line.kind !== 'steps' || line.id !== id) return line
      const steps = line.steps.map((s) =>
        s.state === 'active' ? { ...s, state: 'done' as const, label: opts.doneLabel ?? s.label } : s,
      )
      if (opts.next) steps.push(opts.next)
      return { ...line, steps }
    }))
  }, [])

  // Mark the current active step as failed and stop tracking this turn.
  const failSteps = useCallback(() => {
    const id = stepsLineIdRef.current
    if (!id) return
    setLines((l) => l.map((line) =>
      line.kind === 'steps' && line.id === id
        ? { ...line, steps: line.steps.map((s) => s.state === 'active' ? { ...s, state: 'error' as const } : s) }
        : line,
    ))
    stepsLineIdRef.current = null
  }, [])

  // Settle the final active step to done and stop tracking this turn.
  const finishSteps = useCallback((doneLabel?: string) => {
    const id = stepsLineIdRef.current
    if (!id) return
    setLines((l) => l.map((line) =>
      line.kind === 'steps' && line.id === id
        ? { ...line, steps: line.steps.map((s) => s.state === 'active' ? { ...s, state: 'done' as const, label: doneLabel ?? s.label } : s) }
        : line,
    ))
    stepsLineIdRef.current = null
  }, [])

  // A plain function declaration (not useCallback) \u2014 the auto-chain hop below
  // calls exec recursively, which would be a TDZ hazard against a `const`
  // bound via useCallback. Recreated every render like the rest of this
  // file's handlers that reference it; harmless, nothing depends on exec's
  // identity being stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  async function exec(command: string, opts?: {
    proceed?: boolean; targetFile?: string; isNewFile?: boolean; instruction?: string
    skillSlug?: string; skillSlugs?: string[]; reasoningTrace?: string; reasoningLineId?: string; _chainDepth?: number
    // Auto mode computes its pick synchronously in handleSend and needs it in
    // THIS same request — setModel/setEffort/setReasoningDepth are async
    // (won't have landed in the `model`/`effort`/`reasoningDepth` closures
    // below by the time exec() runs in the same handler), so the freshly
    // computed values are passed straight through instead of relying on
    // state that hasn't re-rendered yet. Manual mode never sets these —
    // exec() then falls back to whatever the pickers currently hold.
    modelOverride?: string; effortOverride?: EffortId; reasoningDepthOverride?: ReasoningDepth
  }) {
      if (!repo) {
        setLines((l) => [...l, { kind: 'system', text: 'select a repository first' }])
        return
      }
      setRunning(true)
      setThinkingCollapsed(false)
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const body: Record<string, unknown> = {
          repo, command, session_id: sessionId,
          model: opts?.modelOverride ?? model,
          effort: opts?.effortOverride ?? effort,
          plan_first: planFirst,
          focus_mode: focusMode,
          reasoning_depth: opts?.reasoningDepthOverride ?? reasoningDepth,
          proceed: opts?.proceed ?? false,
          monid_enabled: false,
          ...(opts?.skillSlugs && opts.skillSlugs.length > 0 ? { skill_slugs: opts.skillSlugs } : {}),
          ...(opts?.skillSlug && !opts?.skillSlugs ? { skill_slug: opts.skillSlug } : {}),
        }
        if (opts?.targetFile) body.target_file = opts.targetFile
        if (opts?.isNewFile !== undefined) body.is_new_file = opts.isNewFile
        if (opts?.instruction) body.instruction = opts.instruction
        if (opts?.reasoningTrace) body.reasoning_trace = opts.reasoningTrace

        const res = await fetch('/api/terminal/exec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!res.ok) {
          const detail = await res.text().catch(() => '')
          let parsed: { error?: string } | null = null
          try { parsed = JSON.parse(detail) } catch { /* not JSON */ }
          setLines((l) => [...l, { kind: 'error', text: parsed?.error || `Request failed (HTTP ${res.status})` }])
          failSteps()
          return
        }
        const data = await res.json()
        if (data.session_id) setSessionId(data.session_id)
        setCurrentBranch(data.current_branch ?? null)
        setHasPendingDiff(!!data.has_pending_diff)

        // Clear the thinking indicator now that real content is arriving.
        setLines((l) => l.filter((line) => line.kind !== 'thinking'))

        // Auto-mode NL edits: the server classifies the target file and stops
        // there (see /api/terminal/exec's dispatch()) so classification and
        // full-file generation get separate maxDuration budgets instead of
        // stacking two blocking LLM calls in one invocation. Chain the
        // follow-up request invisibly \u2014 same pattern as terminal-chat.tsx.
        // Cap of 2 (not 1): with Think on, the full chain is classify ->
        // reasoning -> generate, three hops. Without Think it's still just
        // two (target_resolved -> propose_edit) since the server only ever
        // returns reasoning_ready when reasoningDepth !== 'off'.
        if (data.action === 'target_resolved' && (opts?._chainDepth ?? 0) < 2) {
          // File located — settle "Analyzing" and queue the next phase. With
          // Think on, reasoning runs as its own hop next; otherwise the diff
          // generation is next.
          const willReason = (opts?.reasoningDepthOverride ?? reasoningDepth) !== 'off'
          const tf = String(data.target_file ?? 'file')
          advanceSteps({
            doneLabel: `Located · ${tf}`,
            next: willReason
              ? { key: 'reason', label: 'Reasoning', icon: 'reason', state: 'active' }
              : { key: 'write', label: `Writing changes · ${tf}`, icon: 'write', state: 'active' },
          })
          await exec(command, {
            proceed: true,
            targetFile: data.target_file,
            isNewFile: data.is_new_file,
            instruction: opts?.instruction ?? command,
            _chainDepth: (opts?._chainDepth ?? 0) + 1,
            // Carry Auto mode's pick through the chain explicitly — relying
            // on the setModel/setEffort/setReasoningDepth state updates
            // having landed by this hop would work in practice (real network
            // latency gives React plenty of time to re-render) but is a
            // timing assumption, not a guarantee.
            modelOverride: opts?.modelOverride, effortOverride: opts?.effortOverride, reasoningDepthOverride: opts?.reasoningDepthOverride,
          })
          return
        }

        // Think, on a plain edit: the reasoning pass is done (own hop, own
        // budget) and its trace is final \u2014 show it now, before the diff
        // exists, then chain straight to the real generation hop with the
        // trace attached as prompt context (see write-ops.ts's
        // generateFileContent: unchanged call, no enable_thinking, the trace
        // only ever arrives as inert text).
        if (data.action === 'reasoning_ready' && (opts?._chainDepth ?? 0) < 2) {
          const trace = ((data.reasoning as string | undefined) ?? '').trim()
          const lineId = `reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          if (trace) {
            setLines((l) => [...l, { kind: 'reasoning', id: lineId, text: trace, targetFile: opts?.targetFile ?? 'unknown', pending: true, deep: isDeep }])
          }
          // Reasoning done — now generating the actual diff.
          advanceSteps({ next: { key: 'write', label: `Writing changes · ${opts?.targetFile ?? 'file'}`, icon: 'write', state: 'active' } })
          await exec(command, {
            proceed: true,
            targetFile: opts?.targetFile,
            isNewFile: opts?.isNewFile,
            instruction: opts?.instruction ?? command,
            reasoningTrace: trace || undefined,
            reasoningLineId: trace ? lineId : undefined,
            _chainDepth: (opts?._chainDepth ?? 0) + 1,
            modelOverride: opts?.modelOverride, effortOverride: opts?.effortOverride, reasoningDepthOverride: opts?.reasoningDepthOverride,
          })
          return
        }

        const text = (data.output ?? data.error ?? '').toString()
        const action = data.action
        const reasoning = data.reasoning as string | undefined

        // Detect clarifying question marker in output
        const clarifyMatch = text.match(/\[CLARIFY\]\s*([\s\S]*?)Options:\s*([\s\S]*)$/i)
        if (clarifyMatch && data.exit_code === 0 && !action) {
          const questionText = clarifyMatch[1].trim()
          const optionsRaw = clarifyMatch[2].trim()
          const options = optionsRaw
            .split(/(?:^|\s*,\s*)[A-Z]\)\s*/)
            .filter(Boolean)
            .map((o: string) => o.trim())
          setLines((l) => [...l, { kind: 'question', questionText, options }])
          finishSteps('Awaiting your answer')
        } else if (action === 'plan') {
          // Plan-first phase 1: a text plan, no diff yet (write-ops.ts's
          // planEdit — the actual plan text is in `reasoning`, NOT `text`,
          // which is just the literal string "Plan for <file>"). dispatch()
          // only includes target_file/is_new_file on the response when
          // planTarget is set, which it is here. Populate planContext so the
          // Propose Diff button (handleProceed) has something to act on —
          // previously never set to a real value anywhere, so that button was
          // permanently disabled.
          const targetFile = (data.target_file as string | undefined) ?? 'unknown'
          const isNewFile = !!data.is_new_file
          setLines((l) => [...l, { kind: 'plan', text: reasoning ?? text, targetFile, isNewFile }])
          setPlanContext({ targetFile, isNewFile, instruction: opts?.instruction ?? command })
          finishSteps(`Plan ready · ${targetFile}`)
        } else if (action === 'propose_edit' && data.exit_code === 0) {
          // The actual diff — from the classify-then-generate chain, or a plan-first
          // approval's Propose Diff click (handleProceed). Neither dispatch()
          // branch that returns this action sets planTarget, so target_file/
          // is_new_file aren't on the response; the file is instead already
          // known from this exact call's own opts (both callers — the
          // auto-chain above and handleProceed — pass targetFile/isNewFile
          // explicitly), or planContext as a fallback for other paths.
          const file = opts?.targetFile ?? planContext?.targetFile ?? 'unknown'
          const isNewFile = opts?.isNewFile ?? planContext?.isNewFile ?? false
          setLines((l) => {
            // Resolve the reasoning line this diff followed (if Think was on)
            // from pending to settled, rather than appending a duplicate.
            const withResolvedReasoning = opts?.reasoningLineId
              ? l.map((line) => line.kind === 'reasoning' && line.id === opts.reasoningLineId ? { ...line, pending: false } : line)
              : l
            return [...withResolvedReasoning, { kind: 'proposal', file, diff: text, isNewFile }]
          })
          setPlanContext(null)
          finishSteps(`Proposed diff · ${file}`)
        } else if (action === 'apply' && data.exit_code === 0) {
          setLines((l) => [...l, { kind: 'applied', text: text || 'Changes applied to working copy' }])
          finishSteps('Applied changes')
        } else if (action === 'commit' && data.exit_code === 0) {
          setLines((l) => [...l, { kind: 'committed', text: text }])
          setHasPendingDiff(false)
          finishSteps('Committed')
        } else if (action === 'pr' && data.exit_code === 0) {
          setLines((l) => [...l, { kind: 'pr', text: text }])
          finishSteps('Opened pull request')
        } else if (data.exit_code !== 0) {
          setLines((l) => [...l, { kind: 'error', text: text || 'command failed' }])
          failSteps()
        } else if (data.invocation_id) {
          setLines((l) => [...l, { kind: 'skill', text: text || '(done)', invocationId: data.invocation_id, skillName: activeSkill?.name ?? activeSkills.map((s) => s.name).join(' + '), reasoningTrace: data.reasoning_trace ?? null }])
          finishSteps('Analysis ready')
        } else {
          setLines((l) => [...l, { kind: 'system', text: text || '(done)' }])
          finishSteps()
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          setLines((l) => [...l, { kind: 'system', text: 'Cancelled' }])
          failSteps()
        } else {
          console.error('[agent] exec request failed:', e)
          setLines((l) => [...l, { kind: 'error', text: 'Request failed or timed out \u2014 retry' }])
          failSteps()
        }
      } finally {
        setRunning(false)
        abortRef.current = null
      }
  }

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || running) return

    // Check for natural-language skill triggers BEFORE falling through to
    // the normal code-edit path. This catches phrases like
    // "should I add X" (Build vs Buy vs Skip),
    // "scan the repo for dead code" (Ghost Hunter), etc.
    // Also supports /skill <slug> [topic] explicit commands.
    // Manual mode: skill choice is sticky picker state (activeSkill), same
    // as before — the whole point of Manual is that the picker IS the
    // source of truth. Auto mode: starts fresh (null) every request. Without
    // this split, Auto would silently inherit whatever skill Manual mode (or
    // Auto's own PRIOR pick) last left active, instead of reassessing the
    // CURRENT request — confirmed live: without this fix, a skill picked
    // once in Manual mode stuck through every later Auto-mode request
    // regardless of what that request actually needed.
    let skillToUse = mode === 'auto' ? null : activeSkill
    let skillsToUse = mode === 'auto' ? [] : activeSkills
    let userText = text

    // (a) /skill <slug1> [slug2] [slug3] [slug4] [topic] — parse multi-skill
    const slashMatch = text.match(/^\/skill\s+([\s\S]+)$/i)
    if (slashMatch) {
      const words = slashMatch[1].trim().split(/\s+/)
      const slugs: string[] = []
      let topicIdx = 0
      for (let i = 0; i < words.length && slugs.length < 4; i++) {
        const candidate = words[i].toLowerCase()
        if (DRIVE_SKILLS.some((s) => s.slug === candidate)) {
          slugs.push(candidate)
          topicIdx = i + 1
        } else {
          break
        }
      }
      if (slugs.length > 0) {
        const foundSkills = DRIVE_SKILLS.filter((s) => slugs.includes(s.slug))
        skillToUse = foundSkills.length === 1 ? foundSkills[0] : null
        skillsToUse = foundSkills
        userText = words.slice(topicIdx).join(' ').trim() || text
        if (foundSkills.length >= 1) setActiveSkillSlugs(slugs)
      }
    }

    // (b) Natural-language trigger — only in Auto mode. Manual mode means
    // "nothing gets auto-selected," and silently activating a skill from
    // phrasing alone would violate that even though it predates this
    // change — Manual-mode skill choice now comes ONLY from the /skill
    // command above or the skill picker.
    if (!skillToUse && mode === 'auto') {
      const detected = detectSkillInvocation(text)
      if (detected && DRIVE_SKILLS.some((s) => s.slug === detected.skill.slug)) {
        skillToUse = detected.skill
        skillsToUse = [detected.skill]
        userText = detected.topic || text
      }
    }

    // ─── Auto mode: classify the request, pick model + effort + Think +
    // skill together (see src/lib/drive/auto-select.ts), and make every
    // pick visible — the pills update to the real values this request will
    // use, plus a transcript line explaining why. Manual mode changes
    // NOTHING here: whatever the pickers already hold is what's sent.
    let modelOverride: string | undefined
    let effortOverride: EffortId | undefined
    let reasoningDepthOverride: ReasoningDepth | undefined
    let autoChoiceNote: string | null = null
    if (mode === 'auto') {
      const complexity = classifyTaskComplexity(userText, skillToUse)
      const picked = autoSelectForComplexity(complexity)
      modelOverride = picked.modelId
      effortOverride = picked.effort as EffortId
      reasoningDepthOverride = picked.think
      setModel(picked.modelId)
      setEffort(picked.effort as EffortId)
      setReasoningDepth(picked.think)
      setActiveSkillSlugs(skillToUse ? [skillToUse.slug] : [])
      const thinkLabel = picked.think === 'off' ? 'Think Off' : picked.think === 'summary' ? 'Think Brief' : 'Think Full'
      const effortLabel = EFFORTS.find((e) => e.id === picked.effort)?.label ?? picked.effort
      autoChoiceNote = `auto → ${picked.modelLabel} · ${effortLabel} · ${thinkLabel}${skillToUse ? ` · ${skillToUse.name}` : ' · no skill'} (assessed: ${complexity})`
      setLastAutoPick(autoChoiceNote)
      setRouterExpanded(false)
      setLastRoutingDecision(buildRoutingDecision({
        complexity: picked.complexity,
        modelId: picked.modelId,
        modelLabel: picked.modelLabel,
        effort: effortLabel,
        think: thinkLabel,
      }))
    }

    // Build instruction — single vs multi-skill
    let instruction: string
    let slugsForServer: string[] | undefined

    // Clarifying-question instruction: only when NOT plan-first, and only
    // for requests that would trigger a real action (code edit, diff,
    // skill). Plan-first already shows a plan before acting (redundant to
    // ask), and ordinary conversational questions should never trigger a
    // question. This used to be gated on Auto/Manual mode — moved to
    // `planFirst` since it's fundamentally about "does something already
    // surface intent for review before acting," not about who picked the
    // model.
    const isLikelyAction = skillsToUse.length > 0 || !/^(how|what|why|explain|tell me|can you|is there|where|which|does|do)\b/i.test(userText)
    const shouldClarify = !planFirst && isLikelyAction
    const CLARIFY_RULE = shouldClarify
      ? `\n\nIf this request is genuinely ambiguous and guessing wrong would waste real effort on a code edit, skill invocation, or diff proposal, ask exactly ONE clarifying question. Format it EXACTLY as:\n[CLARIFY] Your question? Options: A) option one, B) option two, C) option three\n\nOnly do this for genuinely ambiguous code-change requests (e.g. "clean up this file", "make this faster", "add auth"). Do NOT ask for well-specified requests where a reasonable default is obvious. Do NOT ask for conversational questions that don't lead to code changes.`
      : ''

    if (skillsToUse.length >= 2) {
      // Multi-skill: use buildMultiSkillPrompt for combined system prompt
      const invocations = skillsToUse.map((s) => ({
        skill: s,
        topic: userText,
        via: 'command' as const,
      }))
      instruction = `[Acting as ${skillsToUse.map((s) => s.name.toUpperCase()).join(' + ')} lenses]

${buildMultiSkillPrompt(invocations)}
${CLARIFY_RULE}

---

USER REQUEST: ${userText}`
      slugsForServer = skillsToUse.map((s) => s.slug)
    } else if (skillToUse) {
      instruction = `[Acting as ${skillToUse.name.toUpperCase()} lens]

${skillToUse.systemPrompt}
${CLARIFY_RULE}

---

USER REQUEST: ${userText}`
    } else {
      // No skill — just the clarifying rule for normal edit requests
      instruction = userText + CLARIFY_RULE
    }

    setLines((l) => [
      ...l,
      { kind: 'prompt', text },
      ...(autoChoiceNote ? [{ kind: 'system' as const, text: autoChoiceNote }] : []),
      // Show thinking indicator while the skill generates — cleared when first
      // response content arrives in exec().
      ...(skillsToUse.length > 0 || skillToUse ? [{ kind: 'thinking' as const }] : []),
    ])
    setInput('')
    beginSteps({ key: 'analyze', label: 'Analyzing request', icon: 'analyze', state: 'active' })
    exec(instruction, {
      skillSlugs: slugsForServer ?? (skillToUse ? [skillToUse.slug] : undefined),
      modelOverride, effortOverride, reasoningDepthOverride,
    })
  }, [input, running, exec, activeSkill, activeSkills, setActiveSkillSlugs, mode, planFirst, beginSteps])

  const handleQuickAction = (action: string) => {
    if (running) return
    const verb = action.split(/\s/)[0]
    if (verb === 'apply') beginSteps({ key: 'apply', label: 'Applying changes', icon: 'apply', state: 'active' })
    else if (verb === 'commit') beginSteps({ key: 'commit', label: 'Committing', icon: 'commit', state: 'active' })
    else if (verb === 'pr') beginSteps({ key: 'pr', label: 'Opening pull request', icon: 'pr', state: 'active' })
    exec(action)
  }

  const handleProceed = () => {
    if (!planContext || running) return
    setLines((l) => [...l, { kind: 'system', text: 'proceeding with plan...' }])
    beginSteps({ key: 'write', label: `Writing changes · ${planContext.targetFile}`, icon: 'write', state: 'active' })
    exec(planContext.instruction, {
      proceed: true,
      targetFile: planContext.targetFile,
      isNewFile: planContext.isNewFile,
      instruction: planContext.instruction,
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const discardProposal = (idx: number) => {
    setLines((l) => l.filter((_, j) => j !== idx))
  }

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }

  const isLoading = status === 'loading'

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const hasRepo = !!repo

  // Render a tree node (recursive)
  const renderTreeNode = (node: TreeNode, depth: number): React.ReactNode => {
    const isExpanded = expandedDirs.has(node.path)
    const indent = depth * 12

    if (node.isDir) {
      return (
        <div key={node.path}>
          <button
            onClick={() => toggleDir(node.path)}
            className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-primary/5 hover:text-primary text-left"
            style={{ paddingLeft: `${8 + indent}px` }}
          >
            <ChevronRight className={`h-3 w-3 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            <Folder className="h-3 w-3 flex-shrink-0 text-muted-foreground/60" />
            <span className="truncate">{node.name}</span>
          </button>
          {isExpanded && node.children.map((child) => renderTreeNode(child, depth + 1))}
        </div>
      )
    }

    return (
      <button
        key={node.path}
        onClick={() => fetchFileContent(node.path)}
        className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-primary/5 hover:text-primary text-left"
        style={{ paddingLeft: `${8 + indent}px` }}
      >
        <span className="w-3 flex-shrink-0" />
        <File className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" />
        <span className="truncate">{node.name}</span>
      </button>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-background font-sans">
      {/* Top bar */}
      <header className="flex h-10 flex-shrink-0 items-center gap-3 border-b border-border bg-background px-4">
        <Link href="/" className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Home
        </Link>

        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">Coding Agent</span>

        {/* Chat / Missions / Terminals workspace switcher — fully separate workspaces */}
        <div className="flex items-center gap-0.5 rounded border border-border bg-surface-secondary p-0.5">
          <button onClick={() => setWorkspaceMode('chat')}
            className={`flex items-center gap-1 rounded px-2 py-1 font-mono text-[10px] transition-colors ${
              workspaceMode === 'chat' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
            title="Chat workspace — conversation, model, skills (no terminals)">
            <MessageSquare className="h-3 w-3" /> Chat
          </button>
          <button onClick={() => setWorkspaceMode('missions')}
            className={`flex items-center gap-1 rounded px-2 py-1 font-mono text-[10px] transition-colors ${
              workspaceMode === 'missions' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
            title="Missions — read-only run history and task list">
            <Swords className="h-3 w-3" /> Missions
          </button>
          <button onClick={() => setWorkspaceMode('command')}
            className={`flex items-center gap-1 rounded px-2 py-1 font-mono text-[10px] transition-colors ${
              workspaceMode === 'command' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
            }`}
            title="Command workspace — full IDE terminals (no chat)">
            <TerminalSquare className="h-3 w-3" /> Terminals
          </button>
        </div>

        <div className="ml-auto flex items-center gap-3">
          {/* See Golem — opens The Atelier with this surface's live context:
              whether a run is going */}
          <Link
            href={`/room?from=drive&state=${running ? 'working' : 'idle'}`}
            title="Watch Golem work in The Atelier"
            className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-primary"
          >
            <Eye className="h-3 w-3" /> See Golem
          </Link>
          {currentBranch && (
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
              <GitBranch className="h-3 w-3" />{currentBranch}
              {hasPendingDiff && <span className="text-warning">*</span>}
            </span>
          )}
          {hasPendingDiff && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-warning">Pending diff</span>
          )}
          <button
            onClick={() => { setWorkspaceMode('command'); terminalWorkspaceRef.current?.createTerminal() }}
            title="Create an unlimited PTY-backed terminal"
            className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-primary"
          >
            <Plus className="h-3 w-3" /> Terminal
            {terminalCount > 0 && <span className="text-[9px] tabular-nums text-muted-foreground/60">{terminalCount}</span>}
          </button>
          <Link href="/resources/terminal" className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground">
            <TerminalSquare className="h-3 w-3" /> Shell
          </Link>
        </div>

        {/* Repo selector — green-tinted when a repo is active */}
        <div ref={repoMenuRef} className="relative">
          <button onClick={() => setRepoMenuOpen((o) => !o)}
            className={`flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-[11px] transition-colors ${
              hasRepo
                ? 'border-primary/30 bg-primary/5 text-primary hover:bg-primary/10'
                : 'border-border bg-surface-secondary text-muted-foreground hover:border-primary/30 hover:text-foreground'
            }`}>
            {hasRepo ? (<>{selectedRepo?.private && <Lock className="h-2.5 w-2.5 text-primary/50" />}{repo}</>) : <span>Select repository</span>}
            <ChevronDown className={`h-3 w-3 transition-transform ${repoMenuOpen ? 'rotate-180' : ''}`} />
          </button>
          <AnimatePresence>
            {repoMenuOpen && (
              <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.12 }}
                className="absolute right-0 top-full z-30 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border border-border bg-surface-elevated shadow-lg">
                {repos.length === 0 ? (
                  <div className="px-3 py-2 font-mono text-[11px] text-muted-foreground">No repositories</div>
                ) : repos.map((r) => (
                  <button key={r.full_name} onClick={() => selectRepo(r.full_name)}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-surface-secondary ${r.full_name === repo ? 'text-primary' : 'text-foreground'}`}>
                    <span className="truncate">{r.full_name}</span>
                    <span className="ml-2 flex items-center gap-1.5 text-[9px] text-muted-foreground">{r.private && <Lock className="h-2.5 w-2.5" />}{r.default_branch}</span>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </header>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <aside className="flex w-[240px] flex-shrink-0 flex-col border-r border-border bg-[#0a0b0d]">
          <div className="border-b border-border p-3">
            <div className="flex items-center gap-1.5">
              <Folder className="h-3 w-3 text-muted-foreground" />
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Repository</span>
            </div>
            {hasRepo ? (
              <div className="mt-2 space-y-1">
                <button onClick={() => setRepoMenuOpen((o) => !o)}
                  className="truncate font-mono text-[11px] text-primary transition-colors hover:text-primary/80 cursor-pointer text-left w-full">
                  {repo}
                </button>
                <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                  <GitBranch className="h-2.5 w-2.5" />
                  {currentBranch ?? selectedRepo?.default_branch ?? 'main'}
                  {hasPendingDiff && <span className="font-semibold text-warning">*</span>}
                </p>
              </div>
            ) : (
              <p className="mt-2 font-mono text-[10px] text-muted-foreground/60">No repository selected</p>
            )}
          </div>

          {/* FIX #1: Real file tree */}
          <div className="flex-1 overflow-y-auto py-2 scrollbar-hidden">
            <div className="flex items-center gap-1.5 px-3 mb-1">
              <File className="h-3 w-3 text-muted-foreground" />
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Files</span>
            </div>

            {loadingTree ? (
              <div className="flex items-center gap-2 px-3 py-2">
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/40" />
                <span className="font-mono text-[10px] text-muted-foreground/40">loading tree...</span>
              </div>
            ) : hasRepo && tree.length > 0 ? (
              <div className="space-y-0.5">
                {tree.map((node) => renderTreeNode(node, 0))}
              </div>
            ) : hasRepo ? (
              <p className="px-3 font-mono text-[10px] text-muted-foreground/50 leading-relaxed">No files found. The repository may be empty.</p>
            ) : (
              <p className="px-3 font-mono text-[10px] text-muted-foreground/50 leading-relaxed">Select a repository to browse its files.</p>
            )}
          </div>

          {/* .enryrules */}
          {hasRepo && (
            <div className="border-t border-border px-3 py-2">
              <div className="mb-1.5 flex items-center gap-1.5">
                <FileText className="h-3 w-3 text-muted-foreground" />
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">.enryrules</span>
              </div>
              {hasEnryRules && !enryRulesEditing ? (
                <button
                  onClick={() => setEnryRulesEditing(true)}
                  className="flex w-full items-center gap-1 rounded border border-border bg-surface-secondary px-2 py-1 font-mono text-[10px] text-primary transition-colors hover:bg-primary/5"
                >
                  <Pencil className="h-3 w-3" />
                  View / Edit
                </button>
              ) : null}
              {!hasEnryRules && !enryRulesEditing ? (
                <button
                  onClick={() => { setEnryRulesEditing(true); setEnryRulesContent('') }}
                  className="flex w-full items-center gap-1 rounded border border-border bg-surface-secondary px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-primary hover:border-primary/30"
                >
                  <Pencil className="h-3 w-3" /> Create .enryrules
                </button>
              ) : null}
              {enryRulesEditing && (
                <div className="mt-2">
                  <textarea
                    value={enryRulesContent}
                    onChange={(e) => setEnryRulesContent(e.target.value)}
                    rows={6}
                    spellCheck={false}
                    className="w-full resize-none rounded border border-border bg-surface-elevated px-2.5 py-2 font-mono text-[10px] leading-relaxed text-foreground placeholder-muted-foreground/40 focus:border-primary/30 focus:outline-none"
                    placeholder="# .enryrules — repo-specific conventions&#10;# e.g.:&#10;# - always use const, never let&#10;# - Tailwind v4 CSS-first config&#10;# - no default exports"
                  />
                  <div className="mt-1.5 flex items-center gap-2">
                    <button
                      onClick={async () => {
                        setEnryRulesSaving(true)
                        try {
                          const res = await fetch('/api/terminal/enryrules', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ repo, content: enryRulesContent }),
                          })
                          if (res.ok) { setEnryRulesEditing(false); setHasEnryRules(true) }
                        } catch { /* ignore */ }
                        setEnryRulesSaving(false)
                      }}
                      disabled={enryRulesSaving}
                      className="flex items-center gap-1 rounded border border-primary/30 bg-primary/5 px-2 py-0.5 font-mono text-[10px] text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
                    >
                      {enryRulesSaving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => { setEnryRulesEditing(false); if (!hasEnryRules) setEnryRulesContent('') }}
                      className="font-mono text-[10px] text-muted-foreground transition-colors hover:text-destructive"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>

        {/* Main workspace — Chat, Missions, and Terminals are fully separate workspaces. */}
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Chat workspace: conversation. No terminals visible. */}
          <div className={`flex min-h-0 min-w-0 flex-col flex-1 ${workspaceMode !== 'chat' ? 'hidden' : ''}`}>
            <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-hidden">
            <div className="mx-auto max-w-[720px] px-8 py-6">
              {driveCompaction.isCompacted && (
                <CompactionIndicator
                  compacted={true}
                  summary={driveCompaction.summary}
                  messageCount={driveCompaction.compactedCount}
                  onToggle={() => setCompactionExpanded((e) => !e)}
                  externalExpanded={compactionExpanded}
                />
              )}
              {(compactionExpanded ? lines : driveCompaction.visibleLines).map((line, i) => {
                if (line.kind === 'system') {
                  return <div key={i} className="mb-3"><p className="font-mono text-[11px] leading-relaxed text-muted-foreground/60">{line.text}</p></div>
                }

                if (line.kind === 'steps') {
                  return <div key={i}><DriveSteps steps={line.steps} /></div>
                }

                if (line.kind === 'prompt') {
                  return (
                    <div key={i} className="mb-6">
                      <div className="border-l-2 border-primary/40 pl-4">
                        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50">You</div>
                        <p className="font-sans text-[14px] leading-relaxed text-foreground">{line.text}</p>
                      </div>
                    </div>
                  )
                }

                if (line.kind === 'thinking') {
                  return (
                    <div key={i} className="mb-6 overflow-hidden rounded border border-muted-foreground/10 bg-surface-secondary/30 border-l-[3px] border-l-muted-foreground/20">
                      <div className="flex items-center gap-1.5 px-3 py-1.5">
                        <Brain className="h-3 w-3 flex-shrink-0 animate-pulse text-muted-foreground/60" />
                        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50">
                          Thinking…
                        </span>
                        <span className="ml-0.5 inline-block h-[10px] w-[4px] animate-pulse bg-muted-foreground/30 align-[-1px]" />
                      </div>
                    </div>
                  )
                }
                if (line.kind === 'question') {
                  return (
                    <motion.div key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="mb-5">
                      <div className="border-l-2 border-accent/50 pl-4">
                        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-accent/70">Clarifying question</div>
                        <p className="mb-3 font-sans text-[14px] leading-relaxed text-foreground">{line.questionText}</p>
                        <div className="flex flex-wrap gap-2">
                          {line.options.map((opt, idx) => (
                            <button
                              key={idx}
                              onClick={() => {
                                setInput(opt)
                                inputRef.current?.focus()
                              }}
                              className="rounded border border-accent/30 bg-accent/5 px-3 py-1.5 font-mono text-[11px] text-accent transition-colors hover:bg-accent/10 hover:border-accent/50"
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                        <p className="mt-2 font-mono text-[9px] text-muted-foreground/50">Click an option or type your own answer above</p>
                      </div>
                    </motion.div>
                  )
                }

                if (line.kind === 'error') {
                  return (
                    <div key={i} className="mb-4">
                      <div className="border-l-2 border-destructive/40 pl-4">
                        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-destructive/60">Error</div>
                        <p className="font-mono text-[12px] leading-relaxed text-destructive">{line.text}</p>
                      </div>
                    </div>
                  )
                }

                if (line.kind === 'reasoning') {
                  // Deep effort gets a distinct, more prominent treatment —
                  // auto-expanded regardless of the Think depth setting (deep
                  // effort implies wanting to see it), a bolder header in the
                  // same language as DeepReasoningIndicator above, and a
                  // pulsing state while the diff that follows is still being
                  // generated. Not the true `<think>` reasoning form.
                  if (line.deep) {
                    return (
                      <motion.div key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="mb-4">
                        <div className="overflow-hidden rounded-md border border-primary/25 bg-primary/[0.03]">
                          <div className="flex items-center gap-1.5 border-b border-primary/15 px-3 py-1.5">
                            {line.pending
                              ? <Loader2 className="h-3 w-3 animate-spin text-primary/60" />
                              : <Check className="h-3 w-3 text-primary/60" />}
                            <span className="font-mono text-[10px] uppercase tracking-wider text-primary/70">Extended reasoning</span>
                            <span className="font-mono text-[9px] text-muted-foreground/50">· {line.targetFile}</span>
                            {line.pending && <span className="ml-auto font-mono text-[9px] text-muted-foreground/50">generating diff…</span>}
                          </div>
                          <div className="px-3 py-2.5">
                            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground/70">{line.text}</pre>
                          </div>
                        </div>
                      </motion.div>
                    )
                  }
                  return (
                    <motion.div key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="mb-4">
                      <ThinkingTrace reasoning={line.text} depth={reasoningDepth === 'off' ? 'summary' : reasoningDepth} modelLabel={currentModel?.label} />
                      {line.pending && (
                        <div className="-mt-3 flex items-center gap-1.5 pl-1">
                          <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground/40" />
                          <span className="font-mono text-[9px] text-muted-foreground/40">generating diff…</span>
                        </div>
                      )}
                    </motion.div>
                  )
                }

                if (line.kind === 'filePreview') {
                  return (
                    <div key={i} className="mb-4">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-primary/60">
                          <Eye className="h-3 w-3 text-primary" /> {line.path}
                        </span>
                        <button onClick={() => setLines((l) => l.filter((_, j) => j !== i))}
                          className="rounded px-1 py-0.5 font-mono text-[9px] text-muted-foreground/40 transition-colors hover:text-muted-foreground">
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="overflow-hidden rounded-md border border-border">
                        <pre className="max-h-64 overflow-auto bg-[#080808] p-3 font-mono text-[11px] leading-relaxed text-foreground/80 whitespace-pre-wrap">
                          {line.content.slice(0, 4000)}
                          {line.content.length > 4000 && <span className="text-muted-foreground/40">{'\n...truncated'}</span>}
                        </pre>
                      </div>
                    </div>
                  )
                }
                // Plan response (plan-first phase 1)
                if (line.kind === 'plan') {
                  return (
                    <motion.div key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="mb-5">
                      <div className="border-l-2 border-accent/40 pl-4">
                        <div className="mb-1 flex items-center gap-2">
                          <span className="font-mono text-[10px] uppercase tracking-wider text-accent/70">Plan</span>
                          <span className="font-mono text-[9px] text-muted-foreground/50">{line.targetFile}{line.isNewFile ? ' (new)' : ''}</span>
                        </div>
                        <div className="my-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">{line.text}</div>
                        <div className="flex items-center gap-2 mt-2">
                          <button onClick={handleProceed} disabled={running || !planContext}
                            className="flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2.5 py-0.5 font-mono text-[10px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40 min-h-[80px]">
                            <Play className="h-3 w-3" /> Propose Diff
                          </button>
                          <button onClick={() => { setLines((l) => l.filter((_, j) => j !== i)); setPlanContext(null) }}
                            className="rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:text-destructive">
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )
                }

                if (line.kind === 'proposal') {
                  return (
                    <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="mb-6">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] uppercase tracking-wider text-warning">Proposed change</span>
                          {line.isNewFile && <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">New file</span>}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => discardProposal(i)}
                            className="flex items-center gap-1 rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-destructive/30 hover:text-destructive">
                            <X className="h-3 w-3" /> Discard
                          </button>
                          <button onClick={() => handleQuickAction('apply')} disabled={running}
                            className="flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2.5 py-0.5 font-mono text-[10px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40 min-h-[80px]">
                            <Check className="h-3 w-3" /> Apply
                          </button>
                        </div>
                      </div>
                      <DiffBlock diffText={line.diff} />
                    </motion.div>
                  )
                }

                if (line.kind === 'applied') {
                  return (
                    <motion.div key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="mb-4">
                      <div className="border-l-2 border-primary/30 pl-4">
                        <div className="mb-1 flex items-center gap-1.5"><Check className="h-3 w-3 text-primary" /><span className="font-mono text-[10px] uppercase tracking-wider text-primary/70">Applied</span></div>
                        <p className="font-mono text-[12px] leading-relaxed text-muted-foreground">{line.text}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <button onClick={() => handleQuickAction('commit "apply proposed changes"')} disabled={running}
                            className="rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary disabled:opacity-40 min-h-[80px]">Commit</button>
                          <button onClick={() => handleQuickAction('pr "Proposed changes" "Auto-generated by Golem coding agent"')} disabled={running}
                            className="rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary disabled:opacity-40 min-h-[80px]">Create PR</button>
                        </div>
                      </div>
                    </motion.div>
                  )
                }

                if (line.kind === 'committed') {
                  return <div key={i} className="mb-4"><div className="border-l-2 border-primary/20 pl-4"><div className="mb-0.5 font-mono text-[10px] uppercase tracking-wider text-primary/50">Committed</div><p className="font-mono text-[11px] leading-relaxed text-muted-foreground">{line.text}</p></div></div>
                }

                if (line.kind === 'pr') {
                  return <div key={i} className="mb-4"><div className="border-l-2 border-primary/20 pl-4"><div className="mb-0.5 font-mono text-[10px] uppercase tracking-wider text-primary/50">Pull Request</div><p className="font-mono text-[11px] leading-relaxed text-muted-foreground">{line.text}</p></div></div>
                }

                if (line.kind === 'skill') {
                  return (
                    <motion.div key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="mb-5">
                      <div className="border-l-2 border-warning/40 pl-4">
                        <div className="mb-1 flex items-center gap-1.5">
                          <Swords className="h-3 w-3 text-warning" />
                          <span className="font-mono text-[10px] uppercase tracking-wider text-warning/70">{line.skillName || 'Skill output'}</span>
                        </div>
                        <ThinkingTrace reasoning={line.reasoningTrace ?? null} depth={reasoningDepth} modelLabel={currentModel?.label} />
                        <div className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-foreground/80">{line.text}</div>
                        <SkillFeedbackBar invocationId={line.invocationId} skillName={line.skillName} />
                      </div>
                    </motion.div>
                  )
                }

                return null
              })}

              {/* Deep effort visual — multi-step checklist. Only when Think is
                  off: when it's on, the real 'reasoning' line above already
                  shows genuine progress (a live trace, then settling once the
                  diff lands) — showing this fake cycling checklist alongside
                  a real trace would be redundant, two different "something is
                  happening" widgets competing for attention. */}
              {isDeep && reasoningDepth === 'off' && <DeepReasoningIndicator running={running} />}

              {/* Normal running indicator */}
              <AnimatePresence>
                {running && !isDeep && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mb-4">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/40" />
                      <span className="font-mono text-[11px] text-muted-foreground/40">thinking</span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Command bar — two-row layout: compact toolbar above, dominant textarea below */}
          <div className="flex-shrink-0 border-t border-border bg-background px-4 py-3">
            <div className="mx-auto max-w-[820px] space-y-2">
              {/* Row 1: controls toolbar — model primary, toggles secondary */}
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Left group: model + skill */}
                <div className="flex items-center gap-1.5">
                {/* Model picker — Golem Engine routing */}
                <div ref={modelMenuRef} className="relative flex-shrink-0">
                  <button onClick={() => setModelMenuOpen((o) => !o)}
                    className="flex items-center gap-1 rounded border border-border bg-surface-secondary px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground">
                    <Sliders className="h-3 w-3" />{currentModel?.label}<ChevronDown className="h-2.5 w-2.5" />
                  </button>
                  <AnimatePresence>
                    {modelMenuOpen && (
                      <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.12 }}
                        className="absolute bottom-full left-0 z-20 mb-1 w-52 rounded-md border border-border bg-surface-elevated shadow-lg">
                        {MODELS.map((m) => (
                          <button key={m.id} onClick={() => { setModel(m.id); setEffort(MODEL_DEFAULTS[m.id] ?? 'medium'); setModelMenuOpen(false); inputRef.current?.focus() }}
                            className={`flex w-full flex-col px-3 py-1.5 text-left transition-colors hover:bg-surface-secondary ${model === m.id ? 'text-primary' : 'text-foreground'}`}>
                            <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold">
                              {m.label}
                              {m.degraded && (
                                <span className="rounded border border-destructive/30 bg-destructive/10 px-1 font-mono text-[8px] uppercase tracking-wider text-destructive">
                                  Degraded
                                </span>
                              )}
                            </span>
                            <span className="font-sans text-[9px] text-muted-foreground">{m.desc}</span>
                            {m.degraded && (
                              <span className="font-sans text-[9px] text-destructive/80">{m.degraded}</span>
                            )}
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Drive skill picker — multi-select */}
                <div ref={skillMenuRef} className="relative flex-shrink-0">
                  <button onClick={() => setSkillMenuOpen((o) => !o)}
                    className={`flex items-center gap-1 rounded border px-2.5 py-1.5 font-mono text-[10px] transition-colors hover:border-primary/30 hover:text-foreground ${
                      activeSkills.length > 0 ? 'border-primary/30 bg-primary/5 text-primary' : 'border-border bg-surface-secondary text-muted-foreground'
                    }`}>
                    <Swords className="h-3 w-3" />
                    {activeSkills.length === 0 ? 'Skill' : activeSkills.length === 1 ? activeSkills[0].name : `${activeSkills.length} skills`}
                    <ChevronDown className="h-2.5 w-2.5" />
                  </button>
                  <AnimatePresence>
                    {skillMenuOpen && (
                      <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.12 }}
                        className="absolute bottom-full left-0 z-20 mb-1 w-56 rounded-md border border-border bg-surface-elevated shadow-lg max-h-[50vh] overflow-y-auto scrollbar-hidden">
                        <button onClick={() => { setActiveSkillSlugs([]); setSkillMenuOpen(false); inputRef.current?.focus() }}
                          className={`flex w-full flex-col px-3 py-1.5 text-left transition-colors hover:bg-surface-secondary ${activeSkills.length === 0 ? 'text-primary' : 'text-foreground'}`}>
                          <span className="font-mono text-[10px] font-semibold">None (default)</span>
                          <span className="font-sans text-[9px] text-muted-foreground">Normal coding agent</span>
                        </button>
                        {DRIVE_SKILLS.map((s) => {
                          const checked = activeSkillSlugs.includes(s.slug)
                          return (
                            <button key={s.slug} onClick={() => {
                              const next = checked
                                ? activeSkillSlugs.filter((x) => x !== s.slug)
                                : [...activeSkillSlugs, s.slug].slice(0, 4)
                              setActiveSkillSlugs(next)
                              // Don't close the menu — allow multi-select
                            }}
                              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-secondary ${checked ? 'text-primary' : 'text-foreground'}`}>
                              <span className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded border text-[8px] ${checked ? 'border-primary bg-primary/20 text-primary' : 'border-border text-transparent'}`}>
                                {checked ? <Check className="h-2.5 w-2.5" /> : null}
                              </span>
                              <div className="flex flex-col min-w-0">
                                <span className="font-mono text-[10px] font-semibold truncate">{s.name}</span>
                                <span className="font-sans text-[9px] text-muted-foreground truncate">{s.description}</span>
                              </div>
                            </button>
                          )
                        })}
                        {activeSkillSlugs.length > 0 && (
                          <button onClick={() => { setActiveSkillSlugs([]); setSkillMenuOpen(false); inputRef.current?.focus() }}
                            className="flex w-full items-center gap-2 border-t border-border px-3 py-1.5 text-left font-mono text-[10px] text-muted-foreground transition-colors hover:text-destructive">
                            <X className="h-3 w-3" /> Clear all ({activeSkillSlugs.length})
                          </button>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              <div className="flex-1 min-w-[12px]" />

              {/* Right group: toggles */}
              <div className="flex items-center gap-1.5">


                {/* Reasoning Depth selector — now genuinely wired for plain
                    code edits too, not just skills. proposeEdit's diff output
                    is generated by an UNCHANGED call (still no enable_thinking,
                    still the same CONTENT_SENTINEL contract); when Think is on,
                    a separate reasoning pass runs first, in its own hop, and
                    only its <think>-stripped TEXT is folded into the diff
                    call's prompt as context — see generateReasoningTrace /
                    dispatch()'s resolvedFile branch in exec/route.ts. */}
                <div ref={reasoningMenuRef} className="relative flex-shrink-0">
                  <button onClick={() => setReasoningMenuOpen((o) => !o)}
                    className={`flex items-center gap-1 rounded border px-2.5 py-1.5 font-mono text-[10px] transition-colors hover:border-primary/30 hover:text-foreground ${
                      reasoningDepth !== 'off' ? 'border-primary/30 bg-primary/5 text-primary' : 'border-border bg-surface-secondary text-muted-foreground'
                    }`}>
                    <Brain className="h-3 w-3" />
                    {reasoningDepth === 'off' ? 'Think' : currentReasoningDepth.label.replace('Think: ', '')}
                    <ChevronDown className="h-2.5 w-2.5" />
                  </button>
                  <AnimatePresence>
                    {reasoningMenuOpen && (
                      <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.12 }}
                        className="absolute bottom-full left-0 z-20 mb-1 w-48 rounded-md border border-border bg-surface-elevated shadow-lg">
                        {REASONING_DEPTHS.map((r) => (
                          <button key={r.id} onClick={() => { setReasoningDepth(r.id); setReasoningMenuOpen(false); inputRef.current?.focus() }}
                            className={`flex w-full flex-col px-3 py-1.5 text-left transition-colors hover:bg-surface-secondary ${reasoningDepth === r.id ? 'text-primary' : 'text-foreground'}`}>
                            <span className="font-mono text-[10px] font-semibold">{r.label}</span>
                            <span className="font-sans text-[9px] text-muted-foreground">{r.desc}</span>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Focus Mode selector */}
                <div ref={focusMenuRef} className="relative flex-shrink-0">
                  <button onClick={() => setFocusMenuOpen((o) => !o)}
                    className={`flex items-center gap-1 rounded border px-2.5 py-1.5 font-mono text-[10px] transition-colors hover:border-primary/30 hover:text-foreground ${
                      focusMode !== 'all' ? 'border-primary/30 bg-primary/5 text-primary' : 'border-border bg-surface-secondary text-muted-foreground'
                    }`}>
                    {currentFocusMode.icon ? <currentFocusMode.icon className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
                    {currentFocusMode.label}
                    <ChevronDown className="h-2.5 w-2.5" />
                  </button>
                  <AnimatePresence>
                    {focusMenuOpen && (
                      <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.12 }}
                        className="absolute bottom-full left-0 z-20 mb-1 w-44 rounded-md border border-border bg-surface-elevated shadow-lg">
                        {FOCUS_MODES.map((f) => (
                          <button key={f.id} onClick={() => { setFocusMode(f.id); setFocusMenuOpen(false); inputRef.current?.focus() }}
                            className={`flex w-full flex-col px-3 py-1.5 text-left transition-colors hover:bg-surface-secondary ${focusMode === f.id ? 'text-primary' : 'text-foreground'}`}>
                            <span className="font-mono text-[10px] font-semibold">{f.label}</span>
                            <span className="font-sans text-[9px] text-muted-foreground">{f.desc}</span>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Effort toggle — 5 levels for coding agent */}
                <div ref={effortMenuRef} className="relative flex-shrink-0">
                  <button onClick={() => setEffortMenuOpen((o) => !o)}
                    className={`flex items-center gap-1 rounded border px-2.5 py-1.5 font-mono text-[10px] transition-colors hover:border-primary/30 hover:text-foreground ${
                      isDeep ? 'border-primary/30 bg-primary/5 text-primary' : 'border-border bg-surface-secondary text-muted-foreground'
                    }`}>
                    <Zap className="h-3 w-3" />{currentEffort?.label}<ChevronDown className="h-2.5 w-2.5" />
                  </button>
                  <AnimatePresence>
                    {effortMenuOpen && (
                      <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.12 }}
                        className="absolute bottom-full left-0 z-20 mb-1 w-44 rounded-md border border-border bg-surface-elevated shadow-lg">
                        {EFFORTS.map((e) => (
                          <button key={e.id} onClick={() => { setEffort(e.id); setEffortMenuOpen(false); inputRef.current?.focus() }}
                            className={`flex w-full flex-col px-3 py-1.5 text-left transition-colors hover:bg-surface-secondary ${effort === e.id ? 'text-primary' : 'text-foreground'}`}>
                            <span className={`font-mono text-[10px] font-semibold ${e.id === 'deep' && effort === e.id ? 'text-primary' : ''}`}>
                              {e.label}{e.id === 'deep' && <span className="font-normal text-muted-foreground/50"> \u2014 slow</span>}
                            </span>
                            <span className="font-sans text-[9px] text-muted-foreground">{e.desc}</span>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Plan first — independent of Auto/Manual. Shows a text plan
                    before generating a diff, whichever mode picked the
                    model/effort/Think/skill for this request. */}
                <button onClick={() => setPlanFirst((p) => !p)} disabled={running}
                  className={`flex-shrink-0 rounded border px-2.5 py-1.5 font-mono text-[10px] transition-colors disabled:opacity-40 ${
                    planFirst
                      ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20'
                      : 'border-border bg-surface-secondary text-muted-foreground hover:border-primary/30 hover:text-foreground'
                  }`}
                  title={planFirst ? 'Plan first: shows a plan before generating a diff, you approve before it proceeds' : 'Plan first off: proposes the diff immediately'}>
                  {planFirst ? 'Plan first' : 'Plan first: off'}
                </button>

                {/* Auto/Manual — who picks model, Think, effort, and skill.
                    Manual: exactly what the pickers show, nothing inferred.
                    Auto: classifies the request and picks all four together
                    (src/lib/drive/auto-select.ts), writing the pick into the
                    same pickers so it's visible, not a black box. */}
                <button onClick={() => setMode(mode === 'auto' ? 'manual' : 'auto')} disabled={running}
                  className={`flex-shrink-0 rounded border px-2.5 py-1.5 font-mono text-[10px] transition-colors disabled:opacity-40 ${
                    mode === 'manual'
                      ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20'
                      : 'border-border bg-surface-secondary text-muted-foreground hover:border-primary/30 hover:text-foreground'
                  }`}
                  title={mode === 'manual'
                    ? 'Manual: you choose model, Think, effort, and skill — nothing auto-selected'
                    : 'Auto: Golem picks model, Think, effort, and skill based on the request'}>
                  {mode === 'manual' ? 'Manual' : 'Auto'}
                </button>
              </div>
            </div>

            {/* Auto mode's pick, right where the decision was made — a
                collapsible "Why this route?" explanation (ChatGPT
                reasoning-disclosure style). Fades after 8s unless expanded
                (see the lastAutoPick effect above). The transcript
                system-line is the permanent record; this is the "even
                briefly, right here" surface. */}
            {lastAutoPick && lastRoutingDecision && (
              <div className="mx-auto max-w-3xl px-4 pb-1">
                <RouterExplanation
                  decision={lastRoutingDecision}
                  expanded={routerExpanded}
                  onExpandedChange={setRouterExpanded}
                  onDismiss={() => { setLastAutoPick(null); setLastRoutingDecision(null) }}
                />
              </div>
            )}

              {/* Row 2: textarea + send button — textarea is the dominant element */}
              <div className="flex items-end gap-2">
                <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
                  placeholder={hasRepo ? 'Describe what you want changed\u2026' : 'Select a repository above to begin'}
                  rows={1} spellCheck={false} autoCapitalize="off" autoComplete="off" disabled={running || !hasRepo}
                  className="flex-1 resize-none rounded border border-muted-foreground/15 bg-surface-secondary px-3 py-2 font-mono text-[13px] leading-relaxed text-foreground placeholder-muted-foreground/40 focus:border-primary/30 focus:outline-none disabled:opacity-40 min-h-[80px]"
                  style={{ maxHeight: '200px' }} />

                <button onClick={handleSend} disabled={!input.trim() || running || !hasRepo}
                  className={`flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded border transition-colors disabled:opacity-30 ${
                    input.trim() && !running && hasRepo
                      ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
                      : 'border-border bg-surface-secondary text-muted-foreground hover:border-primary/30 hover:text-primary'
                  }`}>
                  {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </div>

              <div className="mt-1.5 flex items-center gap-3">
                <p className="font-mono text-[9px] text-muted-foreground/40">
                  <kbd className="rounded border border-border/50 bg-surface-secondary px-1 py-0.5 font-mono text-[8px]">Enter</kbd> send{' \u00b7 '}
                  <kbd className="rounded border border-border/50 bg-surface-secondary px-1 py-0.5 font-mono text-[8px]">Shift+Enter</kbd> newline
                </p>
              </div>
            </div>
          </div>
        </div>
        </div>
          {/* Missions workspace: read-only run history + task list. */}
          <div className={`min-h-0 min-w-0 flex-1 ${workspaceMode === 'missions' ? 'flex' : 'hidden'}`}>
            <MissionsPanel repo={repo} onChat={() => setWorkspaceMode('chat')} />
          </div>
          {/* Command workspace: full IDE — terminals only, no chat. */}
          <div className={`min-h-0 min-w-0 flex-1 ${workspaceMode === 'command' ? 'flex' : 'hidden'}`}>
            <DriveTerminalWorkspace ref={terminalWorkspaceRef} onCountChange={setTerminalCount} />
          </div>
        </div>
      </div>
    </div>
  )
}
