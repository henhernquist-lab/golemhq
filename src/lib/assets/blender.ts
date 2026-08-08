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
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

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

export async function blenderAvailable(): Promise<{ available: boolean; version: string | null }> {
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
