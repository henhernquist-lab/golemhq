import { auth } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { resolveResourceUserId } from '@/lib/resource-user'
import type { MemoryPayload } from '@/lib/resources'
import { emitResourceSaved } from '@/lib/resource-events'
import { readRequestJson } from '@/lib/request-json'
import { saveMemory } from '@/lib/memory'

export const maxDuration = 30

function userId(session: { user?: { id?: string } } | null): string | null {
  return (session?.user as { id?: string } | undefined)?.id ?? null
}

// Memories are stored as rows in `resources` with type='memory'. source is
// always 'user' (Golem-captured or imported by Henry). An `imported` flag in the
// payload marks entries pasted from another AI so the UI can badge them.

export async function GET() {
  const session = await auth()
  const uid = await resolveResourceUserId(userId(session))
  if (!uid) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('resources')
    .select('id, type, source, title, payload, created_at, updated_at')
    .eq('user_id', uid)
    .eq('type', 'memory')
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) return Response.json({ error: 'Failed to fetch' }, { status: 500 })
  return Response.json({ memories: data ?? [] })
}

export async function POST(req: Request) {
  const session = await auth()
  const uid = await resolveResourceUserId(userId(session))
  if (!uid) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await readRequestJson(req)
  const { content, origin, imported } = body as {
    content?: string
    origin?: string
    imported?: boolean
  }

  if (typeof content !== 'string' || !content.trim()) {
    return Response.json({ error: 'Content required' }, { status: 400 })
  }

  const text = content.trim()
  const payload: MemoryPayload = {
    content: text,
    imported: imported === true ? true : undefined,
    origin: origin?.trim() ? origin.trim().slice(0, 60) : undefined,
  }
  const title = text.length > 80 ? `${text.slice(0, 80)}…` : text

  const { data, error } = await supabase
    .from('resources')
    .insert({
      user_id: uid,
      type: 'memory',
      source: 'user',
      title: title.slice(0, 200),
      payload,
    })
    .select('id, type, source, title, payload, created_at, updated_at')
    .single()

  if (error) {
    console.error('[memory] insert failed:', error)
    return Response.json({ error: 'Failed to save' }, { status: 500 })
  }

  emitResourceSaved()

  // A manually-entered or imported fact is already reviewed by definition —
  // Henry typed or pasted it himself — so unlike an auto-captured pending
  // fact, it's safe to mirror into the legacy `memories` table (the
  // pgvector-searched store chat actually recalls from) immediately. Best
  // effort: the resource row is the source of truth and already saved.
  const rawUserId = userId(session)
  if (rawUserId) {
    saveMemory(rawUserId, text).then((result) => {
      if (result.error) console.error('[memory] recall-store mirror failed:', result.error)
    })
  }

  return Response.json({ memory: data })
}

// Review actions on an auto-captured pending fact. Accept marks it reviewed
// and — only now — mirrors it into the legacy recall store, since that's the
// point at which a human actually looked at it (see src/lib/auto-memory.ts
// and src/lib/lab-auto-memory.ts for why this doesn't happen at insert time).
// Reject is handled by the existing DELETE below; there's nothing to mirror
// or clean up for a fact that was never accepted.
export async function PATCH(req: Request) {
  const session = await auth()
  const uid = await resolveResourceUserId(userId(session))
  if (!uid) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await readRequestJson(req)
  const { id, action } = body as { id?: string; action?: string }
  if (typeof id !== 'string' || !id) return Response.json({ error: 'id required' }, { status: 400 })
  if (action !== 'accept') return Response.json({ error: 'Unsupported action' }, { status: 400 })

  const { data: current, error: fetchErr } = await supabase
    .from('resources')
    .select('payload')
    .eq('id', id)
    .eq('user_id', uid)
    .eq('type', 'memory')
    .maybeSingle()
  if (fetchErr || !current) return Response.json({ error: 'Not found' }, { status: 404 })

  const payload = (current.payload ?? {}) as MemoryPayload
  const nextPayload: MemoryPayload = { ...payload, reviewState: 'reviewed' }

  const { data, error } = await supabase
    .from('resources')
    .update({ payload: nextPayload, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', uid)
    .select('id, type, source, title, payload, created_at, updated_at')
    .single()
  if (error) return Response.json({ error: 'Failed to accept' }, { status: 500 })

  const rawUserId = userId(session)
  if (rawUserId && typeof payload.content === 'string') {
    saveMemory(rawUserId, payload.content).then((result) => {
      if (result.error) console.error('[memory] recall-store mirror failed on accept:', result.error)
    })
  }

  emitResourceSaved()
  return Response.json({ memory: data })
}

export async function DELETE(req: Request) {
  const session = await auth()
  const uid = await resolveResourceUserId(userId(session))
  if (!uid) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return Response.json({ error: 'id required' }, { status: 400 })

  const { error } = await supabase
    .from('resources')
    .delete()
    .eq('id', id)
    .eq('user_id', uid)
    .eq('type', 'memory')

  if (error) return Response.json({ error: 'Failed to delete' }, { status: 500 })
  emitResourceSaved()
  return Response.json({ ok: true })
}
