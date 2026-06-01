-- TrailForge — widen trails.source to accept any non-empty string.
--
-- The original constraint in 0007_ai_discovery.sql hard-coded a short enum:
--   CHECK (source IN ('user', 'tet', 'act', 'ai-forum', 'ai-approx'))
-- The TET importer uses 'TET-UK', the ACT importer may use similar labels,
-- and future partners will need their own identifiers.  A rigid enum here
-- causes import failures every time a new source is added.
--
-- Resolution: drop the enum constraint and replace it with a simple NOT NULL
-- check so the column still rejects nulls but accepts any meaningful string.
-- The ai_discovered_trails table has its own separate source_check which is
-- left untouched (it has a different, smaller domain that is still valid).

-- ── trails.source ───────────────────────────────────────────────────────────

ALTER TABLE trails
  DROP CONSTRAINT IF EXISTS trails_source_check;

-- Ensure the column still rejects NULL (defensive — column was already NOT
-- NULL in the original DDL, but make it explicit in case of drift).
ALTER TABLE trails
  ALTER COLUMN source SET NOT NULL;

-- Optional: add a lightweight sanity check so truly empty strings are also
-- rejected (avoids accidental blank-source inserts from future scripts).
ALTER TABLE trails
  ADD CONSTRAINT trails_source_nonempty CHECK (source <> '');
