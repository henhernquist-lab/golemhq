import { test, expect } from 'playwright/test'
import { existsSync } from 'node:fs'

/**
 * Voice mode in a real browser.
 *
 * ─── What this can and cannot cover ───────────────────────────────────
 * The voice routes are owner-gated (they run local processes), and the E2E
 * account is deliberately NOT the owner — so these tests cannot drive the full
 * audio round trip through HTTP. That is a property of the security model, not
 * a gap to work around, and the gate itself is asserted below.
 *
 * The engine round trip is proven elsewhere and more strictly:
 * scripts/verify-voice.mjs has Kokoro speak a known sentence and Whisper
 * transcribe it back, matching 10/10 words. What only a browser can prove is
 * the capture half — that MediaRecorder produces real audio bytes — and that
 * is what runs here, against Chromium's fake device fed from the .wav Kokoro
 * actually generated.
 */
const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD
const PROBE_WAV = '/tmp/golem-voice-probe.wav'

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${PROBE_WAV}`,
    ],
  },
  permissions: ['microphone'],
})

test.describe('voice mode', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD to run voice tests.')
  test.skip(!existsSync(PROBE_WAV), `No ${PROBE_WAV} — run scripts/verify-voice.mjs first to generate it.`)

  async function signIn(page: import('playwright/test').Page) {
    await page.goto('/login')
    await page.getByRole('button', { name: 'email', exact: true }).click()
    await page.locator('button[type="button"]', { hasText: /^sign in$/ }).first().click()
    await page.getByPlaceholder('email').fill(EMAIL!)
    await page.getByPlaceholder('password').fill(PASSWORD!)
    await page.locator('button[type="submit"]').click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 })
  }

  test('MediaRecorder captures real audio from the microphone', async ({ page }) => {
    await signIn(page)
    await page.goto('/missions')

    // Driven directly rather than through hold-to-talk: the claim under test is
    // that the capture path yields real bytes, and synthesising a press-and-hold
    // long enough to record adds timing flakiness without testing more.
    const captured = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      const chunks: Blob[] = []
      recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      recorder.start()
      await new Promise((r) => setTimeout(r, 4000))
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
        recorder.stop()
      })
      stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunks, { type: recorder.mimeType })
      return { bytes: blob.size, mime: recorder.mimeType, tracks: stream.getTracks().length }
    })

    expect(captured.tracks, 'no audio track was opened').toBeGreaterThan(0)
    // A silent or absent device still produces a container with headers, so the
    // threshold is well above "an empty webm".
    expect(captured.bytes, `the fake microphone produced only ${captured.bytes} bytes`).toBeGreaterThan(5000)
    expect(captured.mime).toMatch(/audio|webm/)
  })

  test('the voice routes refuse a non-owner', async ({ page }) => {
    await signIn(page)
    await page.goto('/missions')

    // Signed in, but not as the owner. Voice runs local processes, so this must
    // be a refusal — a signed-in-is-enough gate here would let any account
    // spend the host's CPU on synthesis.
    const results = await page.evaluate(async () => {
      const speak = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      })
      const status = await fetch('/api/voice', { cache: 'no-store' })
      const voices = await fetch('/api/voice/voices', { cache: 'no-store' })
      return { speak: speak.status, status: status.status, voices: voices.status }
    })

    expect(results.speak, 'a non-owner was allowed to synthesise speech').toBe(403)
    expect(results.status, 'a non-owner could read voice status').toBe(403)
    // The catalog looks harmless, but it also reports which voice every agent
    // uses — roster shape, and it shares the picker's preview endpoint.
    expect(results.voices, 'a non-owner could read the voice catalog').toBe(403)
  })

  test('voice mode degrades to type rather than failing silently', async ({ page }) => {
    await signIn(page)
    await page.goto('/missions')

    // The panel only exists for agents with a CLI.
    const chat = page.getByRole('button', { name: /chat with Claude Code/i }).first()
    await expect(chat).toBeVisible({ timeout: 30_000 })
    await chat.click()

    // Type is always offered. Voice is disabled with a stated reason whenever
    // the environment cannot serve it — never a mic button that does nothing.
    const typeToggle = page.getByRole('button', { name: 'type', exact: true })
    await expect(typeToggle).toBeVisible({ timeout: 30_000 })

    const voiceToggle = page.getByRole('button', { name: 'voice', exact: true })
    await expect(voiceToggle).toBeVisible()
    if (await voiceToggle.isDisabled()) {
      await expect(page.getByText(/voice unavailable/)).toBeVisible()
      await expect(page.getByText(/type mode still works/)).toBeVisible()
    }
  })
})
