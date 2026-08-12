import { auth } from '@/lib/auth'
import { writeInput as writeLocalInput } from '@/lib/terminal/pty-manager'
import { writeInput as writeSpriteInput, ensureWsLive } from '@/lib/terminal/sprite-manager'
import { requireHenryOwner } from '@/lib/auth-owner'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

interface RouteCtx {
  params: Promise<{ id: string }>
}

// POST /api/terminal/pty/[id]/input — send keystrokes to the terminal.
// Codespace → local PTY. Vercel → Sprites WS (requires Henry).
export async function POST(req: Request, ctx: RouteCtx) {
  // Phase timings, surfaced as a Server-Timing header so the browser can read
  // the server's own breakdown on the very same request that carried the
  // keystroke. Correlating two separate logs by timestamp across a lambda
  // boundary is guesswork; this is the same clock and the same request.
  const tStart = performance.now()
  const marks: Record<string, number> = {}
  const mark = (name: string, from: number) => {
    marks[name] = performance.now() - from
  }

  const { id } = await ctx.params

  const onCloud = !!process.env.VERCEL
  const tAuth = performance.now()
  if (onCloud) {
    const gate = await requireHenryOwner()
    if (gate.response) return gate.response
  } else {
    const session = await auth()
    if (!session?.user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }
  mark('auth', tAuth)

  let data = ''
  try {
    const body = await req.json().catch(() => ({}))
    if (typeof body?.data === 'string') data = body.data
  } catch {
    return Response.json({ error: 'Invalid body' }, { status: 400 })
  }

  if (!data) return Response.json({ ok: true })

  // Cloud: WS may be down from a prior function cycle. Best-effort revive —
  // if it can't come back, return ok:false so the client knows the keystroke
  // was dropped (xterm.js local echo still shows it; the shell just didn't get it).
  const tWs = performance.now()
  if (onCloud) await ensureWsLive(id)
  mark('ws', tWs)

  const tWrite = performance.now()
  const ok = onCloud ? await writeSpriteInput(id, data) : writeLocalInput(id, data)
  mark('write', tWrite)
  mark('total', tStart)

  console.debug('[terminal chain] input route → PTY manager', { id, bytes: data.length, ok, cloud: onCloud })
  return Response.json(
    { ok },
    {
      headers: {
        // `dur` is milliseconds; the browser exposes this on the PerformanceResourceTiming
        // entry, and it is cheap enough to leave on permanently.
        'Server-Timing': Object.entries(marks)
          .map(([name, dur]) => `${name};dur=${dur.toFixed(2)}`)
          .join(', '),
      },
    },
  )
}
