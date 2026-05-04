-- TrailForge — Per-group push notification preferences.
-- Apply via the Supabase SQL editor after 0025_chat.sql.
--
-- Adds:
--   * group_members.push_enabled — per-group opt-out flag. When false,
--     the server skips fanning pushes for this group to this user but
--     still delivers notifications from other groups and keeps the
--     in-app activity feed working as before.
--
-- Defaults to true so existing memberships continue receiving pushes
-- without requiring a data backfill.

ALTER TABLE group_members
  ADD COLUMN IF NOT EXISTS push_enabled boolean NOT NULL DEFAULT true;
