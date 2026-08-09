// Evidence that a task's work is real, and honest labelling when it is not.
//
// A green "complete" badge is a claim the system makes about itself. The only
// thing that settles the question is a link that leaves this app entirely and
// lands on something GitHub agrees exists.
//
// ─── The trap this is built to avoid ──────────────────────────────────
// Constructing `github.com/<owner>/<repo>/commit/<sha>` from a local SHA is
// trivial, looks completely convincing, and is worthless: a commit that was
// never pushed produces a 404 at that URL. A UI full of confident links that
// 404 is worse than no links at all, because it launders "the builder said so"
// into what looks like third-party confirmation.
//
// So a commit is only ever labelled `verified` after GitHub has been asked
// whether it has that object. Everything else is labelled for what it is: a
// local commit, unpushed, real on this machine and nowhere else.

import { orchestratorToken } from './github'

const GITHUB_API = 'https://api.github.com'

export type ArtifactKind = 'commit' | 'pull_request' | 'comment'

/**
 * `verified`   GitHub confirmed this object exists — the link resolves.
 * `local_only` real here, absent from the remote. Not third-party evidence.
 * `unverified` could not be checked (no remote, no token, GitHub unreachable).
 */
export type ArtifactVerification = 'verified' | 'local_only' | 'unverified'

export interface TaskArtifact {
  kind: ArtifactKind
  /** Short sha, PR number, or comment id — whatever identifies it to a human. */
  label: string
  /** Where a human goes to check. Null when there is nowhere real to send them. */
  url: string | null
  verification: ArtifactVerification
  /** Why it is not verified. Shown verbatim, so it must read as an explanation. */
  note: string | null
}

export interface RepoRemote {
  owner: string
  repo: string
}

/**
 * Parse a git remote URL into owner/repo.
 *
 * Handles both forms git actually stores — `https://github.com/o/r.git` and
 * `git@github.com:o/r.git` — and returns null for anything not on github.com,
 * because a link to a host we cannot check is not evidence.
 */
export function parseGitHubRemote(remoteUrl: string): RepoRemote | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '')
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/.exec(trimmed)
  if (ssh) return { owner: ssh[1], repo: ssh[2] }
  const https = /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+)$/.exec(trimmed)
  if (https) return { owner: https[1], repo: https[2] }
  return null
}

export function commitUrl(remote: RepoRemote, sha: string): string {
  return `https://github.com/${remote.owner}/${remote.repo}/commit/${sha}`
}

/**
 * Ask GitHub whether it actually has this commit.
 *
 * A 404 here is the interesting answer, not an error: it means the builder
 * committed locally and nothing was ever pushed, which is exactly the case the
 * UI must not dress up as verified.
 */
export async function verifyCommit(remote: RepoRemote, sha: string): Promise<TaskArtifact> {
  const short = sha.slice(0, 7)
  const url = commitUrl(remote, sha)

  let token: string
  try {
    token = orchestratorToken()
  } catch {
    return {
      kind: 'commit',
      label: short,
      url: null,
      verification: 'unverified',
      note: 'no GitHub token configured, so this commit could not be checked against the remote',
    }
  }

  try {
    const res = await fetch(`${GITHUB_API}/repos/${remote.owner}/${remote.repo}/commits/${sha}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
    })

    if (res.ok) {
      return { kind: 'commit', label: short, url, verification: 'verified', note: null }
    }
    if (res.status === 404 || res.status === 422) {
      return {
        kind: 'commit',
        label: short,
        url: null,
        verification: 'local_only',
        note: `commit exists on the builder's machine but not on ${remote.owner}/${remote.repo} — it was never pushed, so there is nothing to verify externally`,
      }
    }
    return {
      kind: 'commit',
      label: short,
      url: null,
      verification: 'unverified',
      note: `GitHub answered ${res.status} when asked about this commit`,
    }
  } catch (err) {
    return {
      kind: 'commit',
      label: short,
      url: null,
      verification: 'unverified',
      note: `could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Artifacts a task recorded for itself, from `task.artifact` events.
 *
 * Anything that opens a PR or leaves a comment (see missions/github.ts) records
 * one of these with the API's own `html_url` — a URL GitHub minted rather than
 * one this code assembled, which is why these are trusted without a re-check.
 */
export function artifactsFromEvents(
  payloads: Record<string, unknown>[],
): TaskArtifact[] {
  const out: TaskArtifact[] = []
  for (const p of payloads) {
    const kind = p.kind
    const url = typeof p.url === 'string' ? p.url : null
    const label = typeof p.label === 'string' ? p.label : null
    if ((kind === 'pull_request' || kind === 'comment' || kind === 'commit') && url && label) {
      out.push({ kind, label, url, verification: 'verified', note: null })
    }
  }
  return out
}
