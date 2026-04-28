-- TrailForge — partial unique index on saved_trails for signed-in users.
-- Apply AFTER 0002_users_and_owner.sql. Pairs with the session_id index
-- created in 0001a so the API server can use upsert with onConflict
-- "user_id,trail_id" for Clerk-authenticated users.

CREATE UNIQUE INDEX IF NOT EXISTS saved_trails_user_trail_unique
  ON saved_trails (user_id, trail_id)
  WHERE user_id IS NOT NULL;
