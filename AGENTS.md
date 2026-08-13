<!-- BEGIN:nextjs-agent-rules -->
This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in node_modules/next/dist/docs/ before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->
AGENTS.md — Golem HQ (enry.agent)

Read fully before touching code. Imperative, not narrative.

Naming: the product is Golem HQ. The repo, package, and most internal identifiers are still enry.agent — that is expected, not a bug. Do not "fix" it. The mascot/assistant character is Golem. Older code and comments say "Enry"; leave them unless you are already editing that line.

0. Rules that override everything else
Commit, don't push. Push only when explicitly told to.
Never auto-apply migrations. Write the SQL, list the filename in your report, stop.
Never git stash, reset, clean, force-push, or rewrite history. Other agent sessions run against this same working tree. git stash has already silently destroyed another session's in-progress work here.
Never read, print, or echo secrets. Not to stdout, not to a log, not "just the first 8 chars." Report key length or presence only.
Verify against origin, not your local cache. git fetch before concluding a file or feature "doesn't exist." A session once reported an entire feature missing because it had read a stale local ref.
Report bugs before fixing them when the fix is non-trivial or changes behavior Henry hasn't seen.
Don't claim a thing works because the code looks right. See §7 (Definition of Done).
1. Stack
Runtime: Next.js 16.2.6 (App Router, Turbopack), React 19, TypeScript, pnpm (pnpm, never npm)
Styling: Tailwind v4 (CSS-first, no tailwind.config.js), tw-animate-css, framer-motion, lucide-react
3D: React Three Fiber / three.js (Golem mascot, The Room / Atelier)
AI: Vercel AI SDK (v6 message shape — parts, not {role, content}), multi-provider (NVIDIA NIM, Google, Groq, GitHub Models)
Backend: Supabase + pgvector, NextAuth v5 (JWT, 30-day maxAge)
Terminal: xterm.js client ⇄ SSE (output) + POST (input). No browser WebSocket — deliberate, see §5.
Deploy: Vercel (next dev -p 8082); long-running/native work executes on a Fly Sprite
2. Source of truth — do not duplicate these in this file

Volatile lists go stale and stale docs are worse than no docs. Read the code:

Thing	Canonical location
Model lineup, providers, supportsTools, supportsReasoning	model registry in src/lib/ (read it; do not trust any list you remember)
Provider clients / API keys mapping	src/lib/nim.ts (MODEL_KEYS) and sibling provider modules
Agent roster (Layer 1/2/3, CLI commands, enabled state)	agents table + roster UI at /missions
Skills	src/lib/skills/ registry
Routes	src/app/
Repo coding rules injected into agent prompts	.enryrules (loaded by loadEnryRules() in src/lib/terminal/write-ops.ts)

Adding a model: add a registry entry + key mapping; callers use client.chat(model), never the bare client. Then assign a system-prompt tier (§4).

3. Execution environments — know which one you're in

Three environments. Most "impossible" bugs here are one environment being mistaken for another.

