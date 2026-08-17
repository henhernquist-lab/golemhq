// Infinite Campus student portal scraper — read-only, per-user.
// Infinite Campus has NO public student API. This uses Playwright to log in
// with each user's stored IC credentials, navigate to the assignments and
// announcements views, and parse the rendered page.
//
// Credentials are stored encrypted in user_credentials (service='infinite_campus')
// and decrypted at runtime. No env var fallback — every user provides their own.
//
// Portal URL: https://ic.apsk12.org/campus/portal/students/atlanta.jsp

// Playwright is a devDependency and is NOT installed in the deployed bundle.
// A static `import … from 'playwright'` here therefore resolved fine in dev and
// during the build, then failed at cold start in production with
// "Can't resolve 'playwright'" — taking down the whole module graph of every
// route that imported this file. /api/chat and /api/school both did, which is
// why both returned Next's raw HTML 500 for every method, before any handler
// code ran. Type-only imports are erased at compile time and are safe; the
// runtime import must stay lazy, inside the one function that launches a
// browser, so importing this module costs nothing.
import type { Browser, Page } from 'playwright'
import { supabase } from '@/lib/supabase'
import { decrypt } from '@/lib/crypto'

const PORTAL_URL = 'https://ic.apsk12.org/campus/portal/students/atlanta.jsp'

export interface ICAssignment {
  name: string
  course: string
  dueDate: string | null
  category: string | null
  score: string | null
  totalPoints: string | null
  status: string | null
}

export interface ICAnnouncement {
  course: string
  text: string
  date: string | null
}

// ── Browser management ──────────────────────────────────────────────────────

let _browser: Browser | null = null

/**
 * Scraping is only possible where Playwright and a browser binary exist — a
 * real machine, not the serverless bundle. The import is deferred to here and
 * its failure is reported as a normal error string, so a caller on Vercel gets
 * "unavailable" instead of an unhandled module-resolution crash.
 */
async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser
  let chromium: typeof import('playwright').chromium
  try {
    ({ chromium } = await import('playwright'))
  } catch {
    throw new Error(
      'Infinite Campus scraping is unavailable in this environment: Playwright is not installed. ' +
        'It runs only where a browser binary is available, not on the serverless deployment.',
    )
  }
  _browser = await chromium.launch({ headless: true })
  return _browser
}

// ── Credential lookup ───────────────────────────────────────────────────────

async function getCredentials(uid: string): Promise<{
  username: string
  password: string
  error: string | null
}> {
  const { data } = await supabase
    .from('user_credentials')
    .select('credential_a, credential_b')
    .eq('user_id', uid)
    .eq('service', 'infinite_campus')
    .maybeSingle()

  if (!data?.credential_a || !data?.credential_b) {
    return {
      username: '',
      password: '',
      error: 'Infinite Campus is not configured. Go to Settings → School to add your IC login.',
    }
  }

  try {
    return {
      username: decrypt(data.credential_a),
      password: decrypt(data.credential_b),
      error: null,
    }
  } catch (e) {
    return {
      username: '',
      password: '',
      error: 'Failed to decrypt IC credentials. Try re-saving them in Settings.',
    }
  }
}

// ── Login ───────────────────────────────────────────────────────────────────

async function login(
  uid: string,
): Promise<{ page: Page; error: string | null }> {
  const { username, password, error: credError } = await getCredentials(uid)
  if (credError) {
    return { page: null as unknown as Page, error: credError }
  }

  let browser: Browser
  try {
    browser = await getBrowser()
  } catch (e) {
    return { page: null as unknown as Page, error: `Failed to launch browser: ${String(e)}` }
  }

  const context = await browser.newContext()
  const page = await context.newPage()

  try {
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle', timeout: 30_000 })

    await page.fill('input[name="username"]', username)
    await page.fill('input[name="password"]', password)
    await page.click('input[type="submit"], button[type="submit"], #loginButton, .login-button')

    await page.waitForURL(/campus\/portal\/students\/atlanta\.jsp/, {
      timeout: 20_000,
      waitUntil: 'networkidle',
    })

    const errorMsg = await page.$('.error-message, .alert-danger, #errorMessage')
    if (errorMsg) {
      const text = await errorMsg.textContent()
      await context.close()
      return { page: null as unknown as Page, error: `IC login failed: ${text?.trim() ?? 'unknown error'}` }
    }

    return { page, error: null }
  } catch (e) {
    await context.close()
    return { page: null as unknown as Page, error: `IC login failed: ${String((e as Error)?.message ?? e)}` }
  }
}

