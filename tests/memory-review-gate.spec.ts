import { test, expect } from 'playwright/test'

/**
 * The memory auto-fill review gate, driven through the real app in a real
 * browser: a pending fact, visually distinguished from a manual one, Accepted
 * by clicking the button, then recalled by semantic search in a later request.
 *
 * Two things this test deliberately does NOT do, because the app cannot:
 *
 * 1. It does not type a multi-turn conversation. `/m/chat` — the last surface
 *    that sent a conversation to /api/chat, where the extraction hook lives —
 *    was deleted in d1c705e, and the only surviving consumer (`/m/tools`) sends
 *    single-message arrays that can never reach the hook's MIN_USER_TURNS of 3.
 *    The pending fact is seeded out-of-band by scripts/_seed-pending-fact.mjs,
 *    which calls the same extractAndSaveAutoMemories() the route calls, and its
 *    marker is passed in as QA_MARKER.
 * 2. The recall leg is opt-in via RECALL=1, because it needs a working
 *    /api/chat and production's currently returns 500 for every model.
 */
const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD
const MARKER = process.env.QA_MARKER

test.use({ launchOptions: { args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'] } })

async function login(page: import('playwright/test').Page) {
  await page.goto('/login')
  await page.getByRole('button', { name: 'email', exact: true }).click()
  await page.locator('button[type="button"]', { hasText: /^sign in$/ }).first().click()
  await page.getByPlaceholder('email').fill(EMAIL!)
  await page.getByPlaceholder('password').fill(PASSWORD!)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 })
}

test.describe('memory review gate', () => {
  test.skip(!EMAIL || !PASSWORD || !MARKER, 'Set E2E_EMAIL, E2E_PASSWORD and QA_MARKER to run this.')

  test('pending fact is distinguished from a manual one, and Accept works', async ({ page }, testInfo) => {
    test.setTimeout(240_000)
    await login(page)

    const manual = `Manual control fact ${MARKER}-MANUAL — typed by hand, never auto-captured.`

    await page.goto('/settings?tab=memory')
    await expect(page.getByRole('heading', { name: 'Memory' })).toBeVisible({ timeout: 60_000 })

    // A manual fact typed into the real Quick Add box, so the pending auto
    // fact has something to be visually distinguished FROM.
    await page.getByPlaceholder('Facts, preferences, context…').fill(manual)
    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await expect(page.getByText(`${MARKER}-MANUAL`)).toBeVisible({ timeout: 30_000 })

    // Two different source labels on screen at once is the distinction.
    await expect(page.getByText('auto · chat · review').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('manual').first()).toBeVisible()
    await testInfo.attach('pending-review', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })

    await page.getByRole('button', { name: 'Accept fact' }).first().click()
    await expect(page.getByText('auto · chat · accepted').first()).toBeVisible({ timeout: 30_000 })
    // The UI's honest signal when the pgvector mirror fails. Its absence is
    // the assertion that the mirror succeeded; the DB check proves it.
    await expect(page.getByText(/not added to chat recall/)).toHaveCount(0)
    await testInfo.attach('accepted', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  })

  test('an accepted fact is recalled by semantic search in a later request', async ({ page }, testInfo) => {
    test.skip(process.env.RECALL !== '1', 'Set RECALL=1 against a base URL whose /api/chat works.')
    test.setTimeout(240_000)
    await login(page)

    // /m/tools' Memory Search posts to /api/chat with focusMode 'memory_only'
    // — a real later request, resolved by pgvector over the recall store the
    // Accept wrote to. Nothing here mentions the marker.
    await page.goto('/m/tools')
    await page.getByPlaceholder('What did I say about…')
      .fill('my telemetry dashboard side project and how I deploy it')
    await page.getByRole('button', { name: 'Go', exact: true }).last().click()

    await expect(page.getByText(new RegExp(MARKER!))).toBeVisible({ timeout: 180_000 })
    await testInfo.attach('recalled', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  })
})
