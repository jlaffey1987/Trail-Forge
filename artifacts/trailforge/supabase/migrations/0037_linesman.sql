-- TrailForge — Linesman System
--
-- Linesfolk are trusted volunteers who maintain a specific group of trails.
-- They get a simplified mobile interface for editing, flagging, replacing
-- routes and adding new trails — all within their assigned group.

-- ── users table extensions ───────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS linesman_access   boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS linesman_group_id uuid REFERENCES groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_linesman_idx ON users(linesman_access) WHERE linesman_access = true;

-- ── linesman_edits audit log ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS linesman_edits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trail_id         uuid REFERENCES trails(id) ON DELETE CASCADE,
  linesman_user_id text REFERENCES users(id) ON DELETE SET NULL,
  edit_type        text CHECK (edit_type IN (
                     'update_metadata',
                     'replace_gpx',
                     'flag',
                     'unflag',
                     'delete',
                     'restore',
                     'add'
                   )),
  previous_values  jsonb,
  new_values       jsonb,
  edit_reason      text,
  created_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS linesman_edits_trail_idx
  ON linesman_edits(trail_id, created_at DESC);

CREATE INDEX IF NOT EXISTS linesman_edits_user_idx
  ON linesman_edits(linesman_user_id, created_at DESC);

-- RLS: linesfolk can read their own edits; admins can read all.
ALTER TABLE linesman_edits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "linesman_read_own_edits"
  ON linesman_edits FOR SELECT
  USING (linesman_user_id = auth.uid()::text);

CREATE POLICY "service_role_all"
  ON linesman_edits FOR ALL
  USING (true)
  WITH CHECK (true);