// ── Scrape assignments ──────────────────────────────────────────────────────

export async function getAssignments(uid: string): Promise<{
  assignments: ICAssignment[]
  error: string | null
}> {
  const { page, error: loginError } = await login(uid)
  if (loginError) return { assignments: [], error: loginError }

  try {
    const context = page.context()

    await page.goto(PORTAL_URL, {
      waitUntil: 'networkidle',
      timeout: 20_000,
    })

    const gradesTab = await page.$('a[href*="grades"], a:has-text("Grades"), #grades, .tab-grades')
    if (gradesTab) {
      await gradesTab.click()
      await page.waitForLoadState('networkidle')
    }

    const rawRows = await page.$$eval(
      'table tr, .assignment-row, .gradebook-row, [data-row]',
      (els) =>
        els
          .map((el) => {
            const cells = el.querySelectorAll('td, th')
            if (cells.length < 3) return null
            const texts = Array.from(cells).map((c) => c.textContent?.trim() ?? '')
            return {
              name: texts[0] ?? '',
              course: texts[1] ?? '',
              dueDate: texts[2] || null,
              category: texts[3] || null,
              score: texts[4] || null,
              totalPoints: texts[5] || null,
              status: texts[6] || null,
            }
          })
          .filter(
            (r): r is { name: string; course: string; dueDate: string | null; category: string | null; score: string | null; totalPoints: string | null; status: string | null } =>
              r !== null && r.name.length > 0 && !r.name.includes('Assignment'),
          ),
    )

    const rows: ICAssignment[] = rawRows

    await context.close()
    return { assignments: rows, error: null }
  } catch (e) {
    await page.context().close()
    return {
      assignments: [],
      error: `IC scrape failed: ${String((e as Error)?.message ?? e)}`,
    }
  }
}

// ── Scrape announcements ────────────────────────────────────────────────────

export async function getAnnouncements(uid: string): Promise<{
  announcements: ICAnnouncement[]
  error: string | null
}> {
  const { page, error: loginError } = await login(uid)
  if (loginError) return { announcements: [], error: loginError }

  try {
    const context = page.context()

    await page.goto(PORTAL_URL, {
      waitUntil: 'networkidle',
      timeout: 20_000,
    })

    const items = await page.$$eval(
      '.announcement-item, .message-item, .notification-item, .portal-announcement, .dashboard-message',
      (els) =>
        els.map((el) => {
          const text = el.textContent?.trim() ?? ''
          const course = el.querySelector('.course-name, .class-name, .subject')?.textContent?.trim() ?? 'General'
          const date = el.querySelector('.date, .timestamp, .time')?.textContent?.trim() ?? null
          return { course, text, date }
        }),
    )

    if (items.length === 0) {
      const blocks = await page.$$eval(
        '.dashboard-widget, .portal-block, .content-block, .message-block',
        (els) =>
          els.map((el) => {
            const header = el.querySelector('h2, h3, h4, .block-title')?.textContent?.trim()
            const text = el.textContent?.trim() ?? ''
            const date = el.querySelector('.date, .timestamp')?.textContent?.trim() ?? null
            return { course: header ?? 'General', text, date }
          }),
      )
      await context.close()
      return { announcements: blocks, error: null }
    }

    await context.close()
    return { announcements: items, error: null }
  } catch (e) {
    await page.context().close()
    return {
      announcements: [],
      error: `IC scrape failed: ${String((e as Error)?.message ?? e)}`,
    }
  }
}
