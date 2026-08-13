import type { IPty } from 'node-pty'
import { randomUUID } from 'crypto'

// PTY session manager for Drive's real-shell terminal panes.
//
// Each terminal pane in the Drive UI is backed by a real PTY (node-pty)
// running an interactive login bash shell in the Codespace/container. This
// gives the user a genuine shell where they can run gemini, freebuff,
// opencode, or any other CLI — not a sandboxed/LLM-mediated pseudo-shell.
//
// Sessions live in module-level state for the lifetime of the Node process.
// A modest scrollback buffer is kept per session so that briefly disconnecting
// the SSE stream (e.g. React Strict Mode double-mount in dev, or tabbing away
// and back) doesn't lose output. A reaper kills long-idle orphaned sessions
// to avoid leaking PTYs when a browser closes without sending DELETE.

export interface PTYSession {
  id: string
  pty: IPty
  cols: number
  rows: number
  cwd: string
  createdAt: number
  lastWriteAt: number
  /** Chunked scrollback, trimmed to MAX_SCROLLBACK_BYTES. */
  scrollback: string[]
  scrollbackBytes: number
  /**
   * Whether anything has ever been trimmed off the FRONT of the scrollback.
   *
   * This matters far more than it looks. Trimming drops whole chunks from the
   * head, so a full-screen TUI's setup — `\x1b[?1049h` to enter the alternate
   * buffer, and the first full paint — is exactly what gets thrown away first,
   * while the mid-stream frames that only make sense relative to it survive.
   * Replaying that to a fresh xterm produces cursor moves and `\x1b[2J` clears
   * with no screen ever set up: a black terminal with a live cursor.
   */
  scrollbackTruncated: boolean
  /** Live SSE subscribers. */
  dataListeners: Set<(data: string) => void>
  exitListeners: Set<(exitCode: number, signal?: number) => void>
  exited: boolean
}

const MAX_SCROLLBACK_BYTES = 256 * 1024 // 256 KiB per session
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000 // kill after 30 min with no listeners + no writes
const REAPER_INTERVAL_MS = 5 * 60 * 1000

const sessions = new Map<string, PTYSession>()

function defaultShell(): { file: string; args: string[] } {
  // Interactive login bash — sources the Codespace profiles so PATH includes
  // nvm/global-installed CLIs (gemini, freebuff, opencode, ...). Matches what
  // the tmux workspace shells see.
  const shell = process.env.SHELL || '/bin/bash'
  return { file: shell, args: ['-l', '-i'] }
}

export async function createSession(opts?: {
  cols?: number
  rows?: number
  cwd?: string
}): Promise<PTYSession> {
  const cols = opts?.cols ?? 80
  const rows = opts?.rows ?? 24
  const cwd = opts?.cwd ?? process.env.HOME ?? process.cwd()
  const { file, args } = defaultShell()

  // Dynamic import (not a top-level static import) so a native-addon load
  // failure — node-pty is a compiled C++ binding, and this session saw
  // repeated pnpm add/remove churn on it — rejects this promise instead of
  // crashing module evaluation for the whole route before the handler's
  // try/catch ever runs. A static `import { spawn } from 'node-pty'` at the
  // top of this file would throw at import time, which is NOT catchable by
  // route.ts's try/catch around this call.
  const { spawn } = await import('node-pty')

  const id = randomUUID()
  const pty = spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      // Drive PTYs are explicitly interactive shells.
      TERM: 'xterm-256color',
      // Disambiguate from the tmux workspace shells if anyone inspects env.
      ENRY_PANE: '1',
    },
  })

  const session: PTYSession = {
    id,
    pty,
    cols,
    rows,
    cwd,
    createdAt: Date.now(),
    lastWriteAt: Date.now(),
    scrollback: [],
    scrollbackBytes: 0,
    scrollbackTruncated: false,
    dataListeners: new Set(),
    exitListeners: new Set(),
    exited: false,
  }

  pty.onData((data) => {
    console.debug('[terminal chain] PTY stdout → transport', { id, bytes: data.length })
    session.scrollback.push(data)
    session.scrollbackBytes += data.length
    trimScrollback(session)
    // Snapshot to array — a listener might remove itself during dispatch.
    const listeners = Array.from(session.dataListeners)
    for (const fn of listeners) {
      try {
        fn(data)
      } catch {
        // Listener threw — drop it so one bad subscriber can't kill the PTY.
        session.dataListeners.delete(fn)
      }
    }
  })

  pty.onExit(({ exitCode, signal }) => {
    session.exited = true
    for (const fn of Array.from(session.exitListeners)) {
      try {
        fn(exitCode, signal)
      } catch {
        /* ignore */
      }
    }
    // Give SSE readers a moment to flush the exit, then reap.
    setTimeout(() => {
      try {
        pty.kill()
      } catch {
        /* already gone */
      }
      sessions.delete(id)
    }, 2000)
  })

  sessions.set(id, session)
  return session
}

function trimScrollback(session: PTYSession) {
  while (session.scrollbackBytes > MAX_SCROLLBACK_BYTES && session.scrollback.length > 1) {
    const chunk = session.scrollback.shift()!
    session.scrollbackBytes -= chunk.length
    session.scrollbackTruncated = true
  }
}

export function getSession(id: string): PTYSession | undefined {
  return sessions.get(id)
}

