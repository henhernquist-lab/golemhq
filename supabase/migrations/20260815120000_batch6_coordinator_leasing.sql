-- Golem HQ — Batch 6: Coordinator + file leasing.
--
-- The leases table itself already exists: Batch 1 (20260806030000_mission_spine)
-- created public.leases with task_id / path_glob / lease_type / owner_agent /
-- acquired_at / expires_at / released_at and left enforcement to this batch.
-- There is no `file_leases` table and this does not create one — building a
-- second table would orphan the indexes Batch 1 already added for exactly the
-- query the Coordinator runs.
--
-- What is genuinely missing is two things:
--
--   1. Somewhere for a task to declare which paths it expects to touch. The
--      Coordinator cannot reason about overlap it was never told about, and
--      inferring it from prose per-dispatch would be a model call on the hot
--      path. tasks.expected_paths is that declaration, written by the Planner.
--
--   2. A liveness signal on a lease. expires_at alone cannot distinguish "this
--      task is still working, it just took longer than the estimate" from
--      "this task died and its lease is stuck". A heartbeat separates them:
--      the reaper takes leases whose heartbeat has gone quiet, and a
--      long-running task that keeps beating holds its lease legitimately.
--
-- Both are additive and both are optional at runtime. Code that reads them
-- treats absence as "no declaration" and falls back to an exclusive whole-repo
-- lease, which is the Batch 4 sequential behaviour — so an unapplied migration
-- makes the system slower, never less safe.

-- ── task path declarations ────────────────────────────────────────────
-- Globs, not literal paths: a task that says "add a route" cannot know the
-- exact filename before it runs, but it can say `src/app/api/foo/**`.
-- NULL means "not declared" and is deliberately distinct from '{}' (declared
-- to touch nothing) — the first is treated conservatively, the second is not.
alter table public.tasks
  add column if not exists expected_paths text[];

comment on column public.tasks.expected_paths is
  'Path globs this task expects to write, for Coordinator overlap analysis. NULL = undeclared, treated as whole-repo exclusive.';

-- ── lease liveness ────────────────────────────────────────────────────
alter table public.leases
  add column if not exists heartbeat_at timestamptz;

comment on column public.leases.heartbeat_at is
  'Last proof-of-life from the lease holder. NULL falls back to acquired_at. A lease past expires_at with no newer heartbeat is reapable.';

-- Denormalised so the Coordinator can ask "what is held in this repo right
-- now" without joining through tasks → missions on every dispatch decision.
-- Nullable because existing rows predate it and the code backfills on write.
alter table public.leases
  add column if not exists mission_id uuid references public.missions(id) on delete cascade;

alter table public.leases
  add column if not exists repo text;

comment on column public.leases.repo is
  'Denormalised missions.repo. Leases only conflict within one checkout, so every conflict query filters on this.';

-- ── indexes ───────────────────────────────────────────────────────────
-- The Coordinator's one hot query: active leases for a repo.
create index if not exists idx_leases_repo_active
  on public.leases(repo)
  where released_at is null;

-- The reaper's one hot query: active leases whose clock has run out. Cannot
-- use now() in the predicate (not immutable), so the ordering does the work.
create index if not exists idx_leases_reapable
  on public.leases(expires_at, heartbeat_at)
  where released_at is null;
