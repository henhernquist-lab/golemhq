CLAUDE.md

This is NOT the Next.js you know. APIs, conventions, and file structure differ from training data. Read node_modules/next/dist/docs/ before writing code. Heed deprecation notices.

This is NOT the AI SDK you know. This repo is on AI SDK v6, not v3/v4. Message shape, convertToModelMessages, and stream helpers all changed. Verify against installed types in node_modules/ai/, not memory.

What this is

Golem HQ — Henry's personal AI superagent and multi-agent orchestration platform. The repo is named enry.agent for historical reasons; the product is Golem HQ and the mascot character is Golem. Production is https://golemhq.vercel.app.

One user (Henry). Optimize everything for him. Owner-gated routes go through requireHenryOwner() and compare against OWNER_EMAIL — these are load-bearing. Never weaken the gate to make a test pass. Note that E2E_EMAIL is not OWNER_EMAIL, so E2E tests will be rejected on owner-gated routes by design.

Stack
Layer	Package / version
Framework	Next.js 16.2.6, App Router, Turbopack
UI	React 19, TypeScript strict, Tailwind v4, Framer Motion
3D	React Three Fiber (@react-three/fiber) — Golem mascot, The Room
AI SDK	Vercel AI SDK v6 — ai, @ai-sdk/react
DB / auth	Supabase (Postgres + auth)
Remote exec	Sprites — sprite enry-terminal, auth via SPRITES_TOKEN
Terminal	xterm.js + PTY, SSE for output, POST for input
Package manager	pnpm
Deploy	Vercel
Models

Five providers. This is not a NIM-only app.

Provider	Model	Prompt tier
Z.ai	GLM 5.2 — default	full
NVIDIA NIM	DeepSeek V4 Pro	full
NVIDIA NIM	DeepSeek V4 Flash	sonnet
Google	Gemini 3.5 Flash — quality anchor	sonnet
Groq	Llama 3.3 70B	haiku
Groq	GPT-OSS 120B	haiku
GitHub Models	Claude 3.5 Sonnet	haiku

Zero OpenRouter models remain — free-tier credit kept collapsing. Do not reintroduce them.

The registry file is the source of truth for exact model ID strings, not this document. Read it before hardcoding any ID; none of these strings match training data. The same allowlist is duplicated in two places and both must be updated together when adding or removing a model. Validate every incoming model ID against the allowlist before passing it to a provider.

Each provider has its own API key environment variable. Never collapse them into one.

Capability flags that are currently non-obvious:

Llama 3.3 70B has supportsTools: false — Groq's function-call syntax breaks roughly 22 of the tools.
GPT-OSS 120B has supportsTools: true.
Only 3 models in the registry have supportsReasoning: true. Gate any reasoning parameter on modelSupportsReasoning(model) before sending it — reasoningExtraBody() ignores its model argument entirely and always returns { chat_template_kwargs: { enable_thinking: true } }, so an ungated call sends a dead parameter to models that do not support it.
System prompt tiers

Three tiers, named after Claude models purely as shorthand for terseness:

full — complete system prompt
sonnet — medium detail
haiku — lean, roughly 780 characters

Tier assignment is budget-driven, not stylistic. Groq models run against hard TPM and TPD limits, so a tier change on a Groq model can push a tool turn past the per-minute ceiling and return 413. Measure the real token cost of the first prompt under the new tier before changing one.

Current GPT-OSS 120B budget, as measured: 8,000 TPM total, first prompt 1,409 tokens on the haiku tier, maxOutputTokensWithTools 1024, toolResultMaxChars 2800, leaving roughly 5,182 tokens for a tool turn. Total usable conversation history is about 1,200 tokens because history is charged on both steps of a tool call.

Invariant — do not break this. A model's per-turn output ceiling must stay above the 16,000-character compaction threshold. maxOutputTokens on GPT-OSS 120B is deliberately held at 2048 for this reason: raising it drops the ceiling below the threshold and removes compaction's ability to rescue a long conversation before it 413s. Longer replies are not worth losing that.

Architecture map
/chat          main chat
/forge         unified chat + agent roster + agent chat
/scribe        Architect / prompt authoring
/cruise        terminal workspace (tabs, splits, file tree)
/missions      orchestration dashboard (missions, tasks, roster, audit trail)
/grimoire      notes
/lab           experiments
/atelier       3D asset generation
/m/chat        Shard (mobile chat)
/room          The Room, 3D HQ (React Three Fiber)
/split         dual-pane view
/trials        benchmarks
/usage         usage stats
Orchestration

Three-layer agent model:

Layer 1 Orchestrators — Planner, Scheduler, Coordinator. These never write code.
Layer 2 Builders — each bound to one specific CLI, not a swappable role. Enabled: Claude Code (--permission-mode acceptEdits), Gemini CLI (--skip-trust --approval-mode auto_edit), Hermes (--yolo --no-restore-cwd -z), OpenCode (run --auto). Disabled: Codex CLI, Freebuff, OpenHands, Crush CLI.
Layer 3 Validators — typecheck, lint, test, security, perf, review.

