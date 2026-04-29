-- TrailForge — Web-Push subscriptions for OS-level group activity pushes.
-- Apply via the Supabase SQL editor after 0013_group_discoverable_join_requests.sql.
--
-- Adds:
--   * users.push_notifications_enabled — per-user opt-out flag. When false,
--     the server skips fanning pushes to any of this user's devices but
--     still keeps the in-app feed working as before.
--   * push_subscriptions — one row per (browser × user) PushSubscription
--     returned by `pushManager.subscribe()`. Endpoint is unique so a device
--     re-subscribing simply updates `last_seen_at` instead of creating a
--     duplicate. ON DELETE CASCADE means deleting a user wipes their tokens.
--
-- Pushes themselves are sent server-side from `routes/push.ts` whenever a
-- new row lands in `trail_shares` or `group_members`. There is no separate
-- "queued push" table — we just call web-push at the moment the source row
-- is inserted (fire-and-forget so it never blocks the API response).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS push_notifications_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON push_subscriptions(user_id);
