// Batch 4.5 — image-to-3D via Hugging Face.
//
// Third attempt at a hosted 3D generator, and the first that actually works.
// Meshy's "free tier" was not free; Tripo3D authenticated fine but refused
// every task with "not enough credit" on a brand-new account with zero usage.
//
// ─── Why a Space and not the Inference API ────────────────────────────
// The obvious route — HF's serverless Inference API — cannot do this. Verified
// against the live API, not assumed:
//
//   POST /hf-inference/models/stabilityai/TripoSR  → 400 "Model not supported
//                                                    by provider hf-inference"
//   POST /hf-inference/models/openai/shap-e        → 400, same
//   POST .../FLUX.1-schnell (text-to-image)        → 410 "deprecated and no
//                                                    longer supported"
//
// Serverless inference no longer serves image-to-3d or text-to-3d pipelines at
// all. What IS live is the stabilityai/TripoSR Space (RUNNING, ZeroGPU), which
// exposes the same model over Gradio's HTTP API. That is what this drives.
//
// ─── Consequences worth knowing ───────────────────────────────────────
// A Space is not an API product. It sleeps when idle and takes ~30s to wake,
// ZeroGPU enforces a per-account quota, and the owner can change or remove it.
// Those are handled explicitly below rather than surfacing as generic failures,
// because "the Space is asleep" and "the model rejected the image" need very
// different responses from a caller.

import { inspectGlb, type GlbInfo } from './blender'
import { writeFile } from 'node:fs/promises'

/** The Space hosting TripoSR. Overridable — Spaces come and go. */
const SPACE = process.env.HF_SPACE_3D?.trim() || 'stabilityai/TripoSR'

function spaceBase(space: string): string {
  return `https://${space.replace('/', '-').toLowerCase()}.hf.space`
}

export class HuggingFaceError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'HuggingFaceError'
    this.status = status
  }
}

export class HuggingFaceNotConfiguredError extends HuggingFaceError {
  constructor() {
    super(
      'HF_API_TOKEN is not set. Create one at https://huggingface.co/settings/tokens ' +
        'and add it to .env.local, then restart the dev server (env changes do not hot-reload).',
    )
    this.name = 'HuggingFaceNotConfiguredError'
  }
}

/** HUGGINGFACE_API_KEY is accepted as an alias — both spellings exist in the wild. */
export function huggingFaceConfigured(): boolean {
  return !!(process.env.HF_API_TOKEN ?? process.env.HUGGINGFACE_API_KEY)?.trim()
}

function token(): string {
  const t = (process.env.HF_API_TOKEN ?? process.env.HUGGINGFACE_API_KEY)?.trim()
  if (!t) throw new HuggingFaceNotConfiguredError()
  return t
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token()}` }
}

// ─── Space readiness ───────────────────────────────────────────────────

export type SpaceStage = 'RUNNING' | 'SLEEPING' | 'BUILDING' | 'RUNTIME_ERROR' | 'CONFIG_ERROR' | 'UNKNOWN'

export interface SpaceStatus {
  stage: SpaceStage
  hardware: string | null
  /** True when a request can be expected to succeed without a cold start. */
  ready: boolean
}

/**
 * Ask the Hub what state the Space is in.
 *
 * Worth doing before a generation rather than after a confusing timeout: a
 * SLEEPING Space answers requests, it just takes half a minute to wake first,
 * and a CONFIG_ERROR Space never will. Those deserve different messages.
 */
export async function spaceStatus(space: string = SPACE): Promise<SpaceStatus> {
  const res = await fetch(`https://huggingface.co/api/spaces/${space}`, { headers: authHeaders() })
  if (!res.ok) {
    throw new HuggingFaceError(`cannot read Space ${space}: HTTP ${res.status}`, res.status)
  }
  const data = (await res.json()) as { runtime?: { stage?: string; hardware?: { current?: string } } }
  const stage = (data.runtime?.stage ?? 'UNKNOWN') as SpaceStage
  return {
    stage,
    hardware: data.runtime?.hardware?.current ?? null,
    ready: stage === 'RUNNING',
  }
}

// ─── Gradio plumbing ───────────────────────────────────────────────────

interface GradioFile {
  path: string
  orig_name?: string
  mime_type?: string
  meta?: { _type: string }
}

/**
 * Call one named Gradio endpoint and wait for its result.
 *
 * Gradio's queue is a two-step protocol — POST returns an event_id, then a GET
 * streams server-sent events until the job finishes. The stream carries
 * heartbeats and progress events too, so the last event is the only one that
 * matters, and an `error` event arrives with HTTP 200 like everything else.
 */
