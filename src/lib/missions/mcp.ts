// Batch 4.5 — giving builders MCP tools.
//
// Until now a layer-2 builder could only touch the world through its own shell:
// edit files, run git. MCP adds structured, authenticated capabilities — the
// GitHub server being the first — that the CLI calls as tools rather than by
// shelling out and parsing output.
//
// ─── Why this is Claude-only, and why that is not an oversight ─────────
// Every builder on the roster supports MCP, but only Claude Code accepts a
// server config PER INVOCATION (`--mcp-config <file>`). gemini, opencode and
// hermes all expose MCP through stateful registration subcommands
// (`gemini mcp add`, `opencode mcp`, `hermes mcp`) that mutate host-level
// config and persist across every future run of that CLI, for every project.
//
// A scheduler that picks a different agent per task cannot depend on that:
// the run would only work on a host where someone had registered the server by
// hand, the registration would leak into unrelated work, and nothing about it
// would be reproducible from the repo. Per-invocation config is the only form
// that is both hermetic and reviewable, so agents that lack it get no MCP and
// say so, rather than silently dropping the flags and looking capable.

import { resolve } from 'node:path'

/**
 * Repo-committed MCP server definitions. Contains no secrets — the GitHub
 * token arrives by `${GITHUB_TOKEN}` expansion at launch, so the file is safe
 * to commit and the credential stays in the environment.
 */
export const MCP_CONFIG_PATH = resolve(process.cwd(), 'mcp/servers.json')

/** Tools a builder may call without an approval prompt, by server. */
export const MCP_TOOLSETS = {
  /**
   * Server-wide grant. Narrower per-tool lists were tempting, but the GitHub
   * server ships ~100 tools whose names change between releases, and a stale
   * allowlist fails as an unexplained mid-run approval hang rather than an
   * error. The real boundary is the token (see missions/github.ts), not this.
   */
  github: ['mcp__github'],
} as const

export type McpServerName = keyof typeof MCP_TOOLSETS

export type McpSupport =
  /** Takes a config file per invocation — usable from the scheduler. */
  | 'per-run'
  /** Only via a subcommand that mutates host-level state — not usable here. */
  | 'host-registered'
  | 'none'

/**
 * How the CLI behind a `cli_command` can be given MCP servers.
 *
 * Keyed on the binary name for the same reason the prompt flag is not
 * hardcoded: these invocations differ per vendor and the agents table stores
 * the command, not the vendor's capabilities.
 */
export function mcpSupport(cliCommand: string): McpSupport {
  const binary = cliCommand.trim().split(/\s+/)[0]?.split('/').pop() ?? ''
  if (binary === 'claude') return 'per-run'
  if (binary === 'gemini' || binary === 'opencode' || binary === 'hermes') return 'host-registered'
  return 'none'
}

export interface McpInjection {
  /** The command to actually run, with MCP flags injected when possible. */
  command: string
  /** Servers the builder will really have. Empty when injection was skipped. */
  servers: McpServerName[]
  /** Why no servers, when there are none. Null when injection succeeded. */
  skipped: string | null
}

/**
 * Inject MCP flags into a builder invocation.
 *
 * `--strict-mcp-config` is deliberate: without it the CLI merges in whatever
 * servers happen to be registered on the host, so a run's real capabilities
 * would depend on the machine rather than on this file. With it, the servers
 * a builder gets are exactly the ones named here.
 *
 * The flags go immediately after the binary rather than at the end, because
 * `cli_command` ends at the prompt flag (`-p`, `-z`, …) and anything appended
 * after that would be parsed as the prompt.
 */
export function withMcp(cliCommand: string, servers: McpServerName[]): McpInjection {
  if (servers.length === 0) return { command: cliCommand, servers: [], skipped: null }

  const support = mcpSupport(cliCommand)
  if (support !== 'per-run') {
    return {
      command: cliCommand,
      servers: [],
      skipped:
        support === 'host-registered'
          ? `${cliCommand.split(/\s+/)[0]} supports MCP only via host-level registration, which the scheduler cannot do per run`
          : `${cliCommand.split(/\s+/)[0]} has no known MCP support`,
    }
  }

  const parts = cliCommand.trim().split(/\s+/)
  const allowed = servers.flatMap((name) => MCP_TOOLSETS[name])
  const flags = [
    '--mcp-config',
    MCP_CONFIG_PATH,
    '--strict-mcp-config',
    '--allowedTools',
    allowed.join(','),
  ]
  return {
    command: [parts[0], ...flags, ...parts.slice(1)].join(' '),
    servers,
    skipped: null,
  }
}
