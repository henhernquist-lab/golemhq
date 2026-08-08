// Batch 4.5 — GitHub as an orchestrator (Layer 1) capability.
//
// Builders reach GitHub through MCP (see mcp.ts). Layer 1 cannot: MCP servers
// are launched per CLI invocation, and the orchestrator is a Next.js route with
// no CLI to attach one to. Batch 7's approval gate has to open PRs from that
// side, so it needs a direct path.
//
// This is deliberately a THIN layer over src/lib/github.ts rather than a second
// client. That file already does blob→tree→commit→ref correctly, including the
// fast-forward-only ref update that stops a concurrent push being clobbered;
// re-implementing it here would mean two write paths drifting apart. What this
// adds is the two things it does not have: a headless token, and a target
// guardrail.

import {
  commitFiles,
  createOrSwitchBranch,
  createPullRequest,
  type CommitFileChange,
  type PullRequest,
} from '@/lib/github'

export class GitHubScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubScopeError'
  }
}

/**
 * Token for unattended orchestrator writes.
 *
 * The interactive paths take a per-user OAuth token off the NextAuth session.
 * A mission runs with nobody logged in, so it uses the environment instead.
 *
 * GITHUB_PAT is preferred over GITHUB_TOKEN, and the distinction is not
 * cosmetic. In a Codespace, GITHUB_TOKEN is an installation token scoped to the
 * Codespace's OWN repository: it reads every repo the account can see, and
 * `permissions.push` comes back true on all of them — but that field describes
 * the user's rights, not the token's. Writes to anything else 403 with
 * "Resource not accessible by integration". Anything that has to open a PR
 * against another repo needs a PAT with `repo` scope.
 */
export function orchestratorToken(): string {
  const token = (process.env.GITHUB_PAT ?? process.env.GITHUB_TOKEN)?.trim()
  if (!token) {
    throw new GitHubScopeError(
      'neither GITHUB_PAT nor GITHUB_TOKEN is set — the orchestrator has no credential for unattended GitHub writes',
    )
  }
  return token
}

// ─── The target guardrail ──────────────────────────────────────────────

let cachedOwners: Set<string> | null = null

/**
 * Owners this system may write to.
 *
 * Defaults to whoever the token actually belongs to, asked of GitHub rather
 * than configured — a hardcoded login would be wrong the moment the token
 * changed, and wrong in the permissive direction.
 *
 * Worth being blunt about why this exists: the token in use is not scoped to
 * one repo. It reports push and admin on every repo the account owns, so
 * "the model named the wrong repo" is a real failure mode with real
 * consequences and nothing upstream of this check would catch it.
 * GITHUB_ALLOWED_OWNERS extends the set for orgs, which the /user login alone
 * cannot cover.
 */
export async function allowedOwners(): Promise<Set<string>> {
  if (cachedOwners) return cachedOwners

  const owners = new Set<string>()
  for (const extra of (process.env.GITHUB_ALLOWED_OWNERS ?? '').split(',')) {
    const trimmed = extra.trim().toLowerCase()
    if (trimmed) owners.add(trimmed)
  }

  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${orchestratorToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) {
    throw new GitHubScopeError(
      `could not resolve the token's own account (GitHub ${res.status}) — refusing to write without knowing who this token is`,
    )
  }
  const login = ((await res.json()) as { login?: string }).login
  if (login) owners.add(login.toLowerCase())

  if (owners.size === 0) {
    throw new GitHubScopeError('no allowed owners could be resolved — refusing to write')
  }
  cachedOwners = owners
  return owners
}

export interface RepoTarget {
  owner: string
  repo: string
}

/** Reject any target outside the allowlist before a single write goes out. */
export async function assertAllowed(target: RepoTarget): Promise<void> {
  const owners = await allowedOwners()
  if (!owners.has(target.owner.toLowerCase())) {
    throw new GitHubScopeError(
      `refusing to act on ${target.owner}/${target.repo}: "${target.owner}" is not an allowed owner ` +
        `(allowed: ${[...owners].join(', ')}). Set GITHUB_ALLOWED_OWNERS to widen this deliberately.`,
    )
  }
}

// ─── Capabilities ──────────────────────────────────────────────────────

export interface ProposeChangesInput extends RepoTarget {
  /** Branch to create. Reused as-is if it already exists. */
  branch: string
  /** Branch to cut from and target the PR at. */
  base: string
  commitMessage: string
  files: CommitFileChange[]
  prTitle: string
  prBody: string
  /** Open as a draft. Sensible default for anything an agent authored. */
  draft?: boolean
}

export interface ProposeChangesResult {
  branch: string
  branchCreated: boolean
  commitSha: string
  pr: PullRequest
}

/**
 * Branch → commit → PR, as one operation.
 *
 * The whole point of a PR here is that agent-authored changes land somewhere a
 * human reviews rather than on a default branch, so this never targets `base`
 * directly. Each step's failure is thrown rather than returned, because a
 * half-finished proposal (branch with no PR, commit nobody sees) is worse than
 * a loud stop.
 */
export async function proposeChanges(input: ProposeChangesInput): Promise<ProposeChangesResult> {
  await assertAllowed(input)
  const token = orchestratorToken()
  const { owner, repo } = input

  const branch = await createOrSwitchBranch(token, owner, repo, input.branch, input.base)
  if (branch.error) throw new GitHubScopeError(`creating branch ${input.branch}: ${branch.error}`)

  const commit = await commitFiles(token, owner, repo, input.branch, input.commitMessage, input.files)
  if (commit.error || !commit.commitSha) {
    throw new GitHubScopeError(`committing to ${input.branch}: ${commit.error ?? 'no commit sha'}`)
  }

  const pr = await createPullRequest(
    token,
    owner,
    repo,
    input.prTitle,
    input.prBody,
    input.branch,
    input.base,
    input.draft ?? true,
  )
  if (pr.error || !pr.pr) throw new GitHubScopeError(`opening PR: ${pr.error ?? 'no pr returned'}`)

  return { branch: input.branch, branchCreated: branch.created, commitSha: commit.commitSha, pr: pr.pr }
}

export interface CommentInput extends RepoTarget {
  /** Issue or PR number — GitHub treats PRs as issues for comments. */
  number: number
  body: string
}

/**
 * Comment on an issue or PR. The one capability neither existing GitHub module
 * had, and the one Batch 7's approval gate needs to report a verdict.
 */
export async function comment(input: CommentInput): Promise<{ id: number; html_url: string }> {
  await assertAllowed(input)
  const res = await fetch(
    `https://api.github.com/repos/${input.owner}/${input.repo}/issues/${input.number}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${orchestratorToken()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: input.body }),
    },
  )
  if (!res.ok) {
    throw new GitHubScopeError(`commenting on #${input.number}: GitHub ${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as { id: number; html_url: string }
  return { id: data.id, html_url: data.html_url }
}

/** Exposed for tests that need to re-resolve after changing the environment. */
export function resetOwnerCache(): void {
  cachedOwners = null
}
