// Verification path for the GitHub capability (Batch 4.5, Part 1).
//
// Proves two independent routes to GitHub, because Layer 1 and Layer 2 reach it
// differently and neither implies the other:
//
//   orchestrator  missions/github.ts  → REST, owner-guarded, used by Batch 7
//   builder       claude + MCP        → mcp__github__* tools, used by tasks
//
// Everything it creates is real. Cleanup closes the PR and deletes the branch
// unless KEEP=1, so the target repo's default branch is never touched.
//
// Run:
//   node --import ./scripts/missions-loader.mjs --experimental-strip-types \
//        ./scripts/verify-github-mcp.mjs
//
// Env:
//   SCRATCH_REPO=owner/name   target (default henhernquist-lab/food-c)
//   SKIP_BUILDER=1            orchestrator route only (no CLI spend)
//   KEEP=1                    leave the branch and PR behind

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {
  /* already in env */
}

const gh = await import('../src/lib/missions/github.ts')
const { MCP_CONFIG_PATH, withMcp, mcpSupport } = await import('../src/lib/missions/mcp.ts')

const [OWNER, REPO] = (process.env.SCRATCH_REPO ?? 'henhernquist-lab/food-c').split('/')
const STAMP = Date.now()
const BRANCH = `golem-verify/batch45-${STAMP}`

const ok = (m) => console.log(`  ✓ ${m}`)
const info = (m) => console.log(`    ${m}`)

let prNumber = null
let branchMade = false

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${gh.orchestratorToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  return res
}

