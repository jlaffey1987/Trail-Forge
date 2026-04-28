-- TrailForge — Member-contributed trails: description + soft-delete.
-- Apply via the Supabase SQL editor after 0004_trail_content.sql.
--
-- Adds:
--  * trails.description     freeform body text (member-authored notes)
--  * trails.deleted_at      timestamptz, NULL = live, set when owner removes
--                            the trail. We soft-delete to preserve any
--                            community trail_notes / trail_photos /
--                            trail_amendments hanging off the trail row.
--
-- Updates the public-read RLS policy on trails so anon clients (and the
-- planner search) only see live, public, non-deleted trails — the soft-
-- deleted ones stay reachable to the API server (service-role) only, so
-- moderators can still inspect them.

ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Object-storage path for the original GPX artifact uploaded by the member.
-- We still keep the parsed `gpx_data` jsonb for the bbox trigger and for
-- in-app rendering, but the source file is the canonical artifact and lives
-- in object storage. Format: "/objects/trails/source/<uuid>.gpx".
ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS gpx_object_path text;

CREATE INDEX IF NOT EXISTS trails_deleted_at_idx ON trails (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ---------- Updated public read policy ----------
DROP POLICY IF EXISTS trails_public_read ON trails;
CREATE POLICY trails_public_read ON trails
  FOR SELECT
  TO anon, authenticated
  USING (is_public = true AND deleted_at IS NULL);

-- ---------- Notes/photos/amendments public-read: also exclude soft-deleted parents.
DROP POLICY IF EXISTS trail_notes_public_read ON trail_notes;
CREATE POLICY trail_notes_public_read ON trail_notes
  FOR SELECT
  TO anon, authenticated
  USING (
    hidden_at IS NULL
    AND EXISTS (
      SELECT 1 FROM trails t
      WHERE t.id = trail_notes.trail_id
        AND t.is_public = true
        AND t.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS trail_photos_public_read ON trail_photos;
CREATE POLICY trail_photos_public_read ON trail_photos
  FOR SELECT
  TO anon, authenticated
  USING (
    hidden_at IS NULL
    AND EXISTS (
      SELECT 1 FROM trails t
      WHERE t.id = trail_photos.trail_id
        AND t.is_public = true
        AND t.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS trail_amendments_public_read ON trail_amendments;
CREATE POLICY trail_amendments_public_read ON trail_amendments
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM trails t
      WHERE t.id = trail_amendments.trail_id
        AND t.is_public = true
        AND t.deleted_at IS NULL
    )
  );
