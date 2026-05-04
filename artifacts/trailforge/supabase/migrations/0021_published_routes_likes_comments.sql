-- TrailForge — Publishable named routes + likes + comments.
-- Apply via `pnpm --filter @workspace/trailforge run db:migrate
--   0021_published_routes_likes_comments.sql` after 0018_saved_routes.sql.
--
-- Until now `saved_routes` was a private library — riders saved a built
-- route under a name and could load it back into the planner. This
-- migration turns a route into a first-class, sharable thing:
--   * A route can be marked Public so other riders discover and follow it.
--   * Public routes can be liked (idempotent, one per user) and commented
--     on (threaded list mirroring `trail_notes`).
--   * Each route carries metadata so Discover can filter by ride type
--     (Adventure / Enduro / Trail / Green-laning / Other) and search by
--     name, and so My Routes / Discover cards can render distance, trail
--     count and liking metrics without hydrating the route in full.
--
-- Schema changes to `saved_routes`:
--   * description           — long-form, optional
--   * ride_type             — short tag the planner save dialog picks
--   * region                — denormalised from the first trail's bbox
--                             (cached at save time, recomputed on update)
--   * is_public             — visibility flag (defaults false)
--   * total_distance_km     — alias for distance_km — keeps the public
--                             API field name aligned with what the
--                             route detail endpoint returns
--   * likes_count           — denormalised; kept in sync via triggers
--                             on route_likes
--   * comments_count        — denormalised; kept in sync via triggers
--                             on route_comments (visible-only)
--   * deleted_at            — soft-delete column matching `trails`
--
-- New tables:
--   * route_likes(route_id, user_id, created_at) PK pair — idempotency
--   * route_comments(id, route_id, author_user_id, body, created_at,
--       updated_at, hidden_at, hidden_reason) — mirrors `trail_notes`
--
-- Indexes target the hot paths:
--   * "list public routes ordered by recency / likes"
--     (saved_routes_public_recency_idx, saved_routes_public_likes_idx)
--   * "list my routes" (already covered by saved_routes_user_id_idx)
--   * "list comments for a route" (route_comments_route_idx)
--   * "count my likes / list likers for a route"
--     (route_likes_user_idx)
--
-- Anon-key clients have NO access — service role bypasses RLS and all
-- reads/writes go through the API server. The RLS-enable + DROP POLICY
-- statements are kept as defence-in-depth so a future anon policy can't
-- silently leak rows.

-- ---------- saved_routes column additions ----------

ALTER TABLE saved_routes
  ADD COLUMN IF NOT EXISTS description        text,
  ADD COLUMN IF NOT EXISTS ride_type          text,
  ADD COLUMN IF NOT EXISTS region             text,
  ADD COLUMN IF NOT EXISTS is_public          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS total_distance_km  numeric,
  ADD COLUMN IF NOT EXISTS likes_count        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comments_count     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz;

-- Backfill total_distance_km from the existing distance_km column so
-- pre-existing rows aren't NULL after the rename.
UPDATE saved_routes
   SET total_distance_km = distance_km
 WHERE total_distance_km IS NULL
   AND distance_km IS NOT NULL;

-- Indexes for the public list endpoints. Partial indexes on
-- is_public=true keep them tight as the (still mostly-private) table
-- grows.
CREATE INDEX IF NOT EXISTS saved_routes_public_recency_idx
  ON saved_routes (created_at DESC)
  WHERE is_public = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS saved_routes_public_likes_idx
  ON saved_routes (likes_count DESC, created_at DESC)
  WHERE is_public = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS saved_routes_public_ride_type_idx
  ON saved_routes (ride_type, created_at DESC)
  WHERE is_public = true AND deleted_at IS NULL;

-- ---------- route_likes ----------

CREATE TABLE IF NOT EXISTS route_likes (
  route_id   uuid NOT NULL REFERENCES saved_routes(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (route_id, user_id)
);

CREATE INDEX IF NOT EXISTS route_likes_user_idx
  ON route_likes (user_id, created_at DESC);

ALTER TABLE route_likes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS route_likes_anon_no_access ON route_likes;
-- (no policies — service role bypasses RLS; anon has nothing)

-- Trigger: keep saved_routes.likes_count in sync.
CREATE OR REPLACE FUNCTION route_likes_count_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE saved_routes
       SET likes_count = likes_count + 1
     WHERE id = NEW.route_id;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE saved_routes
       SET likes_count = GREATEST(0, likes_count - 1)
     WHERE id = OLD.route_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS route_likes_count_after_iud ON route_likes;
CREATE TRIGGER route_likes_count_after_iud
AFTER INSERT OR DELETE ON route_likes
FOR EACH ROW EXECUTE FUNCTION route_likes_count_trigger();

-- ---------- route_comments ----------

CREATE TABLE IF NOT EXISTS route_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id        uuid NOT NULL REFERENCES saved_routes(id) ON DELETE CASCADE,
  author_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  hidden_at       timestamptz,
  hidden_reason   text
);

CREATE INDEX IF NOT EXISTS route_comments_route_idx
  ON route_comments (route_id, created_at DESC);

ALTER TABLE route_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS route_comments_anon_no_access ON route_comments;
-- (no policies — service role bypasses RLS; anon has nothing)

-- Trigger: keep saved_routes.comments_count in sync, counting only
-- visible (non-hidden) comments. Recomputed for INSERT/DELETE and for
-- UPDATE that flips hidden_at in/out of NULL.
CREATE OR REPLACE FUNCTION route_comments_count_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta integer := 0;
  rid uuid;
BEGIN
  IF (TG_OP = 'INSERT') THEN
    rid := NEW.route_id;
    IF NEW.hidden_at IS NULL THEN delta := 1; END IF;
  ELSIF (TG_OP = 'DELETE') THEN
    rid := OLD.route_id;
    IF OLD.hidden_at IS NULL THEN delta := -1; END IF;
  ELSIF (TG_OP = 'UPDATE') THEN
    rid := NEW.route_id;
    IF OLD.hidden_at IS NULL AND NEW.hidden_at IS NOT NULL THEN delta := -1; END IF;
    IF OLD.hidden_at IS NOT NULL AND NEW.hidden_at IS NULL THEN delta := 1; END IF;
  END IF;
  IF delta <> 0 THEN
    UPDATE saved_routes
       SET comments_count = GREATEST(0, comments_count + delta)
     WHERE id = rid;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS route_comments_count_after_iud ON route_comments;
CREATE TRIGGER route_comments_count_after_iud
AFTER INSERT OR UPDATE OR DELETE ON route_comments
FOR EACH ROW EXECUTE FUNCTION route_comments_count_trigger();

ALTER TABLE saved_routes ENABLE ROW LEVEL SECURITY;
