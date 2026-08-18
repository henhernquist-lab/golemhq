/**
 * POST /api/missions/[id]/dispatch — hand a planned mission to the Scheduler.
 *
 * Separate from /api/missions/start because this is the part that runs real
 * builder CLIs against a real checkout. One task in the recorded history took
 * just over three minutes; a wave of them takes longer than any serverless
 * request budget. So this starts the run and returns 202 immediately — the
 * mission_events stream is the progress record, which is what the dashboard
 * already reads.
 *
 * Refuses outright on Vercel. Builders are CLI processes (claude, gemini,
 * opencode, hermes) that do not exist in the serverless bundle, so dispatching
 * there would mark tasks running and then fail every one of them for the wrong
 * reason. Saying so is more useful than a mission full of misleading failures.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { readRequestJson } from '@/lib/request-json'
import { getMission, listTasks, recordEvent, updateMissionStatus } from '@/lib/missions/store'
import { scheduleTasks } from '@/lib/missions/scheduler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

interface RouteCtx {
  params: Promise<{ id: string }>
}

export async function POST(req: Request, ctx: RouteCtx) {
  const { response } = await requireHenryOwner()
  if (response) return response

  const { id } = await ctx.params

  if (process.env.VERCEL) {
    return Response.json(
      {
        error:
          'Builders run as local CLI processes and are not installed in the serverless runtime. ' +
          'Dispatch from the Codespace (or a Sprite-backed host), not from the Vercel deployment.',
        kind: 'no_builder_backend',
      },
      { status: 501 },
    )
  }

  const mission = await getMission(id)
  if (!mission) return Response.json({ error: 'Mission not found' }, { status: 404 })
  if (mission.status !== 'running') {
    return Response.json(
      { error: `Mission is "${mission.status}" — only a planned (running) mission can be dispatched.` },
      { status: 409 },
    )
  }

  const body = await readRequestJson(req)
  const { maxTasks, maxConcurrent } = body as { maxTasks?: number; maxConcurrent?: number }
  const cwd = process.env.GOLEM_REPO_ROOT?.trim() || process.cwd()

  // Fire and forget. Awaiting would exceed the request budget and the caller
  // would see a timeout while the run kept going — the events are the record.
  void scheduleTasks(id, {
    cwd,
    maxTasks: Math.min(Math.max(1, maxTasks ?? 2), 10),
    maxConcurrent: Math.min(Math.max(1, maxConcurrent ?? 1), 4),
  }).then(async () => {
    // Nothing in Batches 1-7 ever moves a mission to `completed`: the Planner
    // sets `running`, failures set `failed`, and a mission whose tasks all
    // finished just stayed `running` forever. That is invisible until there is
    // a front door — createMission refuses a second mission while an active
    // one holds the repo, so without this the entry point jams permanently
    // after the first success. Closing it here rather than inside the
    // Scheduler keeps the proven pipeline untouched.
    try {
      const tasks = await listTasks(id)
      if (tasks.length > 0 && tasks.every((t) => t.status === 'complete')) {
        await updateMissionStatus(id, 'completed', { completedTasks: tasks.length })
      }
    } catch {
      /* best effort — the events remain the record either way */
    }
  }).catch(async (err) => {
    // A throw here happens off-request, so without this the only trace would
    // be a server log nobody can read back.
    await recordEvent(id, 'scheduler.run', {
      dispatchError: err instanceof Error ? err.message : String(err),
    }).catch(() => {})
  })

  return Response.json({ ok: true, missionId: id, dispatched: true }, { status: 202 })
}
