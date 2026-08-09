// Run one shell command to completion inside a real terminal session and
// capture its stdout and exit code.
//
// Extracted from the Batch 2 builder adapter so anything else that needs to
// drive the terminal headlessly — CLI detection, later validators — shares the
// exec path instead of growing a second one. The adapter's behaviour is
// unchanged; it now supplies the inner command and lets this own the framing.
//
// Backend selection mirrors src/app/api/terminal/pty/route.ts exactly: Vercel
// runs on the Fly Sprite, the Codespace runs node-pty. Callers never branch.

import {
  createSession as createLocalSession,
  writeInput as writeLocalInput,
  killSession as killLocalSession,
  subscribe as subscribeLocal,
} from './pty-manager'
import {
  createSession as createSpriteSession,
  writeInput as writeSpriteInput,
  killSession as killSpriteSession,
  subscribe as subscribeSprite,
} from './sprite-manager'

/** Give bash time to print its first prompt before typing at it. */
const SHELL_READY_TIMEOUT_MS = 10_000

/** Geometry for a headless session. Wide enough that CLIs don't hard-wrap. */
const HEADLESS_COLS = 200
const HEADLESS_ROWS = 50

export type BackendKind = 'sprite' | 'local'

export interface TerminalBackend {
  readonly kind: BackendKind
  create(opts: { cols: number; rows: number; cwd?: string }): Promise<{ id: string }>
  write(id: string, data: string): Promise<boolean>
  kill(id: string): Promise<boolean>
  subscribe(id: string, onData: (data: string) => void, onExit?: (code: number) => void): () => void
}

export function backend(): TerminalBackend {
  if (process.env.VERCEL) {
    return {
      kind: 'sprite',
      create: (opts) => createSpriteSession(opts),
      write: (id, data) => writeSpriteInput(id, data),
      kill: (id) => killSpriteSession(id),
      subscribe: (id, onData, onExit) => subscribeSprite(id, onData, onExit),
    }
  }
  return {
    kind: 'local',
    create: async (opts) => createLocalSession(opts),
    write: async (id, data) => writeLocalInput(id, data),
    kill: async (id) => killLocalSession(id),
    subscribe: (id, onData, onExit) => subscribeLocal(id, onData, onExit),
  }
}

// ─── Shell helpers ─────────────────────────────────────────────────────

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Wrap a command so its output self-delimits in the TTY byte stream.
 *
 * A TTY has no framing: the previous command's output, the echoed command line
 * and the next shell prompt all arrive on the same stream. The markers say
 * where this run starts and stops, and `$?` rides the end marker so the exit
 * code is the real one rather than a guess from scanning for crash text.
 *
 * Each marker appears twice — once in the TTY's echo of the command line, once
 * when actually printed. The echoed copy carries the literal `%d`, so a regex
 * demanding digits only ever matches the printed one. See parseRun().
 */
export function frameCommand(inner: string, runId: string, cwd?: string): string {
  const cd = cwd ? `cd ${shellQuote(cwd)} 2>/dev/null; ` : ''
  return (
    `${cd}printf '\\n${startMarker(runId)}\\n'; ` +
    `${inner}; ` +
    `printf '\\n${doneMarkerPrefix(runId)}%d__\\n' "$?"`
  )
}

/**
 * Pass arbitrary text to a CLI without it ever touching shell quoting.
 *
 * Prompts and detection scripts are free text full of quotes, backticks, `$`
 * and newlines; each either breaks out of quoting or turns one typed line into
 * several, and a multi-line paste into a TTY is at the mercy of readline.
 */
export function base64Arg(text: string): string {
  return `"$(printf %s ${shellQuote(Buffer.from(text, 'utf8').toString('base64'))} | base64 -d)"`
}

const startMarker = (runId: string) => `__GOLEM_RUN_START_${markerId(runId)}__`
const doneMarkerPrefix = (runId: string) => `__GOLEM_RUN_DONE_${markerId(runId)}_`

/** Marker bodies go through the shell as literals — keep them [A-Z0-9_]. */
function markerId(runId: string): string {
  return runId.replaceAll(/[^A-Za-z0-9]/g, '').toUpperCase()
}

// ─── Output parsing ────────────────────────────────────────────────────

/** CSI / OSC escape sequences. Captured output is read by humans and parsers. */
const ANSI_PATTERN =
  /\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[()][B0]|\x1B[=>]/g

export function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_PATTERN, '').replaceAll('\r\n', '\n').replaceAll('\r', '')
}

