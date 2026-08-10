-- The voice each agent speaks in.
--
-- APPLY: Review, then run against your Supabase instance. Do NOT auto-apply.
--
-- ─── Why nullable with no backfill ────────────────────────────────────
-- Null does not mean "silent" and it does not mean "the default voice". It
-- means nobody has chosen, and src/lib/voice/voices.ts then round-robins over
-- creation order so the roster is audibly varied from the first reply. Writing
-- those computed defaults into the table instead would freeze one rotation into
-- the data and make "Henry has never picked a voice for this agent" and "Henry
-- deliberately picked bm_george" indistinguishable.
--
-- The practical consequence is that this column is optional in a stronger sense
-- than most: every read tolerates it being absent, so distinct voices work on a
-- database where this migration has not run. Applying it is what makes a
-- CHOSEN voice persist.
--
-- ─── Why no enum and no foreign key ───────────────────────────────────
-- The catalog is a curated slice of what hexgrad/Kokoro-82M publishes, and it
-- moves when the model does. A Postgres enum would need a migration every time
-- a voice pack is added or dropped, and would reject a value the running app
-- considers valid. The allowlist lives in src/lib/voice/voices.ts and is
-- enforced on write in /api/missions/agents; the constraint here is only the
-- shape, which catches a junk value without pinning the vocabulary.

alter table agents
  add column if not exists voice_id text;

comment on column agents.voice_id is
  'Kokoro voice pack this agent speaks in (e.g. bm_george). Null = not chosen; src/lib/voice/voices.ts assigns a rotation default. Allowlist enforced in the API.';

alter table agents
  drop constraint if exists agents_voice_id_shape;

-- Kokoro voice ids are <lang><gender>_<name>, and the first letter is the
-- pipeline's lang_code — a value that does not match this shape cannot be
-- routed to a pipeline at all.
alter table agents
  add constraint agents_voice_id_shape
  check (voice_id is null or voice_id ~ '^[a-z]{2}_[a-z]+$');
