/**
 * POST /api/memory/auto-extract/lab — manually-triggered Memory auto-fill
 * from real Lab activity (Evolutionary Code Generation + Overnight R&D).
 *
 * Manual, not periodic: Lab runs are experiments, and whether that counts as
 * a real usage pattern worth extracting is Henry's call each time, not a
 * background job's. See src/lib/lab-auto-memory.ts for the extraction logic
 * and why LARP Engine queries aren't included (never persisted).
 */

import { auth } from '@/lib/auth'
import { resolveResourceUserId } from '@/lib/resource-user'
import { extractLabMemories } from '@/lib/lab-auto-memory'

export const maxDuration = 30

function userId(session: { user?: { id?: string } } | null): string | null {
  return (session?.user as { id?: string } | undefined)?.id ?? null
}

export async function POST() {
  const session = await auth()
  const uid = await resolveResourceUserId(userId(session))
  if (!uid) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await extractLabMemories(uid)
    return Response.json(result)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'extraction failed' }, { status: 500 })
  }
}
