// Batch 5 — Layer 3 validators.
//
// A builder's own verdict is not evidence. Batch 2 already learned the cheap
// version of that lesson (a CLI exiting 0 having written nothing), and the
// worktree delta catches it. This is the expensive version: the builder wrote
// code, and the code is wrong. Nothing in the pipeline could tell the
// difference, which is why tasks stopped at `validating` and stayed there.
//
// ─── Where the checks run ─────────────────────────────────────────────
// Through runHeadless, on the same host the builder ran on. That is not a
// stylistic choice: the code being validated exists on the builder's disk and
// nowhere else. On Vercel the lambda has no checkout at all, so a validator
// that shelled out locally would type-check an empty directory and pass
// everything — a green light that means nothing. Same reasoning as
// src/lib/assets/blender.ts.
//
// All checks share one terminal session. Creating one costs ~10s on the Sprite
// and four checks would otherwise pay it four times.
//
// ─── Why the checks are scoped to changed files ───────────────────────
// Whole-project `tsc --noEmit` cannot run here: it exceeds this container's
// memory and gets killed around the ten-minute mark. Scoping to the files a
// task touched is both what fits and what is actually being asked — a task is
// responsible for its own changes, not for the repo's pre-existing state.
// tsc still follows imports out of those files, so a change that breaks a
// consumer elsewhere is caught by type-checking the consumer's own task.

import { randomUUID } from 'node:crypto'

import { backend, base64Arg, runHeadless } from '@/lib/terminal/headless-run'
import { getTask, listEvents, recordEvent, updateTaskStatus } from './store'
import type { Task } from './types'

export class ValidatorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidatorError'
  }
}

export type CheckName = 'typecheck' | 'lint' | 'test' | 'security' | 'review'
export type CheckStatus = 'passed' | 'failed' | 'skipped'

export interface ValidationCheck {
  name: CheckName
  /** Layer-3 roster agent this check stands in for, for attribution. */
  agent: string
  status: CheckStatus
  /** Why it failed, or why it was skipped. Null when it simply passed. */
  reason: string | null
  durationMs: number
  /** Trimmed tool output — enough to act on, not the whole log. */
  output: string
}

export interface ValidationReport {
  taskId: string
  missionId: string
  /** Files the builder touched, per the adapter's worktree delta. */
  files: string[]
  checks: ValidationCheck[]
  passed: boolean
  finalStatus: 'complete' | 'failed'
  durationMs: number
}

export interface ValidateTaskOptions {
  /**
   * Checkout to validate. Defaults to this process's working directory.
   *
   * Not optional in practice, whatever the type says. A PTY with no cwd starts
   * in $HOME, where `npx tsc` finds no local TypeScript and answers "This is
   * not the tsc command you are looking for" — a failure that looks like the
   * task's fault and is not.
   */
  cwd?: string
  /** Per-check wall clock cap. */
  timeoutMs?: number
  /** Compute the verdict without moving the task. Used by the verifier. */
  dryRun?: boolean
  /**
   * Validate regardless of current status. Off by default so a re-run cannot
   * quietly resurrect a task some other path already failed.
   */
  force?: boolean
}

const DEFAULT_CHECK_TIMEOUT_MS = 8 * 60 * 1000
const MAX_OUTPUT_CHARS = 4000

/** Layer-3 roster names, so events attribute to the agents that already exist. */
const AGENT_FOR: Record<CheckName, string> = {
  typecheck: 'Type Checker',
  lint: 'Linter',
  test: 'Test Runner',
  security: 'Security Scanner',
  review: 'AI Reviewer',
}

