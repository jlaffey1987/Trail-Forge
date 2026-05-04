-- TrailForge — Align route_comments schema with the API.
--
-- 0021 created `route_comments(author_user_id, ...)` and shipped without
-- the `parent_id` column needed for threaded replies. The /api/me/routes
-- comment handlers consistently read/write `user_id` + `parent_id`, so
-- this migration brings the table into line with the running code:
--
--   * RENAME `author_user_id` → `user_id` (idempotent guard).
--   * ADD `parent_id uuid` self-FK with ON DELETE CASCADE so a removed
--     parent comment also cleans up its replies.
--   * Re-create the per-route index that `route_comments_route_idx`
--     already covers (no-op if present).
--
-- Safe to apply on top of 0021. Running it on a DB that already has
-- `user_id` is a no-op for the rename (the IF EXISTS guard skips it).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'route_comments'
       AND column_name = 'author_user_id'
  ) AND NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'route_comments'
       AND column_name = 'user_id'
  ) THEN
    EXECUTE 'ALTER TABLE route_comments RENAME COLUMN author_user_id TO user_id';
  END IF;
END$$;

ALTER TABLE route_comments
  ADD COLUMN IF NOT EXISTS parent_id uuid
    REFERENCES route_comments(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS route_comments_parent_idx
  ON route_comments (parent_id)
  WHERE parent_id IS NOT NULL;
