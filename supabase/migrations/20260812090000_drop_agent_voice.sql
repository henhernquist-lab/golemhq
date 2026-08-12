-- Drop the per-agent voice column. Voice mode has been removed.
--
-- APPLY: Review, then run against your Supabase instance. Do NOT auto-apply.
--
-- ─── This one actually has to be run ──────────────────────────────────
-- Unlike a migration that only adds an unused column, this reverses one that
-- IS live: 20260810120000_agent_voice.sql was applied to the production
-- database, and at the time of writing one agent ("AI Reviewer") has a stored
-- voice of bf_emma. Leaving the column in place means a column no code reads,
-- holding a value that refers to a Kokoro voice pack no longer installed
-- anywhere — dead schema that outlives the feature and confuses the next
-- person to read the table.
--
-- ─── The data is not worth preserving ─────────────────────────────────
-- No backup table, no export. The column held one non-null value, and that
-- value is only meaningful to a TTS engine that has been deleted from the
-- repo and uninstalled from the host. Preserving it would be preserving a
-- pointer to something that no longer exists.
--
-- ─── Ordering ─────────────────────────────────────────────────────────
-- The check constraint is dropped first and explicitly. Postgres would drop it
-- along with the column anyway, but naming it here means this file still works
-- if the column was already removed by hand, and says out loud that both
-- objects from the original migration are being reversed.

alter table agents
  drop constraint if exists agents_voice_id_shape;

alter table agents
  drop column if exists voice_id;
