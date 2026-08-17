-- Seed org-chart parent relationships for the seeded roster.
--
-- The agents table has had parent_id since mission_spine (20260806030000),
-- but nothing ever set it, so the org-chart connectors (Batch 8.5 UI) draw
-- nothing. This wires the seeded roster into a real 1 → 2 → 3 hierarchy by
-- name, idempotently — safe to re-run; only links that are missing get set.
--
-- Layer 2 builders report to a Layer 1 orchestrator; Layer 3 validators
-- report to the builder whose work they check.

update public.agents a
set parent_id = p.id
from (values
  -- Layer 2 → Layer 1
  ('Claude Code',  'Mission Planner'),
  ('Codex CLI',    'Mission Planner'),
  ('Gemini CLI',   'Scheduler'),
  ('OpenHands',    'Scheduler'),
  ('Crush CLI',    'Coordinator'),
  ('Freebuff',     'Coordinator'),
  -- Layer 3 → Layer 2
  ('Type Checker',      'Claude Code'),
  ('Linter',            'Claude Code'),
  ('AI Reviewer',       'Claude Code'),
  ('Test Runner',       'Codex CLI'),
  ('Security Scanner',  'Gemini CLI'),
  ('Performance Check', 'Crush CLI')
) as v(child_name, parent_name),
public.agents p
where a.name = v.child_name
  and p.name = v.parent_name
  and a.parent_id is distinct from p.id;
