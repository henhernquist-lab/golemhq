import { test, expect } from 'playwright/test'

/**
 * Batch 9 — proves the Command tab actually ignites the shipped pipeline.
 *
 * Uses a real owner session (scripts/mint-session.mjs) because /api/missions/*
 * is owner-gated by design and E2E_EMAIL is deliberately not the owner. The
 * gate is exercised, not bypassed: the cookie is a genuine signed session for
 * OWNER_EMAIL, minted with NEXTAUTH_SECRET the same way a real login does.
 */
const TOKEN = process.env.OWNER_SESSION_TOKEN

test.use({ launchOptions: { args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'] } })

test.describe('head agent', () => {
  test.skip(!TOKEN, 'Set OWNER_SESSION_TOKEN (scripts/mint-session.mjs) to run this.')

  test('a typed request becomes a real mission with a real task graph', async ({ page, context }, testInfo) => {
    test.setTimeout(300_000)
    await context.addCookies([{
      name: 'authjs.session-token', value: TOKEN!, domain: 'localhost', path: '/',
      httpOnly: true, secure: false, sameSite: 'Lax',
    }])

    await page.goto('/forge')
    await page.getByRole('button', { name: 'Command', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'command' })).toBeVisible({ timeout: 30_000 })
    const shotDir = process.env.SHOT_DIR
await testInfo.attach('command-empty', { body: await page.screenshot({ fullPage: true, ...(shotDir ? { path: `${shotDir}/command-empty.png` } : {}) }), contentType: 'image/png' })

    await page.getByPlaceholder(/Add a \/api\/uptime route/).fill(
      'Add a GET /api/version route that returns { version } read from package.json, with a Playwright test.',
    )
    await page.getByRole('button', { name: /plan mission/ }).click()

    // Real planner call against a real model. Two legitimate outcomes, and
    // both prove the surface reached the real pipeline rather than a stub:
    // a task graph, or the store's one-active-mission-per-repo guard (which
    // fires when another session is already running a mission on this repo).
    const graph = page.getByText('task graph', { exact: true })
    const activeGuard = page.getByText(/already has an active mission/)
    await expect(graph.or(activeGuard).first()).toBeVisible({ timeout: 180_000 })
    await testInfo.attach('command-planned', { body: await page.screenshot({ fullPage: true, ...(shotDir ? { path: `${shotDir}/command-planned.png` } : {}) }), contentType: 'image/png' })

    if (await activeGuard.count()) {
      // The guard names the mission that holds the repo — real store state.
      await expect(activeGuard).toContainText(/status "(planning|running)"/)
      test.info().annotations.push({ type: 'note', description: 'repo held by another active mission; guard path asserted' })
      return
    }

    await expect(page.getByText('live · mission_events')).toBeVisible()
    // Real events from the real stream, not a synthesised confirmation.
    await expect(page.getByText(/plan ready — \d+ tasks/)).toBeVisible({ timeout: 30_000 })
  })
})
