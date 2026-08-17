import { test, expect } from 'playwright/test'

/**
 * The Lab manual-trigger leg of Memory auto-fill: clicking "Scan Lab activity"
 * in the real Settings > Memory tab, against real evolution_runs rows created
 * by real /api/lab/evolve invocations (not seeded rows).
 */
const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

test.use({ launchOptions: { args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'] } })

test.describe('memory lab scan', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD to run this.')

  test('Scan Lab activity runs against real Lab rows and reports its outcome', async ({ page }, testInfo) => {
    test.setTimeout(240_000)

    await page.goto('/login')
    await page.getByRole('button', { name: 'email', exact: true }).click()
    await page.locator('button[type="button"]', { hasText: /^sign in$/ }).first().click()
    await page.getByPlaceholder('email').fill(EMAIL!)
    await page.getByPlaceholder('password').fill(PASSWORD!)
    await page.locator('button[type="submit"]').click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 })

    await page.goto('/settings?tab=memory')
    await expect(page.getByRole('heading', { name: 'Memory' })).toBeVisible({ timeout: 60_000 })

    await page.getByRole('button', { name: 'Scan Lab activity' }).click()

    // Either a new fact to review, or an honest reason nothing was written.
    // Both are real outcomes; a silent no-op would not be.
    const banner = page.locator('text=/Found \\d+ new fact|no recurring pattern|already exist in Memory|only \\d+ Lab run/')
    await expect(banner.first()).toBeVisible({ timeout: 120_000 })
    const outcome = await banner.first().innerText()
    console.log('LAB SCAN OUTCOME:', outcome)
    await testInfo.attach('lab-scan', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })

    expect(outcome).not.toMatch(/only \d+ Lab run/)
  })
})