Env	What it is	Can it run native/long-lived work?
Codespace / dev	Where you almost always are. Full filesystem, CLIs, Blender installed.	Yes
Vercel (prod)	Serverless functions. Read-only FS, no persistent process, no in-process state, no WebSocket upgrade, bundle size caps.	No
Sprite (Fly, enry-terminal)	Persistent box reached via exec stream. Blender lives here for prod.	Yes
backend() branches on process.env.VERCEL. Never write VERCEL=1 into .env.local — it silently reroutes every builder/terminal run to the Sprite and looks like the app spontaneously broke.
Anything spawning a process (execFile, python venv, Blender) must branch on backend().kind and route to the Sprite in prod. Sprites has no file transfer API — artifacts come back base64 over the exec stream, capped at 24MB.
Nothing may hold state in a module-level Map/variable across requests. Vercel routes each request to an arbitrary lambda. This is the confirmed root cause of the "can't type in the terminal" bug — session state must live in a durable store (session-store.ts → Supabase).
Module-level variables in client components are equally dangerous: /split mounts two CenterPanel instances, and module-scoped transport/compaction state was shared across both. Scope per instance; namespace any localStorage key by paneId.
/tmp in the Codespace is a fresh disk on every resume, and postCreateCommand does not re-run. Anything installed to /tmp needs a postStartCommand hook and a runtime probe that degrades gracefully.
Watch disk. A full disk has silently truncated .env.local to zero bytes twice. Check free space before large installs.
4. Conventions
Auth
session.user.id = profiles.google_id (provider account ID, not the auth.users UUID). Seven+ route files depend on this. Do not change it.
src/lib/auth.ts: Google, GitHub, Credentials. GitHub OAuth requests repo workflow scope (Cruise dispatch needs it).
Known inconsistency, leave it: profiles (migration 005) is standalone and does not FK auth.users; newer lab tables do. Two identity systems coexist. Match the surrounding migration's pattern when adding tables; do not retroactively "fix" the old ones.
Owner-gated routes use requireHenryOwner() / OWNER_EMAIL. Terminal and hire/edit-worker routes are owner-gated by design — if a route 403s identically everywhere, check OWNER_EMAIL is set before debugging anything else. E2E_EMAIL ≠ OWNER_EMAIL; E2E sessions will legitimately fail owner gates.
Messages
AI SDK v6 shape (parts) throughout. Legacy {role, content} bodies must be normalized via src/lib/messages.ts before convertToModelMessages(), or the route throws and Next.js serves an HTML 500.
Every client-side response read must check Content-Type before .json()/.text(). Rendering an arbitrary HTML body as text is how the "raw HTML in the UI" bug presented. Use the fetch-json.ts helper.
API routes must return clean JSON errors for pre-stream failures (auth, session lookup, message conversion, compaction). An uncaught throw = platform HTML 500 = unreadable.
System prompt tiers

Three tiers, assigned per model: full (default), sonnet (medium), haiku (lean). Tiers exist for token budget, not style.

Do not raise maxOutputTokens above the point where the per-turn ceiling drops below the 16,000-char compaction threshold. That ordering is the safety property that lets compaction rescue a long conversation before a 413. Longer replies are not worth breaking it.
Tool-turn budgets (maxOutputTokensWithTools, toolResultMaxChars, search-result budget) are tuned per model against real TPM headroom. Changing one means re-measuring a real two-step tool round trip, not eyeballing it.
Gate reasoning params: reasoningDepth !== 'off' && modelSupportsReasoning(model). Sending enable_thinking to a model that doesn't support it is a live bug in the terminal exec path.
Session state
casUpdateSessionPayload() in src/lib/terminal/write-ops.ts — optimistic-concurrency read-modify-write on resources.payload. Always use it. Never raw supabase.from('resources').upsert(). Requires migration 018 (resources.version).
Migrations
Two naming patterns coexist: sequential (001_–018_) and timestamped (20260808040000_). Match neighbors.
Add only. Never modify an applied migration. Never run one yourself.
Code that reads a new column must tolerate the column being absent, so nothing breaks between merge and apply.
Env files
Never hand-roll an env parser. /^([A-Z0-9_]+)=(.*)$/ greedily swallows trailing aligned comments. That single line made a valid SPRITES_TOKEN return 401 for weeks across many sessions, while the real app (using @next/env) was fine the whole time. Use the shared loader. playwright.config.ts is CJS and can't import it — it has its own hardened copy; keep them in sync.
Never assign a secret via command substitution (KEY=$(some-cli ...)). It has written CLI log text in as the value of five keys at once.
Vercel env vars marked Sensitive are write-only forever — unreadable via dashboard, CLI, or API. There is no clever pull path. If a value is needed locally, ask Henry to paste it.
Validate env values, not just key presence. A bare grep KEY= passes on garbage.
UI
Themes: Midnight, Light, OG — anything visual must work in all three. Grimoire × Clay aesthetic; surface-base / surface-secondary / surface-elevated tokens; Inter + IBM Plex Mono; labels and model names in font-mono. Animation via framer-motion.
Theme tokens are color-mix() expressions. getPropertyValue() returns them unresolved, and THREE.Color cannot parse that — resolve through a probe element's computed color when feeding CSS vars into WebGL.
Golem mascot: motion (drift/bounce/anchor) is a DOM transform; bob/squash/facing hand off to the mesh via a ref applied in useFrame. Zero React re-renders per frame. Model tint reuses golemTintForModel — do not create a second color table.
Module organization

