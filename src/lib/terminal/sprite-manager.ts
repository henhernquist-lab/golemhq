import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import {
  persistSession,
  loadSession,
  updateSpriteSessionId,
  touchSession,
  markExited,
  deleteSession as deleteStoredSession,
} from './session-store'

// Cloud-terminal session manager — the deployed counterpart to pty-manager.ts.
//
// On Vercel, serverless functions can't hold a long-lived PTY. We route
// terminal panes to a Fly.io Sprite, which is a persistent Linux VM that
// hibernates when idle and wakes on demand (~1s). Each Drive pane is a TTY
// `bash` exec session on that VM; the WS ↔ SSE bridge in the route files
// keeps the browser wire format byte-identical to the Codespace node-pty
// path so terminal-pane.tsx never knows which backend it's talking to.
//
// Identical exported surface to pty-manager.ts:
//   createSession / getSession / writeInput / resizeSession
//   killSession / subscribe / getScrollback
// The route files pick which manager to call based on `process.env.VERCEL`.
//
// ─── Why a server-side WS instead of browser→Sprites direct ──────────────
// Sprites auth is a single org-level `Authorization: Bearer <SPRITES_TOKEN>`
// header (sprites.dev/api). The browser WebSocket API can't set headers, so
// direct browser→Sprites would require putting the org token in a URL query
// string — which leaks it in CDN/proxy/referrer logs. That violates the
// "token server-side only" requirement. So we open the WS from inside the
// Next.js route, where the server-side env var is safe to read. The cost is
// Vercel's function duration cap: SSE resyncs every few minutes. The existing
// EventSource auto-reconnect + this manager's getScrollback() make that
// graceful (terminal blanks ~1s then resumes — same UX as a Codespace tab-away).
//
// ─── Sprites exec wire format (sprites.dev/api/sprites/exec) ────────────
// WSS /sprites/{name}/exec?cmd=bash&tty=true&stdin=true&cols=&rows=
//   Binary frames:  raw PTY bytes (TTY mode). c→s = stdin, s→c = stdout.
//   Text frames (JSON):
//     {"type":"session_info","session_id":"..."}    — server→client on connect
//     {"type":"resize","cols":n,"rows":n}            — client→server onResize
//     {"type":"exit","exit_code":n}                  — server→client on process death
// Sessions persist across WS disconnects (TTY default max_run_after_disconnect=0
// = forever), and reattaching via WSS /sprites/{name}/exec/{session_id}
// replays server-side scrollback immediately.
//
// ─── Owner isolation ────────────────────────────────────────────────────
// A single Sprite hosts ALL of Henry's panes. Only Henry can reach this
// manager — every route hard-gates via requireHenryOwner() in src/lib/auth-owner.ts
// BEFORE calling any method here. No other user's request can ever reach
// createSession/writeInput/etc. The sprite itself is owned by the
// SPRITES_TOKEN's Fly organization, which is Henry's.

const SPRITES_BASE = 'https://api.sprites.dev/v1'
const SPRITES_WSS_BASE = 'wss://api.sprites.dev/v1'
const MAX_SCROLLBACK_BYTES = 256 * 1024 // 256 KiB — matches pty-manager
const REAPER_INTERVAL_MS = 5 * 60 * 1000

export interface SpriteSession {
  /** Local opaque id returned to the browser; used in the SSE route URLs. */
  id: string
  /** Name of the underlying Sprite VM on Fly. */
  spriteName: string
  /** Sprites-side exec session id (captured from `session_info`). */
  spriteSessionId: string | null
  cols: number
  rows: number
  createdAt: number
  lastWriteAt: number
  /** Chunked scrollback, trimmed to MAX_SCROLLBACK_BYTES. */
  scrollback: string[]
  scrollbackBytes: number
  /**
   * Whether anything has been trimmed off the FRONT. Same meaning and same
   * consequence as pty-manager's flag: the head is where a full-screen TUI's
   * `\x1b[?1049h` and first paint live, so a truncated replay can leave a
   * reattached terminal black. See forceRepaint.
   */
  scrollbackTruncated: boolean
  /** Live SSE subscribers. */
  dataListeners: Set<(data: string) => void>
  exitListeners: Set<(exitCode: number, signal?: number) => void>
  exited: boolean
  /** Underlying WS to Sprites, when up. May be null during a resync gap. */
  ws: WebSocket | null
  /** Set true once the WS has finished its initial handshake, to distinguish
   *  a real post-connect error from a never-connected-WS being closed. */
  ready: boolean
}

