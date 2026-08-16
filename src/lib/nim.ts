import { createOpenAI } from '@ai-sdk/openai'

// ───────────────────────────────────────────────────────────────────
// Model registry — single source of truth for every model Golem Engine
// exposes to the chat picker, Drive picker, Shard picker, and server
// routes. Replaces the old NIM-only MODEL_KEYS map. Adding a model:
//   1. Append an entry to MODEL_LIST below (id, label, scopes, etc.)
//   2. Append a provider row to PROVIDERS (baseURL + env-key getter)
// All UI pickers drive off MODEL_LIST — no more inline arrays.
//
// Free-tier final lineup (July 2026 cleanup):
//   * GLM 5.2          → NVIDIA NIM (GLM_API_KEY)
//   * DeepSeek V4 Flash → NVIDIA NIM (DEEPSEEK_API_KEY / NVIDIA_API_KEY)
//   * DeepSeek V4 Pro   → NVIDIA NIM (DEEPSEEK_API_KEY / NVIDIA_API_KEY)
//   * Gemini 3.5 Flash  → Google AI Studio (GEMINI_API_KEY)
//   * Llama 3.3 70B     → Groq (GROQ_API_KEY)
//   * GPT-OSS 120B       → Groq (GROQ_API_KEY)
//   * Claude 3.5 Sonnet  → GitHub Models (GITHUB_MODELS_TOKEN)
// Models are only shown in pickers if their provider key is configured.
// ───────────────────────────────────────────────────────────────────

export type ModelScope = 'chat' | 'drive' | 'lite'

export interface ModelMeta {
  id: string
  label: string
  company: string
  description: string
  scopes: ModelScope[]
  /** Whether the model's UI defaults to Medium effort (for new/unproven models). */
  defaultEffort?: 'low' | 'medium' | 'high'
  /** Reserved: future flag for models that natively accept image input. */
  supportsVision?: boolean
  /** Whether the model emits reasoning-style trace content the UI can split out. */
  supportsReasoning?: boolean
  /**
   * Set when a model is known-unreliable at its provider right now. It stays
   * fully selectable — this only drives an honest badge in the pickers and
   * keeps autonomous selection off it. Same principle as the error sanitizer:
   * surface the real state, don't hide it and don't silently block it.
   */
  degraded?: string
  /**
   * Per-model cap on requested output tokens. Groq bills `prompt + max_tokens`
   * against a rolling per-minute budget *whether or not the output is used*, so
   * a blanket 4096 reservation on a 6000 TPM model burns two-thirds of the
   * minute on a reply that may be three words — and a single request with a
   * system prompt plus the tool schemas then exceeds the limit outright and
   * comes back 413. Measured TPM: llama-3.1-8b-instant 6000,
   * openai/gpt-oss-120b 8000, llama-3.3-70b-versatile 12000.
   * Omitted = use the route's default.
   */
  maxOutputTokens?: number
  /**
   * System prompt terseness tier. Maps to Claude naming as shorthand:
   * - 'haiku' = terse, minimal (rate-limited models)
   * - 'sonnet' = medium detail (balanced models)
   * - 'full' (or undefined) = unchanged original prompt (default)
   * Groq models sit on 'haiku': the prompt is re-sent on every step of a tool
   * turn and charged against a per-minute ceiling, so its size decides whether
   * a tool round-trip fits at all.
   */
  systemPromptTier?: 'haiku' | 'sonnet' | 'full'
  /**
   * False when a model cannot reliably use tools right now — either a token
   * budget that can't fit a tool round-trip, or (as with Llama 3.3 70B on
   * Groq) a model that mangles the function-call syntax whenever it attempts
   * one. Omitted = tools attached normally. Read by the chat route to decide
   * whether to pass the tool set to streamText at all.
   */
  supportsTools?: boolean
  /**
   * Output reservation for a turn that has tools attached, overriding
   * `maxOutputTokens` for that turn only.
   *
   * Orthogonal to systemPromptTier: the tier decides how many tokens the
   * system prompt costs, this decides how many the reservation costs. They
   * compound rather than conflict — a leaner tier lowers P1, which is what
   * makes a given reservation affordable.
   *
   * It matters because a tool turn is not one request. The SDK re-sends the
   * whole context once per step, and Groq both admits and debits on
   * `prompt + max_tokens` rather than tokens actually produced — so the
   * reservation is paid again on every step while the prompt only grows, and
   * an unused output budget is what starves the follow-up request. Budget for
   * a two-step turn is `2×P1 + toolResult + 2×reservation ≤ TPM`.
   */
  maxOutputTokensWithTools?: number
  /**
   * Cap on the characters of a single tool result fed back into context.
   * Applies to Tavily search results and every Composio result (Gmail bodies,
   * scraped pages). Sized from the model's headroom, since every later step of
   * the turn re-sends it. Omitted = the tool layer's own defaults.
   */
  toolResultMaxChars?: number
}

