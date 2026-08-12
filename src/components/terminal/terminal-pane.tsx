'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal as XTermTerminal } from '@xterm/xterm'
import type { FitAddon as XTermFitAddon } from '@xterm/addon-fit'
import { X, Sparkles, Loader2, ChevronDown, Copy, Eraser, Maximize2, Minimize2, Pencil, Rows2, Columns2, RotateCcw, Square } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'

import { keystrokeTiming, type KeystrokeSample } from '@/lib/terminal/keystroke-timing'

interface TerminalPaneProps {
  id: string
  cwd?: string
  name?: string
  clearSignal?: number
  onClose: () => void
  onClosePane?: () => void
  onCommand?: (command: string) => void
  onOutput?: () => void
  onRename?: () => void
  onDuplicate?: () => void
  onRestart?: () => void
  onKill?: () => void
  onClear?: () => void
  onSplitVertical?: () => void
  onSplitHorizontal?: () => void
  onCollapse?: () => void
  onMoveToPane?: () => void
  onMaximize?: () => void
  isMaximized?: boolean
  status?: 'idle' | 'active'
}

/**
 * A real PTY-backed terminal pane. Mounts an xterm.js instance, streams PTY
 * output over SSE, and posts keystrokes back to /api/terminal/pty/[id]/input.
 *
 * The PTY session is owned by the parent (which created it and calls DELETE
 * on close). This component only connects the stream and renders output — on
 * unmount it disconnects SSE and disposes xterm, but does NOT kill the PTY,
 * so Strict Mode remounts and brief tab-aways resume via scrollback replay.
 */
/**
 * How long a keystroke may wait to be batched with the next one.
 *
 * Only ever paid by a character typed while a request is already in flight —
 * an idle burst's first character is sent immediately — so this is a ceiling
 * on added latency for fast typists, not a floor for everyone. 12ms is under
 * one frame at 60Hz, so a batched character still paints in the same frame it
 * would have anyway.
 */
const COALESCE_WINDOW_MS = 12

