-- TrailForge — Removal-style group activity events.
-- Apply via the Supabase SQL editor after 0014_push_subscriptions.sql.
--
-- Today's notification feed (see GET /api/me/notifications) unions together
-- append-only source rows: trail_shares (additions) and group_members
-- (joins). That works for "good news" events because the source rows
-- carry a stable timestamp and stick around forever, but it can't surface
-- removal-style events — when a member leaves a group or a trail share
-- is taken back, the source row is physically deleted and the timestamp
-- of that action is gone with it.
--
-- Rather than retrofit soft-delete columns onto group_members and
-- trail_shares (both of which use composite primary keys that would
-- conflict if a user re-joined or a trail were re-shared), we keep a tiny
-- append-only event log on the side. Declined invites already carry
-- declined_at / declined_by_user_id on group_invites itself, so they do
-- NOT need a row in this table — the notification feed reads those
-- columns directly.
--
-- New table:
--   * group_activity_events — append-only log of {member_left, trail_unshared}
--     events. Read by GET /api/me/notifications and joined to groups,
--     users, and trails to render the feed.
--
-- Anon access: none. The route layer reads with the service role.

CREATE TABLE IF NOT EXISTS group_activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Event kind. Keep the CHECK in sync with the union the route layer
  -- expects when it constructs the feed.
  type text NOT NULL CHECK (type IN ('member_left', 'trail_unshared')),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  -- The user that triggered the event:
  --   * member_left      → the user who left, or the owner/admin who
  --                        removed them (matches subject_user_id when the
  --                        member left voluntarily)
  --   * trail_unshared   → the trail owner (or owner/admin) who removed
  --                        the share
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Populated for trail_unshared. Nullable so member_left can re-use the
  -- same table.
  trail_id uuid REFERENCES trails(id) ON DELETE SET NULL,
  -- Snapshot the trail name at event time so the feed can render a useful
  -- description even if the trail row has since been hard-deleted.
  trail_name_snapshot text,
  -- Populated for member_left — the member that left or was removed.
  -- ON DELETE SET NULL so wiping a Clerk user doesn't blow up history;
  -- the feed falls back to a generic "a rider" label in that case.
  subject_user_id text REFERENCES users(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS group_activity_events_group_idx
  ON group_activity_events (group_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS group_activity_events_type_idx
  ON group_activity_events (type, occurred_at DESC);

ALTER TABLE group_activity_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS group_activity_events_no_anon ON group_activity_events;
-- Intentionally empty — service role only.
