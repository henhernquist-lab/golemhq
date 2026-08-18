/**
 * /api/missions/[id] — one mission's task graph.
 *
 * Split from the list route because tasks are only needed for the mission the
 * user actually opened, and the dashboard polls: fetching every mission's tasks
 * every few seconds to render one of them is the kind of thing that looks fine
 * with three missions and melts with three hundred.
 */

import { auth } from '@/lib/auth'
import { getMission, listTasks, listEvents, listLeasesForTasks } from '@/lib/missions/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RouteCtx {
  params: Promise<{ id: string }>
}

export async function GET(_req: Request, ctx: RouteCtx) {
  const session = await auth()
  if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params

  try {
    const mission = await getMission(id)
    if (!mission) return Response.json({ error: 'Mission not found' }, { status: 404 })

    const [tasks, events] = await Promise.all([listTasks(id), listEvents(id, 200)])

    // Batch 6: what each task is holding right now, and — for the ones that
    // are not running — whether they are waiting on a dependency or on another
    // task's files. Those look identical in the status column (both sit at
    // 'pending') and have completely different remedies, which is the whole
    // reason this is surfaced.
    const leases = await listLeasesForTasks(tasks.map((t) => t.id))
    const leasesByTask = leases.reduce<Record<string, typeof leases>>((acc, l) => {
      ;(acc[l.taskId] ??= []).push(l)
      return acc
    }, {})

    // Last coordinator verdict per task. A later acquisition supersedes an
    // earlier conflict, so oldest-first iteration means last write wins.
    const conflicts: Record<string, { blockedBy: string[]; detail: string }> = {}
    for (const e of events) {
      if (!e.taskId) continue
      if (e.type === 'coordinator.task_queued') {
        const p = e.payload as { blockedBy?: string[]; detail?: string }
        conflicts[e.taskId] = { blockedBy: p.blockedBy ?? [], detail: p.detail ?? 'path conflict' }
      } else if (e.type === 'coordinator.leases_acquired') {
        delete conflicts[e.taskId]
      }
    }

    // The validator verdicts are the thing worth surfacing per task: a task
    // reading "failed" with no visible reason is exactly the dead end this
    // whole pipeline keeps producing.
    const validations = events
      .filter((e) => e.type === 'task.validated' && e.taskId)
      .reduce<Record<string, unknown>>((acc, e) => {
        // listEvents is oldest-first, so LAST write wins — a re-validated task
        // must show its latest verdict, not the one it got the first time.
        if (e.taskId) acc[e.taskId] = e.payload
        return acc
      }, {})

    // The raw event stream, already loaded above for the derivations. Batch 9's
    // Command surface renders it as live progress, and it is the only honest
    // source for that — the pipeline records nothing else as it runs. Returning
    // it costs no extra query.
    return Response.json({ mission, tasks, events, validations, leases: leasesByTask, conflicts })
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'failed to load mission' },
      { status: 500 },
    )
  }
}
