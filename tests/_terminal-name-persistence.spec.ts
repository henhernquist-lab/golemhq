import { test, expect } from 'playwright/test'

/**
 * Why "opencodeopencode" survived the b8a33a0 fix, and what now clears it.
 *
 * b8a33a0 stops the name from being BUILT wrongly. It did nothing about a
 * wrong name already persisted — records, including `name`, are written to
 * localStorage and restored verbatim, and the reconnect probe carries the name
 * onto a brand new PTY. It also made the name stickier: a line the
 * reconstruction cannot model (history recall, a paste, a mid-line edit) is
 * deliberately NOT used for naming, so nothing overwrote the stale label.
 *
 * The OSC 0/2 title closes it. This test starts from a poisoned workspace and
 * asserts nothing — it prints, so the correction is visible as a sequence.
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

  test('a stale bad name carries onto a fresh PTY, then the OSC title clears it', async ({ page }) => {
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

    // Launch with a mid-line edit, so the keystroke reconstruction refuses to
    // name it and only an OSC title can. This is the case that used to leave
    // the poisoned name on screen forever.
    await page.keyboard.type('opencode')
    // Net-zero cursor move: the command really is `opencode`, but the
    // keystroke reconstruction has seen escape sequences and will refuse to
    // name from it. Only an OSC title can fix the tab now.
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(16_000)
    console.log('TABS_AFTER_HISTORY_RELAUNCH=' + JSON.stringify(await tabNames()))
    await page.keyboard.press('Control+C')
    await page.waitForTimeout(600)
    await page.keyboard.press('Control+C')
    await page.waitForTimeout(2500)

    console.log('TABS_FINAL=' + JSON.stringify(await tabNames()))
  })
})
