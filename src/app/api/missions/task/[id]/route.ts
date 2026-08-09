/**
 * /api/missions/task/[id] — everything needed to answer "did this actually
 * happen", for one task.
 *
 * The dashboard already shows a status badge. A badge is the system's opinion
 * of itself, which is precisely what is in question, so this returns the raw
 * material instead: what the builder wrote, what changed on disk, every state
 * transition with its timestamp, and any artifact that can be checked outside
 * this application entirely.
 *
 * Artifacts are verified on read rather than at write time. A commit that was
 * local when the task ran may be pushed an hour later, and a stored
 * "unverified" flag would still be claiming otherwise. Asking GitHub each time
 * the view is opened costs one request and is never stale.
 */

import { auth } from '@/lib/auth'
import { getTask, listEvents, listResults } from '@/lib/missions/store'
import { parseGitHubRemote, verifyCommit, artifactsFromEvents, type TaskArtifact } from '@/lib/missions/artifacts'

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
    const task = await getTask(id)
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 })

    const [results, allEvents] = await Promise.all([listResults(id), listEvents(task.missionId, 500)])
    const events = allEvents.filter((e) => e.taskId === id)

    const worktree = events.find((e) => e.type === 'task.worktree')?.payload ?? null
    const files = Array.isArray(worktree?.files) ? (worktree.files as string[]) : []

    const artifacts: TaskArtifact[] = []

    // Anything GitHub itself minted a URL for — a PR, a comment — is trusted
    // as-is, because the URL came from the API rather than from string
    // concatenation here.
    artifacts.push(
      ...artifactsFromEvents(
        events.filter((e) => e.type === 'task.artifact').map((e) => e.payload),
      ),
    )

    // A local commit is the common case: the builder CLIs commit, they do not
    // push. Turning that into a github.com link without checking would be the
    // single most misleading thing this endpoint could do.
    const sha = typeof worktree?.headAfter === 'string' ? worktree.headAfter : null
    const movedHead = worktree?.committed === true && sha && sha !== worktree.headBefore
    if (movedHead) {
      const remoteUrl = typeof worktree.remote === 'string' ? worktree.remote : null
      const remote = remoteUrl ? parseGitHubRemote(remoteUrl) : null
      if (remote) {
        artifacts.push(await verifyCommit(remote, sha))
      } else {
        artifacts.push({
          kind: 'commit',
          label: sha.slice(0, 7),
          url: null,
          verification: 'unverified',
          note: remoteUrl
            ? `the checkout's remote (${remoteUrl}) is not on github.com, so this commit cannot be checked from here`
            : 'the checkout has no git remote, so this commit exists only on the builder machine',
        })
      }
    }

    return Response.json({
      task,
      results,
      events,
      worktree: { files, committed: worktree?.committed === true, unknown: worktree?.unknown === true },
      artifacts,
      // Said explicitly so the UI never has to infer it from an empty array.
      hasExternalEvidence: artifacts.some((a) => a.verification === 'verified'),
    })
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'failed to load task' },
      { status: 500 },
    )
  }
}