const sessions = new Map<string, SpriteSession>()

function envConfig(): { token: string; spriteName: string } {
  const token = process.env.SPRITES_TOKEN ?? ''
  const spriteName = process.env.SPRITE_NAME ?? 'enry-terminal'
  return { token, spriteName }
}

function trimScrollback(session: SpriteSession) {
  while (session.scrollbackBytes > MAX_SCROLLBACK_BYTES && session.scrollback.length > 1) {
    const chunk = session.scrollback.shift()!
    session.scrollbackBytes -= chunk.length
    session.scrollbackTruncated = true
  }
}

// ─── Sprite VM lifecycle ───────────────────────────────────────────────
// One persistent Sprite hosts all of Henry's panes. Created idempotently on
// first pane; subsequent panes spawn new exec sessions on the same VM.
// A 409 on create (already exists) is the happy path on every call after the
// first, so it's swallowed.

async function ensureSprite(token: string, spriteName: string): Promise<void> {
  const res = await fetch(`${SPRITES_BASE}/sprites/${encodeURIComponent(spriteName)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.ok) return // already exists

  if (res.status !== 404) {
    const body = await res.text().catch(() => '')
    throw new Error(`Sprite lookup failed (${res.status}): ${body.slice(0, 200)}`)
  }

  const createRes = await fetch(`${SPRITES_BASE}/sprites`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: spriteName }),
  })
  if (createRes.ok || createRes.status === 409) return
  const body = await createRes.text().catch(() => '')
  throw new Error(`Sprite create failed (${createRes.status}): ${body.slice(0, 200)}`)
}

// ─── WS lifecycle ───────────────────────────────────────────────────────

function buildExecUrl(spriteName: string, cols: number, rows: number): string {
  const name = encodeURIComponent(spriteName)
  const cmd = encodeURIComponent('bash')
  // TTY mode = raw binary frames xterm.js can write directly. stdin=true lets
  // the browser's keystrokes flow through. TTY default
  // max_run_after_disconnect=0 (forever) — the shell survives WS disconnects.
  return `${SPRITES_WSS_BASE}/sprites/${name}/exec?cmd=${cmd}&tty=true&stdin=true&cols=${cols}&rows=${rows}`
}

function buildAttachUrl(spriteName: string, spriteSessionId: string): string {
  const name = encodeURIComponent(spriteName)
  const sid = encodeURIComponent(spriteSessionId)
  return `${SPRITES_WSS_BASE}/sprites/${name}/exec/${sid}`
}

function openSession(
  session: SpriteSession,
  token: string,
  spriteName: string,
  attachTo?: string,
): WebSocket {
  const url =
    attachTo != null
      ? buildAttachUrl(spriteName, attachTo)
      : buildExecUrl(spriteName, session.cols, session.rows)

  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
    // Sprites' WSS may take a moment to warm a cold Sprite; a liberal timeout
    // here avoids tearing down a session that's simply waiting on first boot.
    handshakeTimeout: 30_000,
  })

  ws.binaryType = 'arraybuffer'

  ws.on('open', () => {
    session.ready = true
    session.ws = ws
    // Push the geometry we believe in as soon as the pipe exists. Two cases
    // this covers, both of which left bash wrapping at 80 columns inside a
    // wide pane: a resize that arrived while the WS was still connecting (see
    // resizeSession), and a reattach — buildAttachUrl carries no cols/rows, so
    // a rehydrated session would otherwise keep whatever size it was created
    // with, forever.
    if (session.cols > 0 && session.rows > 0) {
      try {
        ws.send(JSON.stringify({ type: 'resize', cols: session.cols, rows: session.rows }))
      } catch (err) {
        console.error('[sprite-manager] initial resize push failed:', err)
      }
    }
  })

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      // JSON text control frame. Parse and handle session_info / exit.
      let msg: { type?: string; session_id?: string; exit_code?: number }
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
      } catch {
        return
      }
      if (msg.type === 'session_info' && msg.session_id) {
        session.spriteSessionId = msg.session_id
        // Without this persisted, a rehydrating instance can't reattach and
        // would spawn a second shell — losing scrollback and running jobs.
        void updateSpriteSessionId(session.id, msg.session_id)
      } else if (msg.type === 'exit') {
        session.exited = true
        void markExited(session.id)
        const code = typeof msg.exit_code === 'number' ? msg.exit_code : 0
        for (const fn of Array.from(session.exitListeners)) {
          try {
            fn(code)
          } catch {
            /* ignore */
          }
        }
        // Give SSE readers a moment to flush, then close the WS.
        setTimeout(() => {
          try {
            ws.close()
          } catch {
            /* already gone */
          }
        }, 2000)
      }
      return
    }

    // Binary frame = raw PTY bytes (TTY mode). Buffer into scrollback and fan
    // out to live SSE subscribers. Decoding as utf-8 here is lossy for binary
    // output but matches what pty-manager does (it holds string scrollback and
    // SSE emits JSON-stringified chunks — the xterm.js side re-encodes). PTY
    // output is overwhelmingly utf-8-compatible ANSI text in practice; the
    // rare non-utf-8 bytes survive the round trip because xterm.js writes them
    // verbatim and JS string round-trips them through code-unit boundaries.
    let text: string
    if (typeof data === 'string') {
      text = data
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString('utf8')
    } else if (Array.isArray(data)) {
      text = Buffer.concat(data.map((b) => Buffer.from(b as Uint8Array))).toString('utf8')
    } else {
      text = (data as Buffer).toString('utf8')
    }

    session.scrollback.push(text)
    session.scrollbackBytes += text.length
    trimScrollback(session)

    for (const fn of Array.from(session.dataListeners)) {
      try {
        fn(text)
      } catch {
        session.dataListeners.delete(fn)
      }
    }
  })

  const handleDead = () => {
    if (session.ws === ws) session.ws = null
    session.ready = false
    // If the bash process is still alive server-side (almost always true on
    // a resync — TTY sessions live forever after disconnect), a fresh WS
    // attach will succeed on the next interaction. Don't mark exited here:
    // only the explicit "exit" control frame sets that.
  }

  ws.on('close', handleDead)
  ws.on('error', (err) => {
    console.error('[sprite-manager] WS error:', err.message)
    handleDead()
  })

  return ws
}

// ─── Public surface (mirrors pty-manager.ts) ────────────────────────────

export interface CreateSessionOpts {
  cols?: number
  rows?: number
  cwd?: string
}

/**
 * Spawn a new bash exec session on the owner's persistent Sprite.
 *
 * `cwd` is accepted (for API parity with pty-manager) but ignored on the
 * cloud path — Sprites' exec starts in the VM's working directory and
 * window-managed `cd` happens naturally in the shell.
 */
export async function createSession(
  opts?: CreateSessionOpts,
): Promise<SpriteSession> {
  const { token, spriteName } = envConfig()
  if (!token) {
    throw new Error('SPRITES_TOKEN is not set — cloud terminals are disabled.')
  }

  await ensureSprite(token, spriteName)

  const cols = opts?.cols ?? 80
  const rows = opts?.rows ?? 24
  const id = randomUUID()

  const session: SpriteSession = {
    id,
    spriteName,
    spriteSessionId: null,
    cols,
    rows,
    createdAt: Date.now(),
    lastWriteAt: Date.now(),
    scrollback: [],
    scrollbackBytes: 0,
    scrollbackTruncated: false,
    dataListeners: new Set(),
    exitListeners: new Set(),
    exited: false,
    ws: null,
    ready: false,
  }

  const ws = openSession(session, token, spriteName)
  session.ws = ws

  // Wait for the handshake so a missing token / unreachable Sprites surfaces
  // here (and to the route's caller) as a real error rather than a deferred
  // WS close that the user never sees. If the WS connects but we never get a
  // session_info frame, the session is still usable — spriteSessionId is
  // nullable and reattach gracefully falls back to a fresh exec.
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.off('error', onError)
      resolve()
    }
    const onError = (err: Error) => {
      ws.off('open', onOpen)
      reject(new Error(`Sprites WS connect failed: ${err.message}`))
    }
    ws.once('open', onOpen)
    ws.once('error', onError)
  }).catch((err) => {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    sessions.delete(id)
    throw err
  })

  sessions.set(id, session)
  // Durable index, so a later invocation on a different lambda can find and
  // reattach to this session instead of dropping the user's keystrokes.
  await persistSession({ id, spriteName, spriteSessionId: session.spriteSessionId, cols, rows, exited: false })
  return session
}

export function getSession(id: string): SpriteSession | undefined {
  return sessions.get(id)
}

/** How long to wait for a rehydrated WS to finish its handshake. */
const REATTACH_TIMEOUT_MS = 15_000

/**
 * Find a session on THIS instance, rebuilding it from the durable store if
 * this lambda has never seen it.
 *
 * The whole point: `sessions` is per-process, so on Vercel the invocation
 * carrying a keystroke is frequently not the one that created the terminal.
 * Before this existed, that lookup simply missed and the keystroke was
 * dropped. Now a miss rehydrates from terminal_sessions and reattaches to the
 * live Sprites-side exec session, which replays its own scrollback — so the
 * shell, its history and its running processes all survive the hop.
 *
 * The in-process Map stays in front as a warm-instance cache: a hit here costs
 * nothing, and only a cold instance pays for the round trip.
 */
export async function resolveSession(id: string): Promise<SpriteSession | undefined> {
  const warm = sessions.get(id)
  if (warm) return warm

  const stored = await loadSession(id)
  if (!stored || stored.exited) return undefined

  const { token } = envConfig()
  if (!token) return undefined

  const session: SpriteSession = {
    id: stored.id,
    spriteName: stored.spriteName,
    spriteSessionId: stored.spriteSessionId,
    cols: stored.cols,
    rows: stored.rows,
    createdAt: Date.now(),
    lastWriteAt: Date.now(),
    // Scrollback lives on the Sprite; reattaching replays it, so starting
    // empty here loses nothing.
    scrollback: [],
    scrollbackBytes: 0,
    scrollbackTruncated: false,
    dataListeners: new Set(),
    exitListeners: new Set(),
    exited: false,
    ws: null,
    ready: false,
  }

  let ws: WebSocket
  try {
    ws = openSession(session, token, stored.spriteName, stored.spriteSessionId ?? undefined)
  } catch (err) {
    console.error('[sprite-manager] rehydrate: openSession threw:', err)
    return undefined
  }
  session.ws = ws

  const opened = await new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer)
      ws.off('open', onOpen)
      ws.off('error', onError)
      resolve(ok)
    }
    const onOpen = () => done(true)
    const onError = (err: Error) => {
      console.error('[sprite-manager] rehydrate: WS error:', err.message)
      done(false)
    }
    const timer = setTimeout(() => done(false), REATTACH_TIMEOUT_MS)
    ws.once('open', onOpen)
    ws.once('error', onError)
  })

  if (!opened) {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    return undefined
  }

  sessions.set(id, session)
  ensureReaper()
  return session
}

/**
 * Reopen the WS to Sprites for an existing session, attaching to the same
 * Sprites-side exec session if we captured its id. Called by the SSE route
 * when a resync arrives and the previous WS has been torn down by Vercel's
 * function cycle. Idempotent — no-ops if a WS is already live.
 */
export async function ensureWsLive(id: string): Promise<boolean> {
  const session = await resolveSession(id)
  if (!session || session.exited) return false
  if (session.ws && session.ws.readyState === WebSocket.OPEN) return true

  const { token, spriteName } = envConfig()
  if (!token) return false

  try {
    const ws = openSession(session, token, spriteName, session.spriteSessionId ?? undefined)
    session.ws = ws
    return true
  } catch (err) {
    console.error('[sprite-manager] ensureWsLive failed:', err)
    return false
  }
}

export async function writeInput(id: string, data: string): Promise<boolean> {
  const session = await resolveSession(id)
  if (!session || session.exited) return false
  const ws = session.ws
  if (!ws || ws.readyState !== WebSocket.OPEN || !session.ready) return false
  try {
    // TTY mode: send raw bytes as a binary frame. Sprites treats client→server
    // binary frames as stdin. UTF-8 round-trips binary-safe through xterm.js.
    ws.send(Buffer.from(data, 'utf8'), { binary: true })
    session.lastWriteAt = Date.now()
    return true
  } catch (err) {
    console.error('[sprite-manager] writeInput failed:', err)
    return false
  }
}

export async function resizeSession(id: string, cols: number, rows: number): Promise<boolean> {
  const session = await resolveSession(id)
  if (!session || session.exited) return false
  const c = Math.max(1, Math.min(400, Math.floor(cols)))
  const r = Math.max(1, Math.min(200, Math.floor(rows)))
  if (c === session.cols && r === session.rows) return true
  session.cols = c
  session.rows = r
  // Persist geometry so a rehydrating instance reattaches at the right size.
  void touchSession(id, c, r)
  const ws = session.ws
  if (!ws || ws.readyState !== WebSocket.OPEN || !session.ready) {
    // Was `return true`, which reported success while sending nothing — the
    // client then never retried and the PTY stayed at its creation size. The
    // new geometry is already on `session`, so the open handler above will
    // flush it; returning false lets the client retry in the meantime.
    return false
  }
  try {
    ws.send(JSON.stringify({ type: 'resize', cols: c, rows: r }))
    return true
  } catch (err) {
    console.error('[sprite-manager] resize failed:', err)
    return false
  }
}

export async function killSession(id: string): Promise<boolean> {
  const session = await resolveSession(id)
  if (!session) {
    // Not resolvable (already gone, or the store row outlived the Sprite) —
    // still drop the row so it can't be rehydrated forever.
    void deleteStoredSession(id)
    return false
  }

  // Best-effort kill of the Sprites-side exec session. If the bash process is
  // already dead or the WS is down, this is a no-op — don't propagate errors.
  const { token } = envConfig()
  if (token) {
    const sid = session.spriteSessionId
    if (sid) {
      const url = `${SPRITES_BASE}/sprites/${encodeURIComponent(session.spriteName)}/exec/${encodeURIComponent(sid)}/kill`
      fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(
        () => {
          /* best-effort */
        },
      )
    }
  }

  try {
    session.ws?.close()
  } catch {
    /* ignore */
  }
  sessions.delete(id)
  void deleteStoredSession(id)
  return true
}

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

export function isScrollbackTruncated(id: string): boolean {
  return sessions.get(id)?.scrollbackTruncated ?? false
}

/**
 * Provoke a repaint from whatever is running, by making the terminal size
 * actually change. See pty-manager.forceRepaint for why re-asserting the same
 * geometry is not enough — resizeSession early-returns on an unchanged size, so
 * a reattached TUI would otherwise never be told to redraw — and for the
 * measurement behind the hold time, which the 50ms this used to use sat below.
 */
const REPAINT_NUDGE_HOLD_MS = 250
const REPAINT_OBSERVE_MS = 1500

export async function forceRepaint(id: string): Promise<{ ok: boolean; repainted: boolean }> {
  const session = sessions.get(id)
  if (!session || session.exited || session.cols <= 1) return { ok: false, repainted: false }
  const { cols, rows } = session
  if (!(await resizeSession(id, cols - 1, rows))) return { ok: false, repainted: false }

  let repainted = false
  const watch = () => {
    repainted = true
  }
  session.dataListeners.add(watch)
  try {
    await delay(REPAINT_NUDGE_HOLD_MS)
    await resizeSession(id, cols, rows)
    await delay(REPAINT_OBSERVE_MS)
  } finally {
    session.dataListeners.delete(watch)
  }
  return { ok: true, repainted }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function getScrollback(id: string): string {
  const session = sessions.get(id)
  if (!session) return ''
  return session.scrollback.join('')
}

// ─── Reaper ─────────────────────────────────────────────────────────────
// Mirrors pty-manager's reaper: kills sessions with no live subscribers and
// no recent input. Same 30-min idle TTL. Vercel's function lifecycle will
// usually tear down the WS before this ever fires — the reaper is the
// backstop for the long-lived Codespace path and for leaked orphan sessions.

let reaperTimer: NodeJS.Timeout | null = null

function reap() {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (session.exited) {
      sessions.delete(id)
      continue
    }
    const idle = now - session.lastWriteAt
    if (session.dataListeners.size === 0 && idle > 30 * 60 * 1000) {
      try {
        session.ws?.close()
      } catch {
        /* ignore */
      }
      sessions.delete(id)
    }
  }
}

function ensureReaper(): void {
  if (reaperTimer) return
  reaperTimer = setInterval(reap, REAPER_INTERVAL_MS)
  if (reaperTimer && typeof reaperTimer.unref === 'function') {
    reaperTimer.unref()
  }
}

ensureReaper()
