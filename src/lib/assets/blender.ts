// Batch 4.5 — 3D asset generation through Blender.
//
// ─── Why this is not the Blender MCP server ───────────────────────────
// The community standard is ahujasid/blender-mcp: a Blender ADD-ON that opens a
// TCP socket on localhost:9876, plus an MCP server (`uvx blender-mcp`) that
// bridges MCP calls to it. It is the right tool for a human at a workstation —
// the agent drives the Blender the human already has open and they watch the
// viewport update.
//
// It is the wrong tool for a mission. The add-on runs inside a full Blender
// GUI process: it needs a display, a human to install the add-on and press
// "Connect", and it holds one global scene that every caller shares. A mission
// running on a server has no display, and two builders generating assets
// concurrently would be editing the same scene.
//
// So this drives Blender the way a server can: `blender --background --python`,
// one process per asset, no display, no shared state, deterministic output.
// mcp/blender.json carries the socket-based config for when Henry does want to
// drive his own local Blender interactively — that path is real, it just is not
// this one.

import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

import { backend, base64Arg, runHeadless } from '@/lib/terminal/headless-run'

const execFileAsync = promisify(execFile)

/** Blender is slow to start but a single asset should never take minutes. */
export const DEFAULT_BLENDER_TIMEOUT_MS = 120_000

export class BlenderError extends Error {
  readonly stderr?: string
  constructor(message: string, stderr?: string) {
    super(message)
    this.name = 'BlenderError'
    this.stderr = stderr
  }
}

/**
 * Where the Blender binary is.
 *
 * Deliberately not defaulting to a bare `blender` on PATH alone: Blender is
 * rarely installed by a package manager on a build host, and a portable
 * extraction is the normal way to get it there. BLENDER_BIN points at that.
 */
export function blenderBinary(): string {
  return process.env.BLENDER_BIN?.trim() || 'blender'
}

// ─── Which machine Blender runs on ─────────────────────────────────────
//
// On Vercel there is no Blender to spawn and no way to put one there: the
// lambda filesystem is read-only apart from /tmp, the bundle has a hard size
// cap, and a 1GB portable build clears neither. Blender lives on the Fly
// Sprite, which is also where builder tasks run, so asset generation goes
// through the same exec path they do — see src/lib/terminal/headless-run.ts.
//
// This module used to call execFile unconditionally. That worked in the
// Codespace and could never have worked in production, which is exactly the
// kind of gap a Codespace-only verification does not surface: installing
// Blender on the Sprite fixes nothing until the caller actually talks to it.
//
// The Sprite's own shell exports BLENDER_BIN (see scripts/install-blender.mjs),
// so the remote command reads the REMOTE env rather than the lambda's.
const REMOTE_BLENDER = '"${BLENDER_BIN:-$HOME/.local/opt/blender/blender}"'

/** Cap on a file carried back from the Sprite (base64 inflates it by 4/3). */
const MAX_TRANSFER_BYTES = 24 * 1024 * 1024

const B64_BEGIN = '__GOLEM_B64_BEGIN__'
const B64_END = '__GOLEM_B64_END__'

function onSprite(): boolean {
  return backend().kind === 'sprite'
}

export async function blenderAvailable(): Promise<{ available: boolean; version: string | null }> {
  if (onSprite()) {
    try {
      const run = await runHeadless(`${REMOTE_BLENDER} --version | head -1`, {
        timeoutMs: 120_000,
        runId: `blender-version-${randomUUID()}`,
      })
      const version = run.output.split('\n').map((l) => l.trim()).find((l) => /^Blender \d/.test(l))
      return { available: run.exitCode === 0 && !!version, version: version ?? null }
    } catch {
      return { available: false, version: null }
    }
  }
  try {
    const { stdout } = await execFileAsync(blenderBinary(), ['--version'], { timeout: 30_000 })
    return { available: true, version: stdout.split('\n')[0]?.trim() ?? null }
  } catch {
    return { available: false, version: null }
  }
}

// ─── Running a script ──────────────────────────────────────────────────

export interface BlenderRunResult {
  glbPath: string
  bytes: number
  stdout: string
  durationMs: number
}

