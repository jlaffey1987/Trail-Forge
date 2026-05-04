-- TrailForge — Trail adoption and amendment reason categories.
-- Apply via the Supabase SQL editor after 0023_route_trails.sql.
--
-- Adds:
--  * trails.adopted_at            timestamp when a member adopted an unowned trail
--  * trail_adoptions              audit log for trail adoptions
--  * trail_amendments.reason_category  categorised reason for the amendment

-- ---------- trails.adopted_at ----------
ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS adopted_at timestamptz;

-- ---------- trail_adoptions (audit log) ----------
CREATE TABLE IF NOT EXISTS trail_adoptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id uuid NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  adopted_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  adopted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trail_adoptions_trail_idx
  ON trail_adoptions (trail_id, adopted_at DESC);

-- ---------- trail_amendments.reason_category ----------
ALTER TABLE trail_amendments
  ADD COLUMN IF NOT EXISTS reason_category text
    CHECK (reason_category IS NULL OR reason_category IN (
      'route_change',
      'difficulty_change',
      'request_removal',
      'other'
    ));

-- ---------- RLS ----------
ALTER TABLE trail_adoptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trail_adoptions_public_read ON trail_adoptions;

CREATE POLICY trail_adoptions_public_read ON trail_adoptions
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM trails t
      WHERE t.id = trail_adoptions.trail_id AND t.is_public = true
    )
  );
