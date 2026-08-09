-- Per-agent standing instructions, prepended to every task that agent runs.
--
-- APPLY: Review, then run against your Supabase instance. Do NOT auto-apply.
--
-- ─── What this is for ─────────────────────────────────────────────────
-- Until now the only thing reaching a builder's CLI was the task description:
--
--   const prompt = task.description.trim() || task.title
--
-- So every agent behaved identically given the same task, and "hire a worker
-- with instructions" had nowhere to put the instructions. This column is that
-- place, and src/lib/missions/adapter.ts reads it on every run — a stored
-- string nothing reads would be worse than not having the feature, because it
-- would look like configuration while changing nothing.
--
-- ─── Why text and not jsonb ───────────────────────────────────────────
-- It is a system prompt. It goes to the CLI as prose, is written by a human in
-- a textarea, and has no fields to query on. jsonb would buy nothing and cost
-- everyone a ->> on every read.
--
-- Nullable with no default: null means "no standing instructions", which is
-- the correct existing state for every agent already in the roster, and is
-- distinct from an empty string someone deliberately cleared.

alter table agents
  add column if not exists instructions text;

comment on column agents.instructions is
  'Standing instructions prepended to every task prompt for this agent. Null = none. Applied by src/lib/missions/adapter.ts.';

-- A blank string is indistinguishable from null in every way that matters here
-- and would make the adapter emit an empty instructions block. Normalise on
-- write so the adapter does not have to defend against it.
alter table agents
  drop constraint if exists agents_instructions_not_blank;

alter table agents
  add constraint agents_instructions_not_blank
  check (instructions is null or length(btrim(instructions)) > 0);
