-- Batch 11 — the plan approval gate.
--
-- A drafted plan needs a status that is NOT 'running'. Before this, the Planner
-- finished by moving the mission to 'running' and the only thing standing
-- between that and real builder CLIs was a button nobody had pressed yet — the
-- row said "running" while nothing ran, and any second caller reading status
-- would have believed it.
--
-- 'awaiting_approval' is NOT reusable here. Batch 7/10 owns that value: it means
-- "the builders finished and their task branches are waiting to be merged", and
-- the approval gate lists those branches. A drafted plan has no branches, no
-- commits and no worktrees, so pointing the same status at both states would
-- make the merge gate offer to land work that was never built.
--
-- Both the CHECK and the partial unique index have to move together. The index
-- is what enforces one active mission per repo; leaving the new status out of it
-- would let two drafted missions hold the same repo at once, which is the exact
-- guardrail the spine migration wrote the index to provide.
--
-- NOT APPLIED BY THE AGENT THAT WROTE IT. Until Henry applies this, writing
-- 'awaiting_plan_approval' fails the CHECK with SQLSTATE 23514; the code path in
-- src/lib/missions/plan-approval.ts catches exactly that and holds the mission
-- at 'planning' instead, which is also outside the dispatchable 'running' state
-- and also inside the active set — so the gate holds either way and the UI says
-- which of the two it is.

alter table public.missions
  drop constraint if exists missions_status_check;

alter table public.missions
  add constraint missions_status_check
  check (status in ('planning', 'running', 'awaiting_plan_approval',
                    'awaiting_approval', 'completed', 'failed', 'cancelled'));

-- Recreated rather than altered: a partial index's WHERE clause cannot be
-- changed in place.
drop index if exists uniq_missions_one_active_per_repo;

create unique index if not exists uniq_missions_one_active_per_repo
  on public.missions(repo)
  where status in ('planning', 'running', 'awaiting_plan_approval', 'awaiting_approval');
