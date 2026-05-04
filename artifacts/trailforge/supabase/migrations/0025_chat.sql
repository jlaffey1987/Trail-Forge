-- TrailForge — In-app chat: group rooms and 1-to-1 direct messages.
-- Apply via the Supabase SQL editor after 0024_trail_adoption_amendment_categories.sql.
--
-- New tables:
--   * chat_rooms          — one per group (kind='group') or DM pair (kind='dm')
--   * chat_room_members   — who belongs to a room, with read-state & archive
--   * chat_messages        — the actual messages
--   * user_blocks          — per-user block list
--
-- Triggers mirror group_members changes into chat_room_members so group
-- chat rooms stay in sync automatically.

-- ---------- chat_rooms ----------
CREATE TABLE IF NOT EXISTS chat_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('group', 'dm')),
  group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_rooms_group_unique UNIQUE (group_id)
);
CREATE INDEX IF NOT EXISTS chat_rooms_group_id_idx ON chat_rooms (group_id) WHERE group_id IS NOT NULL;

ALTER TABLE chat_rooms ENABLE ROW LEVEL SECURITY;

-- ---------- chat_room_members ----------
CREATE TABLE IF NOT EXISTS chat_room_members (
  room_id uuid NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz,
  archived_at timestamptz,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_room_members_user_id_idx ON chat_room_members (user_id);

ALTER TABLE chat_room_members ENABLE ROW LEVEL SECURITY;

-- ---------- chat_messages ----------
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  sender_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_room_created_idx ON chat_messages (room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_room_id_idx ON chat_messages (room_id);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- ---------- user_blocks ----------
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CONSTRAINT user_blocks_no_self CHECK (blocker_user_id <> blocked_user_id)
);
CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON user_blocks (blocked_user_id);

ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;

-- ---------- Backfill: create a chat room for every existing group ----------
INSERT INTO chat_rooms (kind, group_id)
SELECT 'group', g.id
FROM groups g
WHERE NOT EXISTS (
  SELECT 1 FROM chat_rooms cr WHERE cr.group_id = g.id
);

-- Backfill: add all current group members to their group's chat room
INSERT INTO chat_room_members (room_id, user_id, role, joined_at)
SELECT cr.id, gm.user_id, gm.role, gm.joined_at
FROM group_members gm
JOIN chat_rooms cr ON cr.group_id = gm.group_id
WHERE NOT EXISTS (
  SELECT 1 FROM chat_room_members crm
  WHERE crm.room_id = cr.id AND crm.user_id = gm.user_id
);

-- ---------- Trigger: auto-create chat room when a new group is created ----------
CREATE OR REPLACE FUNCTION trg_group_after_insert_chat_room()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO chat_rooms (kind, group_id)
  VALUES ('group', NEW.id)
  ON CONFLICT (group_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_after_insert_chat_room ON groups;
CREATE TRIGGER group_after_insert_chat_room
  AFTER INSERT ON groups
  FOR EACH ROW
  EXECUTE FUNCTION trg_group_after_insert_chat_room();

-- ---------- Trigger: mirror group_members INSERT into chat_room_members ----------
CREATE OR REPLACE FUNCTION trg_group_member_after_insert_chat()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_room_id uuid;
BEGIN
  SELECT id INTO v_room_id FROM chat_rooms WHERE group_id = NEW.group_id;
  IF v_room_id IS NOT NULL THEN
    INSERT INTO chat_room_members (room_id, user_id, role, joined_at)
    VALUES (v_room_id, NEW.user_id, NEW.role, NEW.joined_at)
    ON CONFLICT (room_id, user_id) DO UPDATE SET role = EXCLUDED.role;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_member_after_insert_chat ON group_members;
CREATE TRIGGER group_member_after_insert_chat
  AFTER INSERT ON group_members
  FOR EACH ROW
  EXECUTE FUNCTION trg_group_member_after_insert_chat();

-- ---------- Trigger: mirror group_members DELETE → remove from chat room ----------
CREATE OR REPLACE FUNCTION trg_group_member_after_delete_chat()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_room_id uuid;
BEGIN
  SELECT id INTO v_room_id FROM chat_rooms WHERE group_id = OLD.group_id;
  IF v_room_id IS NOT NULL THEN
    DELETE FROM chat_room_members
    WHERE room_id = v_room_id AND user_id = OLD.user_id;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS group_member_after_delete_chat ON group_members;
CREATE TRIGGER group_member_after_delete_chat
  AFTER DELETE ON group_members
  FOR EACH ROW
  EXECUTE FUNCTION trg_group_member_after_delete_chat();

-- ---------- Trigger: mirror group_members role UPDATE ----------
CREATE OR REPLACE FUNCTION trg_group_member_after_update_chat()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_room_id uuid;
BEGIN
  IF OLD.role IS DISTINCT FROM NEW.role THEN
    SELECT id INTO v_room_id FROM chat_rooms WHERE group_id = NEW.group_id;
    IF v_room_id IS NOT NULL THEN
      UPDATE chat_room_members SET role = NEW.role
      WHERE room_id = v_room_id AND user_id = NEW.user_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_member_after_update_chat ON group_members;
CREATE TRIGGER group_member_after_update_chat
  AFTER UPDATE ON group_members
  FOR EACH ROW
  EXECUTE FUNCTION trg_group_member_after_update_chat();
