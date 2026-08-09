// Verification for the Fly Sprite terminal backend — the path production uses.
//
// Every previous attempt to check this reported `401 authentication failed`
// and stopped there. The 401 was never real: the probe scripts parsed
// .env.local with `/^([A-Z0-9_]+)=(.*)$/`, which swallowed the aligned inline
// comment after SPRITES_TOKEN and sent a 196-character bearer token instead of
// the real 128-character one. See scripts/load-env.mjs. This script exists so
// the Sprite is checked through the same loader and the same manager the app
// uses, and can never again be declared dead by a parser bug.
//
// Forces VERCEL=1 so backend() selects the Sprite exactly as it does on Vercel.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-sprite.mjs
//
// Env:
//   CMD=<shell>     run something else instead of the default probe
//   TIMEOUT_MS=<n>  override the run cap (default 180000 — a cold Sprite boots slowly)

import './load-env.mjs'

// backend() reads this at call time, so it has to be set before the import.
process.env.VERCEL = '1'

const { runHeadless, backend } = await import('../src/lib/terminal/headless-run.ts')

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 180_000)
const CMD =
  process.env.CMD ??
  'echo "sprite=$(hostname)"; uname -sm; (blender --version 2>/dev/null | head -1) || echo "blender: not installed"'

const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)

try {
  console.log('\nBACKEND SELECTION')
  const kind = backend().kind
  if (kind !== 'sprite') throw new Error(`expected the sprite backend with VERCEL set, got "${kind}"`)
  ok(`backend() -> ${kind} (SPRITE_NAME=${process.env.SPRITE_NAME ?? 'enry-terminal'})`)

  const token = process.env.SPRITES_TOKEN ?? ''
  if (!token) throw new Error('SPRITES_TOKEN is not set')
  // Length, never the value — this output gets pasted into reports.
  info(`SPRITES_TOKEN present (${token.length} chars)`)
  if (/[#\s]/.test(token)) {
    throw new Error('SPRITES_TOKEN contains whitespace or a "#" — it has picked up a comment again')
  }
  ok('token is free of whitespace and comment characters')

  console.log('\nEXEC ON THE SPRITE')
  const started = Date.now()
  const run = await runHeadless(CMD, { timeoutMs: TIMEOUT_MS, runId: `verify-sprite-${Date.now()}` })
  const secs = ((Date.now() - started) / 1000).toFixed(1)

  if (run.failure) info(`manager reported: ${run.failure}`)
  if (run.timedOut) throw new Error(`run timed out after ${secs}s`)
  ok(`command completed in ${secs}s with exit code ${run.exitCode}`)
  console.log('\n--- output ---')
  console.log(run.output.trim())
  console.log('--------------')

  if (run.exitCode !== 0) throw new Error(`non-zero exit: ${run.exitCode}`)

  console.log('\n✓ the Sprite is reachable and runs commands through the production backend\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
} finally {
  process.exit(process.exitCode ?? 0)
}
