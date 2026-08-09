/**
 * /api/diag/sprite — is the Fly Sprite actually reachable from THIS deployment?
 *
 * Every previous answer to that question was inferred from the Codespace, and
 * the inference was wrong for weeks: SPRITES_TOKEN was declared dead because a
 * script's .env parser had glued a trailing comment onto it, while the deployed
 * app — which parses .env properly and reads its token from Vercel, not from
 * that file at all — was never even tested. Nothing short of running inside the
 * deployment settles it, so this runs there.
 *
 * Auth: the CRON_SECRET bearer, matching /api/cron/*. Deliberately not the
 * owner session — the point is to be callable by a script from outside, and a
 * check that needs a browser login is a check nobody runs. It executes one
 * fixed, read-only command; the caller cannot choose it.
 *
 * The response reports the token's LENGTH and never its value.
 */

import { backend, runHeadless } from '@/lib/terminal/headless-run'
import { blenderAvailable } from '@/lib/assets/blender'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const PROBE = 'echo "host=$(hostname)"; echo "user=$(whoami)"'

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = process.env.SPRITES_TOKEN ?? ''
  const env = {
    onVercel: !!process.env.VERCEL,
    backend: backend().kind,
    spriteName: process.env.SPRITE_NAME ?? null,
    tokenPresent: token.length > 0,
    tokenLength: token.length,
    // The exact failure that caused the 401: a value carrying a comment or
    // whitespace is malformed no matter how plausible its length looks.
    tokenLooksMalformed: /[#\s]/.test(token),
  }

  try {
    const started = Date.now()
    const run = await runHeadless(PROBE, { timeoutMs: 45_000, runId: `diag-sprite-${Date.now()}` })
    const blender = await blenderAvailable()

    return Response.json({
      ok: run.exitCode === 0 && !run.timedOut,
      env,
      exec: {
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        durationMs: Date.now() - started,
        failure: run.failure ?? null,
        output: run.output.slice(0, 500),
      },
      blender,
    })
  } catch (err) {
    return Response.json(
      { ok: false, env, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