src/lib/ is one file per concern. Subtrees: cruise/, lab/, skills/, terminal/, ghost/, assets/.

5. Terminal (highest-scar-tissue area — read before touching)
Transport is SSE for output + POST for input, both nodejs runtime. There is deliberately no browser WebSocket (a browser WS can't set an Authorization header; the alternative leaks the token in a query string). Do not "fix" this by adding one — Vercel cannot hold a WS upgrade anyway.
Session state is durable (session-store.ts), not in-process. Keep it that way.
PTY geometry: the remote PTY is created at cols:80, rows:24 before xterm exists. Correct sizing depends on the post-fit resize actually landing — it is pushed from the WS-open handler, re-asserted on SSE open and first output, retried on backoff, and surfaces a banner if it never lands. If terminal output looks like it's wrapping in a third of a wide pane, the shell is the wrong size, not the renderer.
resizeSession must return false when it sends nothing. Silent true was the original defect.
Backlog is trimmed from the front. For full-screen TUIs (Gemini CLI, Claude Code, OpenCode) that discards the screen-setup sequence first, so replaying later frames to a fresh xterm paints garbage on a screen that was never established → black terminal that still accepts keystrokes. The stream announces truncation; the client resets and requests a repaint. pty-manager early-returns on unchanged geometry, so a repaint must nudge cols by one and back to force a real SIGWINCH.
The nudge must be HELD. Delivering both SIGWINCHes before the app handles either one means it reads the size it already had and does nothing. Measured against real OpenCode 1.18 in a real PTY: 50/60/70/80/90ms holds produced zero bytes, 100ms+ produced a full ~7KB repaint every time. The hold is 250ms in both managers. This is why the truncation repair above appeared to work for two years and never actually repaired an OpenCode session.
forceRepaint reports whether output actually followed, not whether the signal was sent. A repaint that provoked nothing must not clear the "screen may be stale" banner.
Any failure the user can see must say what it is and offer an action (Redraw / Restart), not fail silently and not repeat advice that already didn't work.
6. Orchestration (missions / agents)

Three layers: L1 orchestrators (plan/schedule/coordinate, never write code) → L2 builders (each bound to a specific CLI) → L3 validators.

Builder CLIs are driven with their own auto-approve flags (e.g. --permission-mode acceptEdits, --approval-mode auto_edit, run --auto). Flags are per-CLI and recorded in the roster — read it, don't guess.
MCP is Claude-only across the roster. Gemini/OpenCode/Hermes mutate host-level config rather than per-run, so the scheduler must not route MCP through them. MCP tool calls also need --allowedTools separately from edit-approval flags.
Per-agent instructions are prepended to the prompt (no CLI shares a --system flag).
Spend caps live in the Planner (PLANNER_{MISSION,DAILY}_TOKEN_CAP / _COST_CAP_USD). Malformed values throw rather than defaulting to unlimited — keep that behavior. Ledger is mission_events, not usage_log.
Audit trail rule: only link an external artifact (commit, PR) after the provider's API confirms the object exists. An unpushed commit gets no link plus a stated reason. Never render a confident link that would 404.
Known open security gap (deferred, don't widen it): mcp/servers.json grants builders a server-wide GitHub surface, and the token can read repos beyond the assigned one.
7. Definition of Done

A task is not done because it compiles. Before reporting:

 pnpm tsc --noEmit on the changed area's scoped config — a full-project tsc gets OOM/SIGTERM-killed in this container (~570s) and always has. That is not your bug. Vercel runs a full typecheck on every deploy, so the project-wide guarantee already exists.
 eslint clean on your files. The CI quality job fails on 3 pre-existing errors (center-panel.tsx:333 and :335, composio-tools.ts:135) plus ~166 warnings. It is lint-only and cannot gate deploys. Don't chase it, don't claim you caused it.
 git diff --check clean.
 git diff origin/<branch> empty if you claim it's pushed. Grep the remote ref for a marker of your change rather than trusting a local read.
 State plainly what you did not verify and what it would take. "Untested in a real browser" is an acceptable report; implying otherwise is not.
 Prove behavior with a paired assertion where possible — e.g. a tool-call event and an independently computed correct answer; a generated file and a check of its contents. "File exists" passes on silence.
 Run a control when claiming a feature changed model behavior (same task with and without it).
 List any migration that now needs applying.
8. Hard boundaries — no edits without explicit approval
src/lib/auth.ts — changing JWT callbacks, providers, or session.user.id semantics breaks sign-in everywhere.
supabase/migrations/*.sql — applied files are frozen.
The CONTENT_SENTINEL (===FILE===) contract in src/lib/terminal/write-ops.ts — it splits plan from file content; altering the format corrupts every code edit.
.env* — never read or print. Merge values blind (freebuff-env set).
The compaction-threshold / output-ceiling ordering described in §4.
9. Scrapped — do not resurrect

Re-adding any of these is a regression, not an improvement:

Voice mode (Kokoro/Whisper venv, /api/voice, Type/Voice toggles, mic buttons, agent_voice column, FISHPRO_API_KEY) — scrapped 8/10.
Web Speech API in any form (webkitSpeechRecognition, speechSynthesis) — deliberately removed app-wide; it shipped mic audio to Google.
OpenRouter models — free-tier credit kept collapsing.
Monid tool wiring, Enry Learn, skill "always use this?" opt-in prompts (skills auto-fire; multiple may fire at once).
10. Where things live
Path	Owns
src/app/page.tsx	Homepage chat (center-panel)
src/app/split/	Dual-pane view — two CenterPanel instances
src/app/agent/, src/app/forge/	Drive / Forge — coding agent, skills, NL edit, terminal workspace
src/app/scribe/	Scribe (formerly Architect)
src/app/lab/, /atelier	Lab — skill forge, evolutionary code, overnight R&D, artifact lab
src/app/missions/	Orchestration dashboard — missions, tasks, agent roster, hire/edit
src/app/grimoire/	Notes / notebook
src/app/room/	The Room — 3D HQ (R3F)
src/app/m/	Shard — mobile shell, chat, inbox, status, tools
src/app/api/	chat, terminal, cruise, lab, composio, memory, models, errors
src/components/terminal/	drive-terminal-workspace.tsx (tabs/splits/tree), terminal-pane.tsx (the only xterm instantiation)
src/components/	Shared UI — center-panel, left-sidebar, split-pane, golem-*
overnight-runner/	Self-contained runner dispatched to scratch repos
11. Recurring failure patterns worth internalizing
A repeatedly-reconfirmed "X is broken" verdict is suspect if only ad-hoc tooling ever produced it. Both the SPRITES_TOKEN 401 (weeks) and the GITHUB_PAT garbage values were measurement bugs, not the thing being measured. Check the instrument.
Serverless statelessness explains more bugs here than any other single cause. If something works locally and behaves randomly in prod, suspect per-instance state first.
Silent catch blocks (try { ... } catch {}) around layout/geometry/IO have hidden at least three real defects. Fail loudly or retry.
Work is lost when it isn't committed. Multiple sessions have lost hours to a deleted worktree or another session's stash. Commit early, locally, often.