export function writeInput(id: string, data: string): boolean {
  const session = sessions.get(id)
  if (!session || session.exited) return false
  try {
    session.pty.write(data)
    console.debug('[terminal chain] transport → shell stdin', { id, bytes: data.length })
    session.lastWriteAt = Date.now()
    return true
  } catch {
    return false
  }
}

export function resizeSession(id: string, cols: number, rows: number): boolean {
  const session = sessions.get(id)
  if (!session || session.exited) return false
  // Clamp to sane bounds — xterm.js can emit 0 cols/rows during collapse.
  const c = Math.max(1, Math.min(400, Math.floor(cols)))
  const r = Math.max(1, Math.min(200, Math.floor(rows)))
  if (c === session.cols && r === session.rows) return true
  try {
    session.pty.resize(c, r)
    session.cols = c
    session.rows = r
    return true
  } catch {
    return false
  }
}

/**
 * How long the nudged geometry is held before the real one is restored.
 *
 * Two SIGWINCHes is not enough on its own: a TUI reads the window size when
 * it gets round to handling the signal, and if both have landed by then it
 * reads the size it already had and concludes nothing changed. Measured
 * against a real OpenCode 1.18 session in a real PTY, holding for 50, 60, 70,
 * 80 or 90ms produced ZERO bytes of output; 100ms and above produced a full
 * ~7KB repaint every time. The previous value here was 50ms, which is why the
 * documented repair for a truncated backlog never actually repaired anything
 * for OpenCode. 250ms buys margin over the observed 90-100ms cliff without
 * being long enough to see as a flicker.
 */
const REPAINT_NUDGE_HOLD_MS = 250
/** How long to watch for the repaint the nudge was supposed to provoke. */
const REPAINT_OBSERVE_MS = 1500

/**
 * Make whatever is running repaint its screen.
 *
 * There is no escape sequence that means "redraw yourself" — a full-screen
 * program owns its own output and only repaints when it decides to. The one
 * signal that reliably provokes one is SIGWINCH, which every TUI handles
 * because it has to re-layout.
 *
 * Hence the deliberate jiggle. resizeSession early-returns when the geometry
 * is unchanged (correctly — it avoids pointless churn), so re-asserting the
 * SAME size after a reconnect delivers no signal at all. That is precisely the
 * gap that leaves a reattached TUI sitting on a screen it will never redraw.
 * Shrinking by one column and restoring forces two real SIGWINCHes and ends on
 * the geometry the caller asked for.
 *
 * `repainted` is observed, not assumed. Reporting success on a nudge that
 * provoked nothing is what let the client clear its "screen may be stale"
 * banner and leave a black rectangle with no explanation.
 */
export async function forceRepaint(id: string): Promise<{ ok: boolean; repainted: boolean }> {
  const session = sessions.get(id)
  if (!session || session.exited) return { ok: false, repainted: false }
  const { cols, rows } = session
  if (cols <= 1) return { ok: false, repainted: false }
  if (!resizeSession(id, cols - 1, rows)) return { ok: false, repainted: false }

  let repainted = false
  const watch = () => {
    repainted = true
  }
  session.dataListeners.add(watch)
  try {
    await delay(REPAINT_NUDGE_HOLD_MS)
    resizeSession(id, cols, rows)
    await delay(REPAINT_OBSERVE_MS)
  } finally {
    session.dataListeners.delete(watch)
  }
  return { ok: true, repainted }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function killSession(id: string): boolean {
  const session = sessions.get(id)
  if (!session) return false
  if (!session.exited) {
    try {
      session.pty.kill()
    } catch {
      /* ignore */
    }
  }
  sessions.delete(id)
  return true
}

/** Subscribe to live PTY output. Returns an unsubscribe fn. */
export function subscribe(
  id: string,
  onData: (data: string) => void,
  onExit?: (exitCode: number, signal?: number) => void,
): () => void {
  const session = sessions.get(id)
  if (!session) return () => {}
  session.dataListeners.add(onData)
  if (onExit) session.exitListeners.add(onExit)
  return () => {
    session.dataListeners.delete(onData)
    if (onExit) session.exitListeners.delete(onExit)
  }
}

/** Full scrollback as a single string (replayed on SSE connect). */
export function getScrollback(id: string): string {
  const session = sessions.get(id)
  if (!session) return ''
  return session.scrollback.join('')
}

/**
 * Whether this session's replay is missing its head.
 *
 * The client needs to know, because a truncated replay cannot be trusted to
 * leave the screen in a coherent state and the only reliable repair is to make
 * the running program repaint itself. See the client's handling of the
 * `backlog` event.
 */
export function isScrollbackTruncated(id: string): boolean {
  return sessions.get(id)?.scrollbackTruncated ?? false
}

// ─── Reaper ─────────────────────────────────────────────────
// Kills sessions that have no live listeners AND haven't received input in a
// while. Guards against orphaned PTYs when a browser closes abruptly.

let reaperTimer: NodeJS.Timeout | null = null

function reap() {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (session.exited) {
      sessions.delete(id)
      continue
    }
    const idle = now - session.lastWriteAt
    if (session.dataListeners.size === 0 && idle > SESSION_IDLE_TTL_MS) {
      try {
        session.pty.kill()
      } catch {
        /* ignore */
      }
      sessions.delete(id)
    }
  }
}

export function ensureReaper(): void {
  if (reaperTimer) return
  reaperTimer = setInterval(reap, REAPER_INTERVAL_MS)
  // Don't keep the process alive just for the reaper.
  if (reaperTimer && typeof reaperTimer.unref === 'function') {
    reaperTimer.unref()
  }
}

ensureReaper()
