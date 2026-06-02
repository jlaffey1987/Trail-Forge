-- Migration 0038: Trail star rating system
-- Riders rate trails they've ridden. Ratings are weighted by rider skill
-- relative to trail difficulty (see lib/ratings.ts on the API server).

CREATE TABLE IF NOT EXISTS trail_ratings (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id        uuid        NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  user_id         text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rider_difficulty integer    NOT NULL,                              -- rider's own grade estimate 1-10
  overall_stars   integer     NOT NULL CHECK (overall_stars BETWEEN 1 AND 5),
  scenery_stars   integer     CHECK (scenery_stars BETWEEN 1 AND 5),
  surface_stars   integer     CHECK (surface_stars BETWEEN 1 AND 5),
  accuracy_stars  integer     CHECK (accuracy_stars BETWEEN 1 AND 5),
  fun_stars       integer     CHECK (fun_stars BETWEEN 1 AND 5),
  review_text     text        CHECK (char_length(review_text) <= 500),
  ridden_at       timestamptz,
  season          text        CHECK (season IN ('spring','summer','autumn','winter')),
  created_at      timestamptz DEFAULT now(),
  UNIQUE (trail_id, user_id)
);

CREATE INDEX IF NOT EXISTS trail_ratings_trail_idx ON trail_ratings(trail_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trail_ratings_user_idx  ON trail_ratings(user_id,  created_at DESC);

-- Materialised summary columns on trails (updated by trigger / API)
ALTER TABLE trails
  ADD COLUMN IF NOT EXISTS avg_stars           double precision,
  ADD COLUMN IF NOT EXISTS avg_scenery_stars   double precision,
  ADD COLUMN IF NOT EXISTS avg_surface_stars   double precision,
  ADD COLUMN IF NOT EXISTS avg_accuracy_stars  double precision,
  ADD COLUMN IF NOT EXISTS avg_fun_stars       double precision,
  ADD COLUMN IF NOT EXISTS rating_count        integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quality_flagged     boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS quality_flag_reason text;

-- RLS
ALTER TABLE trail_ratings ENABLE ROW LEVEL SECURITY;

-- Anyone can read ratings
CREATE POLICY "trail_ratings_read" ON trail_ratings
  FOR SELECT USING (true);

-- Authenticated users can insert their own rating
CREATE POLICY "trail_ratings_insert" ON trail_ratings
  FOR INSERT WITH CHECK (auth.uid()::text = user_id);

-- Users can update only their own rating
CREATE POLICY "trail_ratings_update" ON trail_ratings
  FOR UPDATE USING (auth.uid()::text = user_id);

-- Users can delete only their own rating
CREATE POLICY "trail_ratings_delete" ON trail_ratings
  FOR DELETE USING (auth.uid()::text = user_id);
