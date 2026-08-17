import { test, expect } from 'playwright/test'

/**
 * Proves the Agency tab (Batch 8) renders real roster data, not a mock.
 *
 * Same guard as missions-dashboard.spec.ts: assertions key on data this page
 * cannot invent — the seeded agent names and their real cli_command strings.
 */
const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

test.describe('agency tab', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD to run the Agency tab test.')

  test('renders the org chart from real agents, not mock data', async ({ page }, testInfo) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'email', exact: true }).click()
    await page.getByPlaceholder('email').fill(EMAIL!)
    await page.getByPlaceholder('password').fill(PASSWORD!)
    await page.locator('button[type="submit"]').click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 })

    await page.goto('/agency')

    // Layer headers group real seeded rows, not placeholder tiers.
    await expect(page.getByText(/layer 1 · Orchestrator/)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/layer 2 · Builder/)).toBeVisible()
    await expect(page.getByText(/layer 3 · Validator/)).toBeVisible()

    // Real agent names from the seed migrations.
    await expect(page.getByText('Claude Code', { exact: true })).toBeVisible()
    await expect(page.getByText('Mission Planner', { exact: true })).toBeVisible()
    await expect(page.getByText('Type Checker', { exact: true })).toBeVisible()

    // The real cli_command string — a mock would not know the exact flags.
    await expect(page.getByText(/claude --permission-mode acceptEdits/)).toBeVisible()
    await expect(page.locator('[data-org-chart]')).toBeVisible()
    await expect(page.locator('[data-org-chart-node]')).not.toHaveCount(0)
    await testInfo.attach('phase2-after-smoothing', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    })

    // Pause/resume is a real control, not decorative — toggling flips the
    // active/paused badge via a genuine PATCH round trip.
    const claudeCard = page.locator('div', { has: page.getByText('Claude Code', { exact: true }) }).first()
    const pauseButton = claudeCard.getByRole('button').first()
    await expect(page.getByText('active', { exact: true }).first()).toBeVisible()
    await pauseButton.click()
    await expect(page.getByText('paused', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
    // Restore state so the run is idempotent for whoever runs it next.
    await pauseButton.click()
    await expect(page.getByText('active', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
  })
})
