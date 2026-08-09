// Batch 2 — the headless builder adapter.
//
// Takes a task that Batch 1 stored, finds the layer-2 agent assigned to it, and
// runs that agent's CLI once, non-interactively, inside a real terminal session.
// The three touchpoints Batch 1 was built for: listAgents(2, true) to resolve
// the CLI, updateTaskStatus to mark it running, recordResult to store what came
// back.
//
// ─── Why headless, not a puppeted TUI ──────────────────────────────────
// The interactive CLIs open auth prompts, trust dialogs and pagers that differ
// per vendor and per version. Driving those by sending keystrokes is guesswork
// that breaks on any UI change. `<cli> -p "<prompt>"` runs once, prints to
// stdout and exits — a contract that holds across versions.
//
// ─── Why the same terminal machinery, not a child_process ──────────────
// On Vercel there is no local machine to spawn on: the whole reason the Cruise
// terminal routes through a Fly Sprite is that a serverless function can't hold
// a process. Reusing pty-manager / sprite-manager means the builder runs on the
// same VM, with the same repo checkout and the same authenticated CLIs the
// human already set up by hand — and a human can watch a run by attaching to
// the session id. Spawning our own process would work only in the Codespace
// and would need every CLI re-authenticated somewhere else.

import {
  runHeadless,
  base64Arg,
  worktreeSignature,
  diffSignatures,
  committedFiles,
  gitRemote,
  type WorktreeDelta,
} from '@/lib/terminal/headless-run'
import { withMcp, type McpServerName } from './mcp'
import {
  getAgentInstructions,
  getTask,
  listAgents,
  recordEvent,
  recordResult,
  updateTaskStatus,
} from './store'
import type { Agent, Task, TaskResult } from './types'

/** Default wall-clock cap for one builder run. */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

const INSTRUCTIONS_HEADING = 'Standing instructions (apply these to everything you do in this task):'
const TASK_HEADING = 'Task:'

export class BuilderAdapterError extends Error {
  readonly detail?: unknown
  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'BuilderAdapterError'
    this.detail = detail
  }
}

// ─── The run ───────────────────────────────────────────────────────────

export interface RunBuilderTaskOptions {
  /** Wall-clock cap. Defaults to DEFAULT_TIMEOUT_MS (5 min). */
  timeoutMs?: number
  /**
   * Run inside an existing terminal session instead of a throwaway one — lets
   * a human watch the run in a Forge pane. The session is left open afterwards.
   */
  sessionId?: string
  /** Working directory. Ignored on the Sprite path (see sprite-manager). */
  cwd?: string
  /**
   * Whether this task is expected to modify the checkout. Default true.
   *
   * When true, a run that exits 0 without changing anything is recorded as a
   * FAILURE, because that is what it is. Set false for genuinely read-only
   * work (a review, an analysis) where no diff is the correct outcome.
   */
  expectsWrite?: boolean
  /**
   * MCP servers to hand this builder. Only agents whose CLI takes a per-run
   * config get them; the rest run without and the skip is recorded rather than
   * hidden. See mcp.ts.
   */
  mcpServers?: McpServerName[]
  /**
   * Override the agent's stored standing instructions for this run.
   *
   * Exists so the wiring can be proven without a database round trip — see
   * scripts/verify-agent-instructions.mjs. An empty string means "run with no
   * instructions", which is different from undefined ("use the agent's").
   */
  instructions?: string
}

export interface RunBuilderTaskResult {
  task: Task
  agent: Agent
  result: TaskResult
  /** Exit code of the CLI, or null if the run never reached its end marker. */
  exitCode: number | null
  output: string
  durationMs: number
  timedOut: boolean
  sessionId: string
  /** What the run did to the checkout. */
  worktree: WorktreeDelta
  /** Which MCP servers the builder actually got, and why not, if it got none. */
  mcp: { servers: McpServerName[]; skipped: string | null }
}

/**
 * Run one task's assigned builder, once, and record the result.
 *
 * Deliberately does NOT move the task past `running` afterwards — Batch 1's
 * recordResult contract leaves the validating/failed decision to the caller,
 * which from Batch 3 onwards is the dispatcher.
 */
