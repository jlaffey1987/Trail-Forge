-- TrailForge — In-app notification feed for group activity.
-- Apply via the Supabase SQL editor after 0009_act_imports.sql.
--
-- Adds:
--   * users.notifications_read_at — timestamp marking the cutoff above which
--     events should be considered "unread" by the in-app notification bell.
--     Updated by `POST /api/me/notifications/read` (server-side, service role).
--
-- The notification feed itself is computed on demand from the existing
-- `trail_shares` and `group_members` tables (see /api/me/notifications).
-- No separate event log is required for this v1 — the source rows are
-- already append-only and carry the timestamps we need.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notifications_read_at timestamptz;
