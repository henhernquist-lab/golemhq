#!/usr/bin/env -S npx tsx
// Prove that per-agent voices are actually different voices.
//
// ─── The claim that needs guarding against ────────────────────────────
// "voice_id was passed through" is trivial to demonstrate and worth nothing: a
// route that accepts a voice id, ignores it, and returns audio would pass any
// test that only checks the request succeeded. So would one that returns three
// files whose bytes differ because of a timestamp. What has to be shown is that
// the SOUND changed.
//
// ─── The control ──────────────────────────────────────────────────────
// Three voices each say two different sentences. That gives two distances:
//
//   within  — same voice, different words
//   between — different voice, same words
//
// A fingerprint that merely tracks WHAT WAS SAID would score those the same
// way. Voices being real means between ≫ within, and this script fails if it is
// not. A single pair of clips could never establish that, however different
// they measured, because there would be nothing to compare the difference to.
//
// Whisper transcribes one clip per voice as well — three files that measure as
// wildly different because two of them are noise would otherwise pass.
//
// Usage:
//   ./scripts/verify-voices.mjs
//
// Env:
//   KEEP=1   leave the .wav files in /tmp/golem-voice-samples for listening

import './load-env.mjs'
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const voice = await import('../src/lib/voice/index.ts')
const { DEFAULT_ROTATION, defaultVoiceFor, langCodeFor, VOICES } = await import('../src/lib/voice/voices.ts')

const execFileAsync = promisify(execFile)

const OUT_DIR = '/tmp/golem-voice-samples'
const FINGERPRINT = new URL('./voice-fingerprint.py', import.meta.url).pathname

// The two lines are similar in length and phonetic content so the comparison is
// not confounded by one clip being twice as long as the other.
const LINE_A = 'Standing by. Tell me what you need built.'
const LINE_B = 'The deployment finished. Nothing else needs your attention.'

/** The three Henry asked to hear: British male, American female, American male. */
const SUBJECTS = ['bm_george', 'af_heart', 'am_adam']

/**
 * Distance between two fingerprints, 0 = identical.
 *
 * Pitch and timbre are combined rather than reported separately because either
 * alone has a blind spot: two voices can share a pitch, and two clips of one
 * voice can drift in spectrum. The pitch term is scaled so an octave apart
 * (the male/female split) contributes about as much as a total mismatch in
 * spectral shape — neither measure gets to dominate the verdict.
 */
function distance(a, b) {
  const spectral = a.mels.reduce((sum, v, i) => sum + Math.abs(v - b.mels[i]), 0)
  const pitch =
    a.medianF0 && b.medianF0 ? Math.abs(Math.log2(a.medianF0 / b.medianF0)) : 0
  return spectral + pitch
}

const pass = (msg) => console.log(`  [32m✓[0m ${msg}`)
const info = (msg) => console.log(`    ${msg}`)