Data model: a mission is a row in missions, every step is a row in mission_events. A chat with an agent is also a mission row, filtered out of the normal dashboard view — there are no separate chat tables.

Per-agent instructions are prepended to the prompt, because none of these CLIs share a --system flag.

MCP is Claude Code only across the roster. Gemini CLI, OpenCode, and Hermes mutate host-level config rather than per-run config, so the Scheduler cannot safely route MCP through them. MCP tool calls also need --allowedTools passed separately from acceptEdits.

The Planner enforces a spend cap via PLANNER_MISSION_TOKEN_CAP, PLANNER_DAILY_TOKEN_CAP, PLANNER_MISSION_COST_CAP_USD, and PLANNER_DAILY_COST_CAP_USD. Malformed values throw rather than silently defaulting to unlimited. The ledger is mission_events with planner.usage events, not usage_log — usage_log has a CHECK constraint and swallows errors, which makes it unsuitable for a hard cap.

A finished wave does not mean landed work. Every dispatched task runs in its own worktree and commits to golem/task/<id> — the mission then sits at awaiting_approval, holding the repo, until the approval gate merges or rejects it. Only the merge sets completed. Note that .env.example is itself covered by the .gitignore .env* rule and is therefore untracked, so it is not where an environment contract survives: GOLEM_REPO_ROOT is what the approval gate merges into, and without it that route returns 503 rather than guessing at a checkout. Dispatch falls back to process.cwd(); the gate deliberately does not.

Backend selection

backend() branches on whether process.env.VERCEL is set. When set, work routes to the Sprite. When unset, it runs in-process on the Codespace.

Anything that needs a real filesystem, a long-lived process, or a native binary cannot run on Vercel and must go through the Sprite. Blender is the reference implementation: src/lib/assets/blender.ts branches on backend().kind, and because Sprites has no file-transfer API, rendered artifacts come back as base64 over the exec stream with a 24MB cap. Follow that pattern for anything similar.

Blender lives at /home/sprite/.local/opt/blender-5.2.0 on the Sprite and /home/codespace/.local/opt/blender-5.2.0 on the Codespace, with BLENDER_BIN exported in both.

Never write VERCEL=1 into .env.local. At least 8 call sites branch on it, including backend(), so setting it locally silently reroutes every builder and terminal run to the Sprite and looks like the entire execution path spontaneously broke.

Terminal
Transport is SSE for output and POST for input. There is deliberately no browser WebSocket: a browser WebSocket cannot set an Authorization header, and the alternative leaks the token in a query string.
Session state lives in a durable store (session-store.ts), not an in-process Map. Serverless requests land on arbitrary lambda instances, so anything held in module scope is effectively gone. This exact bug is what made typing appear to do nothing for weeks.
The remote PTY is created hardcoded at 80 columns by 24 rows before xterm exists. Geometry must be re-asserted from the WebSocket open handler, on SSE open, and on first output. pty-manager.ts early-returns on unchanged cols/rows, so identical geometry fires no SIGWINCH and the program never redraws.
Scrollback is trimmed from the front. For a full-screen TUI this discards the screen-setup sequence first, so a replayed backlog paints against a screen that was never established. Managers track head-trimming and expose forceRepaint, which nudges by one column and back to force a real SIGWINCH.
Landmines

Each of these has burned multiple sessions. Recognize the pattern instead of re-deriving it.

1. Doubt the measurement tool before the thing measured.

SPRITES_TOKEN was reported broken across many separate sessions for weeks. It was valid the entire time. Every ad-hoc diagnostic script wrote its own env parser, /^([A-Z0-9_]+)=(.*)$/, and (.*) greedily swallowed the aligned trailing comment — sending 196 characters as a 128-character token. Every failure report logged "token length: 196" and nobody questioned it. The running app was never affected, because the app uses @next/env, which parses correctly.

Never write an ad-hoc env parser. Use the shared loader. playwright.config.ts is the single exception, because Playwright requires CJS config — and it had this identical bug, found later.

A verdict of "this credential is broken," reconfirmed many times, is worth doubting if only ad-hoc tooling ever produced it.

2. Vercel environment variables marked Sensitive are permanently write-only.

They cannot be read via CLI, API, or dashboard. There is no pull path and no exception. GITHUB_PAT, TRIPO_API_KEY, E2E_EMAIL, E2E_PASSWORD, and SPRITES_TOKEN are all in this state. Values must be re-entered from their original source.

Always assign literally:

GITHUB_PAT=github_pat_11ABCDEF0123456789

Never assign by command substitution:

GITHUB_PAT=$(vercel env pull)