interface ParsedRun {
  output: string
  exitCode: number
}

function parseRun(raw: string, runId: string): ParsedRun | null {
  const clean = stripAnsi(raw)
  const done = new RegExp(`${doneMarkerPrefix(runId)}(\\d+)__`).exec(clean)
  if (!done) return null

  const before = clean.slice(0, done.index)
  // lastIndexOf, not indexOf: the first hit is inside the TTY's echo of the
  // command line, the last is the marker the shell actually printed.
  const start = before.lastIndexOf(startMarker(runId))
  const body = start === -1 ? before : before.slice(start + startMarker(runId).length)

  return { output: body.replace(/^\n+/, '').replace(/\n+$/, ''), exitCode: Number(done[1]) }
}

// ─── The run ───────────────────────────────────────────────────────────

export interface HeadlessRunOptions {
  /** Wall-clock cap. Required — there is no sensible universal default. */
  timeoutMs: number
  /** Correlates the framing markers. Any string; uniqueness is what matters. */
  runId: string
  /** Reuse an existing session (e.g. a pane a human is watching) instead of a throwaway. */
  sessionId?: string
  /** Working directory. Ignored on the Sprite path (see sprite-manager). */
  cwd?: string
}

export interface HeadlessRunResult {
  /** Framed output, or the raw stream if the run never reached its end marker. */
  output: string
  /** Exit code, or null when no end marker arrived. */
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  sessionId: string
  /** Set when the run threw rather than merely failing. */
  failure: string | null
  backendKind: BackendKind
}

