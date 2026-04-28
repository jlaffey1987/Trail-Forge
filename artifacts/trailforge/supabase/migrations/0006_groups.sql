-- TrailForge — Private groups, invites, and trail sharing.
-- Apply via the Supabase SQL editor after 0005_member_trails.sql.
--
-- New tables:
--   * groups            — owner-created private groups (name, description, cover photo).
--   * group_members     — membership join (role: owner | admin | member).
--   * group_invites     — single-consumption signed invite tokens (link / email).
--   * trail_shares      — trails shared into a group by their owner.
--
-- Anon-key access surface (RLS):
--   * groups / group_members / group_invites / trail_shares: NO anon access.
--     All reads & writes flow through the API server (`/api/groups*`),
--     which authenticates the caller via Clerk and uses the Supabase
--     service-role key. The service role bypasses RLS, so the policies
--     defined here are intentionally restrictive — the server is the
--     single trusted enforcement point.
--
-- The `trails_public_read` anon policy is intentionally NOT changed: anon
-- still only sees `is_public = true AND deleted_at IS NULL`. Group-shared
-- private trails are surfaced to members through server endpoints
-- (`/api/me/group-trails*`) using the service role.

-- ---------- groups ----------
CREATE TABLE IF NOT EXISTS groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  cover_photo_key text,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS groups_owner_user_id_idx ON groups (owner_user_id);

ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS groups_no_anon ON groups;
-- Intentionally empty — no anon/authenticated policies. Service role only.

-- ---------- group_members ----------
CREATE TABLE IF NOT EXISTS group_members (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user_id_idx ON group_members (user_id);

ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS group_members_no_anon ON group_members;

-- ---------- group_invites ----------
-- An invite can be bound to:
--   * nothing  → shareable link (anyone with the token can claim it)
--   * email    → caller's verified primary email must match (server-enforced
--                on accept/auto-accept; tokens are still required to view)
--   * a Clerk username/user_id → resolved server-side at create time, the
--                caller's userId must match on accept (so usernames can be
--                changed without breaking the binding)
CREATE TABLE IF NOT EXISTS group_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  -- URL-safe random token (>= 32 chars). The server is the only writer,
  -- and it stores the raw token. This is acceptable because anon clients
  -- have no read access to this table.
  token text NOT NULL UNIQUE,
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Optional email pre-binding (lowercase). When set, accept enforces that
  -- the caller's verified primary email matches.
  email text,
  -- Optional Clerk user id pre-binding (set when the invite was created by
  -- username). When set, accept enforces that the caller is that user.
  target_user_id text REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  declined_at timestamptz,
  declined_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Schema upgrade for environments that already have the v1 group_invites:
ALTER TABLE group_invites ADD COLUMN IF NOT EXISTS target_user_id text
  REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE group_invites ADD COLUMN IF NOT EXISTS declined_at timestamptz;
ALTER TABLE group_invites ADD COLUMN IF NOT EXISTS declined_by_user_id text
  REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS group_invites_group_id_idx ON group_invites (group_id);
CREATE INDEX IF NOT EXISTS group_invites_email_idx
  ON group_invites (lower(email))
  WHERE email IS NOT NULL AND accepted_at IS NULL AND declined_at IS NULL;
CREATE INDEX IF NOT EXISTS group_invites_target_user_idx
  ON group_invites (target_user_id)
  WHERE target_user_id IS NOT NULL AND accepted_at IS NULL AND declined_at IS NULL;

ALTER TABLE group_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS group_invites_no_anon ON group_invites;

-- ---------- trail_shares ----------
CREATE TABLE IF NOT EXISTS trail_shares (
  trail_id uuid NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  shared_by_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trail_id, group_id)
);
CREATE INDEX IF NOT EXISTS trail_shares_group_id_idx ON trail_shares (group_id);
CREATE INDEX IF NOT EXISTS trail_shares_trail_id_idx ON trail_shares (trail_id);

ALTER TABLE trail_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trail_shares_no_anon ON trail_shares;

-- ---------- transactional helpers ----------
-- Transfer group ownership atomically: demote the old owner to admin,
-- promote the new owner, and update groups.owner_user_id in a single
-- transaction. Raises if the inputs are invalid.
CREATE OR REPLACE FUNCTION transfer_group_ownership(
  p_group_id uuid,
  p_from_user_id text,
  p_to_user_id text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_owner text;
  v_target_role text;
BEGIN
  IF p_from_user_id = p_to_user_id THEN
    RAISE EXCEPTION 'cannot transfer to self';
  END IF;
  SELECT owner_user_id INTO v_current_owner FROM groups WHERE id = p_group_id;
  IF v_current_owner IS NULL THEN
    RAISE EXCEPTION 'group not found';
  END IF;
  IF v_current_owner <> p_from_user_id THEN
    RAISE EXCEPTION 'caller is not the current owner';
  END IF;
  SELECT role INTO v_target_role FROM group_members
   WHERE group_id = p_group_id AND user_id = p_to_user_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'target user is not a member';
  END IF;

  UPDATE group_members SET role = 'admin'
   WHERE group_id = p_group_id AND user_id = p_from_user_id;
  UPDATE group_members SET role = 'owner'
   WHERE group_id = p_group_id AND user_id = p_to_user_id;
  UPDATE groups SET owner_user_id = p_to_user_id WHERE id = p_group_id;
END;
$$;

-- Atomically claim an invite and add the caller as a member. Returns the
-- group_id on success. Raises if already used, expired, declined, or if
-- the caller fails the email/target_user_id binding check.
CREATE OR REPLACE FUNCTION claim_group_invite(
  p_token text,
  p_user_id text,
  p_user_email text  -- caller's verified primary email, lowercase, may be NULL
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_invite_id uuid;
  v_group_id uuid;
  v_email text;
  v_target text;
  v_expires timestamptz;
BEGIN
  SELECT id, group_id, lower(email), target_user_id, expires_at
    INTO v_invite_id, v_group_id, v_email, v_target, v_expires
  FROM group_invites
  WHERE token = p_token
    AND accepted_at IS NULL
    AND declined_at IS NULL
  FOR UPDATE;

  IF v_invite_id IS NULL THEN
    RAISE EXCEPTION 'invite not found or already used' USING ERRCODE = 'P0002';
  END IF;
  IF v_expires < now() THEN
    RAISE EXCEPTION 'invite expired' USING ERRCODE = 'P0003';
  END IF;
  IF v_email IS NOT NULL AND (p_user_email IS NULL OR p_user_email <> v_email) THEN
    RAISE EXCEPTION 'invite is bound to a different email' USING ERRCODE = 'P0004';
  END IF;
  IF v_target IS NOT NULL AND v_target <> p_user_id THEN
    RAISE EXCEPTION 'invite is bound to a different user' USING ERRCODE = 'P0005';
  END IF;

  INSERT INTO group_members (group_id, user_id, role)
  VALUES (v_group_id, p_user_id, 'member')
  ON CONFLICT (group_id, user_id) DO NOTHING;

  UPDATE group_invites
     SET accepted_at = now(),
         accepted_by_user_id = p_user_id
   WHERE id = v_invite_id;

  RETURN v_group_id;
END;
$$;
