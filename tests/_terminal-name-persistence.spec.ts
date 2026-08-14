import { test, expect } from 'playwright/test'

/**
 * Why "opencodeopencode" survives the b8a33a0 fix.
 *
 * The fix stops the name from being BUILT wrongly. It does nothing about a
 * wrong name that is already persisted — records, including `name`, are
 * written to localStorage and restored verbatim, and the reconnect probe
 * carries the name across onto a brand new PTY. Worse, the fix made the name
 * stickier: a line the reconstruction cannot model (history recall with the up
 * arrow — the obvious way to relaunch a CLI) is now deliberately NOT used for
 * naming, so nothing overwrites the stale label.
 *
 * Throwaway: evidence, not a guard.
 */
const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD
const STORAGE_KEY = 'golem.drive.terminals.v3'
const POISON = 'opencodeopencode'

async function login(page: import('playwright/test').Page) {
  await page.goto('/login')
  await page.getByRole('button', { name: 'email', exact: true }).click()
  await page.locator('button[type="button"]', { hasText: /^sign in$/ }).first().click()
  await page.getByPlaceholder('email').fill(EMAIL!)
  await page.getByPlaceholder('password').fill(PASSWORD!)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 })
}

test.describe('terminal name persistence', () => {
  test.skip(!EMAIL || !PASSWORD, 'needs E2E credentials')
  test.setTimeout(240_000)

  test('a stale bad name survives onto a fresh PTY and is never corrected', async ({ page }) => {
    await login(page)

    // Exactly what a workspace saved before the fix looks like. The id is
    // dead on purpose: the hydration probe will replace the session and keep
    // the name, which is the carry-over being tested.
    await page.evaluate(
      ([key, name]) => {
        const paneId = 'pane-poison'
        const id = 'dead-session-0000'
        localStorage.setItem(
          key,
          JSON.stringify({
            version: 3,
            records: [{ id, name, cwd: '/home/codespace', createdAt: Date.now(), autoName: true }],
            closed: [],
            layout: { kind: 'pane', id: paneId, terminalIds: [id], activeId: id },
            focusedPaneId: paneId,
          }),
        )
      },
      [STORAGE_KEY, POISON],
    )

    await page.goto('/forge')
    await page.getByRole('button', { name: /^Terminals$/ }).first().click()
    await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 60_000 })
    await page.waitForTimeout(4000)

    const tabNames = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('button'))
          .filter((b) => b.getAttribute('title') === 'Double-click to rename')
          .map((b) => b.textContent?.trim() ?? ''),
      )

    console.log('TABS_ON_FRESH_PTY=' + JSON.stringify(await tabNames()))

    await page.locator('textarea.xterm-helper-textarea').first().focus()

    // Seed shell history WITHOUT letting the tab rename itself: the line is
    // typed, then abandoned with Ctrl-C after being pushed into history via a
    // comment, so the poisoned name is still in place for the real test.
    await page.keyboard.type('opencode # seed')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2500)
    console.log('TABS_AFTER_SEED=' + JSON.stringify(await tabNames()))

    // Relaunch the way a person actually does it: up-arrow, Enter.
    await page.keyboard.press('ArrowUp')
    await page.waitForTimeout(400)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(12_000)
    console.log('TABS_AFTER_HISTORY_RELAUNCH=' + JSON.stringify(await tabNames()))
    await page.keyboard.press('Control+C')
    await page.waitForTimeout(600)
    await page.keyboard.press('Control+C')
    await page.waitForTimeout(2500)

    console.log('TABS_FINAL=' + JSON.stringify(await tabNames()))
  })
})
