-- TrailForge — AI grading + external trail discovery (TET / ACT / forums).
-- Apply via the Supabase SQL editor after 0006_groups.sql.
--
-- Adds:
--   * trails.source                   provenance: 'user' | 'tet' | 'act' | 'ai-forum' | 'ai-approx'
--   * trails.source_url               deep link back to original source (TET/ACT/forum thread)
--   * trails.verification_status      'verified' | 'ai-approximated' | 'unverified'
--   * trails.ai_grade                 cached numeric difficulty (1-10) returned by the AI grader
--   * trails.ai_grade_rationale       short textual rationale ("steep, rocky, several wades")
--   * trails.ai_grade_model           model id used (claude-sonnet-4-6, etc) for auditability
--   * trails.ai_graded_at             timestamptz of the most recent AI grade
--   * system_admins                   global app moderators (Clerk user_id, granted_at)
--   * ai_discovered_trails            review queue for AI-discovered routes pending moderator action
--   * forum_sources                   configurable list of forum / RSS URLs to scan

ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'verified',
  ADD COLUMN IF NOT EXISTS ai_grade smallint,
  ADD COLUMN IF NOT EXISTS ai_grade_rationale text,
  ADD COLUMN IF NOT EXISTS ai_grade_model text,
  ADD COLUMN IF NOT EXISTS ai_graded_at timestamptz;

-- Soft constraint via a CHECK so legacy rows with NULL or odd values still load.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trails_source_check'
  ) THEN
    ALTER TABLE trails
      ADD CONSTRAINT trails_source_check
      CHECK (source IN ('user', 'tet', 'act', 'ai-forum', 'ai-approx'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trails_verification_status_check'
  ) THEN
    ALTER TABLE trails
      ADD CONSTRAINT trails_verification_status_check
      CHECK (verification_status IN ('verified', 'ai-approximated', 'unverified'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trails_ai_grade_range'
  ) THEN
    ALTER TABLE trails
      ADD CONSTRAINT trails_ai_grade_range
      CHECK (ai_grade IS NULL OR (ai_grade BETWEEN 1 AND 10));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS trails_source_idx ON trails (source);
CREATE INDEX IF NOT EXISTS trails_verification_idx ON trails (verification_status);

-- ---------- Global app moderators ----------
CREATE TABLE IF NOT EXISTS system_admins (
  user_id    text PRIMARY KEY,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by text,
  note       text
);

ALTER TABLE system_admins ENABLE ROW LEVEL SECURITY;

-- Anon and signed-in clients cannot read or write system_admins from the
-- browser. Admin checks happen exclusively through the API server (service
-- role).
DROP POLICY IF EXISTS system_admins_no_anon ON system_admins;
CREATE POLICY system_admins_no_anon ON system_admins
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- ---------- AI-discovered trails review queue ----------
CREATE TABLE IF NOT EXISTS ai_discovered_trails (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'tet' | 'act' | 'ai-forum' | 'ai-approx'
  source          text NOT NULL,
  source_url      text NOT NULL,
  source_title    text,
  -- AI extraction snapshot (so a moderator can audit what the model said).
  extracted_name        text,
  extracted_location    text,
  extracted_summary     text,
  extracted_difficulty  smallint,
  extracted_surface     text,
  -- If the post linked to a downloadable GPX, the parsed file goes here.
  gpx_data        jsonb,
  bbox_min_lat    double precision,
  bbox_max_lat    double precision,
  bbox_min_lng    double precision,
  bbox_max_lng    double precision,
  -- 'pending' | 'approved' | 'rejected' | 'merged'
  status          text NOT NULL DEFAULT 'pending',
  -- When approved, the trail row that was created from this discovery.
  trail_id        uuid REFERENCES trails(id) ON DELETE SET NULL,
  reviewed_by     text,
  reviewed_at     timestamptz,
  review_note     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Convenience: keep the AI rationale separate from the trail's own grade rationale.
  ai_grade            smallint,
  ai_grade_rationale  text
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_discovered_status_check'
  ) THEN
    ALTER TABLE ai_discovered_trails
      ADD CONSTRAINT ai_discovered_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'merged'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_discovered_source_check'
  ) THEN
    ALTER TABLE ai_discovered_trails
      ADD CONSTRAINT ai_discovered_source_check
      CHECK (source IN ('tet', 'act', 'ai-forum', 'ai-approx'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_discovered_status_idx ON ai_discovered_trails (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ai_discovered_source_url_idx
  ON ai_discovered_trails (source_url);

ALTER TABLE ai_discovered_trails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_discovered_no_anon ON ai_discovered_trails;
CREATE POLICY ai_discovered_no_anon ON ai_discovered_trails
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- ---------- Configurable forum source list ----------
CREATE TABLE IF NOT EXISTS forum_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label       text NOT NULL,
  url         text NOT NULL,
  -- 'rss' | 'html' — controls how the scanner reads the page.
  kind        text NOT NULL DEFAULT 'rss',
  -- Pause without deleting; sweepers skip when disabled = true.
  disabled    boolean NOT NULL DEFAULT false,
  last_scanned_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE forum_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS forum_sources_no_anon ON forum_sources;
CREATE POLICY forum_sources_no_anon ON forum_sources
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