export async function runBuilderTask(
  taskId: string,
  options: RunBuilderTaskOptions = {},
): Promise<RunBuilderTaskResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const task = await getTask(taskId)
  if (!task) throw new BuilderAdapterError(`runBuilderTask: task ${taskId} not found`)
  if (!task.assignedAgent) {
    throw new BuilderAdapterError(`runBuilderTask: task ${taskId} has no assigned agent`)
  }

  // Layer 2 + enabled is the whole eligibility rule; resolving through this
  // list rather than by id means a disabled or wrong-layer agent can't be
  // dispatched to even if something wrote its id onto the task.
  const builders = await listAgents(2, true)
  const agent = builders.find((candidate) => candidate.id === task.assignedAgent)
  if (!agent) {
    throw new BuilderAdapterError(
      `runBuilderTask: assigned agent ${task.assignedAgent} is not an enabled layer-2 builder`,
    )
  }
  if (!agent.cliCommand) {
    // The migration's check constraint makes this unreachable; treated as a
    // real error rather than an assertion so a hand-edited row fails loudly.
    throw new BuilderAdapterError(`runBuilderTask: agent ${agent.name} has no cli_command`)
  }

  const taskPrompt = task.description.trim() || task.title

  // Standing instructions are prepended to the task, not sent separately:
  // none of these CLIs share a --system flag, and the one channel every one of
  // them does have is the prompt itself. Labelled so the model can tell the
  // operator's standing rules from the task at hand.
  const instructions =
    options.instructions !== undefined ? options.instructions.trim() : await getAgentInstructions(agent.id)
  const prompt = instructions
    ? `${INSTRUCTIONS_HEADING}\n${instructions}\n\n${TASK_HEADING}\n${taskPrompt}`
    : taskPrompt

  await updateTaskStatus(taskId, 'running', { agent: agent.name, cli: agent.cliCommand })

  // cli_command carries the whole invocation up to (but not including) the
  // prompt, because the prompt flag is NOT universal: claude and gemini take
  // -p, hermes takes -z, and opencode takes `run <message>` while its own -p
  // means --password. Hardcoding -p here silently mis-invoked half the roster.
  const mcp = withMcp(agent.cliCommand, options.mcpServers ?? [])

  const before = await worktreeSignature(options.cwd)
  const run = await runHeadless(`${mcp.command} ${base64Arg(prompt)}`, {
    timeoutMs,
    runId: taskId,
    sessionId: options.sessionId,
    cwd: options.cwd,
  })

  const { output, exitCode, timedOut, durationMs } = run
  const after = await worktreeSignature(options.cwd)
  const delta: WorktreeDelta = diffSignatures(before, after)

  // A committed change leaves a clean tree, so the delta knows work happened
  // but has no paths to show for it. The validators key off this list — an
  // empty one skips every check and calls that a pass — so fill it from the
  // commit itself.
  if (delta.committed && delta.files.length === 0) {
    delta.files = await committedFiles(options.cwd)
  }

  // Captured now, while the checkout is in front of us. The audit view turns
  // this plus headAfter into a link, and only calls it verified once GitHub
  // confirms it — see missions/artifacts.ts.
  const remote = delta.committed ? await gitRemote(options.cwd) : null

  const ranCleanly = run.failure === null && !timedOut && exitCode === 0
  // A builder that changed nothing did not do the task, whatever it exited.
  // This is the check that would have caught two batches of hollow successes.
  const wroteNothing = ranCleanly && options.expectsWrite !== false && !delta.changed && !delta.unknown
  const success = ranCleanly && !wroteNothing
  const error = run.failure
    ? run.failure
    : timedOut
      ? `timeout after ${timeoutMs}ms`
      : exitCode === null
        ? 'run ended without an end marker — the shell or CLI died mid-run'
        : wroteNothing
        ? `${agent.cliCommand} exited 0 but neither the working tree nor HEAD moved — the CLI ran and produced no edits`
        : exitCode === 0
          ? null
          : `${agent.cliCommand} exited ${exitCode}`

  // A builder silently running without the tools it was meant to have would
  // look exactly like a builder that chose not to use them, so record either way.
  if (options.mcpServers?.length) {
    await recordEvent(
      task.missionId,
      'task.mcp',
      { requested: options.mcpServers, granted: mcp.servers, skipped: mcp.skipped, agent: agent.name },
      taskId,
    )
  }

  // Whether instructions were in play is part of the audit trail: an agent
  // that ignored its instructions and one that never received them look
  // identical in the output alone.
  if (instructions) {
    await recordEvent(
      task.missionId,
      'task.instructions',
      { agent: agent.name, chars: instructions.length, preview: instructions.slice(0, 200) },
      taskId,
    )
  }

  await recordEvent(
    task.missionId,
    'task.worktree',
    {
      changed: delta.changed,
      unknown: delta.unknown,
      committed: delta.committed,
      headBefore: delta.headBefore,
      headAfter: delta.headAfter,
      remote,
      fileCount: delta.files.length,
      files: delta.files,
      agent: agent.name,
    },
    taskId,
  )

  const result = await recordResult(taskId, agent.id, output, success, error, durationMs)

  return {
    task,
    agent,
    result,
    exitCode,
    output,
    durationMs,
    timedOut,
    sessionId: run.sessionId,
    worktree: delta,
    mcp: { servers: mcp.servers, skipped: mcp.skipped },
  }
}
