// Batch 4.5 — text-to-3D and image-to-3D via Tripo3D.
//
// Replaces the Meshy integration, which was written but never exercised: its
// free tier turned out to be paid-and-blocked. Tripo3D fills the same slot —
// describe a thing in words, get a .glb R3F can load — so callers that used
// generateGlbFromText keep the same shape.
//
// ─── Two traps this API has that Meshy's did not ──────────────────────
// 1. HTTP 200 does NOT mean success. Every response is wrapped in
//    {code, data, message}, and a non-zero `code` is an error carried inside a
//    200. Checking res.ok alone would read failures as successes.
// 2. Status casing is inconsistent between Tripo's own documents ("success" vs
//    "Success"), so status is normalised before comparison rather than matched
//    literally.
//
// Verified against the live API: the endpoints below answer 401 with Tripo's
// own {code:1002,...} envelope rather than 404, so the paths and the envelope
// shape are confirmed. The success-path payload handling is from the docs — the
// first real generation is its actual test.

import { inspectGlb, type GlbInfo } from './blender'
import { writeFile } from 'node:fs/promises'

const BASE = 'https://api.tripo3d.ai/v2/openapi'

export class TripoError extends Error {
  readonly status?: number
  readonly code?: number
  constructor(message: string, status?: number, code?: number) {
    super(message)
    this.name = 'TripoError'
    this.status = status
    this.code = code
  }
}

export class TripoNotConfiguredError extends TripoError {
  constructor() {
    super(
      'TRIPO_API_KEY is not set. Create a key at https://platform.tripo3d.ai and add it to ' +
        '.env.local, then restart the dev server (env changes do not hot-reload).',
    )
    this.name = 'TripoNotConfiguredError'
  }
}

/** TRIPO3D_API_KEY is accepted as an alias so either spelling works. */
export function tripoConfigured(): boolean {
  return !!(process.env.TRIPO_API_KEY ?? process.env.TRIPO3D_API_KEY)?.trim()
}

function key(): string {
  const k = (process.env.TRIPO_API_KEY ?? process.env.TRIPO3D_API_KEY)?.trim()
  if (!k) throw new TripoNotConfiguredError()
  return k
}

interface Envelope<T> {
  code: number
  data: T
  message?: string
  suggestion?: string
}

