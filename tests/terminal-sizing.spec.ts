import { test, expect } from 'playwright/test'

// Regression test for the terminal "autoshrink" bug.
//
// FitAddon.fit() silently no-ops when proposeDimensions() can't measure a
// cell, and the old call site swallowed that in a bare catch — leaving the
// grid on the constructor default of 80x24 (~577x384px) inside a much larger
// pane. These assertions fail if that ever comes back.
//
// The terminal is behind auth and behind the owner gate, so this needs a real
// login. Set E2E_EMAIL / E2E_PASSWORD (an account whose profiles.email matches
// OWNER_EMAIL, or the cloud-terminal routes 503) to run it. Without them the
// test skips rather than failing, so CI stays green on a repo that has no test
// credentials provisioned.

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

/** Same default the Terminal() constructor uses in terminal-pane.tsx. */
const DEFAULT_GRID = { cols: 80, rows: 24 }

test.describe('terminal sizing', () => {
  test.skip(
    !EMAIL || !PASSWORD,
    'Set E2E_EMAIL and E2E_PASSWORD (owner account) to run the terminal sizing test.',
  )

  test('a mounted terminal fills its pane and is not stuck at the default grid', async ({ page }) => {
    await page.goto('/login')
    // The email form sits behind two disclosure steps; the placeholders do
    // not exist in the DOM until both have been clicked.
    await page.getByRole('button', { name: 'email', exact: true }).click()
    await page.locator('button[type="button"]', { hasText: /^sign in$/ }).first().click()
    await page.getByPlaceholder('email').fill(EMAIL!)
    await page.getByPlaceholder('password').fill(PASSWORD!)
    await page.locator('button[type="submit"]').click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 })

    await page.goto('/forge')

    // Open a terminal, then wait for xterm to actually render a screen. The
    // Command workspace opens empty — switching to it is not enough, one has
    // to be asked for.
    await page.getByRole('button', { name: /^Terminals$/ }).first().click()
    const newTerminal = page.getByRole('button', { name: /new terminal/i }).first()
    if (await newTerminal.isVisible().catch(() => false)) await newTerminal.click()
    const screen = page.locator('.xterm-screen').first()
    await expect(screen).toBeVisible({ timeout: 30_000 })

    // Let the retrying fit settle (rAF, rAF, 50, 150, 400ms) plus fonts.ready.
    await page.waitForTimeout(1500)

    const measured = await page.evaluate(() => {
      const el = document.querySelector('.xterm-screen') as HTMLElement | null
      if (!el) return null
      const host = (el.closest('.xterm')?.parentElement ?? el.parentElement) as HTMLElement
      const s = el.getBoundingClientRect()
      const h = host.getBoundingClientRect()
      return { screen: { w: s.width, h: s.height }, host: { w: h.width, h: h.height } }
    })

    expect(measured, 'xterm screen should be in the DOM').not.toBeNull()
    const { screen: s, host: h } = measured!

    // Only meaningful when the pane is genuinely large — below ~600px the
    // default grid is a plausible fit and proves nothing.
    test.skip(h.w <= 600, `pane too small to test (${Math.round(h.w)}px wide)`)

    const grid = await page.evaluate(() => {
      const rows = document.querySelectorAll('.xterm-rows > div').length
      return { rows }
    })

    // The bug's signature: the default grid inside a big pane.
    expect(
      grid.rows === DEFAULT_GRID.rows && h.w > 600,
      `grid is stuck at the ${DEFAULT_GRID.cols}x${DEFAULT_GRID.rows} default inside a ${Math.round(h.w)}px pane`,
    ).toBeFalsy()

    // And the positive assertion: the screen fills its host within 10%.
    expect(s.w).toBeGreaterThan(h.w * 0.9)
    expect(s.h).toBeGreaterThan(h.h * 0.9)
  })
})
