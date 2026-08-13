import { test, expect } from 'playwright/test'

/**
 * Diagnostic probe for three reported terminal-workspace bugs. Throwaway:
 * this exists to produce evidence, not to guard behaviour.
 *
 *  1. the workspace fullscreen button appears to do nothing
 *  2. OpenCode blanks to black after typing
 *  3. relaunching OpenCode concatenates the tab name ("opencodeopencode")
 *
 * Everything is measured from the live DOM and the live SSE wire, because the
 * rendered xterm state is exactly what cannot be trusted in bugs 2 and 3.
 */
const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

async function login(page: import('playwright/test').Page) {
  await page.goto('/login')
  // The email form is behind two disclosure steps; the placeholders do not
  // exist until both are clicked.
  await page.getByRole('button', { name: 'email', exact: true }).click()
  await page.locator('button[type="button"]', { hasText: /^sign in$/ }).first().click()
  await page.getByPlaceholder('email').fill(EMAIL!)
  await page.getByPlaceholder('password').fill(PASSWORD!)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 })
}

async function openWorkspace(page: import('playwright/test').Page) {
  await page.goto('/forge')
  await page.getByRole('button', { name: /^Terminals$/ }).first().click()
  const screen = page.locator('.xterm-screen').first()
  if (!(await screen.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /New Terminal/i }).first().click()
  }
  await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(2000)
}

