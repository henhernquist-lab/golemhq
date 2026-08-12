import { test, expect } from 'playwright/test'

/**
 * Measures per-keystroke terminal latency in a real browser, by typing real
 * keys into the real terminal and reading the instrumentation the input path
 * records about itself.
 *
 * Keys go through page.keyboard.type, not a synthesised onData call — the
 * point is to measure the path a person's keystroke actually takes, including
 * xterm's own handling, so anything that injects further down would skip the
 * part being measured.
 *
 * Throwaway: this exists to produce a before/after number, not to guard
 * behaviour.
 */
const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD
const PHRASE = 'echo probe'

// Launch flags deliberately NOT overridden here: playwright.config.ts already
// sets --disable-dev-shm-usage and the swiftshader flags, and re-declaring a
// partial list replaces them rather than adding to them — which is how an
// earlier version of this file removed the GPU flags the config had put there.
// The crashes seen while writing this were host memory pressure, not /dev/shm.
test.use({ viewport: { width: 1280, height: 720 } })

test.describe('terminal latency', () => {
  test.skip(!EMAIL || !PASSWORD, 'needs owner credentials')
  test.setTimeout(300_000)

  test('measure keystroke path', async ({ page }) => {
    page.on('console', (m) => {
      const t = m.text()
      if (t.startsWith('LATENCY')) console.log(t)
    })

    // Enable the recorder before any app code runs, since it reads
    // localStorage once at module construction.
    await page.addInitScript(() => localStorage.setItem('golem:termtiming', '1'))

    await page.goto('/login')
    await page.getByRole('button', { name: 'email', exact: true }).click()
    await page.locator('button[type="button"]', { hasText: /^sign in$/ }).first().click()
    await page.getByPlaceholder('email').fill(EMAIL!)
    await page.getByPlaceholder('password').fill(PASSWORD!)
    await page.locator('button[type="submit"]').click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 })

    await page.goto('/forge')

    // Terminals live behind the Terminals tab in the unified Drive view, and
    // the workspace starts with zero panes — one has to be opened.
    await page.getByRole('button', { name: /^Terminals$/i }).first().click()
    await page.getByRole('button', { name: /New Terminal/i }).first().click()

    // xterm does not receive keys on the canvas — it keeps a hidden textarea
    // (.xterm-helper-textarea) as the real focus target and reads key events
    // from it. Clicking the screen alone left it unfocused, which is why an
    // earlier run typed 24 characters and produced zero input requests.
    const screen = page.locator('.xterm-screen, .xterm').first()
    await expect(screen).toBeVisible({ timeout: 90_000 })
    await screen.click()
    const helper = page.locator('textarea.xterm-helper-textarea').first()
    await expect(helper).toBeAttached({ timeout: 30_000 })
    await helper.focus()

    // Let the shell settle and the prompt paint before measuring, so the
    // first sample is not competing with session startup.
    await page.waitForTimeout(5000)
    await page.evaluate(() => (window as any).__golemTermTiming?.clear())

    // Typed with a human-ish gap: bursts hide queueing behind coalescing and
    // would flatter the result.
    for (const ch of PHRASE) {
      await page.keyboard.type(ch)
      await page.waitForTimeout(120)
    }

    // Give the slowest echoes time to land before reading.
    await page.waitForTimeout(5000)

    const report = await page.evaluate(() => {
      const t = (window as any).__golemTermTiming
      return t ? { report: t.report(), raw: t.all().slice(0, 8) } : null
    })

    console.log(`LATENCY_REPORT=${JSON.stringify(report, null, 2)}`)
    expect(report, 'the timing recorder was not present — is it enabled?').not.toBeNull()
    // A run that records nothing is a broken probe, not a fast terminal.
    expect(report!.report.samples, 'no keystrokes were recorded — xterm never got focus').toBeGreaterThan(0)
    expect(report!.report.echoed, 'no echo was ever matched — t3/t4 are unmeasured').toBeGreaterThan(0)
  })
})
