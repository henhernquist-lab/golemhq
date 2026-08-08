// Batch 4.5 — text-to-3D and image-to-3D via Meshy.
//
// Blender builds what you can describe geometrically; Meshy builds what you can
// only describe in words. Both land in the same place — a .glb that R3F can
// load — so callers can treat them as interchangeable sources.
//
// ─── Status ───────────────────────────────────────────────────────────
// Written against Meshy's OpenAPI v2 (text) / v1 (image), and NOT yet exercised
// against a live account: MESHY_API_KEY does not exist in this environment. The
// endpoint shapes are confirmed — all three URLs below answer 401 "Invalid API
// key" rather than 404 — but the response payload handling is from the docs,
// not from a real generation. Treat the first real run as the actual test.

const BASE = 'https://api.meshy.ai/openapi'

export class MeshyError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'MeshyError'
    this.status = status
  }
}

export class MeshyNotConfiguredError extends MeshyError {
  constructor() {
    super(
      'MESHY_API_KEY is not set. Create a key at https://www.meshy.ai/api and add it to .env.local, ' +
        'then restart the dev server (env changes do not hot-reload).',
    )
    this.name = 'MeshyNotConfiguredError'
  }
}

export function meshyConfigured(): boolean {
  return !!process.env.MESHY_API_KEY?.trim()
}

function key(): string {
  const k = process.env.MESHY_API_KEY?.trim()
  if (!k) throw new MeshyNotConfiguredError()
  return k
}

async function meshyFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key()}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...((init.headers ?? {}) as Record<string, string>),
    },
  })
  const text = await res.text()
  if (!res.ok) {
    // 402 is the one worth naming: on the free tier it means credits are gone,
    // which is a different problem from a bad key and needs a different fix.
    const hint = res.status === 402 ? ' — free-tier credits exhausted' : ''
    throw new MeshyError(`Meshy ${res.status}${hint}: ${text.slice(0, 300)}`, res.status)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new MeshyError(`Meshy returned non-JSON: ${text.slice(0, 200)}`)
  }
}

// ─── Tasks ─────────────────────────────────────────────────────────────

export type MeshyStatus = 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED'

export interface MeshyTask {
  id: string
  status: MeshyStatus
  progress: number
  /** Populated only once SUCCEEDED. */
  modelUrls: { glb?: string; fbx?: string; obj?: string; usdz?: string }
  thumbnailUrl: string | null
  error: string | null
}

function toTask(raw: unknown): MeshyTask {
  const r = raw as {
    id?: string
    result?: string
    status?: MeshyStatus
    progress?: number
    model_urls?: Record<string, string>
    thumbnail_url?: string
    task_error?: { message?: string }
  }
  return {
    id: r.id ?? r.result ?? '',
    status: r.status ?? 'PENDING',
    progress: r.progress ?? 0,
    modelUrls: r.model_urls ?? {},
    thumbnailUrl: r.thumbnail_url ?? null,
    error: r.task_error?.message ?? null,
  }
}

export interface TextTo3DOptions {
  prompt: string
  /**
   * 'preview' produces untextured geometry and is what the free tier is for.
   * 'refine' adds texture and costs a separate, larger credit charge, and it
   * requires the preview task id — so it is never the first call.
   */
  mode?: 'preview' | 'refine'
  artStyle?: 'realistic' | 'sculpture'
  negativePrompt?: string
  /** Required when mode is 'refine'. */
  previewTaskId?: string
}

/** Start a text-to-3D generation. Returns immediately with a task id. */
export async function createTextTo3D(options: TextTo3DOptions): Promise<string> {
  const mode = options.mode ?? 'preview'
  if (mode === 'refine' && !options.previewTaskId) {
    throw new MeshyError('refine mode needs the preview task id it is refining')
  }
  const body =
    mode === 'refine'
      ? { mode, preview_task_id: options.previewTaskId }
      : {
          mode,
          prompt: options.prompt,
          art_style: options.artStyle ?? 'realistic',
          should_remesh: true,
          ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
        }

  const raw = (await meshyFetch('/v2/text-to-3d', { method: 'POST', body: JSON.stringify(body) })) as {
    result?: string
  }
  if (!raw.result) throw new MeshyError('Meshy accepted the request but returned no task id')
  return raw.result
}

/** Start an image-to-3D generation from a publicly reachable image URL or data URI. */
export async function createImageTo3D(imageUrl: string): Promise<string> {
  const raw = (await meshyFetch('/v1/image-to-3d', {
    method: 'POST',
    body: JSON.stringify({ image_url: imageUrl, enable_pbr: true, should_remesh: true }),
  })) as { result?: string }
  if (!raw.result) throw new MeshyError('Meshy accepted the request but returned no task id')
  return raw.result
}

export async function getTask(taskId: string, kind: 'text' | 'image' = 'text'): Promise<MeshyTask> {
  const path = kind === 'text' ? `/v2/text-to-3d/${taskId}` : `/v1/image-to-3d/${taskId}`
  return toTask(await meshyFetch(path))
}

/**
 * Poll until the task finishes.
 *
 * Generation takes minutes, not seconds, so the caller gets an onProgress hook
 * rather than a silent wait — a mission that looks hung for four minutes is
 * indistinguishable from one that is actually hung.
 */
export async function waitForTask(
  taskId: string,
  options: {
    kind?: 'text' | 'image'
    timeoutMs?: number
    pollMs?: number
    onProgress?: (task: MeshyTask) => void
  } = {},
): Promise<MeshyTask> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
  const pollMs = options.pollMs ?? 5_000
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const task = await getTask(taskId, options.kind ?? 'text')
    options.onProgress?.(task)
    if (task.status === 'SUCCEEDED') return task
    if (task.status === 'FAILED' || task.status === 'CANCELED') {
      throw new MeshyError(`Meshy task ${taskId} ${task.status}: ${task.error ?? 'no reason given'}`)
    }
    if (Date.now() > deadline) {
      throw new MeshyError(`Meshy task ${taskId} still ${task.status} after ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/**
 * Download a finished model's .glb.
 *
 * Meshy's URLs are pre-signed and expire, so a task id stored today will not
 * still resolve to a file next week — fetch the bytes when the task lands, do
 * not persist the URL and hope.
 */
export async function downloadGlb(task: MeshyTask): Promise<Buffer> {
  const url = task.modelUrls.glb
  if (!url) throw new MeshyError(`task ${task.id} has no .glb among ${Object.keys(task.modelUrls).join(', ') || 'no formats'}`)
  const res = await fetch(url)
  if (!res.ok) throw new MeshyError(`downloading .glb: HTTP ${res.status}`, res.status)
  return Buffer.from(await res.arrayBuffer())
}

/** Text prompt in, .glb bytes out. The whole pipeline for the common case. */
export async function generateGlbFromText(
  prompt: string,
  options: { onProgress?: (t: MeshyTask) => void; timeoutMs?: number } = {},
): Promise<{ task: MeshyTask; glb: Buffer }> {
  const taskId = await createTextTo3D({ prompt })
  const task = await waitForTask(taskId, { onProgress: options.onProgress, timeoutMs: options.timeoutMs })
  return { task, glb: await downloadGlb(task) }
}
