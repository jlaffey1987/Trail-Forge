-- TrailForge — Trail notes, photos and member-submitted amendments.
-- Apply via the Supabase SQL editor after 0003_rls_policies.sql.
--
-- Adds:
--  * trail_notes              short text comments by members (warning/info/condition)
--  * trail_photos             member-uploaded photos (object-storage backed)
--  * trail_amendments         member proposals to change a trail's metadata or route
--  * trail_amendment_history  audit row written when an amendment is approved
--  * users.is_moderator       designated moderator flag
--
-- Threat model: anon-key client may read non-hidden notes/photos and
-- non-rejected amendments for public trails. ALL writes flow through the
-- API server (service-role key, Clerk-authenticated). RLS enforces this.

-- ---------- users.is_moderator ----------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_moderator boolean NOT NULL DEFAULT false;

-- ---------- trail_notes ----------
CREATE TABLE IF NOT EXISTS trail_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id uuid NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  author_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  kind text NOT NULL DEFAULT 'info'
    CHECK (kind IN ('info', 'warning', 'condition')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  hidden_at timestamptz
);

CREATE INDEX IF NOT EXISTS trail_notes_trail_id_idx
  ON trail_notes (trail_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trail_notes_author_idx
  ON trail_notes (author_user_id);

-- ---------- trail_photos ----------
CREATE TABLE IF NOT EXISTS trail_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id uuid NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  author_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  width integer,
  height integer,
  caption text CHECK (caption IS NULL OR char_length(caption) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  hidden_at timestamptz
);

CREATE INDEX IF NOT EXISTS trail_photos_trail_id_idx
  ON trail_photos (trail_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trail_photos_author_idx
  ON trail_photos (author_user_id);

-- ---------- trail_amendments ----------
CREATE TABLE IF NOT EXISTS trail_amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id uuid NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  author_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposed_changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  replacement_gpx_storage_key text,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'archived')),
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trail_amendments_trail_id_idx
  ON trail_amendments (trail_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trail_amendments_status_idx
  ON trail_amendments (status, created_at DESC);
CREATE INDEX IF NOT EXISTS trail_amendments_author_idx
  ON trail_amendments (author_user_id);

-- ---------- trail_amendment_history ----------
-- Snapshot of the trail row's pre-approval values, written on every approval
-- (including self-approvals by the trail owner) so changes can be audited
-- and reverted.
CREATE TABLE IF NOT EXISTS trail_amendment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id uuid NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  amendment_id uuid NOT NULL REFERENCES trail_amendments(id) ON DELETE CASCADE,
  previous_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS trail_amendment_history_trail_idx
  ON trail_amendment_history (trail_id, applied_at DESC);

-- ---------- RLS ----------
ALTER TABLE trail_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE trail_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE trail_amendments ENABLE ROW LEVEL SECURITY;
ALTER TABLE trail_amendment_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trail_notes_public_read ON trail_notes;
DROP POLICY IF EXISTS trail_photos_public_read ON trail_photos;
DROP POLICY IF EXISTS trail_amendments_public_read ON trail_amendments;
DROP POLICY IF EXISTS trail_amendment_history_public_read ON trail_amendment_history;

-- Public read: notes / photos that are not hidden, attached to a public trail.
CREATE POLICY trail_notes_public_read ON trail_notes
  FOR SELECT
  TO anon, authenticated
  USING (
    hidden_at IS NULL
    AND EXISTS (
      SELECT 1 FROM trails t
      WHERE t.id = trail_notes.trail_id AND t.is_public = true
    )
  );

CREATE POLICY trail_photos_public_read ON trail_photos
  FOR SELECT
  TO anon, authenticated
  USING (
    hidden_at IS NULL
    AND EXISTS (
      SELECT 1 FROM trails t
      WHERE t.id = trail_photos.trail_id AND t.is_public = true
    )
  );

-- Amendments: pending amendments are visible to anyone (so the "X pending"
-- counter works for guests). Approved/rejected ones are also public for
-- transparency. The audit history is server-only.
CREATE POLICY trail_amendments_public_read ON trail_amendments
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM trails t
      WHERE t.id = trail_amendments.trail_id AND t.is_public = true
    )
  );

-- No anon read policy on trail_amendment_history — service role only.

-- No INSERT / UPDATE / DELETE policies for any of these tables. The API
-- server uses the service-role key (which bypasses RLS) for all writes
-- and authenticates the caller via Clerk before touching the DB.
