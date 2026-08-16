import { test, expect } from 'playwright/test'

/**
 * Proves the Memory auto-fill review pipeline end to end against a REAL
 * conversation — not a mock. Posts a real 3-user-turn conversation straight
 * to the live /api/chat route (the same route and the same
 * extractAndSaveAutoMemories() hook a chat UI would trigger — a concurrent
 * session removed the only remaining multi-turn chat UI, /m/chat, mid-batch,
 * so this drives the real server route directly with the same request shape
 * /api/m/tools already sends it, rather than through a now-gone UI), then
 * confirms a new PENDING fact appears in the merged Settings > Memory tab,
 * and that Accept moves it to reviewed.
 */
const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

test.describe('memory auto-extract', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD to run this test.')

  test('a real chat request produces a pending fact, and Accept works', async ({ page }) => {
    test.setTimeout(240_000)
    await page.goto('/login')
    await page.getByRole('button', { name: 'email', exact: true }).click()
    await page.locator('button[type="button"]', { hasText: /^sign in$/ }).first().click()
    await page.getByPlaceholder('email').fill(EMAIL!)
    await page.getByPlaceholder('password').fill(PASSWORD!)
    await page.locator('button[type="submit"]').click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 })

    // Unique marker so this run's fact is unambiguous in the review list.
    const marker = `QA-${Date.now()}`

    // Real POST to the live /api/chat route, same request shape the
    // surviving mobile tool utility (src/app/m/tools/page.tsx) sends it —
    // {role, content} messages, normalized server-side by toUIMessages().
    // Three user turns in one call triggers extractAndSaveAutoMemories()
    // exactly as three real round-trips would.
    const res = await page.request.post('/api/chat', {
      data: {
        messages: [
          { role: 'user', content: 'What is 2+2? Answer in one word.' },
          { role: 'assistant', content: 'Four.' },
          { role: 'user', content: 'What is the capital of France? Answer in one word.' },
          { role: 'assistant', content: 'Paris.' },
          { role: 'user', content: `Just so you know, for this test my callsign is ${marker} and I always want you to remember it as a durable fact about me.` },
        ],
        model: 'z-ai/glm-5.2',
      },
      timeout: 120_000,
    })
    expect(res.ok()).toBeTruthy()
    // Drain the stream so the request actually completes server-side —
    // the extraction hook fires after the response finishes.
    await res.body()

    // Fire-and-forget background work after the response completes — give it
    // real time to run a real LLM extraction call and a real DB write.
    await page.waitForTimeout(20_000)

    await page.goto('/settings?tab=memory')
    await expect(page.getByRole('heading', { name: 'Memory' })).toBeVisible({ timeout: 20_000 })

    // Real proof: a pending fact mentioning this run's unique marker exists.
    const pendingFact = page.getByText(new RegExp(marker)).first()
    await expect(pendingFact).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('auto · chat · review').first()).toBeVisible()

    // Accept it — real PATCH round trip, moves reviewState to reviewed and
    // mirrors into the legacy recall store.
    const row = page.locator('div', { has: pendingFact }).first()
    await row.getByRole('button', { name: 'Accept fact' }).click()
    await expect(page.getByText('auto · chat · accepted').first()).toBeVisible({ timeout: 15_000 })
  })
})
