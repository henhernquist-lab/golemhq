// AI SDK tool wrappers for the Composio-backed Connectors (Gmail + Composio
// Search, v1). Each tool is a hand-rolled Vercel AI SDK `tool()` block — at
// v1 we only expose a deliberate read-only allowlist of actions:
//
//   Gmail:      GMAIL_FETCH_EMAILS, GMAIL_GET_MESSAGE, GMAIL_SEARCH_EMAILS
//   Search:     COMPOSIO_SEARCH_DUCKDUCKGO_SEARCH,
//               COMPOSIO_SEARCH_FETCH_URL_CONTENT,
//               COMPOSIO_SEARCH_FINANCE,
//               COMPOSIO_SEARCH_FLIGHTS,
//               COMPOSIO_SEARCH_AMAZON
//
// Why hand-rolled Zod schemas: see the Composio Gmail wrapper comment for the
// full rationale (latency, stability, hand-tuned descriptions). Same
// reasoning applies here — every composio_search action uses the same
// executeTool path, and we choose which actions to expose based on what's
// genuinely useful vs. what would just add latency/noise to the tool list.

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { supabase } from '@/lib/supabase'
import { executeTool, type ComposioToolkit, type ComposioConnectable } from '@/lib/composio'
import type { FocusMode } from '@/lib/focus-mode'
import { clipToSerializedBudget } from '@/lib/tool-budget'

// Defaults for bounding a Composio tool result. Sized so a 10-message Gmail
// fetch lands near ~1.5k tokens rather than being unbounded: enough for the
// model to summarise an inbox and pick a message to open, without a single
// long thread crowding out the rest of the turn.
const DEFAULT_TOOL_STRING_CHARS = 600
const DEFAULT_TOOL_TOTAL_CHARS = 6000

type ConnectionStatus = 'disconnected' | 'pending' | 'connected' | 'error'

interface ComposioRow {
  toolkit: ComposioToolkit
  status: ConnectionStatus
  composio_connected_account_id: string | null
}

// Reads composio_connections for this user. Returns the connected_account_id
// per toolkit where the status is 'connected'. Called once per chat turn
// (cached for the turn's lifetime by the caller via the closure).
async function loadConnections(uid: string): Promise<Partial<Record<ComposioConnectable, string>>> {
  try {
    const { data } = await supabase
      .from('composio_connections')
      .select('toolkit, status, composio_connected_account_id')
      .eq('user_id', uid)
    const out: Partial<Record<ComposioConnectable, string>> = {}
    for (const row of (data ?? []) as ComposioRow[]) {
      if (row.status === 'connected' && row.composio_connected_account_id) {
        out[row.toolkit as ComposioConnectable] = row.composio_connected_account_id
      }
    }
    return out
  } catch (e) {
    console.error('[composio-tools] failed to load connections:', e)
    return {}
  }
}

const FOCUS_ALLOWS: Record<string, boolean> = {
  all: true,
  memory_only: true,
  web_only: true,
  repo_only: false,
}

