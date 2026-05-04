import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import {
  resetMockSupa,
  getMockSupa,
  setAclShouldFail,
  getObjectStorageMocks,
} from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const GROUP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "user_owner";
const ADMIN_ID = "user_admin";
const MEMBER_ID = "user_member";
const UPLOADER_ID = "user_uploader";
const STRANGER_ID = "user_stranger";

function seedBase() {
  const supa = resetMockSupa();
  supa.seed("users", [
    { id: OWNER_ID, display_name: "Owner", avatar_url: null, is_moderator: false },
    { id: ADMIN_ID, display_name: "Admin", avatar_url: null, is_moderator: false },
    { id: MEMBER_ID, display_name: "Member", avatar_url: null, is_moderator: false },
    { id: UPLOADER_ID, display_name: "Uploader", avatar_url: null, is_moderator: false },
    { id: STRANGER_ID, display_name: "Stranger", avatar_url: null, is_moderator: false },
  ]);
  supa.seed("groups", [
    { id: GROUP_ID, name: "Gallery Group", cover_photo_key: null, owner_user_id: OWNER_ID },
  ]);
  supa.seed("group_members", [
    { group_id: GROUP_ID, user_id: OWNER_ID, role: "owner" },
    { group_id: GROUP_ID, user_id: ADMIN_ID, role: "admin" },
    { group_id: GROUP_ID, user_id: MEMBER_ID, role: "member" },
    { group_id: GROUP_ID, user_id: UPLOADER_ID, role: "member" },
  ]);
  return supa;
}

function seedPhoto(uploaderId: string) {
  return getMockSupa().insertSeed("group_photos", {
    group_id: GROUP_ID,
    uploader_user_id: uploaderId,
    storage_key: `groups/${GROUP_ID}/photos/seed.jpg`,
    width: null,
    height: null,
    caption: null,
    hidden_at: null,
  });
}

describe("GET /api/groups/:groupId/photos", () => {
  beforeEach(() => {
    seedBase();
  });

  it("requires auth (401)", async () => {
    const res = await request(makeApp()).get(`/api/groups/${GROUP_ID}/photos`);
    expect(res.status).toBe(401);
  });

  it("blocks non-members (403)", async () => {
    const res = await request(makeApp(STRANGER_ID)).get(
      `/api/groups/${GROUP_ID}/photos`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a member/i);
  });

  it("returns photos to a member", async () => {
    seedPhoto(UPLOADER_ID);
    const res = await request(makeApp(MEMBER_ID)).get(
      `/api/groups/${GROUP_ID}/photos`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].uploader_user_id).toBe(UPLOADER_ID);
  });

  it("excludes photos with hidden_at set", async () => {
    const supa = getMockSupa();
    supa.insertSeed("group_photos", {
      group_id: GROUP_ID,
      uploader_user_id: UPLOADER_ID,
      storage_key: "groups/x/photos/visible.jpg",
      hidden_at: null,
      created_at: "2026-01-01T00:00:00Z",
    });
    supa.insertSeed("group_photos", {
      group_id: GROUP_ID,
      uploader_user_id: UPLOADER_ID,
      storage_key: "groups/x/photos/hidden.jpg",
      hidden_at: "2026-02-01T00:00:00Z",
      created_at: "2026-01-02T00:00:00Z",
    });
    const res = await request(makeApp(MEMBER_ID)).get(
      `/api/groups/${GROUP_ID}/photos`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].storage_key).toBe("groups/x/photos/visible.jpg");
  });
});

describe("POST /api/groups/:groupId/photos/upload-url", () => {
  beforeEach(() => {
    seedBase();
  });

  it("requires auth (401)", async () => {
    const res = await request(makeApp()).post(
      `/api/groups/${GROUP_ID}/photos/upload-url`,
    );
    expect(res.status).toBe(401);
  });

  it("blocks non-members (403)", async () => {
    const res = await request(makeApp(STRANGER_ID)).post(
      `/api/groups/${GROUP_ID}/photos/upload-url`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a member/i);
  });

  it("returns an upload URL with a group-scoped storage key", async () => {
    const res = await request(makeApp(MEMBER_ID)).post(
      `/api/groups/${GROUP_ID}/photos/upload-url`,
    );
    expect(res.status).toBe(200);
    expect(res.body.storageKey).toMatch(
      new RegExp(`^groups/${GROUP_ID}/photos/[0-9a-f-]+\\.jpg$`),
    );
    expect(res.body.uploadURL).toContain(res.body.storageKey);
    expect(res.body.objectPath).toBe(`/objects/${res.body.storageKey}`);
  });
});

