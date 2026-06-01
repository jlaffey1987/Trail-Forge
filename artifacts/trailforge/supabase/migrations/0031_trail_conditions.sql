-- TrailForge — community trail condition reports with a 30-day TTL.
--
-- Apply via the Supabase SQL editor after 0030_trail_centroid.sql.
--
-- Riders submit one of four conditions for a trail section:
--   good       — rideable, surface is fine
--   wet_muddy  — passable but wet / slippery
--   overgrown  — vegetation encroaching, passage possible
--   closed     — impassable (fallen tree, flood, private land action, etc.)
--
-- Reports expire automatically after 30 days (expires_at column).
-- The API filters to `expires_at > now()` so stale reports never surface.

CREATE TABLE IF NOT EXISTS trail_conditions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id         uuid NOT NULL,
  reporter_user_id text REFERENCES users(id) ON DELETE SET NULL,
  condition        text NOT NULL
    CHECK (condition IN ('good', 'wet_muddy', 'overgrown', 'closed')),
  note             text CHECK (char_length(note) <= 500),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

-- Hot path: latest active report for a given trail.
CREATE INDEX IF NOT EXISTS trail_conditions_trail_active_idx
  ON trail_conditions (trail_id, created_at DESC)
  WHERE expires_at > now();

-- ── Row-level security ────────────────────────────────────────────────────────

ALTER TABLE trail_conditions ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read active condition reports
DROP POLICY IF EXISTS tc_authenticated_read ON trail_conditions;
CREATE POLICY tc_authenticated_read ON trail_conditions
  FOR SELECT
  TO authenticated
  USING (expires_at > now());

-- Authenticated users may insert their own reports
DROP POLICY IF EXISTS tc_authenticated_insert ON trail_conditions;
CREATE POLICY tc_authenticated_insert ON trail_conditions
  FOR INSERT
  TO authenticated
  WITH CHECK (reporter_user_id = auth.uid()::text);

-- Service role (used by the API server) bypasses RLS.
