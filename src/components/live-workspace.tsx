'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Terminal, FileText, ChevronDown, ChevronUp, Loader2, Wifi, WifiOff, Pause, Play, XCircle } from 'lucide-react'

export interface LiveStep {
  at: string
  action: string
  file: string | null
  command: string | null
  output_preview: string | null
}

interface LiveWorkspaceProps {
  /** Polling endpoint — e.g. '/api/cruise/live-steps?scan_id=...' */
  pollUrl: string | null
  /** If true, hides the component entirely (no run to watch) */
  hidden?: boolean
  /** Called when the run finishes (status leaves 'running'/'queued') */
  onFinished?: (status: string) => void
  /** Control endpoint — e.g. '/api/cruise/control' or '/api/lab/overnight/control' */
  controlUrl?: string | null
  /** ID of the scan/run to control */
  controlId?: string | null
}

const POLL_MS = 2500
const MAX_VISIBLE = 50

export function LiveWorkspace({ pollUrl, hidden, onFinished, controlUrl, controlId }: LiveWorkspaceProps) {
  const [steps, setSteps] = useState<LiveStep[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const [connecting, setConnecting] = useState(true)
  const [stale, setStale] = useState(false)
  const [controlPending, setControlPending] = useState(false)
  const [paused, setPaused] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const finishedRef = useRef(false)
  // Latest poll closure, read from the interval so it never goes stale even if
  // the caller recreates `onFinished` between renders.
  const pollRef = useRef<() => Promise<void>>(async () => {})

  const sendControl = useCallback(async (signal: 'pause' | 'cancel' | '') => {
    if (!controlUrl || !controlId) return
    setControlPending(true)
    try {
      await fetch(controlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scan_id: controlId, run_id: controlId, signal }),
      })
      if (signal === 'pause') setPaused(true)
      if (signal === '') setPaused(false)
    } catch { /* best-effort */ }
    finally { setControlPending(false) }
  }, [controlUrl, controlId])

  const poll = useCallback(async () => {
    if (!pollUrl) return
    try {
      const res = await fetch(pollUrl)
      if (!res.ok) return
      const data = await res.json()
      const newSteps: LiveStep[] = Array.isArray(data.steps) ? data.steps : []
      setSteps((prev) => {
        if (newSteps.length > prev.length) return newSteps
        return prev
      })
      const newStatus = String(data.status ?? '')
      setStatus(newStatus)
      setConnecting(false)

      // Detect staleness: no heartbeat in last 90s
      if (data.heartbeat_at) {
        const age = Date.now() - new Date(data.heartbeat_at).getTime()
        setStale(age > 90_000)
      }

      // Auto-stop polling when the run is no longer active
      if (newStatus !== 'running' && newStatus !== 'queued') {
        if (!finishedRef.current) {
          finishedRef.current = true
          onFinished?.(newStatus)
        }
      }
    } catch {
      setConnecting(false)
      setStale(true)
    }
  }, [pollUrl, onFinished])

  // Keep the interval's view of `poll` current without touching the ref during
  // render (the lint rule forbids it). Runs before the polling effect below, so
  // the interval never holds a stale closure.
  useEffect(() => {
    pollRef.current = poll
  }, [poll])

  // Reset the view when switching to a different run. Done during render (the
  // React-sanctioned pattern) rather than in an effect, so the old run's steps
  // are never shown against the new run's status and the lint rule isn't
  // tripped by synchronous setState inside the effect.
  const [prevPollUrl, setPrevPollUrl] = useState(pollUrl)
  if (prevPollUrl !== pollUrl) {
    setPrevPollUrl(pollUrl)
    setSteps([])
    setStatus(null)
    setConnecting(true)
    setStale(false)
  }

  useEffect(() => {
    if (!pollUrl) return
    finishedRef.current = false
    pollRef.current()
    timerRef.current = setInterval(() => pollRef.current(), POLL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [pollUrl])

  // Auto-scroll to bottom on new steps
  useEffect(() => {
    if (containerRef.current && expanded) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [steps, expanded])

  if (hidden || !pollUrl) return null

  const isActive = status === 'running' || status === 'queued'
  const visibleSteps = steps.slice(-MAX_VISIBLE)

  const actionIcon = (action: string) => {
    if (/read|open|file/i.test(action)) return <FileText className="h-3 w-3 text-accent" />
    if (/cmd|exec|run|command/i.test(action)) return <Terminal className="h-3 w-3 text-primary" />
    if (/build|test|lint|typecheck|install/i.test(action)) return <Loader2 className="h-3 w-3 text-warning animate-spin" />
    return <Terminal className="h-3 w-3 text-muted-foreground" />
  }

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="border border-border bg-surface-secondary overflow-hidden"
    >
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${isActive ? 'bg-primary animate-pulse' : status === 'completed' ? 'bg-accent' : status === 'failed' ? 'bg-warning' : 'bg-muted-foreground'}`} />
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Live Workspace
          </span>
          {status && (
            <span className={`font-mono text-[10px] ${isActive ? 'text-primary' : 'text-muted-foreground'}`}>
              {status === 'running' ? '• running' : status}
            </span>
          )}
          {!isActive && status && (
            <span className="font-mono text-[10px] text-muted-foreground">
              — finished
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {connecting && !stale && (
            <span className="flex items-center gap-1 font-mono text-[9px] text-muted-foreground">
              <Loader2 className="h-2.5 w-2.5 animate-spin" /> connecting
            </span>
          )}
          {stale && (
            <span className="flex items-center gap-1 font-mono text-[9px] text-warning">
              <WifiOff className="h-2.5 w-2.5" /> stale
            </span>
          )}
          {isActive && !stale && (
            <span className="flex items-center gap-1 font-mono text-[9px] text-primary">
              <Wifi className="h-2.5 w-2.5" /> live
            </span>
          )}
          {paused && (
            <span className="flex items-center gap-1 font-mono text-[9px] text-warning">
              <Pause className="h-2.5 w-2.5" /> paused
            </span>
          )}
          {/* Control buttons — only when a control URL is available and run is active */}
          {isActive && controlUrl && controlId && (
            <>
              <div className="h-3 w-px bg-border" />
              {!paused ? (
                <button
                  onClick={() => sendControl('pause')}
                  disabled={controlPending}
                  className="rounded p-0.5 text-muted-foreground hover:text-warning hover:bg-surface-elevated disabled:opacity-30"
                  title="Pause run"
                >
                  {controlPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
                </button>
              ) : (
                <button
                  onClick={() => sendControl('')}
                  disabled={controlPending}
                  className="rounded p-0.5 text-muted-foreground hover:text-primary hover:bg-surface-elevated disabled:opacity-30"
                  title="Resume run"
                >
                  {controlPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                </button>
              )}
              <button
                onClick={() => sendControl('cancel')}
                disabled={controlPending}
                className="rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-surface-elevated disabled:opacity-30"
                title="Cancel run"
              >
                {controlPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
              </button>
            </>
          )}
          <button
            onClick={() => setExpanded((e) => !e)}
            className="rounded p-0.5 hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Steps list */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            ref={containerRef}
            initial={{ height: 0 }}
            animate={{ height: 'auto', maxHeight: 400 }}
            exit={{ height: 0 }}
            className="overflow-y-auto scrollbar-hidden px-3 py-2 space-y-1"
            style={{ maxHeight: 400 }}
          >
            {visibleSteps.length === 0 && (
              <div className="py-4 text-center font-mono text-[11px] text-muted-foreground">
                {connecting ? 'Connecting to runner…' : 'Waiting for runner to send steps…'}
              </div>
            )}
            {visibleSteps.map((step, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.15 }}
                className="flex items-start gap-2 rounded px-2 py-1 hover:bg-surface-elevated/50 transition-colors"
              >
                <span className="mt-0.5 flex-shrink-0 font-mono text-[9px] text-muted-foreground w-14 text-right tabular-nums">
                  {new Date(step.at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className="mt-0.5 flex-shrink-0">
                  {actionIcon(step.action)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] font-semibold text-foreground">{step.action}</span>
                    {step.file && (
                      <span className="font-mono text-[9px] text-accent truncate">{step.file}</span>
                    )}
                  </div>
                  {step.command && (
                    <div className="mt-0.5 font-mono text-[9px] text-muted-foreground bg-surface-elevated px-1.5 py-0.5 rounded truncate">
                      $ {step.command}
                    </div>
                  )}
                  {step.output_preview && (
                    <div className="mt-0.5 font-mono text-[9px] text-muted-foreground/70 line-clamp-2 whitespace-pre-wrap break-all">
                      {step.output_preview.slice(0, 200)}
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
            {isActive && (
              <div className="flex items-center gap-2 px-2 py-1">
                <span className="font-mono text-[9px] text-muted-foreground">—</span>
                <span className="flex gap-1">
                  {[0, 0.2, 0.4].map((d) => (
                    <motion.span
                      key={d}
                      className="h-1 w-1 rounded-full bg-primary"
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{ duration: 0.8, repeat: Infinity, delay: d }}
                    />
                  ))}
                </span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