export function TerminalPane({ id, cwd, name = 'bash', clearSignal = 0, onClose, onClosePane, onCommand, onOutput, onRename, onDuplicate, onRestart, onKill, onClear, onSplitVertical, onSplitHorizontal, onMoveToPane, onCollapse, onMaximize, isMaximized = false, status = 'idle' }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Why the last keystroke didn't reach the shell. Rendered inline on the
  // pane: a dropped keystroke is invisible otherwise, because xterm echoes
  // locally whether or not the backend ever received it.
  const [inputError, setInputError] = useState<string | null>(null)
  // The output stream can drop while the input path stays perfectly healthy —
  // they are different routes. Keystrokes still reach the shell, but nothing
  // echoes them back, so typing looks like it is going nowhere. Without this
  // the state is completely invisible; see the SSE handlers below.
  const [streamDown, setStreamDown] = useState(false)
  // Set when a reconnect replayed a backlog that had been trimmed at the front.
  // That replay can leave a live terminal showing nothing (see the 'backlog'
  // handler), so the pane offers an explicit way out instead of leaving the
  // only recovery as "close the browser tab", which is what it used to be.
  const [needsRepaint, setNeedsRepaint] = useState(false)
  const [repainting, setRepainting] = useState(false)
  const termRef = useRef<XTermTerminal | null>(null)
  const fitRef = useRef<XTermFitAddon | null>(null)
  const closedRef = useRef(false)
  const onCommandRef = useRef(onCommand)
  const onOutputRef = useRef(onOutput)
  // Serialize stdin writes. A separate fetch per keystroke can resolve out
  // of order during paste or fast typing; the PTY must receive bytes in order.
  const inputQueueRef = useRef(Promise.resolve())
  const inputSequenceRef = useRef(0)
  // Keystrokes typed while a request is in flight, sent as one batch.
  const pendingBatchRef = useRef<{
    data: string
    submits: boolean
    timing: KeystrokeSample | null
    sequence: number
  }>({ data: '', submits: false, timing: null, sequence: 0 })
  const coalesceTimerRef = useRef<number | null>(null)
  const inFlightRef = useRef(0)
  useEffect(() => {
    onCommandRef.current = onCommand
    onOutputRef.current = onOutput
  }, [onCommand, onOutput])

  // ─── "Explain last command" ────────────────────────────────────────
  // lineBufferRef reconstructs the command line from the keystroke stream
  // that's already flowing through term.onData → the PTY. It is NOT a second
  // history tracker — it's derived from the same input path, purely so the
  // "Explain" button knows what the last-submitted command was.
  const lineBufferRef = useRef('')
  const [lastCommand, setLastCommand] = useState('')
  const [explainOpen, setExplainOpen] = useState(false)
  const [explaining, setExplaining] = useState(false)
  const [explanation, setExplanation] = useState('')
  const [explainError, setExplainError] = useState<string | null>(null)
  // Last process exit code (shown as a header badge). Captured from the SSE
  // 'exit' event; reset when a new command is submitted or output resumes.
  const [exitCode, setExitCode] = useState<number | null>(null)

  const explain = useCallback(async () => {
    if (!lastCommand || explaining) return
    setExplainOpen(true)
    setExplaining(true)
    setExplanation('')
    setExplainError(null)
    try {
      const res = await fetch('/api/terminal/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: lastCommand }),
      })
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}))
        setExplainError(err?.error ?? `Explain failed (${res.status})`)
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        setExplanation((prev) => prev + decoder.decode(value, { stream: true }))
      }
    } catch (e) {
      setExplainError(e instanceof Error ? e.message : 'Explain request failed')
    } finally {
      setExplaining(false)
    }
  }, [lastCommand, explaining])

  useEffect(() => {
    closedRef.current = false
    let disposed = false
    let cleanup: (() => void) | undefined

    // xterm touches window/document at import time — load it lazily so SSR
    // (and the initial client render) doesn't crash.
    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ])
      if (disposed || !containerRef.current) return

      const term = new Terminal({
        cols: 80,
        rows: 24,
        cursorBlink: true,
        cursorStyle: 'bar',
        fontFamily: "'IBM Plex Mono', 'JetBrains Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
        fontSize: 12,
        lineHeight: 1.2,
        allowProposedApi: true,
        scrollback: 5000,
        theme: {
          background: '#080808',
          foreground: '#e5e5e5',
          cursor: '#3a9e60',
          cursorAccent: '#080808',
          selectionBackground: 'rgba(58, 158, 96, 0.25)',
          selectionInactiveBackground: 'rgba(58, 158, 96, 0.12)',
          black: '#080808',
          red: '#ff4d4d',
          green: '#3a9e60',
          yellow: '#ffb800',
          blue: '#3b82c4',
          magenta: '#c45b9e',
          cyan: '#3bb4c4',
          white: '#e5e5e5',
          brightBlack: '#525252',
          brightRed: '#ff7a7a',
          brightGreen: '#5cc77f',
          brightYellow: '#ffcf4d',
          brightBlue: '#6aa6d6',
          brightMagenta: '#d67fb5',
          brightCyan: '#6acdd6',
          brightWhite: '#ffffff',
        },
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.loadAddon(new WebLinksAddon())
      term.open(containerRef.current)
      termRef.current = term
      fitRef.current = fit

      // ─── Sizing ────────────────────────────────────────────────────
      // FitAddon.fit() is a silent no-op whenever proposeDimensions() can't
      // measure a cell — which happens if the renderer hasn't measured the
      // font yet. The old code was `try { fit.fit() } catch {}`, so that
      // no-op left the grid on the constructor's 80x24 (~577x384px) inside a
      // much larger pane, and swallowed every trace of why. That is the
      // "autoshrink" bug.
      //
      // DEFAULT_COLS/ROWS below must match the Terminal() options above.
      const DEFAULT_COLS = 80
      const DEFAULT_ROWS = 24
      // Below this the default grid is a plausible fit, so it isn't evidence
      // of failure; above it, 80x24 means fit() never applied.
      const SUSPICIOUS_WIDTH = 600

      const gridLooksStuck = () => {
        const el = containerRef.current
        if (!el) return false
        return (
          term.cols === DEFAULT_COLS &&
          term.rows === DEFAULT_ROWS &&
          el.getBoundingClientRect().width > SUSPICIOUS_WIDTH
        )
      }

      /** One fit attempt. True when the terminal ends up correctly sized. */
      const tryFit = (): boolean => {
        if (disposed || !containerRef.current) return true
        try {
          const proposed = fit.proposeDimensions()
          if (!proposed || !proposed.cols || !proposed.rows) return false
          fit.fit()
          return !gridLooksStuck()
        } catch {
          return false
        }
      }

      // Backs off rather than giving up after one shot: two animation frames
      // (cheap, covers the common "not measured yet" case), then widening
      // timeouts for a slow font or a pane still settling.
      // The PTY starts at 80x24 and only this call widens it, so a dropped
      // resize is not cosmetic — it decides how bash wraps every line.
      // Retries until the server confirms it landed.
      // Geometry the server has actually acknowledged, as "COLSxROWS". Distinct
      // from term.cols/term.rows, which is only what the browser believes.
      let confirmedGeometry = ''

      const RESIZE_RETRY_MS = [0, 250, 750, 2000]
      const pushResize = (cols: number, rows: number, attempt = 0): void => {
        if (disposed) return
        window.setTimeout(() => {
          if (disposed) return
          void sendResize(id, cols, rows).then((ok) => {
            if (ok) confirmedGeometry = `${cols}x${rows}`
            if (ok || disposed) return
            if (attempt + 1 < RESIZE_RETRY_MS.length) {
              pushResize(cols, rows, attempt + 1)
            } else {
              console.warn('[terminal-pane] PTY resize never confirmed', { id, cols, rows })
              setInputError('Terminal size could not be sent to the shell — output may wrap short. Try reopening the terminal.')
            }
          })
        }, RESIZE_RETRY_MS[attempt])
      }

      const RETRY_DELAYS_MS = [50, 150, 400]
      let fitAttempt = 0
      const scheduleFit = () => {
        if (disposed) return
        if (tryFit()) {
          pushResize(term.cols, term.rows)
          return
        }
        if (fitAttempt >= RETRY_DELAYS_MS.length + 2) {
          // Never fail silently again — this is the diagnostic that was
          // missing when the bug was first reported.
          const rect = containerRef.current?.getBoundingClientRect()
          console.warn(
            '[terminal-pane] fit() never succeeded — terminal may be mis-sized.',
            {
              id,
              container: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : 'gone',
              proposed: (() => {
                try {
                  return fit.proposeDimensions()
                } catch {
                  return undefined
                }
              })(),
              grid: `${term.cols}x${term.rows}`,
            },
          )
          return
        }
        const attempt = fitAttempt++
        if (attempt < 2) requestAnimationFrame(scheduleFit)
        else setTimeout(scheduleFit, RETRY_DELAYS_MS[attempt - 2])
      }
      scheduleFit()

      // IBM Plex Mono is an async webfont (next/font). If it lands after the
      // first fit, cell metrics change and the grid is stale — refit then.
      void document.fonts?.ready.then(() => {
        if (disposed) return
        fitAttempt = 0
        scheduleFit()
      })

      // Keystrokes → PTY. Also reconstruct the current command line from the
      // same stream so "Explain" knows the last-submitted command. Best-effort:
      // handles typing, backspace, Ctrl-U/Ctrl-C; bails on escape/arrow
      // sequences (we don't model mid-line cursor edits), which is fine for the
      // "type a command, hit enter, explain it" flow this targets.
      const onDataDisp = term.onData((data) => {
        onOutputRef.current?.()
        setExitCode(null) // new keystrokes mean a fresh command is in flight

        const sequence = ++inputSequenceRef.current
        const timing = keystrokeTiming.start(sequence, data)
        console.debug('[terminal chain] xterm → input queue', { id, sequence, bytes: data.length })

        // ─── Coalescing ────────────────────────────────────────────
        // Every keystroke used to become its own POST, chained onto the
        // previous one's promise. Ordering was correct, but the Nth character
        // could not leave the browser until N-1 round trips had completed, so
        // latency accumulated across a burst instead of being paid once.
        //
        // A burst is now one request. The first character of an idle burst
        // still leaves immediately — delaying that would ADD latency to the
        // case that already felt fine — and only characters typed while a
        // request is already in flight get batched behind it.
        const batch = pendingBatchRef.current
        batch.data += data
        // A TUI reads TIOCGWINSZ once at exec time, so a command submitted
        // before the resize handshake lands snapshots the 80x24 the PTY was
        // born at and paints into a corner of a much wider pane. Enter is the
        // only keystroke that can exec something, so it is the only one that
        // waits — and only when the server has not confirmed the current size.
        if (data.includes('\r') || data.includes('\n')) batch.submits = true
        // The batch is timed against its OLDEST character, which is the one
        // that has been waiting; crediting it with the newest keystroke's
        // clock would report a latency nobody experienced.
        if (!batch.timing) batch.timing = timing
        if (batch.sequence === 0) batch.sequence = sequence

        const flush = () => {
          if (coalesceTimerRef.current !== null) {
            window.clearTimeout(coalesceTimerRef.current)
            coalesceTimerRef.current = null
          }
          const payload = batch.data
          if (!payload) return
          const submits = batch.submits
          const batchTiming = batch.timing
          const batchSequence = batch.sequence
          batch.data = ''
          batch.submits = false
          batch.timing = null
          batch.sequence = 0

          inFlightRef.current += 1
          inputQueueRef.current = inputQueueRef.current
            .then(async () => {
              // Re-read inside the queue: an earlier Enter may already have
              // confirmed this geometry, and the grid may have changed since.
              const current = `${term.cols}x${term.rows}`
              if (!submits || disposed || confirmedGeometry === current) return
              if (await sendResize(id, term.cols, term.rows)) confirmedGeometry = current
            })
            .then(() => sendInput(id, payload, batchSequence, batchTiming))
            .then((reason) => {
              if (!disposed) setInputError(reason)
            })
            .catch(() => {})
            .finally(() => {
              inFlightRef.current -= 1
              // Anything typed while this was in flight is already waiting;
              // send it the moment the line clears rather than making it sit
              // out the rest of its coalescing window.
              if (inFlightRef.current === 0 && pendingBatchRef.current.data) flush()
            })
        }

        if (inFlightRef.current === 0) {
          flush()
        } else if (coalesceTimerRef.current === null) {
          // Bounded so a long-running request cannot hold keystrokes forever.
          coalesceTimerRef.current = window.setTimeout(flush, COALESCE_WINDOW_MS)
        }
        for (const ch of data) {
          if (ch === '\r' || ch === '\n') {
            const cmd = lineBufferRef.current.trim()
            lineBufferRef.current = ''
            if (cmd) {
              setLastCommand(cmd)
              onCommandRef.current?.(cmd)
            }
          } else if (ch === '\x7f' || ch === '\b') {
            lineBufferRef.current = lineBufferRef.current.slice(0, -1)
          } else if (ch === '\x15' || ch === '\x03') {
            lineBufferRef.current = '' // Ctrl-U (kill line) / Ctrl-C (abandon)
          } else if (ch === '\x1b') {
            break // escape / CSI sequence (arrows, etc.)
          } else if (ch >= ' ') {
            lineBufferRef.current += ch
          }
        }
      })

      // SSE: replay scrollback, then live output.
      const es = new EventSource(`/api/terminal/pty/${id}`, { withCredentials: true })

      // Every (re)connect may be a different lambda that just reattached to
      // the Sprite, so re-assert the geometry — nothing else does it, and a
      // reattach carries no cols/rows. Also refits, since the pane has
      // certainly been laid out by the time the stream is up.
      es.onopen = () => {
        if (disposed) return
        setStreamDown(false)
        fitAttempt = 0
        scheduleFit()
        pushResize(term.cols, term.rows)
      }
      // Sent once per connect, immediately before the replayed bytes.
      //
      // A truncated backlog is not just "some scrollback is missing". The head
      // is where a full-screen program's setup lives — the switch into the
      // alternate buffer and the first full paint — and the trim drops exactly
      // that while keeping the mid-stream frames that only make sense after it.
      // Replaying the remainder gives xterm cursor moves and clears against a
      // screen that was never established, which renders as solid black even
      // though the session is completely healthy and still taking input.
      //
      // xterm cannot repair this from the client: the program owns its output
      // and only repaints when it decides to. So ask the server to make it
      // redraw, and if that does not take, say so rather than leaving a black
      // rectangle and no explanation.
      es.addEventListener('backlog', (e) => {
        if (disposed) return
        try {
          const meta = JSON.parse((e as MessageEvent).data) as { truncated?: boolean }
          if (!meta.truncated) return
          // Clear first: the replay is about to write frames that assume a
          // screen state this terminal has never been in, and leaving the
          // fragments behind makes the result harder to read, not easier.
          term.reset()
          setNeedsRepaint(true)
          void requestRepaint(id).then((ok) => {
            if (!disposed && ok) setNeedsRepaint(false)
          })
        } catch {
          /* malformed meta — treat as a normal replay */
        }
      })

      // First byte of real output is the latest point at which layout is
      // guaranteed settled; cheap one-shot correction.
      let sawFirstOutput = false
      es.addEventListener('output', (e) => {
        onOutputRef.current?.()
        setStreamDown(false) // bytes arriving is the only proof the gap closed
        if (!sawFirstOutput) {
          sawFirstOutput = true
          fitAttempt = 0
          scheduleFit()
          pushResize(term.cols, term.rows)
        }
        try {
          const text = JSON.parse((e as MessageEvent).data) as string
          const echoed = keystrokeTiming.echo(text)
          console.debug('[terminal chain] transport → xterm', { id, bytes: text.length })
          // The callback fires once xterm has actually processed the chunk,
          // which is t4 — writes are queued internally, so timing the call
          // itself would measure enqueueing rather than painting.
          if (echoed) term.write(text, () => keystrokeTiming.painted(echoed))
          else term.write(text)
        } catch {
          /* malformed chunk */
        }
      })
      es.addEventListener('exit', (e) => {
        if (!disposed) {
          term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
        }
        try {
          const parsed = JSON.parse((e as MessageEvent).data) as { exitCode?: number }
          if (typeof parsed.exitCode === 'number') setExitCode(parsed.exitCode)
        } catch {
          /* malformed payload */
        }
      })
      es.onerror = () => {
        // EventSource reconnects on its own, so there is nothing to repair —
        // but the gap is not cosmetic. Keystrokes keep POSTing successfully to
        // a different route the whole time, and a PTY echoes typed characters
        // back through THIS stream rather than xterm drawing them locally. So
        // while this is down, typing is invisible even though every keystroke
        // lands, and the command runs normally on Enter. That is indisting-
        // uishable from a frozen UI unless it says so.
        //
        // On Vercel this is routine, not exceptional: the SSE route caps at
        // maxDuration 300, so the function is torn down and reconnected every
        // five minutes for as long as the pane is open.
        if (!disposed && es.readyState !== EventSource.OPEN) setStreamDown(true)
      }

      // Resize handling — debounce, since a split-layout reflow fires many.
      let resizeTimer: ReturnType<typeof setTimeout> | null = null
      const doFit = () => {
        if (disposed) return
        const before = `${term.cols}x${term.rows}`
        // Same retrying helper as mount, so a resize that arrives mid-layout
        // gets the same treatment instead of silently no-oping.
        fitAttempt = 0
        scheduleFit()
        if (`${term.cols}x${term.rows}` !== before) pushResize(term.cols, term.rows)
      }

      // Safety net, not the fix: if the grid is ever sitting on the default
      // while the pane is clearly bigger, something upstream failed — re-fit.
      // Measures the rendered result rather than the grid numbers: the grid can
      // be perfectly sized while the screen still under-fills its host, and the
      // 80x24 signature alone missed that. Stops once it settles so an idle
      // terminal isn't polling forever.
      const underFilled = () => {
        const screenEl = containerRef.current?.querySelector('.xterm-screen') as HTMLElement | null
        const hostEl = containerRef.current
        if (!screenEl || !hostEl) return false
        const s = screenEl.getBoundingClientRect()
        const h = hostEl.getBoundingClientRect()
        if (h.width < 50) return false // pane collapsed or hidden — nothing to fix
        return s.width < h.width * 0.9
      }

      let healChecks = 0
      const healTimer = setInterval(() => {
        if (disposed) return
        // A hidden pane is not healthy, it is unmeasurable. The Chat/Commands
        // switcher hides this whole subtree with display:none while leaving it
        // mounted, so both checks below read zero width and report "fine" —
        // three of those in six seconds used to clear this interval for good,
        // retiring the safety net exactly when a later reveal might need it.
        const hostWidth = containerRef.current?.getBoundingClientRect().width ?? 0
        if (hostWidth < 50) return
        if (gridLooksStuck() || underFilled()) {
          healChecks = 0
          fitAttempt = 0
          scheduleFit()
          pushResize(term.cols, term.rows)
          return
        }
        // Healthy for three consecutive checks — stand down.
        if (++healChecks >= 3) clearInterval(healTimer)
      }, 2000)
      const ro = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(doFit, 60)
      })
      ro.observe(containerRef.current)

      // Focus on mount + click.
      term.focus()
      const onClick = () => term.focus()
      containerRef.current.addEventListener('mousedown', onClick)

      cleanup = () => {
        clearInterval(healTimer)
        onDataDisp.dispose()
        // A coalesced batch still waiting on its timer would otherwise fire
        // after the terminal is gone, posting keystrokes to a dead session.
        if (coalesceTimerRef.current !== null) {
          window.clearTimeout(coalesceTimerRef.current)
          coalesceTimerRef.current = null
        }
        pendingBatchRef.current = { data: '', submits: false, timing: null, sequence: 0 }
        containerRef.current?.removeEventListener('mousedown', onClick)
        ro.disconnect()
        if (resizeTimer) clearTimeout(resizeTimer)
        es.close()
        term.dispose()
        termRef.current = null
        fitRef.current = null
      }
    })()

    return () => {
      disposed = true
      cleanup?.()
      cleanup = undefined
    }
  }, [id])

  useEffect(() => {
    if (clearSignal > 0) termRef.current?.clear()
  }, [clearSignal])

  const handleClose = () => {
    if (closedRef.current) return
    closedRef.current = true
    onClose()
  }

  return (
    // flex-1 is load-bearing: the parent in drive-terminal-workspace is a row
    // flex container, so without it this is `flex: 0 1 auto` and sizes to the
    // toolbar's max-content — roughly a quarter of a wide workspace, with the
    // rest left black. min-w-0 lets it shrink below that content width when a
    // split gets narrow, instead of overflowing its share.
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-[#080808]">
      <div className="flex items-center justify-between border-b border-border bg-surface-secondary px-2.5 py-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`h-2 w-2 flex-shrink-0 rounded-full ${status === 'active' ? 'animate-pulse bg-primary' : 'bg-muted-foreground/50'}`} />
          <span className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {name}{cwd ? ` · ${cwd.replace(/^\/workspaces\/[^/]+/, '.')}` : ''}
          </span>
          {exitCode !== null && (
            <span
              title="Last process exit code"
              className={`flex-shrink-0 rounded px-1 py-px font-mono text-[9px] tabular-nums ${
                exitCode === 0 ? 'bg-primary/10 text-primary/80' : 'bg-warning/15 text-warning'
              }`}
            >
              {exitCode === 0 ? 'exit 0' : `exit ${exitCode}`}
            </span>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          <button onClick={onSplitVertical} title="Split vertically" className="rounded p-1 text-muted-foreground/70 hover:bg-primary/10 hover:text-primary"><Columns2 className="h-3 w-3" /></button>
          <button onClick={onSplitHorizontal} title="Split horizontally" className="rounded p-1 text-muted-foreground/70 hover:bg-primary/10 hover:text-primary"><Rows2 className="h-3 w-3" /></button>
          <button onClick={onDuplicate} title="Duplicate terminal" className="rounded p-1 text-muted-foreground/70 hover:bg-primary/10 hover:text-primary"><Copy className="h-3 w-3" /></button>
          <button onClick={onRename} title="Rename terminal" className="rounded p-1 text-muted-foreground/70 hover:bg-primary/10 hover:text-primary"><Pencil className="h-3 w-3" /></button>
          <button onClick={onRestart} title="Restart terminal" className="rounded p-1 text-muted-foreground/70 hover:bg-primary/10 hover:text-primary"><RotateCcw className="h-3 w-3" /></button>
          <button onClick={onKill} title="Kill running process" className="rounded p-1 text-muted-foreground/70 hover:bg-warning/10 hover:text-warning"><Square className="h-3 w-3" /></button>
          <button onClick={onClear} title="Clear terminal" className="rounded p-1 text-muted-foreground/70 hover:bg-primary/10 hover:text-primary"><Eraser className="h-3 w-3" /></button>
          <button onClick={onMaximize} title={isMaximized ? 'Restore terminal layout' : 'Maximize terminal'} className="rounded p-1 text-muted-foreground/70 hover:bg-primary/10 hover:text-primary">{isMaximized ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}</button>
          <button onClick={onMoveToPane} title="Move terminal to a new pane" className="rounded p-1 text-muted-foreground/70 hover:bg-primary/10 hover:text-primary"><Columns2 className="h-3 w-3" /></button>
          <button onClick={onCollapse} title="Collapse pane" className="rounded p-1 text-muted-foreground/70 hover:bg-primary/10 hover:text-primary"><Minimize2 className="h-3 w-3" /></button>
          <button
            onClick={explain}
            disabled={!lastCommand || explaining}
            title={lastCommand ? `Explain last command: ${lastCommand}` : 'Run a command first, then explain it'}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70 transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-30"
          >
            {explaining ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            Explain
          </button>
          <button
            onClick={onClosePane}
            title="Close pane"
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <Rows2 className="h-3 w-3" />
          </button>
          <button
            onClick={handleClose}
            title="Close terminal"
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
      {streamDown && (
        <div
          role="status"
          className="flex shrink-0 items-start gap-1.5 border-b border-warning/30 bg-warning/10 px-2.5 py-1 font-mono text-[10px] leading-relaxed text-warning"
        >
          <span className="mt-[1px] shrink-0 animate-pulse" aria-hidden="true">&#9679;</span>
          <span className="min-w-0 flex-1">
            Output stream reconnecting — keystrokes are still reaching the shell, but nothing will
            echo back until it resumes.
          </span>
        </div>
      )}
      {needsRepaint && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-1.5 border-b border-warning/30 bg-warning/10 px-2.5 py-1 font-mono text-[10px] leading-relaxed text-warning"
        >
          <span className="mt-[1px] shrink-0" aria-hidden="true">&#9888;</span>
          <span className="min-w-0 flex-1">
            This terminal reconnected with part of its history missing, so the screen may be
            blank or stale. The session itself is fine — typing still reaches it.
          </span>
          <button
            type="button"
            disabled={repainting}
            onClick={async () => {
              setRepainting(true)
              const ok = await requestRepaint(id)
              setRepainting(false)
              if (ok) setNeedsRepaint(false)
              // Failed repaint means no live session behind this pane. Say what
              // will actually work rather than repeating a suggestion that just
              // demonstrably didn't.
              else setInputError('Could not redraw — the session is gone. Restart the terminal.')
            }}
            className="shrink-0 rounded border border-warning/40 px-1.5 py-0.5 uppercase tracking-wider transition-colors hover:bg-warning/20 disabled:opacity-50"
          >
            {repainting ? 'Redrawing…' : 'Redraw'}
          </button>
          <button
            type="button"
            onClick={onRestart}
            title="Restart this terminal — ends the running process"
            className="shrink-0 rounded border border-warning/40 px-1.5 py-0.5 uppercase tracking-wider transition-colors hover:bg-warning/20"
          >
            Restart
          </button>
        </div>
      )}
      {inputError && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-1.5 border-b border-destructive/30 bg-destructive/10 px-2.5 py-1 font-mono text-[10px] leading-relaxed text-destructive"
        >
          <span className="mt-[1px] shrink-0" aria-hidden="true">&#9888;</span>
          <span className="min-w-0 flex-1">{inputError}</span>
          {/* The message has always said "restart the terminal"; this makes that
              a thing you can click. Without it the instruction is accurate and
              useless — the restart control is one of eleven unlabelled icons. */}
          {/session was lost|session is gone/i.test(inputError) && (
            <button
              type="button"
              onClick={() => {
                setInputError(null)
                onRestart?.()
              }}
              className="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 uppercase tracking-wider transition-colors hover:bg-destructive/20"
            >
              Restart
            </button>
          )}
          <button
            type="button"
            onClick={() => setInputError(null)}
            aria-label="Dismiss terminal input error"
            className="shrink-0 text-destructive/60 transition-colors hover:text-destructive"
          >
            &times;
          </button>
        </div>
      )}
      <div ref={containerRef} className="min-h-0 flex-1 px-1 py-1" />

      {/* On-demand, Feynman-style explanation of the last command. Inline and
          collapsible so it never disrupts the terminal's own flow. */}
      {explainOpen && (
        <div className="flex max-h-[45%] min-h-0 flex-col border-t border-primary/20 bg-surface-base">
          <div className="flex flex-shrink-0 items-center justify-between border-b border-border/60 px-2.5 py-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <Sparkles className="h-3 w-3 flex-shrink-0 text-primary" />
              <span className="font-mono text-[9px] uppercase tracking-wider text-primary/80">Explain</span>
              {lastCommand && (
                <code className="truncate font-mono text-[10px] text-muted-foreground/80">{lastCommand}</code>
              )}
            </div>
            <button
              onClick={() => setExplainOpen(false)}
              title="Collapse explanation"
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:text-foreground"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hidden px-3 py-2">
            {explainError ? (
              <p className="font-mono text-[10px] text-destructive">{explainError}</p>
            ) : (
              <p className="whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-foreground/90">
                {explanation}
                {explaining && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-primary/70 align-middle" />}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Send a keystroke, and report why it failed if it did.
 *
 * This used to await the fetch and throw the response away. xterm echoes
 * locally, so a dropped keystroke still appeared on screen and the terminal
 * looked alive while nothing reached the shell — which is precisely why "can't
 * type" was so hard to pin down. Returns null on success, else a message the
 * pane shows inline.
 */
async function sendInput(
  id: string,
  data: string,
  sequence: number,
  timing?: KeystrokeSample | null,
): Promise<string | null> {
  console.debug('[terminal chain] input queue → transport', { id, sequence, bytes: data.length })
  try {
    if (timing) timing.dispatch = performance.now() - timing.t0
    const response = await fetch(`/api/terminal/pty/${id}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    })
    if (timing) {
      timing.response = performance.now() - timing.t0
      // The server's own phase breakdown, riding back on the same request that
      // carried this keystroke — no cross-log correlation required.
      const header = response.headers.get('Server-Timing')
      if (header) {
        timing.server = Object.fromEntries(
          header.split(',').map((part) => {
            const [name, dur] = part.trim().split(';dur=')
            return [name, Number(dur)]
          }),
        )
      }
    }
    const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    console.debug('[terminal chain] transport → PTY stdin', { id, sequence, status: response.status, ok: result.ok === true })

    if (response.ok && result.ok === true) return null

    // Each failure class gets its own message — they have different fixes and
    // used to be indistinguishable from the UI.
    if (response.status === 503 && /OWNER_EMAIL/i.test(result.error ?? '')) {
      return 'Cloud terminals are not configured — OWNER_EMAIL is not set on the deployment.'
    }
    if (response.status === 503) {
      return result.error || 'Terminal backend unavailable (503).'
    }
    if (response.status === 403) {
      return 'This account is not the terminal owner — cloud terminals are owner-only.'
    }
    if (response.status === 401) {
      return 'Session expired — reload and sign in again.'
    }
    if (response.ok && result.ok === false) {
      return 'Input dropped — the terminal session was lost. Restart the terminal.'
    }
    return `Input failed (HTTP ${response.status}).`
  } catch (error) {
    console.error('[terminal chain] transport failed', { id, sequence, error: error instanceof Error ? error.message : String(error) })
    return 'Terminal backend unreachable — check your connection.'
  }
}

/**
 * Ask the server to make the running program repaint.
 *
 * Separate from sendResize because the pane's size is not what's wrong — the
 * screen is. See the repaint route for why this cannot be done client-side.
 */
async function requestRepaint(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/terminal/pty/${id}/repaint`, { method: 'POST' })
    if (!res.ok) return false
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean }
    return body.ok === true
  } catch {
    return false
  }
}

/**
 * Push the rendered geometry to the remote PTY. Returns false if it didn't
 * land, so the caller can retry.
 *
 * This used to swallow the result. The PTY is created at 80x24 before xterm
 * exists, so this call is the ONLY thing that ever widens it — when it failed
 * silently, bash kept wrapping at 80 columns inside a full-width pane and the
 * output filled about a third of it. That looked like the terminal was small;
 * it wasn't, the shell was.
 */
async function sendResize(id: string, cols: number, rows: number): Promise<boolean> {
  try {
    const res = await fetch(`/api/terminal/pty/${id}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols, rows }),
    })
    if (!res.ok) return false
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean }
    return body.ok !== false
  } catch {
    return false
  }
}
