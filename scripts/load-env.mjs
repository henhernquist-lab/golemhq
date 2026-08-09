// Shared .env.local loader for the scripts in this directory.
//
// Every verify/setup script used to inline its own three-line parser:
//
//   const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
//
// `(.*)` runs to end of line, so an aligned trailing comment becomes part of
// the value. That is not hypothetical: SPRITES_TOKEN is written as
//
//   SPRITES_TOKEN=<128 chars>                     # org token from `sprite org auth`
//
// and the naive parser produced a 196-character bearer token. Sprites answered
// `401 authentication failed`, which was then recorded across several sessions
// as "the Sprites token is dead" — it never was. The app itself was always
// fine, because Next parses .env.local properly. Only the diagnostics lied.
//
// So this delegates to the very loader Next uses rather than reimplementing
// dotenv semantics a second time. A script that loads env this way cannot
// disagree with the running app about what a variable's value is.
//
// Usage — import for side effects, before importing anything that reads env:
//   import './load-env.mjs'

import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// pnpm's strict layout keeps @next/env out of the top-level node_modules, and
// createRequire follows the symlink's *literal* path, so resolution has to
// start from next's real location inside .pnpm.
const require = createRequire(realpathSync(resolve(projectRoot, 'node_modules/next/package.json')))
const { loadEnvConfig } = require('@next/env')

// dev=true so the precedence chain matches `next dev`. Like the old inline
// parser (and like Next), an already-set process.env value always wins.
loadEnvConfig(projectRoot, true, { info() {}, error: console.error })
