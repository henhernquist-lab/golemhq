import { test } from 'playwright/test'

/** Does the OSC title reach the browser, and does xterm surface it? Throwaway. */
const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

test.describe('osc title', () => {
  test.skip(!EMAIL || !PASSWORD, 'needs E2E credentials')
  test.setTimeout(240_000)

  test('probe', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __osc: string[]; __bytes: number }
      w.__osc = []
      w.__bytes = 0
      const Original = window.EventSource
      class Recording extends Original {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init)
          super.addEventListener('output', (e) => {
            try {
              const text = JSON.parse((e as MessageEvent).data) as string
              w.__bytes += text.length
              for (const m of text.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
                w.__osc.push(`OSC ${m[1]} => ${JSON.stringify(m[2])}`)
              }
            } catch {
              /* ignore */
            }
          })
        }
      }
      window.EventSource = Recording as unknown as typeof EventSource
    })

    await page.goto('/login')
    await page.getByRole('button', { name: 'email', exact: true }).click()
    await page.locator('button[type="button"]', { hasText: /^sign in$/ }).first().click()
    await page.getByPlaceholder('email').fill(EMAIL!)
    await page.getByPlaceholder('password').fill(PASSWORD!)
    await page.locator('button[type="submit"]').click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 })

    await page.goto('/forge')
    await page.getByRole('button', { name: /^Terminals$/ }).first().click()
    const newTerminal = page.getByRole('button', { name: /new terminal/i }).first()
    if (await newTerminal.isVisible().catch(() => false)) await newTerminal.click()
    await page.locator('.xterm-screen').first().waitFor({ state: 'visible', timeout: 60_000 })
    await page.waitForTimeout(3000)

    await page.locator('textarea.xterm-helper-textarea').first().focus()
    await page.keyboard.type('opencode')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(20_000)

    const out = await page.evaluate(() => {
      const w = window as unknown as { __osc: string[]; __bytes: number }
      return { bytes: w.__bytes, osc: w.__osc, title: document.title }
    })
    console.log('OSC_ON_WIRE=' + JSON.stringify(out))

    const tabs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button'))
        .filter((b) => b.getAttribute('title') === 'Double-click to rename')
        .map((b) => b.textContent?.trim() ?? ''),
    )
    console.log('TABS=' + JSON.stringify(tabs))
    await page.screenshot({ path: 'test-results/osc-probe.png' })
  })
})
