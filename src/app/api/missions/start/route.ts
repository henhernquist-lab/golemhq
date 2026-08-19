/**
 * POST /api/missions/start — the mission ignition.
 *
 * Batches 1-7 built Planner → Scheduler → Coordinator → Builders → Validators
 * → Approval and proved each one, but nothing in the app ever called them:
 * `planMission` and `scheduleTasks` had zero callers outside
 * scripts/verify-*.mjs. The pipeline had no front door. This is it.
 *
 * Deliberately only plans. Planning is one bounded model call (~10-15s, inside
 * maxDuration) and produces the task graph Henry reviews. Dispatch is a
 * separate call because it runs real CLIs against a real checkout for minutes
 * — putting it here would guarantee a timeout and leave a half-run mission
 * with no record of why.
 *
 * Owner-gated: this spends real money (planner tokens) and the mission it
 * creates goes on to execute real code. Not a read.
 */

import { requireHenryOwner } from '@/lib/auth-owner'
import { resolveResourceUserId } from '@/lib/resource-user'
import { readRequestJson } from '@/lib/request-json'
import { createMission, listTasks, MissionStoreError } from '@/lib/missions/store'
import { planMission, PlannerError, BudgetExceededError } from '@/lib/missions/planner'
import { enterPlanGate } from '@/lib/missions/plan-approval'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: Request) {
  const { response, session } = await requireHenryOwner()
  if (response) return response

  const body = await readRequestJson(req)
  const { goal, repo } = body as { goal?: string; repo?: string }

  if (typeof goal !== 'string' || goal.trim().length < 8) {
    return Response.json(
      { error: 'Describe what you want built — at least a sentence.' },
      { status: 400 },
    )
  }

  // The checkout the Planner reads for grounding. On Vercel there is no repo
  // on disk, so planning runs unground rather than failing — gatherRepoContext
  // already tolerates that and records a warning event.
  const cwd = process.env.GOLEM_REPO_ROOT?.trim() || process.cwd()
  const targetRepo = repo?.trim() || 'golemhq/enry.agent'

  // missions.created_by is a uuid referencing profiles(id); the session
  // carries profiles.google_id, which is not the same thing and is rejected by
  // Postgres as malformed uuid input.
  const createdBy = await resolveResourceUserId(session?.user?.id ?? null)

  let missionId: string | null = null
  try {
    const mission = await createMission(targetRepo, goal.trim(), createdBy)
    missionId = mission.id

    // Batch 11: the plan stops here. Before this it landed on 'running', which
    // the dispatch route acts on — so the only thing between a drafted graph
    // and real CLIs editing a real checkout was a button not yet pressed, and
    // any other caller reading the row would have seen a mission claiming to
    // run while nothing did.
    // Annotated rather than inferred: assigned only inside the callback, which
    // control-flow analysis does not follow, so an inferred `false` narrows to
    // the literal type and the read below stops compiling.
    let planGateMigrationApplied: boolean = false
    const planned = await planMission(mission.id, {
      cwd,
      finalize: async (missionId, taskCount) => {
        const gated = await enterPlanGate(missionId, { plannedTasks: taskCount })
        planGateMigrationApplied = gated.migrationApplied
        return gated.mission
      },
    })
    const tasks = await listTasks(mission.id)

    return Response.json({
      mission: planned.mission,
      tasks,
      usage: planned.usage,
      // False means the mission is parked on 'planning' instead, because
      // PLAN_GATE_MIGRATION has not been applied. The gate holds either way;
      // the caller is told which so it can say so rather than guess.
      planGateMigrationApplied,
    })
  } catch (err) {
    // Every failure mode here is one a human needs the reason for: an active
    // mission already holds this repo, the spend cap is breached, or the model
    // would not produce a valid graph. A bare 500 loses all three.
    if (err instanceof BudgetExceededError) {
      return Response.json(
        { error: err.message, kind: 'budget', missionId, verdict: err.verdict },
        { status: 429 },
      )
    }
    if (err instanceof MissionStoreError) {
      return Response.json({ error: err.message, kind: 'store', missionId }, { status: 409 })
    }
    if (err instanceof PlannerError) {
      return Response.json({ error: err.message, kind: 'planner', missionId }, { status: 502 })
    }
    return Response.json(
      { error: err instanceof Error ? err.message : 'failed to start mission', missionId },
      { status: 500 },
    )
  }
}
