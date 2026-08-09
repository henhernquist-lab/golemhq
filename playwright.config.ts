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
  // 30s is not enough here. This container has no GPU, so WebGL runs on
  // SwiftShader, and a cold Turbopack compile of a 3D route routinely costs
  // 10-15s before the first frame. The old limit expired mid-assertion and
  // tore the browser down, which surfaced as "Target page has been closed" —
  // hiding whatever the test was actually about to report.
  timeout: 120_000,
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  use: {
    // localhost, NOT 127.0.0.1. Next 16 blocks cross-origin access to dev
    // resources (/_next/webpack-hmr, the RSC payload) by default, and it counts
    // 127.0.0.1 as a different origin from the localhost the server binds. The
    // page still server-renders, so it looks completely fine — but React never
    // hydrates, nothing responds to a click, and there is no error anywhere to
    // explain it. Every interaction test would fail for reasons that look like
    // application bugs. The alternative fix is allowedDevOrigins in
    // next.config.ts; using the origin the server already trusts is narrower.
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8082',
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
