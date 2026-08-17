import { streamText, convertToModelMessages, tool, stepCountIs } from 'ai'
import { tavily } from '@tavily/core'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { saveMemory, searchMemories } from '@/lib/memory'
import { listRepos, listIssues, createIssue, getFileContent } from '@/lib/github'
import { createBranch, createFile, updateFile, createPR, createRepo } from '@/lib/github-write'
import { resolveResourceUserId } from '@/lib/resource-user'
import { supabase } from '@/lib/supabase'
import { getSkills, buildMultiSkillPrompt } from '@/lib/skills/registry'
import { parseSessionFocusId, SESSION_FOCUS_PROMPTS } from '@/lib/focus-mode'
import { insertSkillInvocation, updateSkillInvocationOutput, getActivePromptOverride } from '@/lib/lab/db'
import { modelSupportsReasoning } from '@/lib/reasoning-trace'
import { compactMessages } from '@/lib/compaction'
import { nimClientFor, isCommunityModelId, isGroqModel, communityRouteParam, warmCommunityModel } from '@/lib/nim'
import { safeStreamErrorMessage } from '@/lib/stream-error'
import { budgetSearchResults } from '@/lib/tool-budget'
import { logUsage } from '@/lib/usage/log'
import { buildComposioTools } from '@/lib/composio-tools'
import { monidDiscover, monidRun } from '@/lib/monid'
import { getReceiptsHook } from '@/lib/learn/receipts-hook'
import { getAllDueWork, getAllAnnouncements } from '@/lib/classroom'
import {
  getAssignments,
  getAnnouncements as getICAnnouncements,
} from '@/lib/infinite-campus'
import { RecoveryManager } from '@/lib/recovery/recovery-manager'
import { buildFinishMetadata } from '@/lib/recovery/finish-metadata'
// Side-effect import: registers enryReceiptsDetector as the active
// ReceiptsHook at module-load time, before this route's first
// getReceiptsHook() call below. Order matters — must precede any code
// that could call getReceiptsHook.
import '@/lib/learn/receipts-detector'
import type { GitHubActionPayload } from '@/lib/resources'

import { listModels, getModelMeta, DEFAULT_MODEL_ID } from '@/lib/nim'
import { getSystemPrompt } from '@/lib/system-prompt'
import { extractAndSaveAutoMemories } from '@/lib/auto-memory'
import { readRequestJson } from '@/lib/request-json'
import { toUIMessages } from '@/lib/messages'

// Chat-scoped model allowlist — subset of MODEL_LIST that has 'chat' scope.
const CHAT_MODELS = listModels('chat').map((m) => m.id)
const DEFAULT_MODEL = CHAT_MODELS[0] ?? DEFAULT_MODEL_ID

// 120 (not 60) so a first message to a freshly-added community model has room
// for the HF Inference Providers cold-start warm-up (bounded ~48s) plus the
// actual stream. First-party models return well within the old budget.
export const maxDuration = 120

const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY ?? '' })

// ─── Focus Mode — controls which tools are available ────────────────────
type FocusMode = 'all' | 'memory_only' | 'web_only' | 'repo_only'

// ─── Context Compaction ────────────────────────────────────────────────
// Delegated to src/lib/compaction.ts — extracts key decisions, files
// touched, and unresolved questions from older messages.

