/**
 * /api/missions/[id] — one mission's task graph.
 *
 * Split from the list route because tasks are only needed for the mission the
 * user actually opened, and the dashboard polls: fetching every mission's tasks
 * every few seconds to render one of them is the kind of thing that looks fine
 * with three missions and melts with three hundred.
 */

import { auth } from '@/lib/auth'
import { getMission, listTasks, listEvents } from '@/lib/missions/store'

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

    // The validator verdicts are the thing worth surfacing per task: a task
    // reading "failed" with no visible reason is exactly the dead end this
    // whole pipeline keeps producing.
    const validations = events
      .filter((e) => e.type === 'task.validated' && e.taskId)
      .reduce<Record<string, unknown>>((acc, e) => {
        // listEvents is newest-first, so the first one seen per task wins.
        if (e.taskId && !acc[e.taskId]) acc[e.taskId] = e.payload
        return acc
      }, {})

    return Response.json({ mission, tasks, validations })
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'failed to load mission' },
      { status: 500 },
    )
  }
}
