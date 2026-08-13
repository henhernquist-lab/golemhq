import { test, expect } from 'playwright/test'

/**
 * Regression tests for the "terminal came back black" incident.
 *
 * Two independent things went wrong there and only one of them was ever
 * theorised about, so both get a test:
 *
 *  1. The Chat/Commands switcher hides the terminal workspace with display:none
 *     while leaving it mounted. The pane's self-heal timer used to read the
 *     resulting zero width as "healthy" and retire itself. That was fixed
 *     defensively before anyone had reproduced it; this checks whether the
 *     user-visible symptom (terminal does not come back) is real.
 *  2. A reconnect whose scrollback had been trimmed at the front replays
 *     screen updates with no screen setup, rendering black. Covered by
 *     scripts/verify-terminal-recovery.mjs, which can drive a real PTY —
 *     something a browser test cannot do.
 */

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

async function signIn(page: import('playwright/test').Page) {
  await page.goto('/login')
  await page.getByRole('button', { name: 'email', exact: true }).click()
  await page.locator('button[type="button"]', { hasText: /^sign in$/ }).first().click()
  await page.getByPlaceholder('email').fill(EMAIL!)
  await page.getByPlaceholder('password').fill(PASSWORD!)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 })
}

test.describe('terminal recovery', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD to run terminal recovery tests.')

  test('terminal survives a Chat/Commands round trip', async ({ page }) => {
    await signIn(page)
    await page.goto('/forge')

    await page.getByRole('button', { name: /^Terminals$/ }).first().click()

    // The Command workspace opens empty — there is no terminal until one is
    // asked for, so the round trip has nothing to test without this.
    const newTerminal = page.getByRole('button', { name: /new terminal/i }).first()
    if (await newTerminal.isVisible().catch(() => false)) await newTerminal.click()

    const screen = page.locator('.xterm-screen').first()
    await expect(screen).toBeVisible({ timeout: 60_000 })

    // Baseline: the grid is properly fitted before hiding.
    const before = await screen.boundingBox()
    expect(before, 'terminal had no box before hiding').not.toBeNull()
    expect(before!.width).toBeGreaterThan(200)

    // Hide it for longer than the self-heal timer's full cycle (2s per check,
    // retires after 3 consecutive "healthy" reads). If zero-width-while-hidden
    // is being counted as healthy, the safety net is gone by the time we
    // return — and any fit that was needed on reveal never happens.
    await page.getByRole('button', { name: /^Chat$/ }).first().click()
    await expect(screen).toBeHidden()
    await page.waitForTimeout(9_000)

    await page.getByRole('button', { name: /^Terminals$/ }).first().click()

    // The actual user-visible claim: it comes back, and comes back usable.
    await expect(screen).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => (await screen.boundingBox())?.width ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(200)

    const after = await screen.boundingBox()
    const host = await page.locator('.xterm').first().boundingBox()
    expect(host, 'terminal host had no box after reveal').not.toBeNull()
    // Not merely present — still filling its pane. A terminal that returns
    // collapsed to the 80x24 default is the same bug wearing a disguise.
    expect(after!.width).toBeGreaterThan(host!.width * 0.8)
  })
})
