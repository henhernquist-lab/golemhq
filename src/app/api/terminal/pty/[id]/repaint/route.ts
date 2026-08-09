import { auth } from '@/lib/auth'
import { forceRepaint as forceLocalRepaint } from '@/lib/terminal/pty-manager'
import { forceRepaint as forceSpriteRepaint, ensureWsLive } from '@/lib/terminal/sprite-manager'
import { requireHenryOwner } from '@/lib/auth-owner'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

interface RouteCtx {
  params: Promise<{ id: string }>
}

// POST /api/terminal/pty/[id]/repaint — make the running program redraw.
//
// Recovering a terminal that has gone blank is not something the client can do
// on its own. xterm can only draw what it is sent, and a full-screen program
// decides for itself when to paint; there is no "please redraw" escape
// sequence to send it. The only lever is SIGWINCH, which lives on the server
// side of the PTY — hence a route rather than a client-side fix.
//
// Deliberately separate from /resize even though both end up resizing: resize
// means "the pane is now this size", repaint means "the size is right but the
// screen is wrong". Folding them together would make resize lie, because the
// repair works by briefly asserting a size that is NOT the pane's.
export async function POST(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params

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

  if (onCloud) await ensureWsLive(id)

  const ok = onCloud ? await forceSpriteRepaint(id) : forceLocalRepaint(id)
  // ok:false means there was no live session to signal — the same condition the
  // input route reports, and the caller should treat it the same way: the
  // session is gone and only a restart will bring the terminal back.
  return Response.json({ ok })
}