// Client-safe metadata. Pickers read this directly. No secrets here.
// Note: listModels() below filters this list at runtime to only models whose
// provider key is configured, so UI pickers never show a model that cannot
// actually be called.
// Order matters: several call sites treat the first entry of a scope as that
// scope's default (chat/architect routes' CHAT_MODELS[0] fallback,
// defaultModelForScope, Drive auto-select tiebreaks). GLM 5.2 leads so those
// all resolve to the same model DEFAULT_MODEL_ID names — otherwise the
// "default" would silently be whichever model happened to be listed first.
export const MODEL_LIST: ModelMeta[] = [
  {
    id: 'z-ai/glm-5.2',
    label: 'GLM 5.2',
    company: 'NVIDIA NIM',
    description: 'Default. Versatile all-rounder.',
    scopes: ['chat', 'drive'],
    systemPromptTier: 'full',
  },
  {
    // Was deepseek/deepseek-v4-pro on OpenRouter — removed, not renamed. That
    // account is a free tier that ran out of credit (402: "requested up to 800
    // tokens, but can only afford 197"), which made the app's own default model
    // fail on the first message of every new chat.
    //
    // NIM's catalog carries DeepSeek under a different prefix (deepseek-ai/,
    // not deepseek/), and its v4-pro deployment is still unusable — a real
    // streaming request sat for 150s without returning headers, matching the
    // DEGRADED behaviour that moved DeepSeek off NIM originally. v4-flash is
    // the current DeepSeek on NIM that actually responds, so that's what this
    // entry routes to. It is NOT the default: under shared free-tier load it
    // returns ResourceExhausted a fair fraction of the time (measured 3/5,
    // queue depth 1863/48), so it's offered as a choice, not a foundation.
    id: 'deepseek-ai/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    company: 'DeepSeek (NVIDIA NIM)',
    description: 'Fast DeepSeek. Free-tier capacity is shared — can be busy at peak.',
    scopes: ['chat', 'drive'],
    defaultEffort: 'medium',
    supportsReasoning: true,
    systemPromptTier: 'sonnet',
  },
  {
    // The full-size DeepSeek, kept selectable alongside Flash rather than
    // replaced by it. NVIDIA's deployment is currently not responding —
    // measured 0/2, a real streaming request held 150s without returning
    // headers — so it carries a degraded badge instead of being hidden or
    // silently dropped. Capacity issues resolve; when it starts answering
    // again, clear `degraded` and it needs no other change.
    id: 'deepseek-ai/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    company: 'DeepSeek (NVIDIA NIM)',
    description: 'Full-size DeepSeek. Strongest on complex tasks when NVIDIA capacity is available.',
    scopes: ['chat', 'drive'],
    defaultEffort: 'high',
    supportsReasoning: true,
    systemPromptTier: 'full',
    // Re-measured after the initial 0/2 timeouts: it now answers 6/6, but at
    // ~50s per reply versus ~3s for Flash, and it returned nothing at all
    // earlier the same day. Shared NVIDIA free-tier capacity, so the honest
    // label is "slow and unpredictable", not "broken" and not "fine".
    degraded: 'Very slow on shared NVIDIA capacity (~50s replies) and can time out entirely.',
  },
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    company: 'Google',
    description: 'Fast multimodal — free-tier quota available.',
    scopes: ['chat', 'drive'],
    defaultEffort: 'medium',
    systemPromptTier: 'sonnet',
  },
  {
    id: 'llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B',
    company: 'Groq',
    description: 'Fast, capable generalist on Groq. Chat only — no tools or web search.',
    scopes: ['chat', 'drive'],
    defaultEffort: 'medium',
    // 12000 TPM. 4096 + lean prompt + 20+ tool schemas + focus/effort
    // directives was exceeding the per-minute budget on tool-annotated
    // requests (same class as the 8B 6000 TPM bug). 2048 leaves enough
    // headroom that a request with all tools won't 413.
    maxOutputTokens: 2048,
    // Groq bills prompt + output tokens against a per-minute budget, so
    // lean prompt saves meaningful TPM headroom on every message.
    systemPromptTier: 'haiku',
    // The 413 above is fixed, but tools stayed broken: with the full ~22-tool
    // schema set, this model reliably mangles Groq's function-call syntax —
    // observed as `tool call validation failed: attempted to call tool
    // 'web_search [{"query": ...}]' which was not in request.tools`, i.e. it
    // concatenates the JSON arguments onto the tool name instead of using a
    // separate arguments field. Reproduced on every message that triggers (or
    // over-triggers) a tool call, including plain conversational input with
    // no search-shaped request — not a prompt-size problem, a Groq/model
    // tool-calling compatibility problem at this schema count. Plain replies
    // (no tool attempt) work fine, so withhold tools rather than offer a
    // capability that fails whenever it's actually used.
    supportsTools: false,
    // Latent while supportsTools is false — kept so re-enabling tools doesn't
    // also silently restore the flat 2048 reservation that caused the original
    // 429s. Measured against the haiku tier: P1 is 2816 with the 24-tool set,
    // so a two-step turn costs 5632 + results + 2×reservation of 12000. At the
    // flat 2048 that leaves ~1470 spare (about 730 tokens of history, charged
    // on both steps); at 1024 it leaves ~3520 (about 1760 tokens of history).
    maxOutputTokensWithTools: 1024,
    toolResultMaxChars: 2800,
  },
  {
    // Replaces Llama 3.1 8B Instant (removed). GitHub Models exposes Claude
    // 3.5 Sonnet through an OpenAI-compatible endpoint at
    // https://models.github.ai/inference — NOT the legacy
    // models.inference.ai.azure.com host (that one only ever served Azure
    // OpenAI/Cohere/Meta; hitting it for anthropic/* returns a bare 401
    // "unauthorized" with no useful detail, which looks like a bad key but
    // isn't). Auth: GitHub PAT with default scopes, GITHUB_MODELS_TOKEN.
    //
    // As of 2026-08-01 the live API itself returns 410
    // github_models_retirement_brownout on this model — GitHub Models is
    // being sunset. The endpoint/id here are correct; the outage is
    // upstream, not a config bug. Re-verify against the catalog
    // (GET https://models.github.ai/catalog/models) before relying on this
    // entry, and expect it may need to move to a direct Anthropic key.
    //
    // Tool calling: GitHub Models' Claude deployment MAY support tool calls,
    // but this is unconfirmed — Anthropic's native API does, but the
    // OpenAI-compatible shim may not. Flag: supportsTools implied by the
    // adapter (all OpenAI-compatible endpoints get tool schemas), but the
    // model may ignore or error on them.
    id: 'anthropic/claude-3.5-sonnet',
    label: 'Claude 3.5 Sonnet',
    company: 'Anthropic (GitHub Models)',
    description: 'Claude via GitHub Models — strong reasoning, long context. Rate limits unconfirmed.',
    scopes: ['chat', 'drive'],
    defaultEffort: 'low',
    // Context window: 200K (native Claude), but GitHub Models may cap lower.
    // 4096 is conservative for an unknown-quota provider, following the
    // same pattern as Groq models.
    maxOutputTokens: 4096,
    // Rate limits unconfirmed — lean prompt is the safest default.
    systemPromptTier: 'haiku',
  },
  {
    id: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B',
    company: 'Groq',
    description: 'Open-source OpenAI model hosted on Groq.',
    scopes: ['chat', 'drive'],
    defaultEffort: 'high',
    supportsReasoning: true,
    systemPromptTier: 'haiku',
    // 8000 TPM. Deliberately NOT raised despite the haiku tier freeing room:
    // a plain turn is 1409 + history + reservation, so 2048 tolerates ~4540
    // tokens of history (~20k chars) while compaction fires at 16k chars. That
    // ordering is the safety property — at 4096 the ceiling drops to ~11k
    // chars, below the compaction threshold, and a long conversation would 413
    // before compaction could rescue it.
    maxOutputTokens: 2048,
    // Moved to the haiku tier (Henry's call, overriding the earlier decision to
    // leave this model on full). P1 falls from 3793 to 1409 against the 24-tool
    // production set — a bigger drop than the 70B's, since this tokenizer is
    // more efficient on the short prompt.
    //
    // That turns a turn that could not fit at ANY reservation into one with
    // real headroom. Two steps now cost 2818 of 8000 rather than 7586, leaving
    // 5182 to split instead of 414:
    //   2×1409 + 800 (2800-char result) + 2×1024 = 5666, margin 2334.
    // History is charged on both steps, so that margin covers roughly 1160
    // tokens (~4600 chars) of prior conversation.
    maxOutputTokensWithTools: 1024,
    toolResultMaxChars: 2800,
  },
]