async function tripoFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key()}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...((init.headers ?? {}) as Record<string, string>),
    },
  })
  const text = await res.text()

  let parsed: Envelope<T>
  try {
    parsed = JSON.parse(text) as Envelope<T>
  } catch {
    throw new TripoError(`Tripo returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status)
  }

  if (!res.ok) {
    const hint = res.status === 402 ? ' — out of credits' : ''
    throw new TripoError(
      `Tripo ${res.status}${hint}: ${parsed.message ?? text.slice(0, 200)}${parsed.suggestion ? ` (${parsed.suggestion})` : ''}`,
      res.status,
      parsed.code,
    )
  }
  // The trap: a 200 carrying a non-zero code is a failure.
  if (parsed.code !== 0) {
    throw new TripoError(
      `Tripo error code ${parsed.code}: ${parsed.message ?? 'no message'}${parsed.suggestion ? ` (${parsed.suggestion})` : ''}`,
      res.status,
      parsed.code,
    )
  }
  return parsed.data
}

// ─── Tasks ─────────────────────────────────────────────────────────────

export type TripoStatus = 'queued' | 'running' | 'success' | 'failed' | 'banned' | 'expired' | 'cancelled' | 'unknown'

const TERMINAL_BAD: TripoStatus[] = ['failed', 'banned', 'expired', 'cancelled']

function normaliseStatus(raw: unknown): TripoStatus {
  const s = String(raw ?? '').toLowerCase()
  const known: TripoStatus[] = ['queued', 'running', 'success', 'failed', 'banned', 'expired', 'cancelled']
  return (known as string[]).includes(s) ? (s as TripoStatus) : 'unknown'
}

export interface TripoTask {
  id: string
  status: TripoStatus
  progress: number
  /** Populated only once status is 'success'. */
  modelUrls: { model?: string; pbrModel?: string }
  thumbnailUrl: string | null
}

function toTask(raw: unknown): TripoTask {
  const r = raw as {
    task_id?: string
    status?: string
    progress?: number
    output?: { model?: string; pbr_model?: string; rendered_image?: string }
    result?: { pbr_model?: { url?: string }; model?: { url?: string } }
  }
  // v2.5+ moved the URLs under `result` with nested {url}; older responses put
  // plain strings under `output`. Both are read so a version bump on Tripo's
  // side does not silently produce a task with no downloadable model.
  return {
    id: r.task_id ?? '',
    status: normaliseStatus(r.status),
    progress: r.progress ?? 0,
    modelUrls: {
      model: r.output?.model ?? r.result?.model?.url,
      pbrModel: r.output?.pbr_model ?? r.result?.pbr_model?.url,
    },
    thumbnailUrl: r.output?.rendered_image ?? null,
  }
}

export interface TextTo3DOptions {
  prompt: string
  negativePrompt?: string
  /** Tripo's generation model version, e.g. 'v2.5-20250123'. Omit for their default. */
  modelVersion?: string
  /** Ask for PBR textures. Costs more credits. */
  texture?: boolean
}

export async function createTextTo3D(options: TextTo3DOptions): Promise<string> {
  const data = await tripoFetch<{ task_id?: string }>('/task', {
    method: 'POST',
    body: JSON.stringify({
      type: 'text_to_model',
      prompt: options.prompt,
      ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
      ...(options.modelVersion ? { model_version: options.modelVersion } : {}),
      ...(options.texture === undefined ? {} : { texture: options.texture }),
    }),
  })
  if (!data.task_id) throw new TripoError('Tripo accepted the request but returned no task_id')
  return data.task_id
}

/** Image-to-3D. The image must be reachable by Tripo, or pre-uploaded via their upload endpoint. */
export async function createImageTo3D(imageUrl: string): Promise<string> {
  const data = await tripoFetch<{ task_id?: string }>('/task', {
    method: 'POST',
    body: JSON.stringify({ type: 'image_to_model', file: { type: 'url', url: imageUrl } }),
  })
  if (!data.task_id) throw new TripoError('Tripo accepted the request but returned no task_id')
  return data.task_id
}

export async function getTask(taskId: string): Promise<TripoTask> {
  return toTask(await tripoFetch<unknown>(`/task/${encodeURIComponent(taskId)}`))
}

/**
 * Poll until the task finishes.
 *
 * An 'unknown' status is treated as still-running rather than as a failure: a
 * status string Tripo adds later should not crash a generation that is fine.
 * The timeout is what stops that being an infinite loop.
 */
export async function waitForTask(
  taskId: string,
  options: { timeoutMs?: number; pollMs?: number; onProgress?: (t: TripoTask) => void } = {},
): Promise<TripoTask> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
  const pollMs = options.pollMs ?? 5_000
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const task = await getTask(taskId)
    options.onProgress?.(task)
    if (task.status === 'success') return task
    if (TERMINAL_BAD.includes(task.status)) {
      throw new TripoError(`Tripo task ${taskId} ended as "${task.status}"`)
    }
    if (Date.now() > deadline) {
      throw new TripoError(`Tripo task ${taskId} still "${task.status}" after ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/**
 * Download a finished model's .glb.
 *
 * Prefers the PBR variant when present — it is the textured one, and a caller
 * that paid for textures should get them. Tripo's URLs are pre-signed and
 * expire, so fetch the bytes when the task lands rather than storing the URL.
 */
export async function downloadGlb(task: TripoTask): Promise<Buffer> {
  const url = task.modelUrls.pbrModel ?? task.modelUrls.model
  if (!url) {
    throw new TripoError(
      `task ${task.id} reported success but carries no model URL — refusing to report a generation that produced nothing`,
    )
  }
  const res = await fetch(url)
  if (!res.ok) throw new TripoError(`downloading .glb: HTTP ${res.status}`, res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength === 0) throw new TripoError(`downloaded .glb is empty (${url.slice(0, 80)}…)`)
  return buf
}

export interface GeneratedModel {
  task: TripoTask
  glb: Buffer
  info: GlbInfo
}

/**
 * Text prompt in, validated .glb out.
 *
 * The validation is the point. A 200 with plausible bytes is not a model: the
 * container is parsed and its declared length checked against the actual byte
 * count, so a truncated download fails here rather than as a blank spot in a
 * scene later. Same check the Blender path uses, deliberately — a generated
 * asset should not be trusted more than one we produced ourselves.
 */
export async function generateGlbFromText(
  prompt: string,
  options: { onProgress?: (t: TripoTask) => void; timeoutMs?: number; outPath?: string } = {},
): Promise<GeneratedModel> {
  const taskId = await createTextTo3D({ prompt })
  const task = await waitForTask(taskId, { onProgress: options.onProgress, timeoutMs: options.timeoutMs })
  const glb = await downloadGlb(task)

  const path = options.outPath ?? `/tmp/tripo-${task.id}.glb`
  await writeFile(path, glb)
  const info = await inspectGlb(path)
  if (!info.valid) {
    throw new TripoError(`Tripo returned ${glb.byteLength} bytes that are not a valid .glb: ${info.error}`)
  }
  return { task, glb, info }
}

/** Remaining credits, for deciding whether a generation is worth attempting. */
export async function balance(): Promise<{ balance: number; frozen: number }> {
  const data = await tripoFetch<{ balance?: number; frozen?: number }>('/user/balance')
  return { balance: data.balance ?? 0, frozen: data.frozen ?? 0 }
}
