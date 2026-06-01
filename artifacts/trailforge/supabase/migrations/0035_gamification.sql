-- TrailForge — Rider Gamification: rank system, achievements, leaderboards.

-- ── users table extensions ───────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS trail_km_total      double precision DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trails_completed    integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trails_added        integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS forum_posts         integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS helpful_votes       integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rank_points         integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rank_title          text DEFAULT 'Greenlaner',
  ADD COLUMN IF NOT EXISTS rank_level          integer DEFAULT 1,
  ADD COLUMN IF NOT EXISTS bike_type           text,
  ADD COLUMN IF NOT EXISTS home_region         text;

-- ── achievements ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS achievements (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_key         text NOT NULL,
  achievement_name        text NOT NULL,
  achievement_description text,
  earned_at               timestamptz DEFAULT now(),
  badge_icon              text,
  badge_colour            text,
  UNIQUE (user_id, achievement_key)
);

CREATE INDEX IF NOT EXISTS achievements_user_idx ON achievements(user_id);

ALTER TABLE achievements ENABLE ROW LEVEL SECURITY;

-- Users can read their own achievements; public can read others' for profiles.
CREATE POLICY "user_read_own_achievements"
  ON achievements FOR SELECT USING (true);

CREATE POLICY "user_insert_own_achievements"
  ON achievements FOR INSERT WITH CHECK (
    auth.uid()::text = user_id
  );

-- ── leaderboard snapshots ────────────────────────────────────────────────────
-- Rebuilt weekly by the admin API endpoint /api/admin/rebuild-leaderboards.

CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leaderboard_type  text NOT NULL,  -- 'trail_miles' | 'trails_completed' | 'elevation' | 'most_helpful'
  user_id           text REFERENCES users(id) ON DELETE SET NULL,
  display_name      text,
  avatar_url        text,
  score             double precision,
  rank              integer,
  period            text NOT NULL,  -- 'weekly' | 'monthly' | 'all_time'
  created_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leaderboard_type_period_idx
  ON leaderboard_snapshots(leaderboard_type, period, rank);

ALTER TABLE leaderboard_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_leaderboard"
  ON leaderboard_snapshots FOR SELECT USING (true);