// Default chat model — falls back here if a request supplies an unknown id.
// GLM 5.2, not DeepSeek: the default is the model every new chat opens on, so
// it has to be the most reliable one available, not the most capable on paper.
// Measured back-to-back on NIM: GLM 5.2 5/5, DeepSeek V4 Flash 3/5
// (ResourceExhausted under shared load). Must never point at an OpenRouter-
// routed model — a credit-exhausted account there is what broke every new chat.
export const DEFAULT_MODEL_ID = 'z-ai/glm-5.2'

// ── Provider config (server-only — env reads happen at request time) ──
// baseURL + apiKey getter per model. All providers expose
// OpenAI-compatible endpoints, so a single `createOpenAI(...)` does the work
// across all of them — no per-provider SDK install required.
interface ProviderConfig {
  baseURL: string | (() => string)
  getApiKey: () => string
  /** Optional per-provider fetch override — used to patch response shapes
   *  that don't match what @ai-sdk/openai expects (see geminiToolCallFetch). */
  fetch?: typeof fetch
}

// Gemini's OpenAI-compatible endpoint (v1beta/openai) streams tool-call
// deltas that omit the per-call `index` field the AI SDK's chat chunk schema
// requires (it uses `index` to accumulate parallel tool calls across
// chunks). Real repro: a tool_calls delta arrives as
//   {"delta":{"tool_calls":[{"extra_content":{...},"function":{...},"id":"...","type":"function"}]}}
// — everything OpenAI's shape has, minus `index` — so Zod's required-field
// check fails with "Type validation failed" and the SDK surfaces the raw
// payload as the stream error instead of a tool call. Since Gemini only ever
// sends one tool call per delta chunk in this shape, position in the array
// (0) is the correct index; this wrapper fills it in before the response
// body reaches the SDK's parser, which is the only point we can intervene at
// (the parsing happens inside @ai-sdk/openai, not in our route code).
function geminiToolCallFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init).then((res) => {
    const contentType = res.headers.get('content-type') ?? ''
    if (!res.body || !contentType.includes('text/event-stream')) return res

    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let buffer = ''

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          controller.enqueue(encoder.encode(patchSseLine(line) + '\n'))
        }
      },
      flush(controller) {
        if (buffer) controller.enqueue(encoder.encode(patchSseLine(buffer)))
      },
    })

    return new Response(res.body.pipeThrough(transform), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  })
}