// Wraps a single Composio slug as an AI SDK tool. Returns the tool if the user
// has an active connection for that toolkit, else returns null so the tool
// list remains honest (the model doesn't see a tool it can't actually call).
async function wrapTool(args: {
  slug: string
  toolkitName: 'Gmail' | 'Google Calendar' | 'Composio Search' | 'Firecrawl'
  description: string
  inputSchema: z.ZodTypeAny
  userId: string
  toolKey: string
  /** Per-string clip. Raise for tools whose value IS one long document. */
  maxStringChars?: number
  /** Ceiling across the whole result. */
  maxTotalChars?: number
}): Promise<ToolSet | null> {
  return {
    [args.toolKey]: tool({
      description: args.description,
      inputSchema: args.inputSchema,
      execute: async (raw: unknown) => {
        const body = (raw ?? {}) as Record<string, unknown>
        // Composio resolves the connected account internally from the
        // (userId, authConfigId) pair registered during connect; no need to
        // pass connected_account_id through to execute().
        const { data, error } = await executeTool(args.userId, args.slug, body)
        if (error) {
          // Always surface the failure to the model as a structured result,
          // never throw — throwing aborts the whole tool-calling step in the
          // AI SDK, and the model can't recover.
          return { success: false, error, toolkit: args.toolkitName, slug: args.slug }
        }
        // Bound before returning. This used to hand back `data` verbatim, which
        // for GMAIL_GET_MESSAGE is an entire email body and for a crawl is
        // whole pages — re-sent on every later step of the turn. Clipping is
        // per-string so the structure the model navigates (ids, subjects,
        // senders, urls) survives intact.
        const { value, clipped } = clipToSerializedBudget(
          data,
          args.maxStringChars ?? DEFAULT_TOOL_STRING_CHARS,
          args.maxTotalChars ?? DEFAULT_TOOL_TOTAL_CHARS,
        )
        return {
          success: true,
          toolkit: args.toolkitName,
          slug: args.slug,
          data: value,
          ...(clipped
            ? { note: 'Long fields were shortened to fit the context budget. Fetch a specific item by id if you need its full text.' }
            : {}),
        }
      },
    }),
  }
}