/**
 * Run a Python script inside headless Blender and collect the .glb it exports.
 *
 * The script receives its output path as the first argument after `--`, which
 * is Blender's convention for "stop parsing, the rest belongs to the script".
 * Passing it rather than letting the script choose keeps the caller in control
 * of where files land — an agent-authored script picking its own path is how
 * you end up with assets written somewhere nobody looks.
 */
export async function runBlenderScript(
  python: string,
  options: { outPath: string; timeoutMs?: number } ,
): Promise<BlenderRunResult> {
  if (onSprite()) return runBlenderScriptOnSprite(python, options)

  const { available, version } = await blenderAvailable()
  if (!available) {
    throw new BlenderError(
      `Blender is not runnable as "${blenderBinary()}". Set BLENDER_BIN to a Blender executable ` +
        `(a portable build from blender.org works — no install needed).`,
    )
  }

  const dir = await mkdtemp(join(tmpdir(), 'golem-blender-'))
  const scriptPath = join(dir, 'generate.py')
  await writeFile(scriptPath, python, 'utf8')

  const started = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync(
      blenderBinary(),
      ['--background', '--factory-startup', '--python-exit-code', '1', '--python', scriptPath, '--', options.outPath],
      { timeout: options.timeoutMs ?? DEFAULT_BLENDER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    )

    // Blender exits 0 for a script that ran but exported nothing, so the file
    // is the success signal — the same lesson the builder adapter learned.
    let bytes: number
    try {
      bytes = (await readFile(options.outPath)).byteLength
    } catch {
      throw new BlenderError(
        `Blender (${version}) exited cleanly but wrote no file at ${options.outPath} — the script ran and exported nothing`,
        stderr,
      )
    }
    return { glbPath: options.outPath, bytes, stdout, durationMs: Date.now() - started }
  } catch (err) {
    if (err instanceof BlenderError) throw err
    const e = err as { stderr?: string; killed?: boolean; message: string }
    if (e.killed) throw new BlenderError(`Blender timed out after ${options.timeoutMs ?? DEFAULT_BLENDER_TIMEOUT_MS}ms`, e.stderr)
    throw new BlenderError(`Blender script failed: ${e.message}`, e.stderr)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * The same run, on the Sprite, with the artefact carried back.
 *
 * Sprites' API exposes no file transfer, so the exported file returns as base64
 * inside the exec stream between two markers. That is only tolerable because
 * the payloads here are small — a cube is ~2KB, a render is a few hundred KB —
 * and it is capped rather than trusted. Anything genuinely large should be
 * uploaded to storage from the Sprite instead of being funnelled through a TTY.
 *
 * Both halves of the script are delivered base64-encoded: a Blender script is
 * full of quotes, backticks and newlines, and any of them typed raw at an
 * interactive shell becomes several commands instead of one.
 */
async function runBlenderScriptOnSprite(
  python: string,
  options: { outPath: string; timeoutMs?: number },
): Promise<BlenderRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BLENDER_TIMEOUT_MS
  const work = `/tmp/golem-blender-${randomUUID()}`
  const remoteOut = `${work}/out${extensionOf(options.outPath)}`
  const started = Date.now()

  const script = `
set -e
mkdir -p ${work}
printf %s ${Buffer.from(python, 'utf8').toString('base64')} | base64 -d > ${work}/generate.py
${REMOTE_BLENDER} --background --factory-startup --python-exit-code 1 \\
  --python ${work}/generate.py -- ${remoteOut}
# Blender exits 0 for a script that ran and exported nothing, so the file is
# the success signal — same lesson as the local path above.
if [ ! -s ${remoteOut} ]; then echo "__GOLEM_NO_OUTPUT__"; exit 3; fi
echo "__GOLEM_BYTES__ $(stat -c %s ${remoteOut})"
echo "${B64_BEGIN}"
base64 ${remoteOut}
echo "${B64_END}"
rm -rf ${work}
`.trim()

  const run = await runHeadless(`bash -c ${base64Arg(script)}`, {
    timeoutMs,
    runId: `blender-run-${randomUUID()}`,
  })

  if (run.failure) throw new BlenderError(`Sprite exec failed: ${run.failure}`)
  if (run.timedOut) throw new BlenderError(`Blender timed out after ${timeoutMs}ms on the Sprite`)
  if (run.output.includes('__GOLEM_NO_OUTPUT__')) {
    throw new BlenderError(
      `Blender exited cleanly on the Sprite but wrote no file — the script ran and exported nothing`,
      tail(run.output),
    )
  }
  if (run.exitCode !== 0) {
    throw new BlenderError(`Blender script failed on the Sprite (exit ${run.exitCode})`, tail(run.output))
  }

  const begin = run.output.indexOf(B64_BEGIN)
  const end = run.output.indexOf(B64_END)
  if (begin === -1 || end === -1 || end < begin) {
    throw new BlenderError('the Sprite produced a file but its transfer markers never arrived', tail(run.output))
  }
  // Whitespace-strip rather than line-split: base64's own wrapping, the TTY's
  // CRLF translation and the shell's echo all put breaks in different places,
  // and none of them are part of the payload.
  const payload = run.output.slice(begin + B64_BEGIN.length, end).replaceAll(/\s+/g, '')
  const buf = Buffer.from(payload, 'base64')

  const declared = Number(/__GOLEM_BYTES__ (\d+)/.exec(run.output)?.[1] ?? NaN)
  if (Number.isFinite(declared) && declared !== buf.byteLength) {
    throw new BlenderError(
      `transfer from the Sprite lost data: ${declared} bytes on the Sprite, ${buf.byteLength} decoded here`,
    )
  }
  if (buf.byteLength > MAX_TRANSFER_BYTES) {
    throw new BlenderError(`artefact is ${buf.byteLength} bytes, over the ${MAX_TRANSFER_BYTES}-byte transfer cap`)
  }

  await mkdir(dirname(options.outPath), { recursive: true })
  await writeFile(options.outPath, buf)

  return {
    glbPath: options.outPath,
    bytes: buf.byteLength,
    stdout: run.output.slice(0, begin),
    durationMs: Date.now() - started,
  }
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : '.glb'
}

/** Blender is loud; only the end of its output says why it failed. */
function tail(output: string): string {
  return output.slice(-2000)
}

// ─── Validation ────────────────────────────────────────────────────────

export interface GlbInfo {
  valid: boolean
  version: number
  bytes: number
  meshes: string[]
  materials: string[]
  error: string | null
}

/**
 * Parse a .glb far enough to know it is really a glTF binary and what is in it.
 *
 * "The file exists and is non-empty" is not the same as "the file is a model",
 * and a truncated export produces a plausible-looking file that fails silently
 * in the browser at render time. The container header carries its own total
 * length, so a truncation is detectable here rather than in R3F.
 */
export async function inspectGlb(path: string): Promise<GlbInfo> {
  const empty: GlbInfo = { valid: false, version: 0, bytes: 0, meshes: [], materials: [], error: null }
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch (e) {
    return { ...empty, error: `unreadable: ${String(e)}` }
  }
  if (buf.byteLength < 20) return { ...empty, bytes: buf.byteLength, error: 'too short to be a glTF container' }
  if (buf.toString('ascii', 0, 4) !== 'glTF') {
    return { ...empty, bytes: buf.byteLength, error: 'missing glTF magic — not a .glb' }
  }

  const version = buf.readUInt32LE(4)
  const declared = buf.readUInt32LE(8)
  if (declared !== buf.byteLength) {
    return { ...empty, version, bytes: buf.byteLength, error: `truncated: header declares ${declared} bytes, file is ${buf.byteLength}` }
  }

  const jsonLength = buf.readUInt32LE(12)
  try {
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength)) as {
      meshes?: { name?: string }[]
      materials?: { name?: string }[]
    }
    return {
      valid: true,
      version,
      bytes: buf.byteLength,
      meshes: (json.meshes ?? []).map((m, i) => m.name ?? `mesh${i}`),
      materials: (json.materials ?? []).map((m, i) => m.name ?? `material${i}`),
      error: null,
    }
  } catch (e) {
    return { ...empty, version, bytes: buf.byteLength, error: `JSON chunk did not parse: ${String(e)}` }
  }
}
