import { describe, it, beforeEach, expect } from "vitest";
import request from "supertest";
import { resetMockSupa, getMockSupa, setAclShouldFail } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const TRAIL_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_TRAIL_ID = "44444444-4444-4444-8444-444444444444";
const OWNER_ID = "user_owner";
const PHOTOG_ID = "user_photog";
const MOD_ID = "user_mod";
const STRANGER_ID = "user_stranger";

function seedBase() {
  const supa = resetMockSupa();
  supa.seed("trails", [{ id: TRAIL_ID, owner_user_id: OWNER_ID, name: "Photo Trail" }]);
  supa.seed("users", [
    { id: OWNER_ID, display_name: "Owner", avatar_url: null, is_moderator: false },
    { id: PHOTOG_ID, display_name: "Photog", avatar_url: null, is_moderator: false },
    { id: MOD_ID, display_name: "Mod", avatar_url: null, is_moderator: true },
    { id: STRANGER_ID, display_name: "Stranger", avatar_url: null, is_moderator: false },
  ]);
  return supa;
}

describe("Trail photos endpoints", () => {
  beforeEach(() => {
    seedBase();
  });

  describe("POST /api/trails/:trailId/photos/upload-url", () => {
    it("requires auth", async () => {
      const res = await request(makeApp())
        .post(`/api/trails/${TRAIL_ID}/photos/upload-url`)
        .send({ contentType: "image/jpeg" });
      expect(res.status).toBe(401);
    });

    it("rejects non-image content types", async () => {
      const res = await request(makeApp(PHOTOG_ID))
        .post(`/api/trails/${TRAIL_ID}/photos/upload-url`)
        .send({ contentType: "video/mp4" });
      expect(res.status).toBe(400);
    });

    it("returns an upload URL with a trail-scoped storage key", async () => {
      const res = await request(makeApp(PHOTOG_ID))
        .post(`/api/trails/${TRAIL_ID}/photos/upload-url`)
        .send({ contentType: "image/jpeg" });
      expect(res.status).toBe(200);
      expect(res.body.storageKey).toMatch(
        new RegExp(`^trails/${TRAIL_ID}/photos/[0-9a-f-]+\\.jpg$`),
      );
      expect(res.body.uploadURL).toContain(res.body.storageKey);
      expect(res.body.objectPath).toBe(`/objects/${res.body.storageKey}`);
    });
  });

  describe("POST /api/trails/:trailId/photos", () => {
    const validKey = `trails/${TRAIL_ID}/photos/abc.jpg`;

    it("requires auth", async () => {
      const res = await request(makeApp())
        .post(`/api/trails/${TRAIL_ID}/photos`)
        .send({ storageKey: validKey });
      expect(res.status).toBe(401);
    });

    it("rejects a storage key that doesn't match the trail prefix", async () => {
      const res = await request(makeApp(PHOTOG_ID))
        .post(`/api/trails/${TRAIL_ID}/photos`)
        .send({ storageKey: `trails/${OTHER_TRAIL_ID}/photos/x.jpg` });
      expect(res.status).toBe(400);
    });

    it("returns 404 when the upload object isn't actually present", async () => {
      setAclShouldFail(true);
      const res = await request(makeApp(PHOTOG_ID))
        .post(`/api/trails/${TRAIL_ID}/photos`)
        .send({ storageKey: validKey });
      expect(res.status).toBe(404);
    });

    it("creates the photo row, attributes it to the uploader, and joins author info", async () => {
      const res = await request(makeApp(PHOTOG_ID))
        .post(`/api/trails/${TRAIL_ID}/photos`)
        .send({ storageKey: validKey, width: 800, height: 600, caption: "Summit" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        trail_id: TRAIL_ID,
        author_user_id: PHOTOG_ID,
        storage_key: validKey,
        width: 800,
        height: 600,
        caption: "Summit",
        users: { id: PHOTOG_ID, display_name: "Photog" },
      });
      expect(getMockSupa().rows("trail_photos")).toHaveLength(1);
    });
  });

  describe("DELETE /api/trails/:trailId/photos/:photoId", () => {
    function seedPhoto(authorId: string) {
      return getMockSupa().insertSeed("trail_photos", {
        trail_id: TRAIL_ID,
        author_user_id: authorId,
        storage_key: `trails/${TRAIL_ID}/photos/x.jpg`,
        width: null,
        height: null,
        caption: null,
        hidden_at: null,
      });
    }

    it("hard-deletes when the author removes their own photo", async () => {
      const p = seedPhoto(PHOTOG_ID);
      const res = await request(makeApp(PHOTOG_ID))
        .delete(`/api/trails/${TRAIL_ID}/photos/${p.id}`);
      expect(res.status).toBe(200);
      expect(getMockSupa().rows("trail_photos")).toHaveLength(0);
    });

    it("soft-hides when a moderator removes someone else's photo", async () => {
      const p = seedPhoto(PHOTOG_ID);
      const res = await request(makeApp(MOD_ID))
        .delete(`/api/trails/${TRAIL_ID}/photos/${p.id}`);
      expect(res.status).toBe(200);
      const stored = getMockSupa().rows("trail_photos");
      expect(stored).toHaveLength(1);
      expect(stored[0]!.hidden_at).not.toBeNull();
    });

    it("forbids a stranger from deleting someone else's photo", async () => {
      const p = seedPhoto(PHOTOG_ID);
      const res = await request(makeApp(STRANGER_ID))
        .delete(`/api/trails/${TRAIL_ID}/photos/${p.id}`);
      expect(res.status).toBe(403);
      expect(getMockSupa().rows("trail_photos")).toHaveLength(1);
    });

    it("returns 404 for a missing photo", async () => {
      const res = await request(makeApp(PHOTOG_ID))
        .delete(`/api/trails/${TRAIL_ID}/photos/00000000-0000-4000-8000-000000000000`);
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/trails/:trailId/photos", () => {
    it("hides photos with hidden_at set", async () => {
      const supa = getMockSupa();
      supa.insertSeed("trail_photos", {
        trail_id: TRAIL_ID,
        author_user_id: PHOTOG_ID,
        storage_key: "trails/x/photos/visible.jpg",
        hidden_at: null,
        created_at: "2026-01-01T00:00:00Z",
      });
      supa.insertSeed("trail_photos", {
        trail_id: TRAIL_ID,
        author_user_id: PHOTOG_ID,
        storage_key: "trails/x/photos/hidden.jpg",
        hidden_at: "2026-02-01T00:00:00Z",
        created_at: "2026-01-02T00:00:00Z",
      });
      const res = await request(makeApp()).get(`/api/trails/${TRAIL_ID}/photos`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].storage_key).toBe("trails/x/photos/visible.jpg");
    });
  });
});