function patchSseLine(line: string): string {
  if (!line.startsWith('data: ') || line === 'data: [DONE]') return line
  try {
    const data = JSON.parse(line.slice(6))
    let mutated = false
    for (const choice of data.choices ?? []) {
      const toolCalls = choice?.delta?.tool_calls
      if (Array.isArray(toolCalls)) {
        toolCalls.forEach((tc: Record<string, unknown>, i: number) => {
          if (typeof tc.index !== 'number') {
            tc.index = i
            mutated = true
          }
        })
      }
    }
    return mutated ? `data: ${JSON.stringify(data)}` : line
  } catch {
    return line // not JSON (or malformed) — pass through untouched
  }
}

const NIM_BASE = 'https://integrate.api.nvidia.com/v1'
const GROQ_BASE = 'https://api.groq.com/openai/v1'
// Hugging Face Inference Providers router — OpenAI-compatible. Community
// models added from The Black Market route here (see COMMUNITY_MODEL_PREFIX).
const HF_ROUTER_BASE = 'https://router.huggingface.co/v1'

// ── Community models (The Black Market) ─────────────────────────────
// Community models aren't in the static MODEL_LIST/PROVIDERS above — they're
// added at runtime and persisted in Supabase (community_models). Their id is
// self-describing so routing needs no DB lookup at call time:
//   community:<hfId>:<provider>
//   e.g. community:NousResearch/Hermes-3-Llama-3.1-8B:featherless-ai
// The part after the prefix is exactly the model param the HF router expects.
export const COMMUNITY_MODEL_PREFIX = 'community:'

