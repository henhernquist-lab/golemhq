// Which CLIs are actually installed where the builders run, and how that lines
// up with the layer-2 rows in `agents`.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/detect-clis.mjs
//
// Flags / env:
//   --persist     write the results back to agents (needs the detection migration)
//   --raw         dump the detection script's raw output
//   CWD=<path>    run detection from a specific directory
//
// The host is whichever backend the terminal path resolves to — 'local' in the
// Codespace, 'sprite' on Vercel. Results describe THAT host only.


import './load-env.mjs'

const { detectClis } = await import('../src/lib/missions/cli-detect.ts')
const { recordDetection, getDetections } = await import('../src/lib/missions/store.ts')

const persist = process.argv.includes('--persist')
const showRaw = process.argv.includes('--raw')

const pad = (s, n) => String(s ?? '').padEnd(n)
const truncate = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''))

try {
  console.log('running detection through the terminal exec path…')
  const report = await detectClis({ cwd: process.env.CWD })

  console.log(`\nHOST: ${report.host}   (${report.host === 'local' ? 'Codespace node-pty' : 'Fly Sprite'})`)
  console.log(`detected at ${report.detectedAt}`)
  if (report.warning) console.log(`\n⚠ ${report.warning}`)

  // ── Registered builders ──────────────────────────────────────────
  console.log('\nLAYER-2 AGENTS — registered in the DB')
  console.log(`  ${pad('AGENT', 16)}${pad('EXECUTABLE', 14)}${pad('STATUS', 13)}${pad('PATH', 40)}VERSION`)
  for (const d of report.agents) {
    const status = d.installed ? 'CONFIRMED' : 'UNCONFIRMED'
    const enabled = d.agent.enabled ? '' : ' (disabled)'
    console.log(
      `  ${pad(truncate(d.agent.name + enabled, 15), 16)}${pad(truncate(d.executable, 13), 14)}${pad(status, 13)}${pad(truncate(d.path ?? '—', 39), 40)}${truncate(d.version ?? '—', 28)}`,
    )
  }
  const confirmed = report.agents.filter((d) => d.installed).length
  console.log(`\n  ${confirmed} confirmed / ${report.agents.length - confirmed} unconfirmed on "${report.host}"`)

  // ── Global packages ──────────────────────────────────────────────
  const registeredNames = new Set(report.agents.map((d) => d.executable))
  console.log(`\nGLOBAL PACKAGES — ${report.packages.length} installed via npm/pipx`)
  if (report.packages.length === 0) {
    console.log('  none detected')
  } else {
    for (const p of report.packages) {
      const known = [...registeredNames].some((n) => n && p.name.includes(n))
      console.log(`  ${pad(p.manager, 6)}${pad(truncate(p.name, 39), 40)}${pad(p.version, 14)}${known ? 'registered' : ''}`)
    }
  }

  // ── Candidates ───────────────────────────────────────────────────
  console.log(`\nDISCOVERED, NOT REGISTERED — ${report.candidates.length} executables in user-install locations`)
  if (report.truncated) console.log('  (list truncated — too many entries to scan)')
  if (report.candidates.length === 0) {
    console.log('  none')
  } else {
    for (const c of report.candidates) console.log(`  ${pad(truncate(c.name, 27), 28)}${c.path}`)
    console.log('\n  Nothing was added. Registering one is a decision, not a detection result —')
    console.log('  insert a layer-2 row with its cli_command to make it dispatchable.')
  }

  // ── Persistence ──────────────────────────────────────────────────
  if (persist) {
    console.log('\nPERSISTING to agents…')
    const n = await recordDetection(
      report.host,
      report.agents.map((d) => ({ agentId: d.agent.id, path: d.path, version: d.version })),
    )
    console.log(`  ${n} rows updated`)
    for (const [id, rec] of await getDetections()) {
      const agent = report.agents.find((d) => d.agent.id === id)
      if (agent) console.log(`  ${pad(truncate(agent.agent.name, 19), 20)}${rec.detectedHost ?? '—'}  ${rec.cliPath ?? 'ABSENT'}`)
    }
  } else {
    console.log('\n(not persisted — pass --persist to write these results back to agents)')
  }

  if (showRaw) console.log(`\nRAW\n${report.raw}`)
} catch (err) {
  console.error('\n✗ DETECTION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
} finally {
  // node-pty keeps the loop alive after killSession.
  process.exit(process.exitCode ?? 0)
}