const TS_FILE = /\.(ts|tsx|mts)$/
const DECLARATION_FILE = /\.d\.ts$/
const LINTABLE = /\.(ts|tsx|mts|js|jsx|mjs|cjs)$/
const TEST_FILE = /\.(spec|test)\.(ts|tsx|js|jsx|mjs)$/
const DEPENDENCY_FILE = /^(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/

/**
 * Run every applicable check against a task's output and settle its status.
 *
 * Advances to `complete` only when nothing failed. A single failure sends the
 * task to `failed` and writes which check failed and why — "validation failed"
 * on its own is not actionable, and a task that died for an unstated reason is
 * one nobody can fix.
 */
export async function validateTask(
  taskId: string,
  options: ValidateTaskOptions = {},
): Promise<ValidationReport> {
  const startedAt = Date.now()
  const task = await getTask(taskId)
  if (!task) throw new ValidatorError(`validateTask: task ${taskId} not found`)

  if (!options.force && task.status !== 'validating') {
    throw new ValidatorError(
      `validateTask: task ${taskId} is "${task.status}", expected "validating" (pass force to override)`,
    )
  }

  const files = await changedFiles(task)
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  const cwd = options.cwd ?? process.cwd()

  // One session for every check. Passing sessionId keeps runHeadless from
  // creating and tearing down a PTY per check.
  const term = backend()
  const session = await term.create({ cols: 200, rows: 50, cwd })
  const run = (script: string) =>
    runHeadless(`bash -c ${base64Arg(script)}`, {
      timeoutMs,
      runId: `validate-${taskId}-${randomUUID().slice(0, 8)}`,
      sessionId: session.id,
      cwd,
    })

  let checks: ValidationCheck[]
  try {
    checks = [
      await typecheck(files, run),
      await lint(files, run),
      await test(files, run),
      await security(files, run),
      reviewUnavailable(),
    ]
  } finally {
    await term.kill(session.id).catch(() => false)
  }

  const failures = checks.filter((c) => c.status === 'failed')
  const passed = failures.length === 0
  const finalStatus: 'complete' | 'failed' = passed ? 'complete' : 'failed'

  const report: ValidationReport = {
    taskId,
    missionId: task.missionId,
    files,
    checks,
    passed,
    finalStatus,
    durationMs: Date.now() - startedAt,
  }

  if (!options.dryRun) {
    // The event carries the whole per-check breakdown, because the status
    // alone loses exactly the information someone needs to fix the task.
    await recordEvent(
      task.missionId,
      'task.validated',
      {
        passed,
        files,
        durationMs: report.durationMs,
        checks: checks.map((c) => ({
          name: c.name,
          agent: c.agent,
          status: c.status,
          reason: c.reason,
          durationMs: c.durationMs,
        })),
        ...(failures.length
          ? { failedChecks: failures.map((f) => `${f.name}: ${f.reason ?? 'failed'}`) }
          : {}),
      },
      taskId,
    )

    await updateTaskStatus(taskId, finalStatus, {
      by: 'validator',
      passed,
      ...(failures.length
        ? {
            failedChecks: failures.map((f) => f.name),
            error: failures.map((f) => `${f.name}: ${f.reason ?? 'failed'}`).join('; '),
          }
        : {}),
    })
  }

  return report
}

// ─── Which files the builder touched ───────────────────────────────────

/**
 * Read the worktree delta the adapter already recorded.
 *
 * Recomputing it here would be wrong as well as wasteful: by validation time
 * the tree may have moved on, and the question is what THIS task changed.
 */
async function changedFiles(task: Task): Promise<string[]> {
  const events = await listEvents(task.missionId)
  const worktree = events
    .filter((e) => e.taskId === task.id && e.type === 'task.worktree')
    .sort((a, b) => b.ts.localeCompare(a.ts))[0]
  if (!worktree) return []
  const files = worktree.payload.files
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : []
}

// ─── The checks ────────────────────────────────────────────────────────

type Runner = (script: string) => Promise<{
  output: string
  exitCode: number | null
  timedOut: boolean
  failure: string | null
}>

function skipped(name: CheckName, reason: string): ValidationCheck {
  return { name, agent: AGENT_FOR[name], status: 'skipped', reason, durationMs: 0, output: '' }
}

/** Turn a raw run into a verdict, with the shell's own failure modes handled. */
async function measure(
  name: CheckName,
  runner: () => Promise<{ output: string; exitCode: number | null; timedOut: boolean; failure: string | null }>,
  interpret: (r: { output: string; exitCode: number | null }) => string | null,
): Promise<ValidationCheck> {
  const started = Date.now()
  const r = await runner()
  const durationMs = Date.now() - started
  const base = { name, agent: AGENT_FOR[name], durationMs, output: trim(r.output) }

  // A check that could not run is not a check that passed. Both of these
  // produce a clean-looking empty output, which is the dangerous case.
  if (r.failure) return { ...base, status: 'failed', reason: `could not run: ${r.failure}` }
  if (r.timedOut) return { ...base, status: 'failed', reason: `timed out after ${durationMs}ms` }

  const reason = interpret(r)
  return reason === null ? { ...base, status: 'passed', reason: null } : { ...base, status: 'failed', reason }
}

async function typecheck(files: string[], run: Runner): Promise<ValidationCheck> {
  const targets = files.filter((f) => TS_FILE.test(f) && !DECLARATION_FILE.test(f))
  if (targets.length === 0) return skipped('typecheck', 'no TypeScript files changed')

  // A generated tsconfig that extends the real one: same strictness, same path
  // aliases, narrower `include`. next-env.d.ts comes along because without it
  // every Next global type resolves to `any` and the check goes quiet.
  const config = JSON.stringify(
    { extends: './tsconfig.json', include: ['next-env.d.ts', ...targets] },
    null,
    2,
  )

  return measure(
    'typecheck',
    () =>
      run(
        `set -o pipefail
printf %s ${b64(config)} | base64 -d > tsconfig.golem-validate.json
trap 'rm -f tsconfig.golem-validate.json tsconfig.golem-validate.tsbuildinfo' EXIT
npx --no-install tsc --noEmit --incremental false -p tsconfig.golem-validate.json 2>&1 | tail -60`,
      ),
    (r) => (r.exitCode === 0 ? null : firstLine(r.output) || `tsc exited ${r.exitCode}`),
  )
}

async function lint(files: string[], run: Runner): Promise<ValidationCheck> {
  const targets = files.filter((f) => LINTABLE.test(f))
  if (targets.length === 0) return skipped('lint', 'no lintable files changed')

  return measure(
    'lint',
    () => run(`npx --no-install eslint ${targets.map(shellQuote).join(' ')} 2>&1 | tail -60`),
    (r) => (r.exitCode === 0 ? null : firstProblem(r.output) || `eslint exited ${r.exitCode}`),
  )
}

/**
 * Run the repo's tests, but only when the task actually touched a test.
 *
 * Running the whole suite on every task would make each validation pay for the
 * entire e2e suite — which here needs a dev server and real credentials — and
 * would fail tasks for breakage they had nothing to do with. A task with no
 * tests to run is not a failing task; it is a task with nothing to run, and
 * that distinction is recorded rather than hidden behind a pass.
 */
async function test(files: string[], run: Runner): Promise<ValidationCheck> {
  const targets = files.filter((f) => TEST_FILE.test(f))
  if (targets.length === 0) return skipped('test', 'no test files changed')

  return measure(
    'test',
    () => run(`npx --no-install playwright test ${targets.map(shellQuote).join(' ')} --reporter=line 2>&1 | tail -60`),
    (r) => (r.exitCode === 0 ? null : firstLine(r.output) || `test run exited ${r.exitCode}`),
  )
}

/**
 * Dependency audit, gated on a committed baseline.
 *
 * A plain `pnpm audit` gate is unusable here: this repo carries 3 critical and
 * 20 high pre-existing advisories, none of them any task's doing, so a gate on
 * absolute counts would fail every task forever — which is worse than no gate,
 * because it teaches everyone to ignore the validator.
 *
 * So the question asked is "did THIS task make it worse": the check runs only
 * when the task touched a dependency manifest, and compares advisory ids
 * against .golem/audit-baseline.json. A missing baseline is established rather
 * than treated as a failure, so the first run after adoption is not a false
 * alarm.
 */
async function security(files: string[], run: Runner): Promise<ValidationCheck> {
  const touched = files.filter((f) => DEPENDENCY_FILE.test(f.split('/').pop() ?? f))
  if (touched.length === 0) return skipped('security', 'no dependency manifests changed')

  const script = `
set -o pipefail
mkdir -p .golem
pnpm audit --json > /tmp/golem-audit.json 2>/dev/null || true
node -e '
  const fs = require("fs");
  const base = ".golem/audit-baseline.json";
  let report;
  try { report = JSON.parse(fs.readFileSync("/tmp/golem-audit.json", "utf8")) } catch {
    console.log("AUDIT_UNPARSEABLE"); process.exit(2)
  }
  const ids = Object.values(report.advisories ?? {})
    .filter(a => ["high", "critical"].includes(a.severity))
    .map(a => String(a.github_advisory_id ?? a.id))
    .sort();
  if (!fs.existsSync(base)) {
    fs.writeFileSync(base, JSON.stringify({ advisories: ids }, null, 2) + "\\n");
    console.log("AUDIT_BASELINE_ESTABLISHED " + ids.length);
    process.exit(0);
  }
  const known = new Set(JSON.parse(fs.readFileSync(base, "utf8")).advisories ?? []);
  const added = ids.filter(id => !known.has(id));
  if (added.length) { console.log("AUDIT_NEW " + added.join(",")); process.exit(1) }
  console.log("AUDIT_CLEAN " + ids.length + " known high/critical, none new");
'`.trim()

  return measure(
    'security',
    () => run(script),
    (r) => {
      if (r.output.includes('AUDIT_UNPARSEABLE')) return 'pnpm audit produced no parseable JSON'
      const added = /AUDIT_NEW (\S+)/.exec(r.output)
      if (added) return `this task introduced new high/critical advisories: ${added[1]}`
      return r.exitCode === 0 ? null : `audit check exited ${r.exitCode}`
    },
  )
}

/**
 * CodeRabbit, the intended AI reviewer, is present but signed out.
 *
 * The CLI (0.7.2) is installed on the Sprite and fits this exec pattern well —
 * `coderabbit review --agent` emits structured findings for exactly this kind
 * of caller. What it cannot do is authenticate: `coderabbit auth login` is an
 * interactive browser flow, and `auth status` reports "signed out".
 *
 * Reported as skipped with the specific blocker rather than wired up to fail
 * or, worse, to pass silently on every task.
 */
function reviewUnavailable(): ValidationCheck {
  return skipped(
    'review',
    'CodeRabbit CLI 0.7.2 is installed but signed out — needs `coderabbit auth login` (interactive browser flow) on the builder host',
  )
}

// ─── Output helpers ────────────────────────────────────────────────────

function trim(output: string): string {
  const clean = output.trim()
  return clean.length > MAX_OUTPUT_CHARS ? `${clean.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)` : clean
}

function firstLine(output: string): string {
  return output.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
}

/** ESLint prints the file path first; the first line with a rule is the useful one. */
function firstProblem(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.find((l) => /^\d+:\d+\s+(error|warning)/.test(l)) ?? lines[0] ?? ''
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function b64(text: string): string {
  return `'${Buffer.from(text, 'utf8').toString('base64')}'`
}