// Builds the composio-aware subset of the chat tools map for one turn. Reads
// the user's connections on demand, only attaches tools for toolkits where the
// user is actually connected (no point handing the model a tool that would
// just fail-401 on execute). Returns {} for focus modes that disallow composio.
export async function buildComposioTools(
  uid: string | null,
  focusMode: FocusMode,
  /** Per-model total char budget for one tool result (see ModelMeta.toolResultMaxChars). */
  resultBudgetChars?: number,
): Promise<ToolSet> {
  if (!uid) return {}
  if (!FOCUS_ALLOWS[focusMode]) return {}

  // Same budget the Tavily path uses, applied to every Composio result.
  const maxTotalChars = resultBudgetChars ?? DEFAULT_TOOL_TOTAL_CHARS
  const listCaps = { maxTotalChars, maxStringChars: Math.min(DEFAULT_TOOL_STRING_CHARS, Math.floor(maxTotalChars / 4)) }
  // Tools whose result IS a single document (one email body, one scraped page)
  // rather than a list — the whole budget can go to that one string.
  const docCaps = { maxTotalChars, maxStringChars: maxTotalChars }

  const connections = await loadConnections(uid)
  const tools: ToolSet = {}
  // loadConnections returns composio_connected_account_id per toolkit, but the
  // SDK doesn't need that ID at execute time — it resolves the connected
  // account internally from the (userId, authConfigId) pair registered during
  // connect. Pass userId through to executeTool; the per-toolkit connection
  // is just a presence check ("is this user authorized for gmail at all?").
  const hasGmail = Boolean(connections.gmail)
  const hasFirecrawl = Boolean(connections.firecrawl)

  if (hasFirecrawl) {
    const firecrawlTools = await Promise.all([
      wrapTool({
        slug: 'FIRECRAWL_SCRAPE',
        toolkitName: 'Firecrawl',
        description: 'Scrape a single URL and return clean, structured content (markdown, HTML, or raw text). Use this to extract the full content of a specific page — docs, articles, product pages, any URL. Returns clean markdown by default. Prefer this over composio_fetch_url for serious scraping — Firecrawl handles JS-rendered pages, auth walls, and produces cleaner output.',
        inputSchema: z.object({
          url: z.string().url().describe('The URL to scrape.'),
          formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'screenshot'])).optional().describe('Output formats. Default ["markdown"].'),
        }),
        userId: uid,
        toolKey: 'firecrawl_scrape',
        ...docCaps,
      }),
      wrapTool({
        slug: 'FIRECRAWL_CRAWL_V2',
        toolkitName: 'Firecrawl',
        description: 'Crawl an entire website — follows links within the same domain and returns content from multiple pages. Use this when the user asks "show me everything on site X" or wants to index/understand a whole site. Returns structured crawl results with page content.',
        inputSchema: z.object({
          url: z.string().url().describe('The starting URL to crawl.'),
          max_pages: z.number().int().min(1).max(100).optional().describe('Max pages to crawl. Default 10. Keep low for quick scans.'),
        }),
        userId: uid,
        toolKey: 'firecrawl_crawl',
        ...listCaps,
      }),
      wrapTool({
        slug: 'FIRECRAWL_EXTRACT',
        toolkitName: 'Firecrawl',
        description: 'Extract structured data from a URL using an LLM prompt. Give it a URL and describe what data fields you want (e.g., "extract all product names, prices, and ratings"). Returns JSON matching your requested schema. Use this for targeted data extraction from any page.',
        inputSchema: z.object({
          url: z.string().url().describe('The URL to extract data from.'),
          prompt: z.string().describe('Describe what data to extract. E.g., "Extract all product names, prices, and ratings as a JSON array."'),
        }),
        userId: uid,
        toolKey: 'firecrawl_extract',
        ...docCaps,
      }),
      wrapTool({
        slug: 'FIRECRAWL_SEARCH',
        toolkitName: 'Firecrawl',
        description: 'Web search via Firecrawl. Similar to web_search but may return different/cleaner results for some queries. Use this as an alternative when Tavily or composio_web_search results are insufficient or when the user specifically wants Firecrawl search quality.',
        inputSchema: z.object({
          query: z.string().describe('The search query.'),
          max_results: z.number().int().min(1).max(20).optional().describe('Number of results. Default 5.'),
        }),
        userId: uid,
        toolKey: 'firecrawl_search',
        ...listCaps,
      }),
      wrapTool({
        slug: 'FIRECRAWL_MAP_MULTIPLE_URLS_BASED_ON_OPTIONS',
        toolkitName: 'Firecrawl',
        description: 'Map/discover all URLs on a website. Returns a list of all discoverable pages on the domain without downloading their content. Use this before a crawl to understand site structure, or when the user asks "what pages does this site have?"',
        inputSchema: z.object({
          url: z.string().url().describe('The URL to map. All discovered links within the same domain are returned.'),
        }),
        userId: uid,
        toolKey: 'firecrawl_map',
        ...listCaps,
      }),
    ])
    for (const t of firecrawlTools) if (t) Object.assign(tools, t)
  }

  // composio_search is a no-auth toolkit — its tools are always available
  // without any connection step. No OAuth, no API key needed.
  {
    const searchTools = await Promise.all([
      wrapTool({
        slug: 'COMPOSIO_SEARCH_DUCKDUCKGO_SEARCH',
        toolkitName: 'Composio Search',
        description: 'General web search via DuckDuckGo. Returns titles, URLs, and snippets for search results. Use this for broad research, fact-checking, or finding information online — distinct from Tavily web_search which is better for deep research. Prefer this for quick lookups, price checks, and transactional queries.',
        inputSchema: z.object({
          query: z.string().describe('The search query.'),
          max_results: z.number().int().min(1).max(20).optional().describe('Number of results. Default 5.'),
        }),
        userId: uid,
        toolKey: 'composio_web_search',
        ...listCaps,
      }),
      wrapTool({
        slug: 'COMPOSIO_SEARCH_FETCH_URL_CONTENT',
        toolkitName: 'Composio Search',
        description: 'Scrape and extract clean markdown content from a specific URL. Use this to read the full text of a page — unlike search snippets, this returns the actual page content. Good for checking prices, availability, or reading docs directly from a source page.',
        inputSchema: z.object({
          url: z.string().url().describe('The full URL to scrape.'),
        }),
        userId: uid,
        toolKey: 'composio_fetch_url',
        ...docCaps,
      }),
      wrapTool({
        slug: 'COMPOSIO_SEARCH_FINANCE',
        toolkitName: 'Composio Search',
        description: 'Get real-time financial data: stock prices, crypto prices, market indices, and company financials. Use this when the user asks about a stock price, crypto value, or market data — this returns live data, not stale training data.',
        inputSchema: z.object({
          query: z.string().describe('The ticker symbol or financial query (e.g. "AAPL", "BTC-USD", "S&P 500").'),
        }),
        userId: uid,
        toolKey: 'composio_finance',
        ...listCaps,
      }),
      wrapTool({
        slug: 'COMPOSIO_SEARCH_FLIGHTS',
        toolkitName: 'Composio Search',
        description: 'Search for flight schedules, routes, and pricing. Use this when the user asks about flight availability, prices between cities, or travel options. Returns real flight data, not estimates.',
        inputSchema: z.object({
          origin: z.string().describe('Origin airport code or city (e.g. "ATL", "New York").'),
          destination: z.string().describe('Destination airport code or city (e.g. "LAX", "London").'),
          date: z.string().optional().describe('Departure date in YYYY-MM-DD format. If omitted, searches soonest.'),
        }),
        userId: uid,
        toolKey: 'composio_flights',
        ...listCaps,
      }),
      wrapTool({
        slug: 'COMPOSIO_SEARCH_AMAZON',
        toolkitName: 'Composio Search',
        description: 'Search Amazon product listings worldwide. Returns product names, prices, ratings, and availability. Use this when the user asks about a product, wants to check prices, or is comparison shopping.',
        inputSchema: z.object({
          query: z.string().describe('The product to search for (e.g. "mechanical keyboard", "Sony WH-1000XM5").'),
          max_results: z.number().int().min(1).max(10).optional().describe('Number of results. Default 5.'),
        }),
        userId: uid,
        toolKey: 'composio_amazon',
        ...listCaps,
      }),
    ])
    for (const t of searchTools) if (t) Object.assign(tools, t)
  }

  if (hasGmail) {
    const gmailTools = await Promise.all([
      wrapTool({
        slug: 'GMAIL_FETCH_EMAILS',
        toolkitName: 'Gmail',
        description: 'Fetch a list of recent emails from Gmail. Returns subject, from, date, and a short preview of each message. Use this when the user asks about recent emails, inbox contents, or wants to know what came in.',
        inputSchema: z.object({
          max_results: z.number().int().min(1).max(50).optional().describe('How many recent messages to return. Default 10.'),
          query: z.string().optional().describe('Optional Gmail search query (e.g. "from:github.com", "subject:invoice", "is:unread"). If omitted, returns the most recent messages.'),
        }),
        userId: uid,
        toolKey: 'gmail_fetch_emails',
        ...listCaps,
      }),
      wrapTool({
        slug: 'GMAIL_GET_MESSAGE',
        toolkitName: 'Gmail',
        description: 'Fetch a single Gmail message by ID. Returns the full message body, headers, and metadata. Use after gmail_fetch_emails when the user asks to read or quote a specific email.',
        inputSchema: z.object({
          message_id: z.string().describe('The Gmail message ID (returned by gmail_fetch_emails).'),
        }),
        userId: uid,
        toolKey: 'gmail_get_message',
        ...docCaps,
      }),
      wrapTool({
        slug: 'GMAIL_SEARCH_EMAILS',
        toolkitName: 'Gmail',
        description: 'Search Gmail using a query string. Returns matching messages with subject, from, date. Use when the user asks for emails matching a specific sender, subject, or filter.',
        inputSchema: z.object({
          query: z.string().describe('Gmail search query, e.g. "from:stripe.com subject:payment".'),
          max_results: z.number().int().min(1).max(50).optional().describe('Max results. Default 10.'),
        }),
        userId: uid,
        toolKey: 'gmail_search_emails',
        ...listCaps,
      }),
    ])
    for (const t of gmailTools) if (t) Object.assign(tools, t)
  }

  return tools
}
