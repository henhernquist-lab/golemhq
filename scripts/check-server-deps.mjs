#!/usr/bin/env node
// Fails if server code statically imports a devDependency.
//
// This exists because of a real outage: src/lib/infinite-campus.ts had a
// top-level `import { chromium } from 'playwright'`. Playwright is a
// devDependency, so it resolved in dev and during the Vercel build but was
// pruned from the deployed bundle. At cold start the module graph failed with
// "Can't resolve 'playwright'", which took down every route importing that
// file — /api/chat and /api/school — with Next's raw HTML 500 for every
// method, before any handler code ran. Nothing caught it, because a
// module-load failure happens before any try/catch in the route.
//
// A dynamic `await import()` inside a function is fine and is the fix: it is
// only evaluated when that code path actually runs, and can be caught. So is
// `import type`, which is erased at compile time. Only static value imports
// are reported.
//
//   node scripts/check-server-deps.mjs

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'src')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}))

/** Bare specifier → the package it resolves to ('next/server' → 'next'). */
function packageOf(spec) {
  if (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('node:')) return null
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full
  }
}

// `import type { X } from 'y'` and `import { type X } from 'y'` are erased, so
// they cannot cause a runtime resolution failure.
const STATIC_IMPORT = /^\s*import\s+(?!type\s)([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/
const BARE_SIDE_EFFECT = /^\s*import\s*['"]([^'"]+)['"]/

const violations = []
for (const file of walk(SRC)) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const m = STATIC_IMPORT.exec(line) ?? BARE_SIDE_EFFECT.exec(line)
    if (!m) return
    const spec = m[2] ?? m[1]
    const pkgName = packageOf(spec)
    if (!pkgName || !devDeps.has(pkgName)) return
    // A clause of only `type` specifiers is erased too.
    const clause = m[2] ? m[1] : ''
    if (clause && /^\{\s*(type\s+[^,}]+,?\s*)+\}$/.test(clause.trim())) return
    violations.push({ file: path.relative(ROOT, file), line: i + 1, pkgName, text: line.trim() })
  })
}

if (violations.length > 0) {
  console.error('Server code statically imports devDependencies:\n')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  →  ${v.pkgName}`)
    console.error(`    ${v.text}`)
  }
  console.error(
    '\nThese resolve in dev and during the build, then fail at cold start in production,\n' +
      'taking down every route that imports the file. Use `import type` if only types are\n' +
      'needed, or `await import()` inside the function that needs it, guarded so a missing\n' +
      'package degrades that one feature instead of the whole route.',
  )
  process.exit(1)
}

console.log(`OK — no devDependency is statically imported by server code (${devDeps.size} devDeps checked).`)