async function gradioCall(base: string, endpoint: string, data: unknown[], timeoutMs: number): Promise<unknown[]> {
  const post = await fetch(`${base}/call${endpoint}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  if (!post.ok) {
    const body = await post.text()
    // ZeroGPU quota is a per-account limit, not a broken request; say so.
    const quota = /quota|gpu.*exceeded/i.test(body) ? ' — ZeroGPU quota exhausted, try again later' : ''
    throw new HuggingFaceError(`${endpoint} rejected: HTTP ${post.status}${quota}: ${body.slice(0, 200)}`, post.status)
  }
  const { event_id: eventId } = (await post.json()) as { event_id?: string }
  if (!eventId) throw new HuggingFaceError(`${endpoint} returned no event_id`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let text: string
  try {
    const stream = await fetch(`${base}/call${endpoint}/${eventId}`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
    text = await stream.text()
  } catch {
    throw new HuggingFaceError(`${endpoint} timed out after ${timeoutMs}ms waiting for the Space`)
  } finally {
    clearTimeout(timer)
  }

  const events = [...text.matchAll(/^event: (\w+)\ndata: (.*)$/gm)]
  const last = events.at(-1)
  if (!last) throw new HuggingFaceError(`${endpoint} produced no events: ${text.slice(0, 200)}`)
  if (last[1] === 'error') throw new HuggingFaceError(`${endpoint} failed: ${last[2].slice(0, 300)}`)

  try {
    return JSON.parse(last[2]) as unknown[]
  } catch {
    throw new HuggingFaceError(`${endpoint} returned unparseable data: ${last[2].slice(0, 200)}`)
  }
}

async function uploadImage(base: string, image: Buffer, filename: string): Promise<GradioFile> {
  const form = new FormData()
  form.append('files', new Blob([new Uint8Array(image)], { type: 'image/png' }), filename)
  const res = await fetch(`${base}/upload`, { method: 'POST', headers: authHeaders(), body: form })
  if (!res.ok) throw new HuggingFaceError(`uploading the image failed: HTTP ${res.status}`, res.status)
  const paths = (await res.json()) as string[]
  if (!paths?.[0]) throw new HuggingFaceError('upload returned no file path')
  return { path: paths[0], orig_name: filename, mime_type: 'image/png', meta: { _type: 'gradio.FileData' } }
}

// ─── The capability ────────────────────────────────────────────────────

export interface ImageTo3DOptions {
  /** Strip the background before reconstruction. Almost always wanted. */
  removeBackground?: boolean
  /** How much of the frame the subject should fill after cropping. */
  foregroundRatio?: number
  /** Marching-cubes resolution. Higher is slower and more detailed. */
  resolution?: number
  /** Where to write the .glb. Defaults to a temp path. */
  outPath?: string
  timeoutMs?: number
}

export interface GeneratedModel {
  glbPath: string
  bytes: number
  info: GlbInfo
  space: string
  durationMs: number
}

/**
 * Reconstruct a 3D model from a single image and return a validated .glb.
 *
 * The validation is not optional politeness. The Space hands back a URL, and a
 * URL that 200s can still be an HTML error page, a truncated transfer, or an
 * empty file — all of which look like success to anything checking status
 * codes. inspectGlb parses the container and compares its declared length to
 * the real byte count, so a bad download fails here rather than as a blank spot
 * in a scene later. Same check the Blender path uses, on purpose.
 */
export async function imageTo3D(
  image: Buffer,
  options: ImageTo3DOptions = {},
): Promise<GeneratedModel> {
  const started = Date.now()
  const base = spaceBase(SPACE)
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000

  const status = await spaceStatus(SPACE)
  if (status.stage === 'CONFIG_ERROR' || status.stage === 'RUNTIME_ERROR') {
    throw new HuggingFaceError(
      `Space ${SPACE} is in ${status.stage} and cannot serve requests. Set HF_SPACE_3D to a working Space.`,
    )
  }
  // SLEEPING and BUILDING are not failures — the first request wakes it. The
  // only cost is latency, which the timeout already covers.

  const uploaded = await uploadImage(base, image, 'input.png')

  const pre = await gradioCall(
    base,
    '/preprocess',
    [uploaded, options.removeBackground ?? true, options.foregroundRatio ?? 0.85],
    timeoutMs,
  )
  const processed = pre[0] as GradioFile | undefined
  if (!processed?.path) throw new HuggingFaceError('preprocess returned no processed image')

  const generated = await gradioCall(base, '/generate', [processed, options.resolution ?? 256], timeoutMs)

  // The endpoint returns [OBJ, GLB]. Pick the .glb by extension rather than by
  // index — an argument order change upstream would otherwise hand us an OBJ
  // that fails glTF validation for reasons that look like corruption.
  const files = generated.filter((f): f is GradioFile => !!(f as GradioFile)?.path)
  const glb = files.find((f) => f.path.toLowerCase().endsWith('.glb'))
  if (!glb) {
    throw new HuggingFaceError(
      `generate produced no .glb (got: ${files.map((f) => f.path.split('.').pop()).join(', ') || 'nothing'})`,
    )
  }

  // Build the download URL rather than trusting the one in the payload: Gradio
  // rewrites paths in its response and has been observed emitting a mangled
  // host (".../ca/file=..." instead of ".../call/file=...").
  const res = await fetch(`${base}/file=${glb.path}`, { headers: authHeaders() })
  if (!res.ok) throw new HuggingFaceError(`downloading the .glb failed: HTTP ${res.status}`, res.status)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.byteLength === 0) throw new HuggingFaceError('the generated .glb downloaded as zero bytes')

  const outPath = options.outPath ?? `/tmp/hf-${Date.now()}.glb`
  await writeFile(outPath, bytes)
  const info = await inspectGlb(outPath)
  if (!info.valid) {
    throw new HuggingFaceError(`the Space returned ${bytes.byteLength} bytes that are not a valid .glb: ${info.error}`)
  }

  return { glbPath: outPath, bytes: bytes.byteLength, info, space: SPACE, durationMs: Date.now() - started }
}

/** The Space this module will use. Exposed so verification can report it. */
export function activeSpace(): string {
  return SPACE
}
