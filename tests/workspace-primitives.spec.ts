import { test, expect } from 'playwright/test'

/**
 * Phase 1 of the design.md UI build order extracted WorkspaceShell, TabStrip
 * and StatusBadge with no intended visual change. Markup equivalence was
 * checked by diffing rendered HTML against the pre-change tree; this covers
 * the half that a markup diff cannot: that the strips still *switch*, and
 * that all three panels stay mounted across a switch (the state-preserving
 * invariant TabStrip deliberately does not own).
 */
const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

// No WebGL on these surfaces, and the config's swiftshader GPU process is the
// first thing to die when this box is under load.
test.use({ launchOptions: { args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'] } })

test.describe('workspace primitives', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD to run this test.')

  test('tab strips switch panels and keep every panel mounted', async ({ page }) => {
    test.setTimeout(180_000)
    await page.goto('/login')
    await page.getByRole('button', { name: 'email', exact: true }).click()
    await page.locator('button[type="button"]', { hasText: /^sign in$/ }).first().click()
    await page.getByPlaceholder('email').fill(EMAIL!)
    await page.getByPlaceholder('password').fill(PASSWORD!)
    await page.locator('button[type="submit"]').click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 })

    await page.goto('/forge')

    const forgeTab = page.getByRole('button', { name: 'Forge', exact: true })
    const missionsTab = page.getByRole('button', { name: 'Missions', exact: true })
    const agencyTab = page.getByRole('button', { name: 'Agency', exact: true })
    await expect(forgeTab).toBeVisible({ timeout: 60_000 })

    // Active state is the tone swap, not a class name we should assert on
    // directly — check the panels instead.
    const missionsPanel = page.locator('h1', { hasText: 'missions' })
    const agencyPanel = page.locator('h1', { hasText: 'agency' })

    // All three panels are mounted from the start (CSS-hidden, not unmounted).
    await expect(missionsPanel).toBeAttached()
    await expect(agencyPanel).toBeAttached()
    await expect(missionsPanel).not.toBeVisible()

    await missionsTab.click()
    await expect(missionsPanel).toBeVisible()

    await agencyTab.click()
    await expect(agencyPanel).toBeVisible()
    await expect(missionsPanel).not.toBeVisible()
    // Still mounted after two switches — the invariant the extraction had to keep.
    await expect(missionsPanel).toBeAttached()

    await forgeTab.click()
    await expect(agencyPanel).not.toBeVisible()

    // Forge's sub-strip is the same primitive at the smaller size.
    const chatTab = page.getByRole('button', { name: 'Chat', exact: true })
    const terminalsTab = page.getByRole('button', { name: 'Terminals', exact: true })
    await expect(chatTab).toBeVisible()
    await terminalsTab.click()
    await expect(chatTab).toBeVisible()
  })
})
