-- TrailForge — Discoverable groups & join requests.
-- Apply via `pnpm --filter @workspace/trailforge run db:migrate 0013_group_discoverable_join_requests.sql`.
--
-- Pivot away from email invites toward a discoverable-group flow:
--   * groups gain a `discoverable` flag the owner can toggle on so other
--     riders can find the group on the Discover screen.
--   * `group_join_requests` records "ask to join" requests that owners /
--     admins can approve (which adds the rider to the group) or decline.
--
-- The existing invite tables (`group_invites`) are intentionally untouched
-- so shareable invite links (and the username invite path) keep working
-- as a fallback. Only the email-bound flow is being retired in the UI.
--
-- Anon-key access surface (RLS):
--   * `group_join_requests`: NO anon access. Same enforcement model as the
--     other group tables — the API server is the single trusted writer
--     using the Supabase service-role key.
--   * `groups.discoverable` is exposed only via the API server's
--     `/api/groups/discoverable` listing (service role); anon clients
--     still have no read access to the `groups` table directly.

-- ---------- groups.discoverable ----------
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS discoverable boolean NOT NULL DEFAULT false;

-- Partial index keeps the discover listing cheap when most groups stay
-- private.
CREATE INDEX IF NOT EXISTS groups_discoverable_created_idx
  ON groups (created_at DESC)
  WHERE discoverable;

-- ---------- group_join_requests ----------
CREATE TABLE IF NOT EXISTS group_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined')),
  message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by_user_id text REFERENCES users(id) ON DELETE SET NULL
);

-- A user can only have one *pending* request per group at a time, but they
-- may re-request later if a previous attempt was declined. Approved rows
-- are kept as a lightweight audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS group_join_requests_pending_unique
  ON group_join_requests (group_id, user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS group_join_requests_group_status_idx
  ON group_join_requests (group_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS group_join_requests_user_status_idx
  ON group_join_requests (user_id, status, created_at DESC);

ALTER TABLE group_join_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS group_join_requests_no_anon ON group_join_requests;
-- Intentionally empty — no anon/authenticated policies. Service role only.
