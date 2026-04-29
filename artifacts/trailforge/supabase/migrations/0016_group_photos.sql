-- TrailForge — Shared per-group photo gallery.
-- Apply via `pnpm --filter @workspace/trailforge run db:migrate 0016_group_photos.sql`.
--
-- Members of a group can upload photos that show up in a shared gallery on
-- the GroupDetailDialog. Storage / signed-URL flow mirrors trail_photos and
-- the new group cover photo:
--   1. POST /api/groups/:id/photos/upload-url → returns signed PUT URL +
--      storageKey at `groups/{groupId}/photos/{uuid}.jpg`.
--   2. Client PUTs the prepared JPEG bytes directly.
--   3. POST /api/groups/:id/photos { storageKey } stamps ACL public + writes
--      a `group_photos` row.
--
-- Moderation (matching trail_photos):
--   * Owners and admins can hide any photo (sets `hidden_at`, list endpoint
--     filters it out — keeps an audit trail rather than physically deleting
--     the row).
--   * The original uploader can hard-delete their own photo.
--
-- Anon-key access surface (RLS):
--   * group_photos: NO anon access. Same enforcement model as the other
--     group tables — the API server is the single trusted writer using the
--     Supabase service-role key.

CREATE TABLE IF NOT EXISTS group_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  uploader_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  width int,
  height int,
  caption text,
  created_at timestamptz NOT NULL DEFAULT now(),
  hidden_at timestamptz
);

CREATE INDEX IF NOT EXISTS group_photos_group_id_created_idx
  ON group_photos (group_id, created_at DESC)
  WHERE hidden_at IS NULL;
CREATE INDEX IF NOT EXISTS group_photos_uploader_idx
  ON group_photos (uploader_user_id);

ALTER TABLE group_photos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS group_photos_no_anon ON group_photos;
-- Intentionally no policies — service-role only.