export function isCommunityModelId(id: string): boolean {
  return id.startsWith(COMMUNITY_MODEL_PREFIX)
}

/** Returns true if the model routes through Groq (known tool-calling quirk at high tool counts). */
export function isGroqModel(id: string): boolean {
  return id === 'llama-3.3-70b-versatile' || id === 'openai/gpt-oss-120b' || id === 'llama-3.1-8b-instant'
}

/** The HF-router model param for a community id (strips the marker prefix). */
export function communityRouteParam(id: string): string {
  return id.slice(COMMUNITY_MODEL_PREFIX.length)
}

const PROVIDERS: Record<string, ProviderConfig> = {
  // DeepSeek V4 Flash — NVIDIA NIM, same baseURL + client path as GLM 5.2.
  // DEEPSEEK_API_KEY now holds an nvapi-* key (verified working against NIM);
  // NVIDIA_API_KEY is the fallback. No OpenRouter route remains in this
  // registry — see the MODEL_LIST entry for why it was removed outright.
  'deepseek-ai/deepseek-v4-flash': {
    baseURL: NIM_BASE,
    getApiKey: () => process.env.DEEPSEEK_API_KEY ?? process.env.NVIDIA_API_KEY ?? '',
  },
  // DeepSeek V4 Pro — same NIM endpoint and key path as Flash.
  'deepseek-ai/deepseek-v4-pro': {
    baseURL: NIM_BASE,
    getApiKey: () => process.env.DEEPSEEK_API_KEY ?? process.env.NVIDIA_API_KEY ?? '',
  },
  // GLM 5.2 — NVIDIA NIM, confirmed live and free-tier capable.
  'z-ai/glm-5.2': {
    baseURL: NIM_BASE,
    getApiKey: () => process.env.GLM_API_KEY ?? '',
  },
  // Google Gemini — OpenAI-compatible endpoint at the v1beta/openai subpath.
  // 3.5 Flash, not Pro — Pro tier is quota-gated at 0 on this Cloud project
  // (needs billing enabled), confirmed via GET /v1beta/openai/models plus a
  // real completion at $0. Flash-tier models on the same key work fine.
  // fetch: geminiToolCallFetch — patches missing `index` on streamed tool-call
  // deltas (see the function's doc comment); without it, any Gemini message
  // that triggers a tool call fails with a raw Zod validation-error dump.
  'gemini-3.5-flash': {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    getApiKey: () => process.env.GEMINI_API_KEY ?? '',
    fetch: geminiToolCallFetch,
  },
  // Groq-hosted free-tier models. All three share the Groq OpenAI-compatible
  // endpoint and GROQ_API_KEY. They are filtered out of pickers when the key
  // is missing (see listModels below).
  'llama-3.3-70b-versatile': {
    baseURL: GROQ_BASE,
    getApiKey: () => process.env.GROQ_API_KEY ?? '',
  },
  'openai/gpt-oss-120b': {
    baseURL: GROQ_BASE,
    getApiKey: () => process.env.GROQ_API_KEY ?? '',
  },
  // GitHub Models — OpenAI-compatible endpoint. Claude 3.5 Sonnet is the
  // first model here. Endpoint: https://models.github.ai/inference (the
  // legacy models.inference.ai.azure.com host never served Anthropic models
  // at all — its catalog is Azure OpenAI/Cohere/Meta only, so requests for
  // anthropic/* there 401 with a "Server Error" that has nothing to do with
  // the key). Auth: GitHub PAT with default scopes. Checks both
  // GITHUB_MODELS_TOKEN and GITHUB_MODELS_API_KEY (env var name was
  // inconsistent in early UI error messages, so both are accepted to avoid
  // silent miss-on-key-update).
  // As of 2026-08-01 GitHub Models returns 410 github_models_retirement_
  // brownout for this model — an upstream sunset, not a config issue.
  'anthropic/claude-3.5-sonnet': {
    baseURL: 'https://models.github.ai/inference',
    getApiKey: () => process.env.GITHUB_MODELS_TOKEN ?? process.env.GITHUB_MODELS_API_KEY ?? '',
  },
}

