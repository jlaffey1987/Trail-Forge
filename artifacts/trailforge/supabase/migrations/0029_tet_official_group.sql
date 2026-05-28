-- TrailForge — TET Official group + group verification badge.
-- Apply via the Supabase SQL editor.
--
-- Adds:
--   * groups.is_verified  — displays a verified-badge in the mobile UI.
--   * A pre-seeded "TET Official" verified discoverable group owned by the
--     bootstrap system-admin account (user_3CyzjHG396eeQ26BuOnuZY9y1hc).
--
-- The TET Official group is intended to be the canonical repository for
-- Trans-Euro Trail route segments imported via the TET import script.

-- ---------- groups.is_verified ----------
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS is_verified boolean NOT NULL DEFAULT false;

-- ---------- Seed TET Official ----------
-- Only insert if the group doesn't already exist (idempotent).
DO $$
DECLARE
  v_owner text := 'user_3CyzjHG396eeQ26BuOnuZY9y1hc';
  v_group_id uuid;
BEGIN
  -- Guard: skip seeding if the owner user doesn't exist
  -- (e.g. on a fresh DB where the user hasn't signed in yet).
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_owner) THEN
    RAISE NOTICE 'TET Official seed skipped: owner user % not found. Run after first sign-in.', v_owner;
    RETURN;
  END IF;

  -- Guard: skip if TET Official already exists.
  SELECT id INTO v_group_id FROM groups WHERE name = 'TET Official' LIMIT 1;
  IF FOUND THEN
    -- Ensure it's verified and discoverable even if it was created manually.
    UPDATE groups SET is_verified = true, discoverable = true WHERE id = v_group_id;
    RAISE NOTICE 'TET Official already exists (%); ensured is_verified=true.', v_group_id;
    RETURN;
  END IF;

  INSERT INTO groups (name, description, owner_user_id, is_verified, discoverable)
  VALUES (
    'TET Official',
    'The official Trans-Euro Trail group. Verified route segments imported from the TET GPX archive. Public trails visible on the map for all riders.',
    v_owner,
    true,
    true
  )
  RETURNING id INTO v_group_id;

  -- Make the owner a member with the owner role.
  INSERT INTO group_members (group_id, user_id, role)
  VALUES (v_group_id, v_owner, 'owner');

  RAISE NOTICE 'TET Official group created: %', v_group_id;
END $$;