That form has written the literal string Loaded env from /workspaces/enry.agent/.env.local as the value of five keys at once. Because orchestratorToken() prefers GITHUB_PAT over GITHUB_TOKEN, that garbage actively overrode the one working credential. Validate values, not just key presence — a bare grep for the key name passes on a key holding a log line.

3. Multiple sessions run against this repo at the same time.

A git stash from another session has swept in-progress work out from under an active edit, reverting files mid-change. Check whether another session is working before any destructive git operation. Verify a claimed push against the remote, not local state: git diff origin/main must be empty.

4. A full disk corrupts things silently.

.env.local has been truncated to zero bytes twice by a full disk. Check free space before any large install. On the Codespace, /tmp is a genuinely different block device after every resume, and postCreateCommand fires only on container creation — never on resume. Use postStartCommand for anything that must survive a resume.

5. Whole-project tsc OOMs in this container.

Long-standing and unrelated to any change; it now gets SIGTERM'd around 570 seconds regardless of heap size. Use the repo's scoped tsc configs on changed files. Vercel runs a full typecheck on every deploy, so a green Vercel build is real proof the project typechecks.

6. The CI quality job fails on three pre-existing errors.

src/components/center-panel.tsx:333 (react-hooks/preserve-manual-memoization), src/components/center-panel.tsx:335 (refs accessed during render), and src/lib/composio-tools.ts:135 (no-explicit-any). It is a lint-only workflow and cannot gate deploys. Do not chase it as the cause of an unrelated bug and do not report it as your own regression.

7. Migrations are written by agents and applied by Henry.

Never assume a migration has run. Any code reading a new column must tolerate its absence and say so clearly in the UI rather than breaking.

Theming

Three themes: Midnight, Light, and OG. The design language is Grimoire × Clay.

Use design tokens. Never use raw Tailwind color classes.

The --golem-* theme tokens are color-mix() expressions, and getPropertyValue() returns them unresolved, which THREE.Color cannot parse. Resolve them through a probe element's computed color, since browsers always resolve that to rgb(), and re-read on data-theme mutation and on color-scheme change.

Model tint comes from golemTintForModel using existing model metadata. Do not build a second color table. The mix is 22 percent and should stay there. Unassigned and community providers deliberately share one fixed hue of 152 degrees rather than hashing into the known-provider wheel, because a false "that is specifically Claude" signal is worse than an honest "not a known house." A newly added registry company reads as unassigned until it is explicitly given a slot.

useGolemColors must observe .golem-figure, not <html>. --golem-model-tint is an inline style on .golem-figure, so observing <html> leaves the WebGL material stuck on the previous model's accent until an unrelated theme change forces a re-read.

Framer Motion handles all animation. Dropdowns open upward when near the bottom of the viewport and need a mousedown click-outside listener scoped to a ref. Use font-mono for labels, model names, and stat values.

Code standards

Before touching a file, read it and its neighbors, then match their conventions exactly.

TypeScript is strict. No any unless fighting a library type. Check package.json before assuming a package exists.

Write a comment only when the reason is non-obvious — a hidden constraint, a workaround, a subtle invariant. Never describe what the code does.

API routes:

Validate model IDs against the allowlist before passing them to a provider.
Always stream or return structured JSON errors. Never let a bare throw escape. An uncaught throw in a Server Component or route handler serves Next.js's raw HTML 500 page, which clients then render as visible text on the screen.
On the client, check Content-Type before parsing and never render an arbitrary HTML body.
Set export const maxDuration = 30 on streaming routes.

Errors persist to the error_log table via src/lib/error-log.ts and src/app/api/errors/route.ts. Read it when diagnosing and write to it rather than calling console.error into a log nobody can retrieve.

Verification standards

Henry's default assumption is that an agent is bluffing. Earn the opposite.

"It compiles" is not verification. Test the actual runtime behavior.
One suggestive run is not proof. Use a control. Per-agent instructions were proven by running the same agent on the same task twice — once without instructions and once with — and showing the requested marker appeared only in the second run.
Prove the thing itself, not a proxy. A file-exists check passes on silence. An audio round trip needs a real amplitude reading and a word-match count.
State explicitly what you did not verify. Partial verification reported as complete is the worst possible outcome.
Link external proof where it exists. Only label a commit verified after the GitHub API confirms it holds the object; an unpushed commit gets no link and a stated reason, never a confident link that 404s.
When a hypothesis is refuted, say so and say what refuted it. Refuted theories are useful information.

Shipping checklist:

Scoped tsc clean on changed files.
eslint clean on changed files. The three pre-existing errors listed above are not yours.
Dev server starts clean.
Test the real runtime behavior, not just the compile.
Commit after every change: git add -A && git commit -m "fix(terminal): re-assert geometry on SSE open".
Never push and never merge to main unless Henry asks.