test.describe('terminal bugs', () => {
  test.skip(!EMAIL || !PASSWORD, 'needs E2E credentials')
  test.setTimeout(300_000)

  test('bug 1 — fullscreen button', async ({ page }) => {
    await login(page)
    await openWorkspace(page)

    const measure = () =>
      page.evaluate(() => {
        // The workspace root is the element that carries `fixed inset-0` when
        // fullscreen; find it by the toolbar it owns rather than by class.
        const label = Array.from(document.querySelectorAll('span')).find(
          (s) => s.textContent?.trim() === 'Command Workspace',
        )
        const root = label?.closest('div')?.parentElement ?? null
        if (!root) return null
        const r = root.getBoundingClientRect()
        const cs = getComputedStyle(root)
        return {
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          position: cs.position,
          zIndex: cs.zIndex,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          nativeFullscreen: document.fullscreenElement === root,
          anyFullscreen: !!document.fullscreenElement,
          // A `fixed` child resolves against the nearest ancestor with a
          // transform/filter/perspective/contain, not the viewport — the
          // classic reason a fixed-inset overlay silently stays put.
          containingBlockAncestors: (() => {
            const out: string[] = []
            for (let el = root.parentElement; el; el = el.parentElement) {
              const s = getComputedStyle(el)
              if (
                s.transform !== 'none' ||
                s.filter !== 'none' ||
                s.perspective !== 'none' ||
                s.backdropFilter !== 'none' ||
                /paint|layout|strict|content/.test(s.contain) ||
                /transform|filter|perspective/.test(s.willChange)
              ) {
                out.push(
                  `${el.tagName}.${el.className?.toString().slice(0, 60)} transform=${s.transform} filter=${s.filter} contain=${s.contain} willChange=${s.willChange}`,
                )
              }
            }
            return out
          })(),
        }
      })

    // What the xterm screen itself measures — the thing a person judges
    // "did it get bigger?" by.
    const screenRect = () =>
      page.evaluate(() => {
        const el = document.querySelector('.xterm-screen') as HTMLElement | null
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      })

    // Every button in the workspace that carries a maximize/fullscreen icon.
    const iconButtons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button'))
        .map((b) => b.getAttribute('title') ?? '')
        .filter((t) => /maximi[sz]e|fullscreen|restore/i.test(t)),
    )
    console.log('MAXIMIZE_BUTTONS=' + JSON.stringify(iconButtons, null, 1))
    console.log('PANE_COUNT=' + (await page.locator('.xterm-screen').count()))

    const before = await measure()
    console.log('FS_BEFORE=' + JSON.stringify(before, null, 2))
    console.log('SCREEN_BEFORE=' + JSON.stringify(await screenRect()))

    // 1. the pane-level "Maximize terminal" button inside TerminalPane
    await page.getByTitle('Maximize terminal').first().click()
    await page.waitForTimeout(800)
    console.log('SCREEN_AFTER_MAXIMIZE_TERMINAL=' + JSON.stringify(await screenRect()))
    console.log('ROOT_AFTER_MAXIMIZE_TERMINAL=' + JSON.stringify((await measure())?.rect))
    await page.getByTitle('Restore terminal layout').first().click()
    await page.waitForTimeout(500)

    // 2. the workspace "Fullscreen workspace" button
    await page.getByTitle(/Fullscreen workspace/i).first().click()
    await page.waitForTimeout(1200)

    const after = await measure()
    console.log('FS_AFTER=' + JSON.stringify(after, null, 2))
    console.log('SCREEN_AFTER_FULLSCREEN=' + JSON.stringify(await screenRect()))
    await page.screenshot({ path: 'test-results/fs-after.png' })

    expect(before, 'workspace root not found').not.toBeNull()
    expect(after, 'workspace root not found after click').not.toBeNull()
  })

  test('bug 1b — with two panes, maximize still maximizes within the workspace', async ({ page }) => {
    await login(page)
    await openWorkspace(page)

    const screenRects = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.xterm-screen')).map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect()
          return { w: Math.round(r.width), h: Math.round(r.height) }
        }),
      )

    await page.getByTitle('Split pane vertically').first().click()
    await expect(page.locator('.xterm-screen')).toHaveCount(2, { timeout: 60_000 })
    await page.waitForTimeout(2500)
    console.log('TWO_PANES=' + JSON.stringify(await screenRects()))

    await page.getByTitle('Maximize pane within the workspace').first().click()
    await page.waitForTimeout(1200)
    console.log('AFTER_MAXIMIZE=' + JSON.stringify(await screenRects()))
    console.log('STILL_IN_PAGE=' + (await page.evaluate(() => !document.fullscreenElement)))
  })

  test('bug 3 — repeated OpenCode launches and the tab name', async ({ page }) => {
    // Record the exact bytes leaving the browser: the tab name is derived from
    // this stream, so a name that looks wrong is a claim about these bytes.
    await page.addInitScript(() => {
      const w = window as unknown as { __sent: string[] }
      w.__sent = []
      const original = window.fetch
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (/\/api\/terminal\/pty\/.*\/input/.test(url) && typeof init?.body === 'string') {
          try {
            w.__sent.push((JSON.parse(init.body) as { data: string }).data)
          } catch {
            /* not the shape expected */
          }
        }
        return original(input, init)
      }
    })

    await login(page)
    await openWorkspace(page)

    const tabNames = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('button'))
          .filter((b) => b.getAttribute('title') === 'Double-click to rename')
          .map((b) => b.textContent?.trim() ?? ''),
      )

    const helper = page.locator('textarea.xterm-helper-textarea').first()
    await helper.focus()

    console.log('TABS_INITIAL=' + JSON.stringify(await tabNames()))

    for (let i = 1; i <= 2; i++) {
      await page.keyboard.type('opencode')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(14_000)
      console.log(`TABS_AFTER_LAUNCH_${i}=` + JSON.stringify(await tabNames()))

      // Interact the way a person does inside the TUI: type a message, submit
      // it, move the mouse over the pane (OpenCode turns on any-motion mouse
      // reporting, so this puts escape sequences into the same input stream).
      await page.keyboard.type('hello there')
      await page.mouse.move(700, 400)
      await page.mouse.move(720, 420)
      await page.waitForTimeout(1000)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(3000)
      console.log(`TABS_AFTER_TUI_MESSAGE_${i}=` + JSON.stringify(await tabNames()))

      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      await page.keyboard.press('Control+C')
      await page.waitForTimeout(500)
      await page.keyboard.press('Control+C')
      await page.waitForTimeout(3000)
      console.log(`TABS_AFTER_EXIT_${i}=` + JSON.stringify(await tabNames()))
    }

    const sent = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent)
    console.log('SENT=' + JSON.stringify(sent))
  })

  test('bug 3b — an escape sequence mid-line leaves the name buffer dirty', async ({ page }) => {
    await login(page)
    await openWorkspace(page)

    const tabNames = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('button'))
          .filter((b) => b.getAttribute('title') === 'Double-click to rename')
          .map((b) => b.textContent?.trim() ?? ''),
      )

    await page.locator('textarea.xterm-helper-textarea').first().focus()

    // Type a word, then send an escape sequence instead of Enter — an arrow
    // key, exactly what any line edit or history recall produces.
    await page.keyboard.type('opencode')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(500)
    console.log('TABS_AFTER_ARROW=' + JSON.stringify(await tabNames()))

    // Now run something for real.
    await page.keyboard.type('opencode')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(6000)
    console.log('TABS_AFTER_SECOND=' + JSON.stringify(await tabNames()))

    // A clean line after all that must still name the tab — the fix is meant
    // to stop a wrong name, not to stop naming.
    await page.keyboard.press('Control+C')
    await page.waitForTimeout(1500)
    await page.keyboard.type('htop')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(3000)
    console.log('TABS_AFTER_CLEAN=' + JSON.stringify(await tabNames()))
    await page.keyboard.press('Control+C')

    // And three launches in a row, the case the report called out.
    for (let i = 1; i <= 3; i++) {
      await page.waitForTimeout(1000)
      await page.keyboard.type('opencode')
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(4000)
      await page.keyboard.press('Control+C')
      await page.waitForTimeout(800)
      await page.keyboard.press('Control+C')
      console.log(`TABS_LOOP_${i}=` + JSON.stringify(await tabNames()))
    }
  })

  test('bug 2b — reconnect after the backlog has been trimmed', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __wire: { ev: string; data: string }[] }
      w.__wire = []
      const Original = window.EventSource
      class Recording extends Original {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init)
          for (const ev of ['output', 'backlog']) {
            super.addEventListener(ev, (e) => {
              const raw = (e as MessageEvent).data as string
              let text: unknown = raw
              try {
                text = JSON.parse(raw)
              } catch {
                /* keep raw */
              }
              w.__wire.push({ ev, data: typeof text === 'string' ? text : raw })
            })
          }
        }
      }
      window.EventSource = Recording as unknown as typeof EventSource
    })

    await login(page)
    await openWorkspace(page)
    await page.locator('textarea.xterm-helper-textarea').first().focus()
    await page.keyboard.type('opencode')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(15_000)
    await page.screenshot({ path: 'test-results/oc2-launched.png' })

    // Push the session past MAX_SCROLLBACK_BYTES (256 KiB) so the head of the
    // backlog — the alternate-buffer switch and the first paint — is trimmed.
    // Each viewport change costs a full OpenCode repaint (~7 KB measured).
    for (let i = 0; i < 150; i++) {
      await page.setViewportSize({ width: 1280 - (i % 2 ? 40 : 0), height: 720 })
      await page.waitForTimeout(250)
    }
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.waitForTimeout(2000)

    const produced = await page.evaluate(() => {
      const w = window as unknown as { __wire: { ev: string; data: string }[] }
      return w.__wire.filter((f) => f.ev === 'output').reduce((n, f) => n + f.data.length, 0)
    })
    console.log('BYTES_PRODUCED=' + produced)

    // A reload is the honest version of "a fresh client attaches": new xterm,
    // new EventSource, server replays whatever backlog it still has.
    await page.reload()
    await openWorkspace(page)
    await page.waitForTimeout(8000)
    await page.screenshot({ path: 'test-results/oc2-after-reload.png' })

    const after = await page.evaluate(() => {
      const w = window as unknown as { __wire: { ev: string; data: string }[] }
      const outputs = w.__wire.filter((f) => f.ev === 'output')
      const all = outputs.map((f) => f.data).join('')
      return {
        backlogMeta: w.__wire.filter((f) => f.ev === 'backlog').map((f) => f.data),
        replayBytes: all.length,
        altEnter: (all.match(/\x1b\[\?1049h/g) || []).length,
        // Frames that only make sense against an established screen.
        cursorAddress: (all.match(/\x1b\[\d+;\d+H/g) || []).length,
      }
    })
    console.log('AFTER_RELOAD=' + JSON.stringify(after))
  })

  test('bug 2 — OpenCode screen state and the raw SSE wire', async ({ page }) => {
    // Record every SSE frame before any app code runs, so what xterm was told
    // can be compared against what it ended up showing.
    await page.addInitScript(() => {
      const w = window as unknown as { __wire: { t: number; ev: string; data: string }[] }
      w.__wire = []
      const Original = window.EventSource
      class Recording extends Original {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init)
          for (const ev of ['output', 'backlog', 'exit']) {
            super.addEventListener(ev, (e) => {
              const raw = (e as MessageEvent).data as string
              let text = raw
              try {
                text = JSON.parse(raw)
              } catch {
                /* keep raw */
              }
              w.__wire.push({ t: Date.now(), ev, data: typeof text === 'string' ? text : raw })
            })
          }
        }
      }
      window.EventSource = Recording as unknown as typeof EventSource
    })

    await login(page)
    await openWorkspace(page)

    const snapshot = () =>
      page.evaluate(() => {
        const screen = document.querySelector('.xterm-screen') as HTMLElement | null
        const rows = document.querySelector('.xterm-rows') as HTMLElement | null
        const text = rows?.innerText ?? ''
        return {
          rect: screen ? { w: screen.getBoundingClientRect().width, h: screen.getBoundingClientRect().height } : null,
          nonBlankChars: text.replace(/\s/g, '').length,
          firstLines: text.split('\n').slice(0, 6),
        }
      })

    const helper = page.locator('textarea.xterm-helper-textarea').first()
    await helper.focus()

    console.log('SCREEN_BEFORE=' + JSON.stringify(await snapshot()))

    await page.keyboard.type('opencode')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(15_000)
    console.log('SCREEN_AFTER_LAUNCH=' + JSON.stringify(await snapshot()))
    await page.screenshot({ path: 'test-results/oc-launched.png' })

    await page.keyboard.type('hello world')
    await page.waitForTimeout(4000)
    console.log('SCREEN_AFTER_TYPING=' + JSON.stringify(await snapshot()))
    await page.screenshot({ path: 'test-results/oc-typed.png' })

    const wire = await page.evaluate(() => {
      const w = window as unknown as { __wire: { t: number; ev: string; data: string }[] }
      return w.__wire.map((f) => ({
        t: f.t,
        ev: f.ev,
        len: f.data.length,
        head: f.data.slice(0, 160),
      }))
    })
    console.log('WIRE=' + JSON.stringify(wire))

    const markers = await page.evaluate(() => {
      const w = window as unknown as { __wire: { ev: string; data: string }[] }
      const all = w.__wire.filter((f) => f.ev === 'output').map((f) => f.data).join('')
      const count = (re: RegExp) => (all.match(re) || []).length
      return {
        totalBytes: all.length,
        altEnter: count(/\x1b\[\?1049h/g),
        altExit: count(/\x1b\[\?1049l/g),
        clear2J: count(/\x1b\[2J/g),
        backlogFrames: w.__wire.filter((f) => f.ev === 'backlog').map((f) => f.data),
      }
    })
    console.log('MARKERS=' + JSON.stringify(markers))
  })
})