describe("POST /api/groups/:groupId/photos (finalize)", () => {
  const validKey = `groups/${GROUP_ID}/photos/abc.jpg`;

  beforeEach(() => {
    seedBase();
  });

  afterEach(() => {
    setAclShouldFail(false);
  });

  it("requires auth (401)", async () => {
    const res = await request(makeApp())
      .post(`/api/groups/${GROUP_ID}/photos`)
      .send({ storageKey: validKey });
    expect(res.status).toBe(401);
  });

  it("blocks non-members (403)", async () => {
    const res = await request(makeApp(STRANGER_ID))
      .post(`/api/groups/${GROUP_ID}/photos`)
      .send({ storageKey: validKey });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a member/i);
  });

  it("rejects a storage key that doesn't match the group prefix (400)", async () => {
    const wrongKey = `groups/00000000-0000-4000-8000-000000000099/photos/x.jpg`;
    const res = await request(makeApp(MEMBER_ID))
      .post(`/api/groups/${GROUP_ID}/photos`)
      .send({ storageKey: wrongKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match this group/i);
  });

  it("returns 404 when the upload wasn't completed (ACL stamp fails)", async () => {
    setAclShouldFail(true);
    const res = await request(makeApp(MEMBER_ID))
      .post(`/api/groups/${GROUP_ID}/photos`)
      .send({ storageKey: validKey });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/upload not completed/i);
  });

  it("creates the photo row, attributes it to the uploader, and joins user info", async () => {
    const res = await request(makeApp(UPLOADER_ID))
      .post(`/api/groups/${GROUP_ID}/photos`)
      .send({ storageKey: validKey, width: 1024, height: 768, caption: "Summit" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      group_id: GROUP_ID,
      uploader_user_id: UPLOADER_ID,
      storage_key: validKey,
      width: 1024,
      height: 768,
      caption: "Summit",
      users: { id: UPLOADER_ID, display_name: "Uploader" },
    });
    expect(getMockSupa().rows("group_photos")).toHaveLength(1);
  });

  it("stamps the ACL public on the uploaded object", async () => {
    const { trySetObjectEntityAclPolicy } = getObjectStorageMocks();
    await request(makeApp(MEMBER_ID))
      .post(`/api/groups/${GROUP_ID}/photos`)
      .send({ storageKey: validKey });
    expect(trySetObjectEntityAclPolicy).toHaveBeenCalledWith(
      `/objects/${validKey}`,
      { owner: MEMBER_ID, visibility: "public" },
    );
  });
});

describe("DELETE /api/groups/:groupId/photos/:photoId", () => {
  beforeEach(() => {
    seedBase();
  });

  it("requires auth (401)", async () => {
    const p = seedPhoto(UPLOADER_ID);
    const res = await request(makeApp()).delete(
      `/api/groups/${GROUP_ID}/photos/${p.id}`,
    );
    expect(res.status).toBe(401);
  });

  it("blocks non-members (403)", async () => {
    const p = seedPhoto(UPLOADER_ID);
    const res = await request(makeApp(STRANGER_ID)).delete(
      `/api/groups/${GROUP_ID}/photos/${p.id}`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a member/i);
  });

  it("hard-deletes when the uploader removes their own photo", async () => {
    const p = seedPhoto(UPLOADER_ID);
    const { deleteObjectEntity } = getObjectStorageMocks();
    const res = await request(makeApp(UPLOADER_ID)).delete(
      `/api/groups/${GROUP_ID}/photos/${p.id}`,
    );
    expect(res.status).toBe(200);
    expect(getMockSupa().rows("group_photos")).toHaveLength(0);
    expect(deleteObjectEntity).toHaveBeenCalledWith(
      `/objects/${p.storage_key}`,
    );
  });

  it("soft-hides when the owner removes someone else's photo (sets hidden_at)", async () => {
    const p = seedPhoto(UPLOADER_ID);
    const res = await request(makeApp(OWNER_ID)).delete(
      `/api/groups/${GROUP_ID}/photos/${p.id}`,
    );
    expect(res.status).toBe(200);
    const stored = getMockSupa().rows("group_photos");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.hidden_at).not.toBeNull();
  });

  it("soft-hides when an admin removes someone else's photo (sets hidden_at)", async () => {
    const p = seedPhoto(UPLOADER_ID);
    const res = await request(makeApp(ADMIN_ID)).delete(
      `/api/groups/${GROUP_ID}/photos/${p.id}`,
    );
    expect(res.status).toBe(200);
    const stored = getMockSupa().rows("group_photos");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.hidden_at).not.toBeNull();
  });

  it("forbids a regular member from deleting someone else's photo (403)", async () => {
    const p = seedPhoto(UPLOADER_ID);
    const res = await request(makeApp(MEMBER_ID)).delete(
      `/api/groups/${GROUP_ID}/photos/${p.id}`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only the uploader/i);
    expect(getMockSupa().rows("group_photos")).toHaveLength(1);
  });

  it("returns 404 for a missing photo", async () => {
    const res = await request(makeApp(MEMBER_ID)).delete(
      `/api/groups/${GROUP_ID}/photos/00000000-0000-4000-8000-000000000000`,
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/groups/:groupId/photos/:photoId (caption)", () => {
  beforeEach(() => {
    seedBase();
  });

  it("blocks non-members (403)", async () => {
    const p = seedPhoto(UPLOADER_ID);
    const res = await request(makeApp(STRANGER_ID))
      .patch(`/api/groups/${GROUP_ID}/photos/${p.id}`)
      .send({ caption: "Nice" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a member/i);
  });

  it("lets the uploader update their own caption", async () => {
    const p = seedPhoto(UPLOADER_ID);
    const res = await request(makeApp(UPLOADER_ID))
      .patch(`/api/groups/${GROUP_ID}/photos/${p.id}`)
      .send({ caption: "Great view" });
    expect(res.status).toBe(200);
    expect(res.body.caption).toBe("Great view");
  });

  it("lets an admin update someone else's caption", async () => {
    const p = seedPhoto(UPLOADER_ID);
    const res = await request(makeApp(ADMIN_ID))
      .patch(`/api/groups/${GROUP_ID}/photos/${p.id}`)
      .send({ caption: "Admin edit" });
    expect(res.status).toBe(200);
    expect(res.body.caption).toBe("Admin edit");
  });

  it("forbids a regular member from editing someone else's caption (403)", async () => {
    const p = seedPhoto(UPLOADER_ID);
    const res = await request(makeApp(MEMBER_ID))
      .patch(`/api/groups/${GROUP_ID}/photos/${p.id}`)
      .send({ caption: "Nope" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only the uploader/i);
  });

  it("returns 404 for a missing photo", async () => {
    const res = await request(makeApp(UPLOADER_ID))
      .patch(`/api/groups/${GROUP_ID}/photos/00000000-0000-4000-8000-000000000000`)
      .send({ caption: "?" });
    expect(res.status).toBe(404);
  });
});