export async function runHeadless(
  inner: string,
  options: HeadlessRunOptions,
): Promise<HeadlessRunResult> {
  const { timeoutMs, runId } = options
  const term = backend()
  const startedAt = Date.now()

  let sessionId = options.sessionId ?? null
  const ownsSession = sessionId === null
  let buffer = ''
  let unsubscribe: (() => void) | null = null
  let timedOut = false
  let parsed: ParsedRun | null = null
  let failure: string | null = null

  try {
    if (sessionId === null) {
      const created = await term.create({ cols: HEADLESS_COLS, rows: HEADLESS_ROWS, cwd: options.cwd })
      sessionId = created.id
    }

    // Subscribe before writing so no output can land in the gap.
    let onChunk: ((chunk: string) => void) | null = null
    let shellReady: (() => void) | null = null
    unsubscribe = term.subscribe(sessionId, (chunk) => {
      buffer += chunk
      shellReady?.()
      onChunk?.(chunk)
    })

    // Bash prints its prompt a beat after the session exists. Typing into that
    // gap is how keystrokes get dropped; the timeout means a silent shell costs
    // 10s rather than the whole run.
    await new Promise<void>((resolve) => {
      if (buffer.length > 0) return resolve()
      const timer = setTimeout(resolve, SHELL_READY_TIMEOUT_MS)
      shellReady = () => {
        clearTimeout(timer)
        shellReady = null
        resolve()
      }
    })

    const written = await term.write(sessionId, `${frameCommand(inner, runId, options.cwd)}\n`)
    if (!written) {
      throw new Error(`terminal session ${sessionId} rejected the command (${term.kind} backend)`)
    }

    parsed = await new Promise<ParsedRun | null>((resolve) => {
      // Output arrives in arbitrary chunks, so re-parse the whole buffer each
      // time — the end marker can straddle a chunk boundary.
      const check = () => {
        const found = parseRun(buffer, runId)
        if (found) {
          clearTimeout(timer)
          onChunk = null
          resolve(found)
        }
      }
      const timer = setTimeout(() => {
        timedOut = true
        onChunk = null
        resolve(null)
      }, timeoutMs)
      onChunk = check
      check() // in case the run already finished while we were setting up
    })

    if (timedOut) {
      // Ctrl-C first: on a reused session it leaves the shell usable, and on a
      // throwaway one it still gives the process a chance to flush before kill.
      await term.write(sessionId, '\x03').catch(() => false)
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  } finally {
    unsubscribe?.()
    if (ownsSession && sessionId) await term.kill(sessionId).catch(() => false)
  }

  return {
    // No markers means nothing to slice, so fall back to the raw stream — a
    // crashed process's stderr is the most useful thing left.
    output: parsed?.output ?? stripAnsi(buffer).trim(),
    exitCode: parsed?.exitCode ?? null,
    timedOut,
    durationMs: Date.now() - startedAt,
    sessionId: sessionId ?? '',
    failure,
    backendKind: term.kind,
  }
}

// ─── Worktree change detection ─────────────────────────────────────────
// Exit code alone is not evidence that a builder did anything. `claude -p` is
// read-only by default and exits 0 while refusing to write; `openhands
// --headless` exits 0 having produced nothing. Both were recorded as successes
// for an entire batch. Comparing the checkout before and after is the only
// signal that distinguishes "did the work" from "ran and declined".

/**
 * Snapshot of a checkout, cheap enough to take on every run.
 *
 * Uses git when the directory is a repo — precise, and fast even on a large
 * tree — and falls back to a path/size/mtime walk otherwise, so a scratch
 * directory that was never `git init`ed still gets covered.
 */
const SIGNATURE_TIMEOUT_MS = 30_000

const SIGNATURE_SCRIPT = `
set +e
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "MODE git"
  echo "HEAD $(git rev-parse HEAD 2>/dev/null || echo none)"
  git status --porcelain=v1 --untracked-files=all 2>/dev/null | sort
else
  echo "MODE find"
  find . -type f -not -path './.git/*' -not -path './node_modules/*' \\
    -printf '%p|%s|%T@\\n' 2>/dev/null | sort
fi
`.trim()

export interface WorktreeSignature {
  /** Raw snapshot lines. Compared verbatim between before and after. */
  lines: string[]
  /** True when the snapshot could not be taken at all. */
  failed: boolean
}

export async function worktreeSignature(cwd?: string): Promise<WorktreeSignature> {
  try {
    const run = await runHeadless(`bash -c ${base64Arg(SIGNATURE_SCRIPT)}`, {
      timeoutMs: SIGNATURE_TIMEOUT_MS,
      runId: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      cwd,
    })
    if (run.failure || run.timedOut || run.exitCode !== 0) return { lines: [], failed: true }
    return { lines: run.output.split('\n').map((l) => l.trim()).filter(Boolean), failed: false }
  } catch {
    return { lines: [], failed: true }
  }
}

export interface WorktreeDelta {
  changed: boolean
  /** Paths that appeared, vanished or changed. Best-effort, capped. */
  files: string[]
  /** True when either snapshot failed, so "changed" is not trustworthy. */
  unknown: boolean
  /** HEAD moved: the builder committed its work rather than leaving it dirty. */
  committed: boolean
}

const MAX_REPORTED_FILES = 50

/** Difference between two snapshots, as a set of lines that moved either way. */
export function diffSignatures(before: WorktreeSignature, after: WorktreeSignature): WorktreeDelta {
  if (before.failed || after.failed) return { changed: false, files: [], unknown: true, committed: false }

  const beforeSet = new Set(before.lines)
  const afterSet = new Set(after.lines)
  const moved = [
    ...after.lines.filter((l) => !beforeSet.has(l)),
    ...before.lines.filter((l) => !afterSet.has(l)),
  ]

  // A builder that COMMITS its work leaves a clean tree, so the porcelain lines
  // are identical before and after and only HEAD moves. That is why HEAD is in
  // the signature at all — but it used to be filtered out before `changed` was
  // computed, which made "committed the feature" indistinguishable from "did
  // nothing" and failed those tasks. Claude Code commits by default, so this
  // was not an edge case.
  const committed = moved.some((l) => l.startsWith('HEAD '))

  // Strip the porcelain status prefix / the find metadata so the report reads
  // as paths rather than as raw snapshot lines.
  const files = [
    ...new Set(
      moved
        .filter((l) => !l.startsWith('MODE ') && !l.startsWith('HEAD '))
        .map((l) => (l.includes('|') ? l.split('|')[0] : l.replace(/^\S+\s+/, '')))
        .map((p) => p.replace(/^\.\//, '')),
    ),
  ]
  return {
    changed: files.length > 0 || committed,
    files: files.slice(0, MAX_REPORTED_FILES),
    unknown: false,
    committed,
  }
}

/**
 * Paths a commit touched, for when the tree is clean because the work landed.
 *
 * The worktree signature can say THAT a commit happened but not what was in
 * it, and the validators need the file list — validating an empty list would
 * skip every check and call that a pass.
 */
export async function committedFiles(cwd?: string, limit = MAX_REPORTED_FILES): Promise<string[]> {
  try {
    const run = await runHeadless(`git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null | head -${limit}`, {
      timeoutMs: SIGNATURE_TIMEOUT_MS,
      runId: `commitfiles-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      cwd,
    })
    if (run.failure || run.timedOut || run.exitCode !== 0) return []
    return run.output.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}
