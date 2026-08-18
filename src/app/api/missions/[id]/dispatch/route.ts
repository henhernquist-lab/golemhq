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
import { getMission, listEvents, listTasks, recordEvent, updateMissionStatus } from '@/lib/missions/store'
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
    // The wave this route fires is serial by default, and until Batch 10 that
    // meant the shared checkout: worktrees were allocated on maxConcurrent > 1
    // alone, so preserveWorktree never ran, no `golem/task/<id>` branch was
    // ever written, and the approval gate had nothing to list. The builder's
    // output stayed as uncommitted changes in this checkout — real work, in
    // the one place a later `git checkout` throws away.
    isolate: true,
  }).then(async () => {
    // Nothing in Batches 1-7 ever moves a mission off `running`: the Planner
    // sets it, failures set `failed`, and a mission whose tasks all finished
    // just stayed there forever. That is invisible until there is a front door
    // — createMission refuses a second mission while an active one holds the
    // repo, so without this the entry point jams permanently after the first
    // success. Closed here rather than inside the proven Scheduler.
    //
    // `awaiting_approval`, not `completed`: with isolation the work is sitting
    // on task branches that have not been merged into anything. Calling that
    // completed is the same lie the missing branch used to tell — it reads as
    // landed while main has none of it. `completed` is the approval gate's to
    // set, once the merge actually moves the target.
    try {
      const [tasks, events] = await Promise.all([listTasks(id), listEvents(id, 500)])
      if (tasks.length === 0 || !tasks.every((t) => t.status === 'complete')) return
      // A task that wrote nothing leaves a clean worktree and no branch, so
      // there is nothing to approve and holding the repo open for a decision
      // that has no subject would jam the door again.
      const preserved = events.some((e) => e.type === 'scheduler.work_preserved')
      await updateMissionStatus(id, preserved ? 'awaiting_approval' : 'completed', {
        completedTasks: tasks.length,
        ...(preserved ? {} : { reason: 'every task finished without writing anything to preserve' }),
      })
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