try {
  console.log(`\nTARGET  ${OWNER}/${REPO}  branch ${BRANCH}`)

  // ── The guardrail comes first ────────────────────────────────────
  // If this does not hold, nothing below is safe to run.
  console.log('\nGUARDRAIL')
  const owners = await gh.allowedOwners()
  ok(`allowed owners resolved from the token: ${[...owners].join(', ')}`)

  let refused = null
  try {
    await gh.assertAllowed({ owner: 'facebook', repo: 'react' })
  } catch (e) {
    refused = e
  }
  if (!refused) throw new Error('assertAllowed permitted facebook/react — the guardrail does not work')
  if (refused.name !== 'GitHubScopeError') throw new Error(`wrong error type: ${refused.name}`)
  ok('a repo outside the allowlist is refused before any request goes out')
  info(refused.message.slice(0, 120))

  await gh.assertAllowed({ owner: OWNER, repo: REPO })
  ok(`${OWNER} is inside the allowlist`)

  // ── Orchestrator route: branch → commit → PR ─────────────────────
  console.log('\nORCHESTRATOR ROUTE (missions/github.ts)')
  const baseRes = await api(`/repos/${OWNER}/${REPO}`)
  if (!baseRes.ok) throw new Error(`cannot read ${OWNER}/${REPO}: GitHub ${baseRes.status}`)
  const base = (await baseRes.json()).default_branch
  info(`base branch: ${base}`)

  const proposal = await gh.proposeChanges({
    owner: OWNER,
    repo: REPO,
    branch: BRANCH,
    base,
    commitMessage: `chore: Golem Batch 4.5 verification ${STAMP}`,
    files: [
      {
        path: `.golem-verify/${STAMP}.md`,
        content: `# Golem verification ${STAMP}\n\nWritten by the Layer 1 orchestrator to prove branch→commit→PR works.\nSafe to delete.\n`,
        isNew: true,
      },
    ],
    prTitle: `[golem-verify] orchestrator branch/commit/PR ${STAMP}`,
    prBody: 'Automated Batch 4.5 verification. Closed and deleted automatically.',
    draft: true,
  })
  branchMade = true
  prNumber = proposal.pr.number
  ok(`branch created: ${proposal.branchCreated}`)
  ok(`commit: ${proposal.commitSha.slice(0, 10)}`)
  ok(`PR #${proposal.pr.number} — ${proposal.pr.html_url}`)

  // Independent read-back: the API telling us it worked is not proof the
  // object exists, so fetch the commit's tree and confirm the file is in it.
  const fileRes = await api(`/repos/${OWNER}/${REPO}/contents/.golem-verify/${STAMP}.md?ref=${BRANCH}`)
  if (!fileRes.ok) throw new Error(`committed file is not readable back: GitHub ${fileRes.status}`)
  const decoded = Buffer.from((await fileRes.json()).content, 'base64').toString('utf8')
  if (!decoded.includes(String(STAMP))) throw new Error('read-back file content does not match')
  ok('committed file read back from the branch and content matches')

  const c = await gh.comment({ owner: OWNER, repo: REPO, number: prNumber, body: `Verification comment ${STAMP}.` })
  ok(`comment posted: ${c.html_url}`)

  // ── Builder route: claude + GitHub MCP ───────────────────────────
  if (process.env.SKIP_BUILDER === '1') {
    console.log('\nBUILDER ROUTE  skipped (SKIP_BUILDER=1)')
  } else {
    console.log('\nBUILDER ROUTE (claude + GitHub MCP)')
    const injected = withMcp('claude --permission-mode acceptEdits -p', ['github'])
    if (injected.skipped) throw new Error(`MCP injection skipped for claude: ${injected.skipped}`)
    ok(`support: claude=${mcpSupport('claude -p')}  gemini=${mcpSupport('gemini -p')}`)
    info(`config: ${MCP_CONFIG_PATH}`)
    info(`command: ${injected.command}`)

    // Run the real injected command, in a throwaway cwd so nothing it does to
    // the filesystem can touch this repo. Only the MCP call matters here.
    const cwd = mkdtempSync(join(tmpdir(), 'golem-mcp-'))
    writeFileSync(join(cwd, 'README.md'), 'scratch\n')
    const prompt =
      `Using the GitHub MCP tools, add a comment to pull request #${prNumber} in the repository ` +
      `${OWNER}/${REPO}. The comment body must be exactly: builder-mcp-${STAMP}. ` +
      `Do not modify any files. When done, reply with only the word DONE.`

    const args = injected.command.split(/\s+/).slice(1)
    let out = ''
    try {
      out = execFileSync('claude', [...args, prompt], {
        cwd,
        encoding: 'utf8',
        timeout: 240_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      throw new Error(`builder run failed: ${e.stderr?.slice(0, 400) ?? e.message}`)
    }
    info(`builder said: ${out.trim().slice(0, 80)}`)

    // Proof is the comment existing on GitHub, not what the CLI printed.
    const commentsRes = await api(`/repos/${OWNER}/${REPO}/issues/${prNumber}/comments`)
    const comments = await commentsRes.json()
    const found = comments.find((x) => x.body.includes(`builder-mcp-${STAMP}`))
    if (!found) {
      throw new Error(
        `builder claimed success but no comment containing "builder-mcp-${STAMP}" exists on the PR — ` +
          `bodies seen: ${comments.map((x) => JSON.stringify(x.body.slice(0, 40))).join(', ')}`,
      )
    }
    ok(`builder's MCP comment verified on GitHub: ${found.html_url}`)
  }

  console.log('\n✓ orchestrator and builder can both act on GitHub, owner-guarded\n')
} catch (err) {
  console.error('\n✗ VERIFICATION FAILED\n')
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exitCode = 1
} finally {
  if (process.env.KEEP === '1') {
    console.log(`kept: PR #${prNumber} and branch ${BRANCH}`)
  } else {
    if (prNumber) {
      await api(`/repos/${OWNER}/${REPO}/pulls/${prNumber}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed' }),
      })
      console.log(`closed PR #${prNumber}`)
    }
    if (branchMade) {
      await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { method: 'DELETE' })
      console.log(`deleted branch ${BRANCH}`)
    }
  }
  process.exit(process.exitCode ?? 0)
}