// Runtime diagnostic: if Groq models are in the registry but no GROQ_API_KEY
// is set, warn once so the operator knows why they are not selectable.
// Server-only: this module is imported by client components, where every
// non-NEXT_PUBLIC env var is undefined — without the window guard this warning
// fires in every visitor's browser console regardless of the real server config.
if (typeof window === 'undefined' && typeof process !== 'undefined' && !process.env.GROQ_API_KEY) {
  console.warn('[nim] GROQ_API_KEY is missing. Groq models (Llama 3.3 70B, GPT-OSS 120B) are still listed in pickers but will fail on use until the key is set.')
}

// ─── Lookup helpers (used by pickers + server routes) ──────────────
export function getModelMeta(id: string): ModelMeta | undefined {
  return MODEL_LIST.find((m) => m.id === id)
}

// CLIENT-SAFE — must stay pure (scope filter only, no process.env reads).
//
// This is imported at module scope by client components ('use client':
// forge/page.tsx). Provider keys are
// server-only secrets: Next.js inlines just NEXT_PUBLIC_* into the client
// bundle, so any process.env.*_API_KEY read here is undefined in the browser.
// A previous version filtered by isModelConfigured() and so returned the full
// list during SSR but [] after hydration — which collapsed every picker to
// zero first-party models and crashed /agent on `MODELS[0].id`. Keep env
// access out of this function; use listConfiguredModels() on the server.
export function listModels(scope?: ModelScope): ModelMeta[] {
  return scope ? MODEL_LIST.filter((m) => m.scopes.includes(scope)) : MODEL_LIST
}

/**
 * SERVER-ONLY: models whose provider key is actually configured. Use this for
 * autonomous selection (which must never pick a model that can't run) and for
 * telling clients what's available. Never call from a client component.
 */
export function listConfiguredModels(scope?: ModelScope): ModelMeta[] {
  return listModels(scope).filter((m) => isModelConfigured(m.id))
}

/** Returns the default id for a given scope — first configured entry. */
export function defaultModelForScope(scope: ModelScope): string {
  return listModels(scope)[0]?.id ?? DEFAULT_MODEL_ID
}

