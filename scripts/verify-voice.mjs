// Prove voice mode works, by making the two halves check each other.
//
// A TTS test that only asserts "a .wav was written" passes on four seconds of
// silence. An STT test needs a recording, and there is no human here to make
// one. So the two are run against each other: Kokoro speaks a known sentence,
// Whisper transcribes the audio back, and the transcript is compared to what
// was said. That closes the loop with no fixture audio and no human in it —
// and it can only pass if the speech is genuinely intelligible, because
// Whisper has to understand it.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-voice.mjs
//
// Env:
//   KEEP=1   leave the generated .wav at /tmp/golem-voice-probe.wav

import { writeFile } from 'node:fs/promises'

import './load-env.mjs'

const voice = await import('../src/lib/voice/index.ts')

const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)

// Deliberately ordinary words. A sentence full of proper nouns would fail on
// spelling rather than on whether the pipeline works.
const SPOKEN = 'The golem is awake and listening for your next instruction.'
const OUT = '/tmp/golem-voice-probe.wav'

/** Compare on words, since punctuation and case are not what is under test. */
const words = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean)

try {
  console.log('\nREADINESS')
  const status = await voice.voiceStatus()
  info(`venv: ${voice.VOICE_VENV}`)
  info(`backend: ${status.backend}  stt=${status.stt} tts=${status.tts}`)
  if (!status.available) {
    // This is the degradation path, and it is worth showing rather than hiding:
    // the message has to tell a human what to actually do.
    console.log(`\n  reason: ${status.reason}`)
    console.log(`  hint:   ${status.hint}`)
    throw new Error('voice is unavailable — the reason above is what the UI would show')
  }
  ok('whisper, kokoro and soundfile all import')

  // ── TTS ──────────────────────────────────────────────────────────
  console.log('\nTEXT → SPEECH (Kokoro, local)')
  const speech = await voice.speak(SPOKEN)
  info(`${speech.backend} produced ${speech.audio.byteLength} bytes of ${speech.contentType} in ${(speech.durationMs / 1000).toFixed(1)}s`)

  if (speech.audio.subarray(0, 4).toString('ascii') !== 'RIFF') {
    throw new Error('the output is not a RIFF/WAV container')
  }
  ok('a real WAV container came back')

  // Silence would sail through a byte-length check, so look at the samples.
  const pcm = speech.audio.subarray(44)
  let peak = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)))
  info(`peak amplitude: ${peak} of 32767`)
  if (peak < 1000) throw new Error(`the audio is effectively silent (peak ${peak}) — a .wav was written but nothing was said`)
  ok('the audio contains real signal, not silence')

  await writeFile(OUT, speech.audio)
  info(`written to ${OUT}`)

  // ── STT ──────────────────────────────────────────────────────────
  console.log('\nSPEECH → TEXT (Whisper, local)')
  const heard = await voice.transcribe(speech.audio, 'probe.wav')
  info(`transcribed in ${(heard.durationMs / 1000).toFixed(1)}s`)
  console.log(`\n  said:  "${SPOKEN}"`)
  console.log(`  heard: "${heard.text}"`)

  const said = words(SPOKEN)
  const got = words(heard.text)
  if (got.length === 0) throw new Error('Whisper returned an empty transcript')

  const matched = said.filter((w) => got.includes(w))
  const accuracy = matched.length / said.length
  info(`\n  ${matched.length}/${said.length} words matched (${(accuracy * 100).toFixed(0)}%)`)
  if (accuracy < 0.8) {
    throw new Error(`only ${(accuracy * 100).toFixed(0)}% of words survived the round trip — the loop is not reliable`)
  }
  ok('Whisper understood what Kokoro said — both halves work, end to end')

  console.log('\n✓ speech synthesised locally, and transcribed back correctly\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
} finally {
  process.exit(process.exitCode ?? 0)
}