// ─── Main Route ────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const body = await readRequestJson(req)
  const { messages: rawMessages, model, userProfile, skill: skillSlug, skills: skillSlugs, skillTurn, recovery, partialContent } = body
  // Normalize to the AI SDK v6 UIMessage shape. The v6 `useChat` client sends
  // `parts`; the mobile tools page (m/tools) and any legacy/third-party caller
  // send `{ role, content }`. convertToModelMessages reads `parts` and throws
  // `undefined.map` on the legacy shape, which 500s the route with raw HTML.
  const messages = toUIMessages(rawMessages)
  if (messages.length === 0) {
    return Response.json({ error: 'No messages provided.' }, { status: 400 })
  }
  // Community models (The Foundry) aren't in the static CHAT_MODELS
  // allowlist but are valid chat targets — recognized by their id prefix and
  // routed via HF Inference Providers. Trust of the id itself is fine: routing
  // is inert for anything that isn't a real, addable model.
  const selectedModel: string =
    CHAT_MODELS.includes(model) || isCommunityModelId(model) ? model : DEFAULT_MODEL

  // Output-token budget for this model. Groq counts `prompt + max_tokens`
  // against a rolling per-minute allowance even when the reply is short, so a
  // flat 4096 on a 6000 TPM model 413s on a one-word message. Registry value
  // wins; 4096 stays the default for everything else.
  const modelMeta = getModelMeta(selectedModel)
  const modelMaxOutputTokens = modelMeta?.maxOutputTokens ?? 4096
  // A tool-calling turn pays the reservation once per STEP, not once per turn,
  // because the SDK re-sends the whole context each step and Groq debits
  // prompt + max_tokens. Falls back to the plain budget when a model has no
  // tool-specific value. Independent of systemPromptTier, which sizes the
  // prompt rather than the reservation.
  const modelToolTurnOutputTokens = modelMeta?.maxOutputTokensWithTools ?? modelMaxOutputTokens
  // Per-model ceiling on a single tool result. Whatever a tool returns is
  // re-sent on every later step, so an unbounded Tavily response or Gmail body
  // is charged repeatedly against the same per-minute budget.
  const modelToolResultMaxChars = modelMeta?.toolResultMaxChars
  const systemPromptTier = modelMeta?.systemPromptTier
  const modelSupportsTools = modelMeta?.supportsTools !== false

  // HF Inference Providers cold-start less-popular models; warm it here (with
  // retries) so the first message doesn't error mid-stream. No-op otherwise.
  if (isCommunityModelId(selectedModel)) {
    await warmCommunityModel(selectedModel)
  }

  // The provider model param. Community ids carry a `community:` marker for our
  // own routing/allowlist logic — but the HF router must receive only the real
  // `<hfId>:<provider>` string. Passing the prefixed id makes the router
  // mis-parse the colon segments ("provider … not valid"). First-party ids
  // pass through unchanged.
  const modelParam = isCommunityModelId(selectedModel) ? communityRouteParam(selectedModel) : selectedModel

  // ─── Recovery Mode ─────────────────────────────────────────
  // When the frontend detects a stream interruption, it sends a
  // follow-up request with recovery: true and the partial content
  // that was received before the interruption. We inject a
  // continuation prompt so the model picks up where it left off.
  const recoveryManager = new RecoveryManager()
  const isRecovery = recovery === true
  let recoverySystemPrompt = ''
  if (isRecovery) {
    recoveryManager.startRequest()
    recoveryManager.markStreaming()
    if (typeof partialContent === 'string') {
      recoveryManager.recordPartial(partialContent)
    }
    recoverySystemPrompt = '\n\nCONTINUATION REQUEST: Your previous response was interrupted unexpectedly. Continue exactly where you left off. Do NOT restart, summarize, or repeat any previous content. Do NOT apologize or acknowledge the interruption. Simply continue writing as if nothing happened.'
    if (typeof partialContent === 'string' && partialContent.length > 0) {
      recoverySystemPrompt += `\n\nThe last content sent before the interruption was:\n\n${partialContent.slice(-500)}\n\nContinue from the exact point this was cut off.`
    }
  }

  let chatClient: ReturnType<typeof nimClientFor>
  try {
    chatClient = nimClientFor(selectedModel)
  } catch {
    return new Response(
      JSON.stringify({ error: `No API key configured for ${selectedModel}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const focusMode: FocusMode = ['all', 'memory_only', 'web_only', 'repo_only'].includes(body.focusMode) ? body.focusMode : 'all'
  // Chat's Think toggle is on/off only now — 'summary' was a dead third
  // state (identical upstream request to 'full', just a client-side 300-char
  // truncation of the trace). Kept as a string rather than boolean since
  // modelSupportsReasoning() and the extra_body gate below both key off the
  // 'off' sentinel — smaller diff than threading a boolean through.
  const reasoningDepth: string = ['off','full'].includes(body.reasoningDepth) ? body.reasoningDepth : 'off'

  // Session focus (domain scope — orthogonal to focusMode/source scope).
  // Accepts the compact wire form "drive" | "learn" | "school" | "none"
  // | "custom:<id>"; unknown values collapse to "none" via the parser.
  // Used for: 1) a directive line in the system prompt so the agent
  // self-contextualizes, 2) hinting the agent which skill family to lean
  // toward. (Server-side doesn't run phrase matching — that's client-side
  // in center-panel via detectSkillInvocation on the typed input — so the
  // server's job here is just labeling the session for the model.)
  const sessionFocus = parseSessionFocusId(body.sessionFocus ?? 'none')
  const focusPrompt = sessionFocus.kind === 'seed' ? SESSION_FOCUS_PROMPTS[sessionFocus.id] : null
  const sessionFocusDirective = sessionFocus.kind !== 'none' && focusPrompt
    ? `\n\n${focusPrompt}`
    : sessionFocus.kind === 'custom'
      ? `\n\nSESSION FOCUS: ${sessionFocus.id.toUpperCase()} — the user has set a custom posture for this session. Adopt a tone and approach that matches this label.`
      : ''

  const session = await auth()
  const googleId    = (session?.user as { id?: string })?.id
  const githubToken = (session as { githubToken?: string } | null)?.githubToken
  const uid = await resolveResourceUserId(googleId ?? null)
  if (!uid) {
    console.warn('[chat/route] Could not resolve user UUID for audit trail — googleId:', googleId)
  }

  const modelMessages = await convertToModelMessages(messages)

  // Apply context compaction (extracts decisions, files, unresolved Qs)
  const compactResult = compactMessages(modelMessages as Parameters<typeof compactMessages>[0])
  const { messages: finalMessages, compacted, summary: compactionSummary } = compactResult

  // Receipts (Golem Learn extension point): let a registered detector check the
  // outgoing user message against the user's claims for contradiction. No-op
  // by default (see src/lib/learn/receipts-hook.ts) — Freebuff registers the
  // real detector. Deliberately NOT awaited: fire-and-forget so chat latency is
  // never affected, now or once a real hook is registered.
  if (uid && googleId) {
    const outgoingUserText = String(finalMessages.findLast((m) => m.role === 'user')?.content ?? '')
    if (outgoingUserText) {
      getReceiptsHook()({ userId: uid, googleId, message: outgoingUserText })
        .then((candidates) => {
          if (candidates?.length) console.log('[receipts] contradiction candidates:', candidates.length)
        })
        .catch((err) => console.error('[receipts] hook threw:', err))
    }
  }

  const focusDirective = focusMode !== 'all'
    ? `\n\nFOCUS MODE: ${focusMode.replace(/_/g, ' ').toUpperCase()} — you are restricted to only the tools available in this mode. Do not attempt to use tools outside this scope.`
    : ''

  // Chat effort (Low/Medium/High) — sent by the client as `effort` from the
  // model picker's effort dropdown. Previously this field reached the server
  // and was silently dropped: it never touched the system prompt, token
  // budget, or any provider option, so the dropdown was cosmetic. This wires
  // it to response depth/verbosity via a system-prompt directive.
  const EFFORT_DIRECTIVES = {
    low: '\n\nEFFORT: LOW — keep every response as short as the question allows. One or two sentences for a factual ask, a short paragraph at most for anything else. Skip the plan/verify/report ceremony below unless Henry explicitly asks for depth.',
    medium: '\n\nEFFORT: MEDIUM (default) — match response length to the actual complexity of the ask. A simple question gets a short, direct answer. Only go long, structured, or multi-section when the request is genuinely multi-part or explicitly asks for detail.',
    high: "\n\nEFFORT: HIGH — Henry wants room to think here. When a question is genuinely complex, ambiguous, or multi-part, give it the full treatment: structure, numbered steps, tradeoffs, edge cases. This permits depth, it doesn't force it — a simple question still gets a simple answer.",
  } as const
  const effortLevel: keyof typeof EFFORT_DIRECTIVES =
    body.effort === 'low' || body.effort === 'high' ? body.effort : 'medium'
  const effortDirective = EFFORT_DIRECTIVES[effortLevel]

  // ─── Multi-skill mode ────────────────────────────────────────────────
  const multiSlugs: string[] = Array.isArray(skillSlugs) && skillSlugs.length > 0
    ? skillSlugs
    : typeof skillSlug === 'string'
      ? [skillSlug]
      : []
  const activeSkills = multiSlugs.length > 0 ? getSkills(multiSlugs) : []
  if (activeSkills.length > 0) {
    const combinedSystem = buildMultiSkillPrompt(
      activeSkills.map((skill) => ({ skill, topic: '', via: 'command' as const })),
    )
    const turn = Number.isFinite(skillTurn) ? Math.max(1, Math.floor(skillTurn)) : 1

    const userText = finalMessages.findLast((m) => m.role === 'user')?.content ?? ''
    let invocationId: string | null = null

    // Determine prompt version — check for active DB overrides
    let promptVersion = 'base'
    if (uid) {
      try {
        const overrides = await Promise.all(
          activeSkills.map((s) => getActivePromptOverride(uid, s.slug)),
        )
        const activeOverride = overrides.find((o) => o !== null)
        if (activeOverride) {
          promptVersion = `override:${activeOverride.id}`
        }
      } catch (err) {
        console.error('[chat/route] failed to check prompt overrides:', err)
      }
    }

    if (uid) {
      try {
        invocationId = await insertSkillInvocation(uid, {
          skill_slug: multiSlugs.join('+'),
          prompt_version: promptVersion,
          input_topic: String(userText).slice(0, 2000),
          output_text: '',
          model_used: selectedModel,
          effort_used: 'medium',
          mode: 'chat',
          source: 'chat',
          explicit_feedback: null,
          implicit_score: 0,
          conversation_id: null,
          follow_up_message_id: null,
        })
      } catch (err) {
        console.error('[chat/route] failed to log skill invocation:', err)
      }
    }

    const skillStartedAt = Date.now()
    const skillResult = streamText({
      model: chatClient.chat(modelParam),
      system: `${combinedSystem}\n\nCURRENT TURN: You are on assistant turn ${turn}. Produce this turn's content.${focusDirective}${sessionFocusDirective}${effortDirective}${isRecovery ? recoverySystemPrompt : ''}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: finalMessages as any,
      ...(reasoningDepth !== 'off' && modelSupportsReasoning(selectedModel) ? {
        providerOptions: { openai: { extra_body: { chat_template_kwargs: { enable_thinking: true } } } },
      } : {}),
      // No explicit timeout, and the AI SDK defaults maxRetries to 2 when
      // unset — a slow/degraded model plus an automatic retry can silently
      // double wall-clock past this route's maxDuration (60s) before any
      // error surfaces, same root cause as Drive's terminal-exec timeout bug.
      // maxRetries: 0 fails once, cleanly, instead of doubling in the dark.
      maxRetries: 0,
      // Left unset, the SDK requests the model's full context window as
      // max_tokens. DeepSeek now routes through OpenRouter on a free-tier
      // key with a real dollar ceiling per request — an uncapped request
      // (65536 tokens) exceeds what the account can afford and the call
      // fails outright before generating anything. 4096 is comfortably
      // within a normal chat reply and well under the account's affordable
      // ceiling (~11.5k tokens at last check).
      maxOutputTokens: modelMaxOutputTokens,
      onError: ({ error }) => { console.error('streamText multi-skill error:', error) },
      onFinish: async ({ text, usage }) => {
        if (invocationId) {
          await updateSkillInvocationOutput(invocationId, text).catch((err) => {
            console.error('[chat/route] failed to update skill invocation output:', err)
          })
        }
        // Usage observability — resilient, never breaks the response.
        if (uid) {
          logUsage({
            userId: uid,
            modelId: selectedModel,
            mode: 'chat',
            promptTokens: usage?.inputTokens,
            completionTokens: usage?.outputTokens,
            totalTokens: usage?.totalTokens,
            latencyMs: Date.now() - skillStartedAt,
          }).catch(() => {})
        }
      },
    })
    const responseHeaders: Record<string, string> = compacted
      ? { 'X-Context-Compacted': 'true', 'X-Context-Compacted-Summary': encodeURIComponent(compactionSummary ?? '') }
      : {}
    if (invocationId) responseHeaders['X-Skill-Invocation-Id'] = invocationId

    return skillResult.toUIMessageStreamResponse({
      headers: Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined,
      // Stamp the finish reason onto the message so the client can tell a
      // completed turn from one the provider truncated. Without this a
      // `length` finish is indistinguishable from a clean `stop`.
      messageMetadata: ({ part }) =>
        part.type === 'finish' ? buildFinishMetadata(part.finishReason) : undefined,
      onError: (error) => safeStreamErrorMessage(error, 'chat route multi-skill error'),
    })
  }

  // Build tools based on focus mode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allTools: Record<string, any> = {}
  if (focusMode === 'all' || focusMode === 'web_only') {
    allTools.web_search = tool({
      description: 'Search the web for current, real-time information. Use this for news, prices, recent events, people, or anything that may have changed.',
      inputSchema: z.object({ query: z.string().describe('The search query'), max_results: z.number().optional().default(5).describe('Number of results to return') }),
      execute: async ({ query, max_results }: { query: string; max_results?: number }) => {
        const response = await tavilyClient.search(query, { maxResults: max_results, includeAnswer: true })
        // Clip before returning, not after: this result is re-sent on every
        // remaining step of the turn. A full 5-result Tavily response is
        // ~1489 tokens, enough on its own to push a follow-up past a Groq
        // per-minute admission check.
        const budgeted = budgetSearchResults(
          response.answer,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          response.results.map((r: any) => ({ title: r.title, url: r.url, content: r.content })),
          modelToolResultMaxChars,
        )
        return {
          answer: budgeted.answer,
          results: budgeted.results,
          ...(budgeted.truncated
            ? { note: 'Snippets were shortened to fit this model\'s context budget. Use the URLs if you need the full text.' }
            : {}),
        }
      },
    })
  }
  if (focusMode === 'all' || focusMode === 'memory_only') {
    allTools.save_memory = tool({
      description: 'Save an important fact about the user to long-term memory.',
      inputSchema: z.object({ content: z.string().describe('The fact or information to remember') }),
      execute: async ({ content }: { content: string }) => {
        if (!googleId) return { success: false, error: 'Not authenticated.' }
        const result = await saveMemory(googleId, content)
        if (result.error) return { success: false, error: result.error }
        return { success: true, id: result.id, content }
      },
    })
    allTools.recall_memory = tool({
      description: "Search the user's long-term memory for relevant past information.",
      inputSchema: z.object({ query: z.string().describe('What to search for in memory'), limit: z.number().optional().default(5).describe('Maximum number of results') }),
      execute: async ({ query, limit }: { query: string; limit?: number }) => {
        if (!googleId) return { results: [], error: 'Not authenticated.' }
        const result = await searchMemories(googleId, query, limit)
        if (result.error) return { results: [], error: result.error }
        return { results: result.results }
      },
    })
  }
  if ((focusMode === 'all' || focusMode === 'repo_only') && githubToken) {
    allTools.github_list_repos = tool({
      description: "List Henry's GitHub repositories.",
      inputSchema: z.object({}),
      execute: async () => {
        const { repos, error } = await listRepos(githubToken)
        if (error) return { repos: [], error }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { repos: repos.map((r: any) => ({ name: r.full_name, private: r.private, description: r.description, language: r.language, stars: r.stargazers_count, updated_at: r.updated_at, url: r.html_url })) }
      },
    })
    allTools.github_read_file = tool({
      description: 'Read a file from a GitHub repo, or list directory contents.',
      inputSchema: z.object({ owner: z.string(), repo: z.string(), path: z.string() }),
      execute: async ({ owner, repo, path }: { owner: string; repo: string; path: string }) => {
        const { content, error } = await getFileContent(githubToken, owner, repo, path)
        if (error) return { content: null, error }
        const truncated = content && content.length > 20000 ? content.slice(0, 20000) + `\n\n[… truncated at 20 000 chars — ${content.length} total]` : content
        return { content: truncated }
      },
    })
    allTools.github_create_issue = tool({
      description: 'Create a new GitHub issue.',
      inputSchema: z.object({ owner: z.string(), repo: z.string(), title: z.string(), body: z.string() }),
      execute: async ({ owner, repo, title, body }: { owner: string; repo: string; title: string; body: string }) => {
        const { issue, error } = await createIssue(githubToken, owner, repo, title, body)
        if (error) return { issue: null, error }
        return { issue: { number: issue!.number, title: issue!.title, url: issue!.html_url } }
      },
    })
    allTools.github_list_issues = tool({
      description: 'List open issues on a GitHub repository.',
      inputSchema: z.object({ owner: z.string(), repo: z.string() }),
      execute: async ({ owner, repo }: { owner: string; repo: string }) => {
        const { issues, error } = await listIssues(githubToken, owner, repo)
        if (error) return { issues: [], error }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { issues: issues.map((i: any) => ({ number: i.number, title: i.title, // eslint-disable-next-line @typescript-eslint/no-explicit-any
        labels: i.labels.map((l: any) => l.name), created_at: i.created_at, url: i.html_url })) }
      },
    })
    allTools.github_create_branch = tool({
      description: 'Create a new branch off the default branch.',
      inputSchema: z.object({ owner: z.string(), repo: z.string(), branch_name: z.string(), confirm: z.boolean().describe('Set false first to preview, true only after user confirms.') }),
      execute: async ({ owner, repo, branch_name, confirm }: { owner: string; repo: string; branch_name: string; confirm: boolean }) => {
        if (!confirm) return { status: 'preview', action: 'create_branch', repo: `${owner}/${repo}`, branch: branch_name, summary: `Create branch "${branch_name}" in ${owner}/${repo}.` }
        const result = await createBranch(githubToken, owner, repo, branch_name)
        if (!result.ok) return { status: 'error', error: result.error }
        if (uid) {
          const payload: GitHubActionPayload = { action: 'create_branch', repo: `${owner}/${repo}`, branch: branch_name, summary: `Created branch "${branch_name}"`, timestamp: new Date().toISOString() }
          ;(async () => { const { error: auditError } = await supabase.from('resources').insert({ user_id: uid, type: 'github_action', source: 'user', title: `Branch: ${branch_name}`, payload }); if (auditError) console.error('[chat] audit insert failed:', auditError) })()
        }
        return { status: 'ok', repo: `${owner}/${repo}`, branch: branch_name }
      },
    })
    allTools.github_create_file = tool({
      description: 'Create a new file on a branch.',
      inputSchema: z.object({ owner: z.string(), repo: z.string(), path: z.string(), content: z.string(), message: z.string(), branch: z.string(), confirm: z.boolean().describe('Set false first to preview, true only after user confirms.') }),
      execute: async ({ owner, repo, path, content, message, branch, confirm }: { owner: string; repo: string; path: string; content: string; message: string; branch: string; confirm: boolean }) => {
        if (!confirm) return { status: 'preview', action: 'create_file', repo: `${owner}/${repo}`, branch, file_path: path, content_summary: content.slice(0, 500) + (content.length > 500 ? '…' : ''), message, summary: `Create "${path}" on "${branch}" in ${owner}/${repo}.` }
        const result = await createFile(githubToken, owner, repo, path, content, message, branch)
        if (!result.ok) return { status: 'error', error: result.error }
        if (uid) { const payload: GitHubActionPayload = { action: 'create_file', repo: `${owner}/${repo}`, branch, file_path: path, summary: `Created "${path}"`, timestamp: new Date().toISOString() }; (async () => { const { error: auditError } = await supabase.from('resources').insert({ user_id: uid, type: 'github_action', source: 'user', title: `Create: ${path}`, payload }); if (auditError) console.error('[chat] audit insert failed:', auditError) })() }
        return { status: 'ok', repo: `${owner}/${repo}`, branch, file_path: path, url: result.url }
      },
    })
    allTools.github_update_file = tool({
      description: 'Edit an existing file on a branch.',
      inputSchema: z.object({ owner: z.string(), repo: z.string(), path: z.string(), content: z.string(), message: z.string(), branch: z.string(), confirm: z.boolean().describe('Set false first to preview, true only after user confirms.') }),
      execute: async ({ owner, repo, path, content, message, branch, confirm }: { owner: string; repo: string; path: string; content: string; message: string; branch: string; confirm: boolean }) => {
        if (!confirm) return { status: 'preview', action: 'update_file', repo: `${owner}/${repo}`, branch, file_path: path, content_summary: content.slice(0, 500) + (content.length > 500 ? '…' : ''), message, summary: `Update "${path}" on "${branch}" in ${owner}/${repo}.` }
        const result = await updateFile(githubToken, owner, repo, path, content, message, branch)
        if (!result.ok) return { status: 'error', error: result.error }
        if (uid) { const payload: GitHubActionPayload = { action: 'update_file', repo: `${owner}/${repo}`, branch, file_path: path, summary: `Updated "${path}"`, timestamp: new Date().toISOString() }; (async () => { const { error: auditError } = await supabase.from('resources').insert({ user_id: uid, type: 'github_action', source: 'user', title: `Update: ${path}`, payload }); if (auditError) console.error('[chat] audit insert failed:', auditError) })() }
        return { status: 'ok', repo: `${owner}/${repo}`, branch, file_path: path, url: result.url }
      },
    })
    allTools.github_create_pull_request = tool({
      description: 'Open a PR from a working branch into base.',
      inputSchema: z.object({ owner: z.string(), repo: z.string(), title: z.string(), body: z.string(), head_branch: z.string(), base_branch: z.string().default('main'), confirm: z.boolean().describe('Set false first to preview, true only after user confirms.') }),
      execute: async ({ owner, repo, title, body, head_branch, base_branch, confirm }: { owner: string; repo: string; title: string; body: string; head_branch: string; base_branch: string; confirm: boolean }) => {
        if (!confirm) return { status: 'preview', action: 'create_pr', repo: `${owner}/${repo}`, title, body, head: head_branch, base: base_branch, summary: `Open PR: "${title}" from "${head_branch}" → "${base_branch}"` }
        const result = await createPR(githubToken, owner, repo, title, body, head_branch, base_branch)
        if (!result.ok) return { status: 'error', error: result.error }
        if (uid) { const payload: GitHubActionPayload = { action: 'create_pr', repo: `${owner}/${repo}`, branch: head_branch, pr_url: result.url, summary: `Opened PR #${result.number}: "${title}"`, timestamp: new Date().toISOString() }; (async () => { const { error: auditError } = await supabase.from('resources').insert({ user_id: uid, type: 'github_action', source: 'user', title: `PR #${result.number}: ${title}`, payload }); if (auditError) console.error('[chat] audit insert failed:', auditError) })() }
        return { status: 'ok', repo: `${owner}/${repo}`, pr_url: result.url, number: result.number, head: head_branch, base: base_branch }
      },
    })
    allTools.github_create_repo = tool({
      description: "Create a brand new GitHub repository.",
      inputSchema: z.object({ name: z.string(), description: z.string(), private: z.boolean().default(true), confirm: z.boolean().describe('Set false first to preview, true only after user confirms.') }),
      execute: async ({ name, description, private: isPrivate, confirm }: { name: string; description: string; private: boolean; confirm: boolean }) => {
        if (!confirm) return { status: 'preview', action: 'create_repo', name, description, private: isPrivate, summary: `Create ${isPrivate ? 'private' : 'public'} repo "${name}"` }
        const result = await createRepo(githubToken, name, description, isPrivate)
        if (!result.ok) return { status: 'error', error: result.error }
        if (uid) { const payload: GitHubActionPayload = { action: 'create_repo', repo: name, summary: `Created ${isPrivate ? 'private' : 'public'} repo "${name}"`, timestamp: new Date().toISOString() }; (async () => { const { error: auditError } = await supabase.from('resources').insert({ user_id: uid, type: 'github_action', source: 'user', title: `Repo: ${name}`, payload }); if (auditError) console.error('[chat] audit insert failed:', auditError) })() }
        return { status: 'ok', name, url: result.url, private: isPrivate }
      },
    })
    allTools.github_read_enryrules = tool({
      description: 'Read .enryrules from a repo — project-specific conventions, naming patterns, "always/never" rules. Call before editing any repo file. Returns empty if the repo has no .enryrules file.',
      inputSchema: z.object({ owner: z.string().describe('Repository owner'), repo: z.string().describe('Repository name') }),
      execute: async ({ owner, repo }: { owner: string; repo: string }) => {
        const { content, error } = await getFileContent(githubToken, owner, repo, '.enryrules')
        if (error && error.includes('404')) return { content: null, exists: false, note: 'No .enryrules file in this repo. Proceed with standard conventions.' }
        if (error) return { content: null, error }
        return { content, exists: true }
      },
    })
  }

  // Attach Composio-backed Gmail + Calendar tools (read-only). buildComposioTools
  // returns {} when the user is unauthenticated, when focus mode disallows it
  // (web_only, repo_only), or when the user has no connected_account_id for a
  // given toolkit - so the model never sees a tool it can't actually call.
  const composioTools = await buildComposioTools(uid, focusMode, modelToolResultMaxChars)
  Object.assign(allTools, composioTools)

  // ── Groq tool-count guard ────────────────────────────────────────
  // Llama 3 models on Groq emit malformed tool-call JSON at high tool
  // counts (~20+). Groq's API validates tool-call outputs before
  // streaming and returns HTTP 400 when the model concatenates JSON
  // args onto the tool name (a known Llama 3 failure mode). Unlike the
  // Gemini index patch in nim.ts (which fixes a quirky but valid 200
  // stream), this can't be patched at the response layer — Groq blocks
  // the stream entirely. Mitigation: trim to a safe subset for Groq.
  if (isGroqModel(selectedModel)) {
    const GROQ_MAX_TOOLS = 18
    const groqBefore = Object.keys(allTools).length
    // Read-only GitHub tools only (4): list_repos, read_file, list_issues, read_enryrules.
    // Drop 6 write tools: create_issue, create_branch, create_file, update_file, create_pr, create_repo.
    // Drop monid_api (1) — it's a fallback discover-and-call tool that adds little value on Groq.
    // Keep: web_search, memory (2), school (2), composio_search (5 no-auth), plus any connected Gmail/Firecrawl.
    const lowPriority = ['github_create_issue', 'github_create_branch', 'github_create_file', 'github_update_file', 'github_create_pull_request', 'github_create_repo', 'monid_api']
    for (const key of lowPriority) delete allTools[key]
    // If still over the cap (e.g. Gmail + Firecrawl both connected), trim
    // the least-used Composio tools further.
    const remaining = Object.keys(allTools)
    if (remaining.length > GROQ_MAX_TOOLS) {
      const excessTools = ['composio_finance', 'composio_flights', 'composio_amazon', 'firecrawl_map', 'firecrawl_crawl', 'gmail_search_emails']
      for (const key of excessTools) {
        if (remaining.length <= GROQ_MAX_TOOLS) break
        delete allTools[key]
      }
    }
    const groqAfter = Object.keys(allTools).length
    if (groqBefore !== groqAfter) {
      console.log(`[chat] Groq tool trim: ${groqBefore} → ${groqAfter} tools (model=${selectedModel}, focus=${focusMode})`)
    }
  }

  // ── Diagnostic: log tool count for every request ────────────────
  const toolKeys = Object.keys(allTools)
  if (toolKeys.length > 15) {
    console.log(`[chat] high tool count: ${toolKeys.length} tools, model=${selectedModel}, focus=${focusMode}, tools=[${toolKeys.join(', ')}]`)
  }

  // School tools — Google Classroom + Infinite Campus (read-only). Always
  // available regardless of focus mode (school data isn't web/repo/memory).
  allTools.school_whats_due = tool({
    description:
      'Pull upcoming and due assignments from Google Classroom and Infinite Campus. Returns assignments sorted by due date (closest first), tagged by source. Use this when Henry asks "what\'s due", "any homework", "upcoming assignments", or similar. Results are merged from both school systems into one sorted list.',
    inputSchema: z.object({}),
    execute: async () => {
      const results: Array<{
        source: string
        title: string
        course: string
        dueDate: string | null
        status: string | null
        points: number | null
        link: string | null
      }> = []
      const errors: string[] = []

      // Google Classroom
      try {
        const { courses: gcCourses, error: gcError } = await getAllDueWork(uid!)
        if (gcError) {
          errors.push(`Google Classroom: ${gcError}`)
        } else {
          for (const { course, work } of gcCourses) {
            for (const w of work) {
              let dueDate: string | null = null
              if (w.dueDate) {
                const d = new Date(
                  w.dueDate.year ?? 0,
                  (w.dueDate.month ?? 1) - 1,
                  w.dueDate.day ?? 1,
                  w.dueTime?.hours ?? 0,
                  w.dueTime?.minutes ?? 0,
                )
                if (!isNaN(d.getTime())) dueDate = d.toISOString()
              }
              results.push({
                source: 'google_classroom',
                title: w.title,
                course: course.name,
                dueDate,
                status: w.state,
                points: w.maxPoints ?? null,
                link: w.alternateLink ?? null,
              })
            }
          }
        }
      } catch (e) {
        errors.push(`Google Classroom: ${String((e as Error)?.message ?? e)}`)
      }

      // Infinite Campus
      try {
        const { assignments: icItems, error: icError } = await getAssignments(uid!)
        if (icError) {
          errors.push(`Infinite Campus: ${icError}`)
        } else {
          for (const a of icItems) {
            let dueDate: string | null = null
            if (a.dueDate) {
              const d = new Date(a.dueDate)
              if (!isNaN(d.getTime())) dueDate = d.toISOString()
            }
            results.push({
              source: 'infinite_campus',
              title: a.name,
              course: a.course,
              dueDate,
              status: a.status,
              points: a.totalPoints ? parseFloat(a.totalPoints) : null,
              link: null,
            })
          }
        }
      } catch (e) {
        errors.push(`Infinite Campus: ${String((e as Error)?.message ?? e)}`)
      }

      // Sort by due date closest first
      results.sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return 0
        if (!a.dueDate) return 1
        if (!b.dueDate) return -1
        return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
      })

      return {
        assignments: results,
        count: results.length,
        errors: errors.length > 0 ? errors : undefined,
      }
    },
  })

  allTools.school_announcements = tool({
    description:
      'Pull recent class announcements from Google Classroom and Infinite Campus. Returns announcements sorted by date (most recent first), tagged by source. Use this when Henry asks "any announcements", "what did my teachers post", "class updates", or similar.',
    inputSchema: z.object({}),
    execute: async () => {
      const results: Array<{
        source: string
        course: string
        text: string
        date: string | null
        link: string | null
      }> = []
      const errors: string[] = []

      // Google Classroom
      try {
        const { courses: gcCourses, error: gcError } = await getAllAnnouncements(uid!)
        if (gcError) {
          errors.push(`Google Classroom: ${gcError}`)
        } else {
          for (const { course, announcements } of gcCourses) {
            for (const a of announcements) {
              results.push({
                source: 'google_classroom',
                course: course.name,
                text: a.text,
                date: a.creationTime ?? null,
                link: a.alternateLink ?? null,
              })
            }
          }
        }
      } catch (e) {
        errors.push(`Google Classroom: ${String((e as Error)?.message ?? e)}`)
      }

      // Infinite Campus
      try {
        const { announcements: icItems, error: icError } = await getICAnnouncements(uid!)
        if (icError) {
          errors.push(`Infinite Campus: ${icError}`)
        } else {
          for (const a of icItems) {
            results.push({
              source: 'infinite_campus',
              course: a.course,
              text: a.text,
              date: a.date,
              link: null,
            })
          }
        }
      } catch (e) {
        errors.push(`Infinite Campus: ${String((e as Error)?.message ?? e)}`)
      }

      // Sort by date most recent first
      results.sort((a, b) => {
        if (!a.date && !b.date) return 0
        if (!a.date) return 1
        if (!b.date) return -1
        return new Date(b.date).getTime() - new Date(a.date).getTime()
      })

      return {
        announcements: results,
        count: results.length,
        errors: errors.length > 0 ? errors : undefined,
      }
    },
  })

  // Monid — general-purpose API discovery/execution fallback. Always available
  // regardless of focus mode. The model should reach for this LAST, after
  // Tavily, Composio search, and Firecrawl have been considered.
  allTools.monid_api = tool({
    description: 'FALLBACK — discover and call third-party APIs for needs not covered by other tools. Use ONLY when Tavily (web_search), Composio search tools (composio_web_search, composio_finance, composio_flights, composio_amazon), Composio fetch (composio_fetch_url), and Firecrawl (firecrawl_scrape, firecrawl_crawl, firecrawl_extract, firecrawl_search, firecrawl_map) do NOT cover the specific API you need. Give it a natural-language description of what API/endpoint you want, and Monid discovers and executes the right one at runtime.',
    inputSchema: z.object({
      query: z.string().describe('Natural language description of the API call you need, e.g. "get the current Bitcoin price from CoinGecko", "search for JavaScript jobs on an obscure job board", "look up a statute on a legal database"'),
    }),
    execute: async ({ query }: { query: string }) => {
      const discovered = await monidDiscover(query)
      if (discovered.error) return { success: false, error: discovered.error }
      if (discovered.results.length === 0) return { success: false, error: `Monid found no APIs matching: ${query}` }

      const best = discovered.results[0]
      const runResult = await monidRun(best.provider, best.endpoint, {})
      return {
        success: runResult.status === 'COMPLETED',
        provider: best.provider,
        endpoint: best.endpoint,
        description: best.description,
        output: runResult.output,
        error: runResult.error,
      }
    },
  })

  // Models with supportsTools:false (unreliable tool-call syntax, or a
  // per-minute token budget that can't fit a tool round-trip) never get the
  // schemas — offering a capability that fails whenever it's used is worse
  // than not offering it. Gated once here so the set can't drift as tools are
  // added above.
  const activeTools = modelSupportsTools ? allTools : {}
  const usingTools = Object.keys(activeTools).length > 0

  const chatStartedAt = Date.now()
  const result = streamText({
    model: chatClient.chat(modelParam),
    system: getSystemPrompt(systemPromptTier, {
      isRecovery,
      recoverySystemPrompt,
      focusDirective,
      sessionFocusDirective,
      effortDirective,
      userProfile,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: finalMessages as any,
    stopWhen: stepCountIs(7),
    ...(reasoningDepth !== 'off' && modelSupportsReasoning(selectedModel) ? {
      providerOptions: { openai: { extra_body: { chat_template_kwargs: { enable_thinking: true } } } },
    } : {}),
    // Models with supportsTools:false (unreliable tool-call syntax, or a
    // per-minute token budget that can't fit a tool round-trip) never get the
    // schemas — offering a capability that fails whenever it's used is worse
    // than not offering it.
    tools: activeTools,
    // Inject recovery continuation into the system prompt when recovering
    // Same reasoning as the multi-skill call above: unset here defaults to
    // maxRetries 2, and this path additionally runs up to 7 tool-calling
    // steps (stopWhen) in one invocation — a broad request that triggers
    // several recall_memory/web_search/GitHub calls can legitimately run
    // 40-50s+ even on a healthy model (confirmed empirically), leaving very
    // little margin before a retry-doubled attempt blows past maxDuration.
    maxRetries: 0,
    // See the multi-skill call above — an uncapped max_tokens request
    // exceeds what the free-tier OpenRouter account (DeepSeek's provider)
    // can afford per call and fails before generating anything. A turn that
    // actually carries tools uses the smaller per-step reservation, since it
    // pays that reservation once per step rather than once per turn.
    maxOutputTokens: usingTools ? modelToolTurnOutputTokens : modelMaxOutputTokens,
    onError: ({ error }) => {
      console.error('streamText error:', error)
    },
    onFinish: async ({ usage, finishReason }) => {
      // A non-clean finish reason here is the silent-truncation case: the
      // request did NOT throw, so onError never fires, but the model
      // stopped before it was done. Log it so the cutoff is traceable
      // server-side; the client learns about it via messageMetadata below.
      if (finishReason !== 'stop' && finishReason !== 'tool-calls') {
        console.warn(`[chat] stream finished early — finishReason=${finishReason} model=${selectedModel} cap=${usingTools ? modelToolTurnOutputTokens : modelMaxOutputTokens}`)
      }
      // Usage observability — resilient, never breaks the response. Runs
      // after the full multi-step stream completes; usage is accumulated
      // across tool-calling steps by the SDK.
      if (uid) {
        logUsage({
          userId: uid,
          modelId: selectedModel,
          mode: 'chat',
          promptTokens: usage?.inputTokens,
          completionTokens: usage?.outputTokens,
          totalTokens: usage?.totalTokens,
          latencyMs: Date.now() - chatStartedAt,
        }).catch(() => {})

        // Every third user turn, run a small, best-effort extraction in the
        // background. It only writes pending review entries and never affects
        // the streamed answer if the provider or database is unavailable.
        extractAndSaveAutoMemories(uid, googleId ?? '', messages as unknown[]).catch((error) => {
          console.error('[chat] auto-memory hook failed:', error)
        })
      }
    },
  })

  return result.toUIMessageStreamResponse({
    headers: compacted ? { 'X-Context-Compacted': 'true', 'X-Context-Compacted-Summary': encodeURIComponent(compactionSummary ?? '') } : undefined,
    // See the multi-skill path above — this is what makes a truncated
    // response visible to the user instead of silently ending.
    messageMetadata: ({ part }) =>
      part.type === 'finish' ? buildFinishMetadata(part.finishReason) : undefined,
    onError: (error) => safeStreamErrorMessage(error, 'chat route error'),
  })
}
