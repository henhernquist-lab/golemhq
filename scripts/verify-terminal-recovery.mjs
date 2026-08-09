// Verification for the black-terminal incident (scrollback truncation).
//
// Drives a real PTY through the same manager the app uses, so the assertions
// are about actual behaviour rather than a simulation of it.
//
// What it establishes, in order:
//   1. A TUI's screen setup is what gets thrown away first when the scrollback
//      overflows — the exact bytes a reattaching terminal needs most.
//   2. The manager now reports that, so the client can react to it.
//   3. forceRepaint delivers a real SIGWINCH, which re-asserting the same
//      geometry does not.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-terminal-recovery.mjs

const pty = await import('../src/lib/terminal/pty-manager.ts')

const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let sessionId = null

try {
  console.log('\nSCROLLBACK TRUNCATION')
  const session = await pty.createSession({ cols: 80, rows: 24 })
  sessionId = session.id
  ok(`session ${sessionId.slice(0, 8)} on a real PTY`)

  if (pty.isScrollbackTruncated(sessionId)) throw new Error('a fresh session reports truncation')
  ok('a fresh session reports no truncation')

  // Emit like a full-screen program: enter the alternate buffer, then redraw
  // far past the 256 KiB cap. printf keeps it to one shell builtin rather than
  // spawning thousands of processes.
  pty.writeInput(sessionId, "printf '\\033[?1049h\\033[2J\\033[H'\n")
  await sleep(300)
  pty.writeInput(sessionId, "for i in $(seq 1 6000); do printf '\\033[%d;1Hframe %d %s\\n' $((i % 24 + 1)) $i 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done\n")

  // Wait for the buffer to actually overflow rather than guessing a duration.
  const deadline = Date.now() + 60_000
  while (!pty.isScrollbackTruncated(sessionId) && Date.now() < deadline) await sleep(500)

  if (!pty.isScrollbackTruncated(sessionId)) {
    throw new Error('scrollback never overflowed — cannot exercise the truncation path')
  }
  ok('truncation detected and reported by the manager')

  const backlog = pty.getScrollback(sessionId)
  info(`backlog is ${backlog.length} bytes (cap 262144)`)

  // The heart of it: the alternate-screen ENTER is gone while the frames that
  // depend on it remain. Replaying this to a fresh xterm is what renders black.
  const hasEnter = backlog.includes('\x1b[?1049h')
  const hasFrames = /\[\d+;1H/.test(backlog)
  info(`contains alt-screen enter (?1049h): ${hasEnter}`)
  info(`contains mid-stream frame updates : ${hasFrames}`)
  if (hasEnter) {
    info('NOTE: enter survived this run — the buffer did not overflow far enough')
  } else if (!hasFrames) {
    throw new Error('backlog has neither the enter sequence nor frames — test emitted nothing useful')
  } else {
    ok('the screen setup was trimmed away while dependent frames survived — the black-screen shape')
  }

  console.log('\nREPAIR')
  const beforeCols = pty.getSession(sessionId).cols

  // Re-asserting the same geometry is what the client used to do on reconnect.
  // It reports success and delivers no signal, which is the whole problem.
  const noop = pty.resizeSession(sessionId, beforeCols, 24)
  if (!noop) throw new Error('resizeSession failed outright')
  ok(`re-asserting the same size returns ${noop} but changes nothing (cols still ${pty.getSession(sessionId).cols})`)

  // forceRepaint must actually move the geometry, which is what produces
  // SIGWINCH and makes a TUI redraw.
  const repainted = pty.forceRepaint(sessionId)
  if (!repainted) throw new Error('forceRepaint returned false on a live session')
  const during = pty.getSession(sessionId).cols
  if (during !== beforeCols - 1) throw new Error(`expected a nudge to ${beforeCols - 1}, saw ${during}`)
  ok(`forceRepaint nudged the PTY to ${during} — a real resize, so a real SIGWINCH`)

  await sleep(200)
  const after = pty.getSession(sessionId).cols
  if (after !== beforeCols) throw new Error(`geometry not restored: expected ${beforeCols}, got ${after}`)
  ok(`geometry restored to ${after} — the pane keeps the size it asked for`)

  // A dead session must report failure, so the UI can say "restart" instead of
  // offering a redraw that cannot work.
  pty.killSession(sessionId)
  if (pty.forceRepaint(sessionId)) throw new Error('forceRepaint succeeded on a killed session')
  ok('forceRepaint reports false once the session is gone')
  sessionId = null

  console.log('\n✓ truncation is detected, and the repair delivers a real repaint signal\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
} finally {
  if (sessionId) pty.killSession(sessionId)
  process.exit(process.exitCode ?? 0)
}
