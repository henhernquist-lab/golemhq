import { auth } from '@/lib/auth'
import {
  getSession as getLocalSession,
  getScrollback as getLocalScrollback,
  isScrollbackTruncated as isLocalScrollbackTruncated,
  subscribe as subscribeLocal,
  killSession as killLocalSession,
} from '@/lib/terminal/pty-manager'
import {
  resolveSession as resolveSpriteSession,
  getScrollback as getSpriteScrollback,
  isScrollbackTruncated as isSpriteScrollbackTruncated,
  subscribe as subscribeSprite,
  killSession as killSpriteSession,
  ensureWsLive,
} from '@/lib/terminal/sprite-manager'
import { requireHenryOwner } from '@/lib/auth-owner'

export const runtime = 'nodejs'
// SSE stream lives as long as the terminal pane is mounted.
export const maxDuration = 300
export const dynamic = 'force-dynamic'

interface RouteCtx {
  params: Promise<{ id: string }>
}

// GET /api/terminal/pty/[id] — Server-Sent Events stream of terminal output.
//
// On the Codespace, this is the existing PTY stream: scrollback replay then
// live output, with a 15s heartbeat. On Vercel, the same byte format is
// bridged to the Fly Sprite WS held open inside this function. When Vercel
// tears the function down at maxDuration, the browser's EventSource
// auto-reconnects — the next invocation reattaches to the same Sprite exec
// session, which has been alive the whole while, and scrollback replays again.
export async function GET(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params

  // Branch on env: Vercel → Henry-only gate, then the Sprite bridge.
  // Codespace → existing "any signed-in user" auth (unchanged behavior).
  const onCloud = !!process.env.VERCEL
  if (onCloud) {
    const gate = await requireHenryOwner()
    if (gate.response) return gate.response
  } else {
    const session = await auth()
    if (!session?.user) {
      return new Response('Unauthorized', { status: 401 })
    }
  }

  // Cloud: rehydrate from the durable store if this lambda has never seen the
  // session, so an SSE reconnect that lands on a cold instance reattaches
  // instead of 404ing the terminal.
  const session = onCloud ? await resolveSpriteSession(id) : getLocalSession(id)
  if (!session) {
    return new Response('Not found', { status: 404 })
  }

  // The workspace uses a lightweight probe during hydration. Return a finite
  // response instead of opening an unused SSE stream just to test existence.
  if (new URL(req.url).searchParams.get('probe') === '1') {
    return Response.json({ ok: true, id })
  }

  // On cloud, revive the WS if it died between function invocations (Vercel
  // torn-down + reconnect, or plain WS idle). If the bash exited meanwhile,
  // getSession still returns the row but its `exited` flag is set — the
  // SSE path below will emit the exit event from scrollback's last frame and
  // the live subscribe won't add anything new. That's the correct behavior
  // (matches Codespace where an exited PTY replays its last output then EOFs).
  if (onCloud) await ensureWsLive(id)

  const getScrollback = onCloud ? getSpriteScrollback : getLocalScrollback
  const subscribe = onCloud ? subscribeSprite : subscribeLocal

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: string) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        try {
          controller.enqueue(encoder.encode(payload))
        } catch {
          /* controller already closed */
        }
      }

      // Replay scrollback so reconnects (Strict Mode, tab-away, Vercel
      // function resync) aren't blank. On cloud, this is the local buffer
      // we've been maintaining from Sprite's WS output — same semantics.
      // Tell the client what kind of replay this is BEFORE the bytes land.
      // A truncated backlog is missing whatever set the screen up — for a
      // full-screen program that means the `\x1b[?1049h` and the first paint —
      // so replaying it verbatim can leave a perfectly live terminal showing
      // nothing at all. The client repairs that by provoking a repaint; it can
      // only do so if it knows.
      const truncated = onCloud ? isSpriteScrollbackTruncated(id) : isLocalScrollbackTruncated(id)
      const backlog = getScrollback(id)
      send('backlog', JSON.stringify({ truncated, bytes: backlog.length }))
      if (backlog) send('output', backlog)

      const unsub = subscribe(
        id,
        (data) => send('output', data),
        (exitCode, signal) => send('exit', JSON.stringify({ exitCode, signal })),
      )

      // Heartbeat keeps the connection alive through proxies and lets the
      // client detect a dead server (no ping → reconnect).
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`))
        } catch {
          /* closed */
        }
      }, 15000)

      const cleanup = () => {
        clearInterval(ping)
        unsub()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }

      if (req.signal.aborted) cleanup()
      req.signal.addEventListener('abort', cleanup, { once: true })
    },
    cancel() {
      // Stream consumer cancelled — cleanup happens via abort listener.
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable Next.js buffering/edge for this route.
      'X-Accel-Buffering': 'no',
    },
  })
}

// DELETE /api/terminal/pty/[id] — kill the terminal (close button).
export async function DELETE(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params

  // Same env/owner branch as GET — non-Henry must not be able to drive a
  // cloud terminal, even to kill one. Leaked pane ids can't reach either.
  const onCloud = !!process.env.VERCEL
  if (onCloud) {
    const gate = await requireHenryOwner()
    if (gate.response) return gate.response
  } else {
    const session = await auth()
    if (!session?.user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const ok = onCloud ? await killSpriteSession(id) : killLocalSession(id)
  return Response.json({ ok })
}