// ─── Server-only: client + chat model factories ────────────────────
// Use these from API routes. Tree-shake friendly — pickers that only import
// `MODEL_LIST` and `getModelMeta` won't pull createOpenAI into the client bundle.
const hfRouterKey = () => process.env.HUGGINGFACE_API_KEY ?? process.env.HF_TOKEN ?? ''

export function isModelConfigured(id: string): boolean {
  if (isCommunityModelId(id)) return Boolean(hfRouterKey())
  return Boolean(PROVIDERS[id]?.getApiKey())
}

export function nimClientFor(model?: string) {
  const id = model ?? DEFAULT_MODEL_ID
  if (isCommunityModelId(id)) {
    const apiKey = hfRouterKey()
    if (!apiKey) throw new Error('No Hugging Face API key configured (HUGGINGFACE_API_KEY)')
    return createOpenAI({ baseURL: HF_ROUTER_BASE, apiKey })
  }
  const provider = PROVIDERS[id] ?? PROVIDERS[DEFAULT_MODEL_ID]
  const apiKey = provider.getApiKey()
  if (!apiKey) throw new Error(`No API key configured for model ${id}`)
  const baseURL = typeof provider.baseURL === 'function' ? provider.baseURL() : provider.baseURL
  return createOpenAI({ baseURL, apiKey, ...(provider.fetch ? { fetch: provider.fetch } : {}) })
}

/**
 * One-call helper for `streamText({ model: getChatModel(requested), ... })`.
 * Returns a LanguageModel ready for AI SDK calls. Validates the id is
 * registered (or a community id) but does not enforce scope — caller's job.
 */
export function getChatModel(modelId?: string) {
  const id = modelId ?? DEFAULT_MODEL_ID
  if (isCommunityModelId(id)) {
    return nimClientFor(id).chat(communityRouteParam(id))
  }
  if (!PROVIDERS[id]) {
    // Fall back to default — never let an unknown id take down the route.
    return nimClientFor(DEFAULT_MODEL_ID).chat(DEFAULT_MODEL_ID)
  }
  return nimClientFor(id).chat(id)
}

/**
 * Warm up a community model before streaming. HF Inference Providers load
 * less-popular models on demand; the router returns 503 for the first
 * ~15–45s while the provider spins the model up (confirmed against
 * featherless-ai). A tiny non-streaming completion with retries lets that
 * cold start happen here — where we can retry — instead of erroring the
 * user's stream. Best-effort: returns true once warm, false if it never
 * came up in the budget (the caller can still attempt the stream).
 */
export async function warmCommunityModel(
  id: string,
  opts: { attempts?: number; timeoutMs?: number; gapMs?: number } = {},
): Promise<boolean> {
  if (!isCommunityModelId(id)) return true
  const apiKey = hfRouterKey()
  if (!apiKey) return false
  // Defaults are bounded so a caller with a tight request budget (e.g. the
  // chat route's maxDuration) can't be pushed over it: worst case here is
  // ~3×12s + 2×6s ≈ 48s. A warm model returns on the first ~1s ping.
  const attempts = opts.attempts ?? 3
  const timeoutMs = opts.timeoutMs ?? 12_000
  const gapMs = opts.gapMs ?? 6_000
  const param = communityRouteParam(id)
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${HF_ROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: param, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.ok) return true
    } catch {
      // timeout / network — treat as still-cold and retry
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, gapMs))
  }
  return false
}

// ─── Backwards compatibility shim ─────────────────────────────────
// The legacy `DEFAULT_NIM_MODEL` export is still referenced in terminal/exec
// and a few other places. Keep the alias so older imports don't break.
export const DEFAULT_NIM_MODEL = DEFAULT_MODEL_ID

// ─── JSON utilities (unchanged from previous nim.ts) ──────────────
// Strips markdown code fences that models sometimes wrap JSON in, then parses.
export function parseJsonLoose<T>(text: string): T | null {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    // Fall back to the first balanced-looking {...} block.
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        return JSON.parse(match[0]) as T
      } catch {
        return null
      }
    }
    return null
  }
}
