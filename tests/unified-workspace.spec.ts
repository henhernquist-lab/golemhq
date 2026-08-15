import { test, expect } from 'playwright/test'

/**
 * Batch 8.5 — proves the unified /forge workspace tabs actually work against
 * real data, that there is exactly one Missions view left in the app (the
 * real spine, not Cruise's scan-and-fix), and that the Grimoire panel no
 * longer blocks the rest of the screen.
 */
const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

test.describe('unified workspace (Batch 8.5)', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD to run this test.')

  test('Forge/Missions/Agency tabs render real data, no Cruise remnants', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'email', exact: true }).click()
    await page.locator('button[type="button"]', { hasText: /^sign in$/ }).first().click()
    await page.getByPlaceholder('email').fill(EMAIL!)
    await page.getByPlaceholder('password').fill(PASSWORD!)
    await page.locator('button[type="submit"]').click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 })

    await page.goto('/forge')

    // The new top-level tab strip.
    const forgeTab = page.getByRole('button', { name: 'Forge', exact: true })
    const missionsTab = page.getByRole('button', { name: 'Missions', exact: true })
    const agencyTab = page.getByRole('button', { name: 'Agency', exact: true })
    await expect(forgeTab).toBeVisible({ timeout: 30_000 })
    await expect(missionsTab).toBeVisible()
    await expect(agencyTab).toBeVisible()

    // Switch to Missions — must be the real spine (Layer labels, real agent
    // names), and must NOT show any Cruise-flavored copy.
    await missionsTab.click()
    await expect(page.getByText('agent roster', { exact: false })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Claude Code', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/Scan-and-fix runs started from Cruise/)).toHaveCount(0)
    await expect(page.getByText(/run a scan from Cruise/)).toHaveCount(0)

    // Switch to Agency — org chart, real cli_command strings.
    await agencyTab.click()
    await expect(page.getByText(/layer 1 · Orchestrator/)).toBeVisible({ timeout: 30_000 })
    // Missions' roster table stays mounted (just hidden) when Agency is
    // active, same pattern as Forge's own Chat/Terminals switcher — so this
    // targets the AgentCard's own <p title> specifically, not the <td> in
    // Missions' (currently hidden) table.
    await expect(page.locator('p[title="claude --permission-mode acceptEdits -p"]')).toBeVisible()

    // Part D: confirm there is no general ChatGPT-style main chat panel above
    // the org chart — only the per-agent AgentChatPanel, which opens on
    // demand from a card's "chat" button and is not present until clicked.
    const inputBoxes = page.locator('input[placeholder="ask it something…"], input[placeholder="opening chat…"]')
    await expect(inputBoxes).toHaveCount(0)

    // Back to Forge — the coding agent chat is still there, untouched.
    await forgeTab.click()
    await expect(page.getByPlaceholder(/Describe what you want changed|Select a repository above/)).toBeVisible({ timeout: 15_000 })
  })

  test('Grimoire notes panel does not blur or block the rest of the screen', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'email', exact: true }).click()
    await page.locator('button[type="button"]', { hasText: /^sign in$/ }).first().click()
    await page.getByPlaceholder('email').fill(EMAIL!)
    await page.getByPlaceholder('password').fill(PASSWORD!)
    await page.locator('button[type="submit"]').click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 })

    await page.goto('/')
    await page.getByLabel('Open The Grimoire').click()
    await expect(page.getByText('The Grimoire', { exact: true })).toBeVisible({ timeout: 10_000 })

    // No backdrop element anywhere in the DOM while the panel is open.
    await expect(page.locator('.backdrop-blur-sm')).toHaveCount(0)

    // The rest of the page must still be interactive — the sidebar's Home
    // link should be clickable without first dismissing anything.
    await expect(page.getByRole('link', { name: /^Home$/ })).toBeEnabled()
  })
})
