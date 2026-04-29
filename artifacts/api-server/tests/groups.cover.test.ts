/**
 * Group cover-photo flow — backend coverage.
 *
 * The cover photo upload is a three-step handshake (signed PUT, then a
 * finalize POST that stamps the ACL public + saves the storage key) and a
 * separate DELETE that clears the column and best-effort drops the blob.
 * Each step also enforces owner/admin gating, so a member or stranger
 * must not be able to mutate the cover. These tests exercise the full
 * surface so future refactors can't silently regress any of:
 *
 *   POST   /api/groups/:groupId/cover/upload-url   — signed URL handshake
 *   POST   /api/groups/:groupId/cover              — finalize + replace
 *   DELETE /api/groups/:groupId/cover              — remove
 *
 * The Supabase + ObjectStorage layers are mocked in `helpers/setup.ts`
 * (see `getObjectStorageMocks()` / `setAclShouldFail()`), which lets us
 * assert that a replace deletes the prior blob, that a finalize against a
 * nonexistent upload returns 404, and that gating returns 403 for callers
 * who aren't owners/admins.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import {
  resetMockSupa,
  getMockSupa,
  setAclShouldFail,
  getObjectStorageMocks,
} from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const OWNER_ID = "user_owner";
const ADMIN_ID = "user_admin";
const MEMBER_ID = "user_member";
const STRANGER_ID = "user_stranger";

const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_GROUP_ID = "22222222-2222-4222-8222-222222222222";
const PRIOR_KEY = `groups/${GROUP_ID}/cover/old-cover.jpg`;

function seedBase(opts: { withPriorCover?: boolean } = {}) {
  const supa = resetMockSupa();
  supa.seed("users", [
    { id: OWNER_ID, display_name: "Owner" },
    { id: ADMIN_ID, display_name: "Admin" },
    { id: MEMBER_ID, display_name: "Member" },
    { id: STRANGER_ID, display_name: "Stranger" },
  ]);
  supa.seed("groups", [
    {
      id: GROUP_ID,
      name: "Test Group",
      cover_photo_key: opts.withPriorCover ? PRIOR_KEY : null,
      owner_user_id: OWNER_ID,
    },
    {
      id: OTHER_GROUP_ID,
      name: "Other Group",
      cover_photo_key: null,
      owner_user_id: STRANGER_ID,
    },
  ]);
  // Owner / admin / member of GROUP_ID. STRANGER_ID is not a member of
  // GROUP_ID — they own OTHER_GROUP_ID, which lets us prove that a key
  // belonging to one group can't be applied to another.
  supa.seed("group_members", [
    { group_id: GROUP_ID, user_id: OWNER_ID, role: "owner" },
    { group_id: GROUP_ID, user_id: ADMIN_ID, role: "admin" },
    { group_id: GROUP_ID, user_id: MEMBER_ID, role: "member" },
    { group_id: OTHER_GROUP_ID, user_id: STRANGER_ID, role: "owner" },
  ]);
  return supa;
}

describe("POST /api/groups/:groupId/cover/upload-url — signed URL handshake", () => {
  beforeEach(() => {
    seedBase();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(makeApp()).post(
      `/api/groups/${GROUP_ID}/cover/upload-url`,
    );
    expect(res.status).toBe(401);
  });

  it("returns a signed URL + storageKey to the owner", async () => {
    const res = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/cover/upload-url`,
    );
    expect(res.status).toBe(200);
    expect(res.body.uploadURL).toMatch(
      new RegExp(`^https://upload\\.test/groups/${GROUP_ID}/cover/.+\\.jpg$`),
    );
    expect(res.body.storageKey).toMatch(
      new RegExp(`^groups/${GROUP_ID}/cover/.+\\.jpg$`),
    );
    expect(res.body.objectPath).toBe(`/objects/${res.body.storageKey}`);
  });

  it("also lets an admin (not just the owner) request an upload URL", async () => {
    const res = await request(makeApp(ADMIN_ID)).post(
      `/api/groups/${GROUP_ID}/cover/upload-url`,
    );
    expect(res.status).toBe(200);
    expect(res.body.storageKey).toMatch(
      new RegExp(`^groups/${GROUP_ID}/cover/`),
    );
  });

  it("forbids a regular member from requesting an upload URL (403)", async () => {
    const res = await request(makeApp(MEMBER_ID)).post(
      `/api/groups/${GROUP_ID}/cover/upload-url`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owners or admins/i);
  });

  it("forbids a non-member with 403 (no membership row at all)", async () => {
    const res = await request(makeApp(STRANGER_ID)).post(
      `/api/groups/${GROUP_ID}/cover/upload-url`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a member/i);
  });

  it("rejects a non-uuid group id with 400", async () => {
    const res = await request(makeApp(OWNER_ID)).post(
      "/api/groups/not-a-uuid/cover/upload-url",
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/groups/:groupId/cover — finalize / replace", () => {
  let storageKey: string;

  beforeEach(async () => {
    seedBase();
    // Get a fresh storage key from the upload-url endpoint so the
    // prefix-check in the finalize handler can't drift away from the
    // generator without us noticing.
    const urlRes = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/cover/upload-url`,
    );
    storageKey = urlRes.body.storageKey as string;
  });

  afterEach(() => {
    setAclShouldFail(false);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(makeApp())
      .post(`/api/groups/${GROUP_ID}/cover`)
      .send({ storageKey });
    expect(res.status).toBe(401);
  });

  it("stamps the ACL public, persists cover_photo_key, and returns the row", async () => {
    const { trySetObjectEntityAclPolicy } = getObjectStorageMocks();
    const res = await request(makeApp(OWNER_ID))
      .post(`/api/groups/${GROUP_ID}/cover`)
      .send({ storageKey });
    expect(res.status).toBe(200);
    expect(res.body.cover_photo_key).toBe(storageKey);

    // ACL was stamped public so any group member viewing the card can
    // render it without needing a per-request signed URL.
    expect(trySetObjectEntityAclPolicy).toHaveBeenCalledTimes(1);
    expect(trySetObjectEntityAclPolicy).toHaveBeenCalledWith(
      `/objects/${storageKey}`,
      { owner: OWNER_ID, visibility: "public" },
    );

    // Persisted to the row so the GroupsSection card + GroupDetailDialog
    // both see the new cover on the next read.
    const groups = getMockSupa().rows("groups");
    const stored = groups.find((g) => g.id === GROUP_ID);
    expect(stored?.cover_photo_key).toBe(storageKey);
  });

  it("admin (not owner) can also finalize a cover", async () => {
    // Admin needs their own upload URL because the prefix check is per
    // group, not per user. Reusing OWNER's key would also work since both
    // are scoped to GROUP_ID, but going through the full handshake keeps
    // the test honest about who can drive each step.
    const urlRes = await request(makeApp(ADMIN_ID)).post(
      `/api/groups/${GROUP_ID}/cover/upload-url`,
    );
    const adminKey = urlRes.body.storageKey as string;

    const res = await request(makeApp(ADMIN_ID))
      .post(`/api/groups/${GROUP_ID}/cover`)
      .send({ storageKey: adminKey });
    expect(res.status).toBe(200);
    expect(res.body.cover_photo_key).toBe(adminKey);
  });

  it("forbids a regular member from finalizing a cover (403)", async () => {
    const res = await request(makeApp(MEMBER_ID))
      .post(`/api/groups/${GROUP_ID}/cover`)
      .send({ storageKey });
    expect(res.status).toBe(403);
    // Cover untouched.
    const groups = getMockSupa().rows("groups");
    expect(groups.find((g) => g.id === GROUP_ID)?.cover_photo_key).toBeNull();
  });

  it("forbids a non-member from finalizing a cover (403)", async () => {
    const res = await request(makeApp(STRANGER_ID))
      .post(`/api/groups/${GROUP_ID}/cover`)
      .send({ storageKey });
    expect(res.status).toBe(403);
  });

  it("rejects a storageKey that doesn't match the group prefix (400)", async () => {
    // A key generated for OTHER_GROUP_ID can't be applied to GROUP_ID
    // even by GROUP_ID's owner. This is what stops one group from
    // hijacking another group's just-uploaded blob.
    const otherKey = `groups/${OTHER_GROUP_ID}/cover/some-uuid.jpg`;
    const res = await request(makeApp(OWNER_ID))
      .post(`/api/groups/${GROUP_ID}/cover`)
      .send({ storageKey: otherKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match this group/i);
  });

  it("rejects a malformed body (missing storageKey) with 400", async () => {
    const res = await request(makeApp(OWNER_ID))
      .post(`/api/groups/${GROUP_ID}/cover`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 if the upload was never completed (ACL stamp throws ObjectNotFound)", async () => {
    setAclShouldFail(true);
    const res = await request(makeApp(OWNER_ID))
      .post(`/api/groups/${GROUP_ID}/cover`)
      .send({ storageKey });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/upload not completed/i);
    // Cover never written.
    const groups = getMockSupa().rows("groups");
    expect(groups.find((g) => g.id === GROUP_ID)?.cover_photo_key).toBeNull();
  });

  it("on replace: persists the new key AND best-effort deletes the prior blob", async () => {
    seedBase({ withPriorCover: true });
    const urlRes = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/cover/upload-url`,
    );
    const newKey = urlRes.body.storageKey as string;
    expect(newKey).not.toBe(PRIOR_KEY);

    const { deleteObjectEntity } = getObjectStorageMocks();
    const res = await request(makeApp(OWNER_ID))
      .post(`/api/groups/${GROUP_ID}/cover`)
      .send({ storageKey: newKey });
    expect(res.status).toBe(200);
    expect(res.body.cover_photo_key).toBe(newKey);

    // Prior blob was queued for deletion so we don't accumulate orphans.
    expect(deleteObjectEntity).toHaveBeenCalledTimes(1);
    expect(deleteObjectEntity).toHaveBeenCalledWith(`/objects/${PRIOR_KEY}`);

    const stored = getMockSupa()
      .rows("groups")
      .find((g) => g.id === GROUP_ID);
    expect(stored?.cover_photo_key).toBe(newKey);
  });

  it("on first finalize (no prior cover): does NOT call deleteObjectEntity", async () => {
    const { deleteObjectEntity } = getObjectStorageMocks();
    const res = await request(makeApp(OWNER_ID))
      .post(`/api/groups/${GROUP_ID}/cover`)
      .send({ storageKey });
    expect(res.status).toBe(200);
    expect(deleteObjectEntity).not.toHaveBeenCalled();
  });

  it("on replace: a delete failure does NOT fail the request", async () => {
    seedBase({ withPriorCover: true });
    const { deleteObjectEntity } = getObjectStorageMocks();
    deleteObjectEntity.mockRejectedValueOnce(new Error("storage 500"));

    const urlRes = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/cover/upload-url`,
    );
    const newKey = urlRes.body.storageKey as string;

    const res = await request(makeApp(OWNER_ID))
      .post(`/api/groups/${GROUP_ID}/cover`)
      .send({ storageKey: newKey });
    expect(res.status).toBe(200);
    // New key still wins even though the cleanup threw.
    expect(res.body.cover_photo_key).toBe(newKey);
  });
});

describe("DELETE /api/groups/:groupId/cover — remove", () => {
  beforeEach(() => {
    seedBase({ withPriorCover: true });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(makeApp()).delete(
      `/api/groups/${GROUP_ID}/cover`,
    );
    expect(res.status).toBe(401);
  });

  it("clears cover_photo_key and deletes the blob for the owner", async () => {
    const { deleteObjectEntity } = getObjectStorageMocks();
    const res = await request(makeApp(OWNER_ID)).delete(
      `/api/groups/${GROUP_ID}/cover`,
    );
    expect(res.status).toBe(200);
    expect(res.body.cover_photo_key).toBeNull();

    expect(deleteObjectEntity).toHaveBeenCalledTimes(1);
    expect(deleteObjectEntity).toHaveBeenCalledWith(`/objects/${PRIOR_KEY}`);

    const stored = getMockSupa()
      .rows("groups")
      .find((g) => g.id === GROUP_ID);
    expect(stored?.cover_photo_key).toBeNull();
  });

  it("admin (not owner) can also remove the cover", async () => {
    const res = await request(makeApp(ADMIN_ID)).delete(
      `/api/groups/${GROUP_ID}/cover`,
    );
    expect(res.status).toBe(200);
    expect(res.body.cover_photo_key).toBeNull();
  });

  it("forbids a regular member from removing the cover (403)", async () => {
    const { deleteObjectEntity } = getObjectStorageMocks();
    const res = await request(makeApp(MEMBER_ID)).delete(
      `/api/groups/${GROUP_ID}/cover`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owners or admins/i);
    // Cover row + blob untouched.
    const stored = getMockSupa()
      .rows("groups")
      .find((g) => g.id === GROUP_ID);
    expect(stored?.cover_photo_key).toBe(PRIOR_KEY);
    expect(deleteObjectEntity).not.toHaveBeenCalled();
  });

  it("forbids a non-member from removing the cover (403)", async () => {
    const res = await request(makeApp(STRANGER_ID)).delete(
      `/api/groups/${GROUP_ID}/cover`,
    );
    expect(res.status).toBe(403);
  });

  it("when there's no prior cover: clears the column and skips the storage delete", async () => {
    seedBase({ withPriorCover: false });
    const { deleteObjectEntity } = getObjectStorageMocks();
    const res = await request(makeApp(OWNER_ID)).delete(
      `/api/groups/${GROUP_ID}/cover`,
    );
    expect(res.status).toBe(200);
    expect(res.body.cover_photo_key).toBeNull();
    expect(deleteObjectEntity).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid group id with 400", async () => {
    const res = await request(makeApp(OWNER_ID)).delete(
      "/api/groups/not-a-uuid/cover",
    );
    expect(res.status).toBe(400);
  });
});

describe("end-to-end cover lifecycle: upload → finalize → replace → remove", () => {
  it("walks the full lifecycle as the owner", async () => {
    seedBase();
    const { deleteObjectEntity, trySetObjectEntityAclPolicy } =
      getObjectStorageMocks();

    // 1. Upload URL #1.
    const url1 = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/cover/upload-url`,
    );
    expect(url1.status).toBe(200);
    const key1 = url1.body.storageKey as string;

    // 2. Finalize the first cover.
    const final1 = await request(makeApp(OWNER_ID))
      .post(`/api/groups/${GROUP_ID}/cover`)
      .send({ storageKey: key1 });
    expect(final1.status).toBe(200);
    expect(final1.body.cover_photo_key).toBe(key1);
    expect(trySetObjectEntityAclPolicy).toHaveBeenCalledTimes(1);
    expect(deleteObjectEntity).not.toHaveBeenCalled();

    // 3. Replace with a second cover. Prior blob must be cleaned up.
    const url2 = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/cover/upload-url`,
    );
    const key2 = url2.body.storageKey as string;
    expect(key2).not.toBe(key1);

    const final2 = await request(makeApp(OWNER_ID))
      .post(`/api/groups/${GROUP_ID}/cover`)
      .send({ storageKey: key2 });
    expect(final2.status).toBe(200);
    expect(final2.body.cover_photo_key).toBe(key2);
    expect(trySetObjectEntityAclPolicy).toHaveBeenCalledTimes(2);
    expect(deleteObjectEntity).toHaveBeenCalledTimes(1);
    expect(deleteObjectEntity).toHaveBeenLastCalledWith(`/objects/${key1}`);

    // 4. Remove the cover entirely. The current blob (key2) must go too.
    const removed = await request(makeApp(OWNER_ID)).delete(
      `/api/groups/${GROUP_ID}/cover`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.cover_photo_key).toBeNull();
    expect(deleteObjectEntity).toHaveBeenCalledTimes(2);
    expect(deleteObjectEntity).toHaveBeenLastCalledWith(`/objects/${key2}`);

    const stored = getMockSupa()
      .rows("groups")
      .find((g) => g.id === GROUP_ID);
    expect(stored?.cover_photo_key).toBeNull();
  });
});