async function main() {
  console.log('\n─── voice catalog ───')
  for (const id of SUBJECTS) {
    const opt = VOICES.find((v) => v.id === id)
    if (!opt) throw new Error(`${id} is not in the catalog — the picker could never offer it`)
    info(`${id.padEnd(11)} lang_code=${langCodeFor(id)}  ${opt.accent} ${opt.gender} — ${opt.note}`)
  }
  pass(`all ${SUBJECTS.length} subjects are catalog entries`)

  // The rotation is what an un-chosen agent gets, so it has to hand out
  // different voices — a "rotation" of one voice repeated is the bug.
  const rotationIds = ['a', 'b', 'c', 'd'].map((id) => defaultVoiceFor(id, ['a', 'b', 'c', 'd']))
  if (new Set(rotationIds).size !== DEFAULT_ROTATION.length) {
    throw new Error(`the rotation repeats itself: ${rotationIds.join(', ')}`)
  }
  pass(`rotation gives the first ${DEFAULT_ROTATION.length} agents distinct voices: ${rotationIds.join(' → ')}`)

  const status = await voice.voiceStatus()
  if (!status.available) {
    console.error(`\n✗ voice unavailable: ${status.reason}\n  ${status.hint ?? ''}`)
    process.exit(1)
  }

  console.log('\n─── synthesis ───')
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  const clips = []
  for (const id of SUBJECTS) {
    for (const [tag, line] of [['a', LINE_A], ['b', LINE_B]]) {
      const result = await voice.speak(line, { voice: id })
      if (result.voice !== id) {
        throw new Error(`asked for ${id} but the engine reported speaking as ${result.voice}`)
      }
      const path = join(OUT_DIR, `${id}-${tag}.wav`)
      await writeFile(path, result.audio)
      clips.push({ id, tag, path, line, bytes: result.audio.byteLength, ms: result.durationMs })
      info(`${id}-${tag}  ${(result.audio.byteLength / 1024).toFixed(0)} KB in ${result.durationMs} ms`)
    }
  }
  pass(`${clips.length} clips synthesised, each reporting the voice it was asked for`)

  console.log('\n─── the words survived ───')
  // Only the first clip per voice: this guards against noise, and three
  // transcriptions is enough to establish that all three engines produce speech.
  const expected = LINE_A.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/)
  for (const clip of clips.filter((c) => c.tag === 'a')) {
    const { text } = await voice.transcribe(await import('node:fs/promises').then((fs) => fs.readFile(clip.path)), 'probe.wav')
    const heard = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean)
    const matched = expected.filter((w) => heard.includes(w)).length
    info(`${clip.id.padEnd(11)} heard "${text.trim()}" — ${matched}/${expected.length} words`)
    if (matched < expected.length * 0.7) {
      throw new Error(`${clip.id} did not produce intelligible speech — measuring it as "distinct" would be meaningless`)
    }
  }
  pass('every voice says the same sentence intelligibly — the differences below are voice, not garble')

  console.log('\n─── acoustic fingerprints ───')
  const { stdout } = await execFileAsync(
    join(voice.VOICE_VENV, 'bin', 'python'),
    [FINGERPRINT, ...clips.map((c) => c.path)],
    { maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
  )
  const prints = new Map(JSON.parse(stdout).files.map((f) => [f.path, f]))
  for (const clip of clips.filter((c) => c.tag === 'a')) {
    const f = prints.get(clip.path)
    info(`${clip.id.padEnd(11)} median pitch ${f.medianF0 ? `${f.medianF0.toFixed(0)} Hz` : 'unvoiced'} · ${f.seconds}s · peak ${f.peak.toFixed(2)}`)
  }

  console.log('\n─── within-voice vs between-voice ───')
  const within = SUBJECTS.map((id) => ({
    id,
    d: distance(prints.get(join(OUT_DIR, `${id}-a.wav`)), prints.get(join(OUT_DIR, `${id}-b.wav`))),
  }))
  for (const w of within) info(`within  ${w.id.padEnd(11)} (two different sentences)  ${w.d.toFixed(3)}`)

  const between = []
  for (let i = 0; i < SUBJECTS.length; i++) {
    for (let j = i + 1; j < SUBJECTS.length; j++) {
      between.push({
        pair: `${SUBJECTS[i]} vs ${SUBJECTS[j]}`,
        d: distance(prints.get(join(OUT_DIR, `${SUBJECTS[i]}-a.wav`)), prints.get(join(OUT_DIR, `${SUBJECTS[j]}-a.wav`))),
      })
    }
  }
  for (const b of between) info(`between ${b.pair.padEnd(24)} (same sentence)  ${b.d.toFixed(3)}`)

  const worstBetween = Math.min(...between.map((b) => b.d))
  const worstWithin = Math.max(...within.map((w) => w.d))
  info(`\n    closest two voices: ${worstBetween.toFixed(3)}   |   most a single voice varies: ${worstWithin.toFixed(3)}`)

  // The margin is the whole claim. Requiring 2× rather than "greater than"
  // means a marginal result reads as a failure, which is the correct outcome
  // for "these might be the same voice".
  if (worstBetween < worstWithin * 2) {
    throw new Error(
      `voices are not reliably distinct: the closest pair (${worstBetween.toFixed(3)}) is not clearly beyond ` +
        `how much one voice varies across sentences (${worstWithin.toFixed(3)})`,
    )
  }
  pass(`every pair of voices is at least ${(worstBetween / worstWithin).toFixed(1)}× further apart than one voice is from itself`)

  if (process.env.KEEP === '1') {
    // Written out so scripts/voice-samples-page.mjs renders measurements that
    // were actually taken, rather than numbers transcribed by hand from this
    // log — a listening page quoting invented figures would undo the point.
    await writeFile(
      join(OUT_DIR, 'report.json'),
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          lines: { a: LINE_A, b: LINE_B },
          voices: SUBJECTS.map((id) => {
            const f = prints.get(join(OUT_DIR, `${id}-a.wav`))
            return { id, medianF0: f.medianF0, seconds: f.seconds, peak: f.peak }
          }),
          within,
          between,
          margin: worstBetween / worstWithin,
        },
        null,
        2,
      ),
    )
    console.log(`\nsamples kept in ${OUT_DIR} — play them and judge for yourself`)
  } else {
    await rm(OUT_DIR, { recursive: true, force: true })
  }
  console.log('\n[32mvoices are distinct.[0m\n')
}

main().catch((err) => {
  console.error(`\n[31m✗ ${err.message}[0m\n`)
  process.exit(1)
})
