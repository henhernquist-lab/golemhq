-- Per-agent model assignment, set from the Agency tab's model selector.
--
-- APPLY: Review, then run against your Supabase instance. Do NOT auto-apply.
--
-- ─── What this is for ─────────────────────────────────────────────────
-- Henry picks which model a layer-2 builder is assigned to, from the real
-- registry (src/lib/nim.ts MODEL_LIST — same lineup the chat picker reads).
-- The value is a registry model id (e.g. `z-ai/glm-5.2`). Nullable with no
-- default: null = "not overridden — use the CLI's own default".
--
-- Persisted through the existing PATCH /api/missions/agents/[id] (same
-- endpoint pause/resume and hire/edit use) and read back by /api/agency.
--
-- ─── Why not wired into dispatch yet ──────────────────────────────────
-- src/lib/missions/adapter.ts invokes each builder's cli_command as-is. Every
-- CLI has its own model flag (and some, like Claude Code, name models the
-- registry does not), so a universal injection point does not exist. This
-- column is the stored selection that wiring will read; it lands now so the
-- picker + persistence exist without a second migration when dispatch wiring
-- arrives.

alter table agents
  add column if not exists model text;

comment on column agents.model is
  'Model id (src/lib/nim.ts MODEL_LIST) Henry assigned this agent. Null = CLI default.';
