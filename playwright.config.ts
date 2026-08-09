import { readFileSync } from 'node:fs'
import { defineConfig, devices } from 'playwright/test'

// Playwright does not read .env.local; Next.js does. Without this, every test
// gated on E2E_EMAIL/E2E_PASSWORD SKIPS even when the credentials are sitting
// right there — and a skip reads as "nothing to see here", not as a problem.
// Real environment wins, so CI can still inject its own.
try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  }
} catch {
  /* no .env.local — credentials must come from the real environment */
}

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:8082',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Container-hostile defaults, all of which surface as a bare "Page
          // crashed" with no console output to explain it:
          //
          //  --disable-dev-shm-usage  /dev/shm here is Docker's 64MB default,
          //      and Chromium puts renderer shared memory in it. Moves those
          //      allocations to /tmp (a 44GB device on this host).
          //  --no-sandbox             no user namespaces available in this
          //      container, so the zygote cannot start.
          //  swiftshader flags        there is no GPU. Without an explicit
          //      software rasteriser the GPU process dies on the first WebGL
          //      context, which is fatal for an R3F page and invisible
          //      everywhere else.
          args: [
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
          ],
        },
      },
    },
  ],
})
