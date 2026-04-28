import { describe, it, beforeEach, expect } from "vitest";
import request from "supertest";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const TRAIL_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "user_owner";
const AUTHOR_ID = "user_author";
const MOD_ID = "user_mod";
const STRANGER_ID = "user_stranger";

function seedBase() {
  const supa = resetMockSupa();
  supa.seed("trails", [{ id: TRAIL_ID, owner_user_id: OWNER_ID, name: "Notes Trail" }]);
  supa.seed("users", [
    { id: OWNER_ID, display_name: "Owner", avatar_url: null, is_moderator: false },
    { id: AUTHOR_ID, display_name: "Note Author", avatar_url: null, is_moderator: false },
    { id: MOD_ID, display_name: "Mod", avatar_url: null, is_moderator: true },
    { id: STRANGER_ID, display_name: "Stranger", avatar_url: null, is_moderator: false },
  ]);
  return supa;
}

describe("Trail notes endpoints", () => {
  beforeEach(() => {
    seedBase();
  });

  describe("GET /api/trails/:trailId/notes", () => {
    it("returns an empty list when the table is missing (PGRST205)", async () => {
      getMockSupa().missingTables.add("trail_notes");
      const res = await request(makeApp()).get(`/api/trails/${TRAIL_ID}/notes`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [] });
    });

    it("returns visible notes (excluding hidden) newest-first with author joined", async () => {
      const supa = getMockSupa();
      supa.seed("trail_notes", [
        {
          id: "n-1",
          trail_id: TRAIL_ID,
          author_user_id: AUTHOR_ID,
          body: "Old note",
          kind: "info",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          hidden_at: null,
        },
        {
          id: "n-2",
          trail_id: TRAIL_ID,
          author_user_id: AUTHOR_ID,
          body: "Newer note",
          kind: "warning",
          created_at: "2026-02-01T00:00:00Z",
          updated_at: "2026-02-01T00:00:00Z",
          hidden_at: null,
        },
        {
          id: "n-hidden",
          trail_id: TRAIL_ID,
          author_user_id: AUTHOR_ID,
          body: "Should be hidden",
          kind: "info",
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
          hidden_at: "2026-03-02T00:00:00Z",
        },
      ]);
      const res = await request(makeApp()).get(`/api/trails/${TRAIL_ID}/notes`);
      expect(res.status).toBe(200);
      expect(res.body.items.map((n: { id: string }) => n.id)).toEqual(["n-2", "n-1"]);
      expect(res.body.items[0].users).toEqual({
        id: AUTHOR_ID,
        display_name: "Note Author",
        avatar_url: null,
      });
    });
  });

  describe("POST /api/trails/:trailId/notes", () => {
    it("rejects anonymous callers with 401", async () => {
      const res = await request(makeApp())
        .post(`/api/trails/${TRAIL_ID}/notes`)
        .send({ body: "hi" });
      expect(res.status).toBe(401);
    });

    it("rejects empty bodies with 400", async () => {
      const res = await request(makeApp(AUTHOR_ID))
        .post(`/api/trails/${TRAIL_ID}/notes`)
        .send({ body: "   " });
      expect(res.status).toBe(400);
    });

    it("creates a note attributed to the signed-in author and returns the joined row", async () => {
      const res = await request(makeApp(AUTHOR_ID))
        .post(`/api/trails/${TRAIL_ID}/notes`)
        .send({ body: "Bridge out at 3km", kind: "warning" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        trail_id: TRAIL_ID,
        author_user_id: AUTHOR_ID,
        body: "Bridge out at 3km",
        kind: "warning",
        users: { id: AUTHOR_ID, display_name: "Note Author", avatar_url: null },
      });
      expect(getMockSupa().rows("trail_notes")).toHaveLength(1);
    });

    it("defaults the note kind to 'info' when omitted", async () => {
      const res = await request(makeApp(AUTHOR_ID))
        .post(`/api/trails/${TRAIL_ID}/notes`)
        .send({ body: "All good" });
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("info");
    });
  });

  describe("PATCH /api/trails/:trailId/notes/:noteId", () => {
    it("lets the author edit their own note", async () => {
      const created = await request(makeApp(AUTHOR_ID))
        .post(`/api/trails/${TRAIL_ID}/notes`)
        .send({ body: "Original" });
      const noteId = created.body.id as string;
      const res = await request(makeApp(AUTHOR_ID))
        .patch(`/api/trails/${TRAIL_ID}/notes/${noteId}`)
        .send({ body: "Edited" });
      expect(res.status).toBe(200);
      expect(res.body.body).toBe("Edited");
    });

    it("forbids someone else from editing the note", async () => {
      const created = await request(makeApp(AUTHOR_ID))
        .post(`/api/trails/${TRAIL_ID}/notes`)
        .send({ body: "Mine" });
      const res = await request(makeApp(STRANGER_ID))
        .patch(`/api/trails/${TRAIL_ID}/notes/${created.body.id}`)
        .send({ body: "Hijack" });
      expect(res.status).toBe(403);
    });

    it("returns 404 when the note doesn't exist", async () => {
      const res = await request(makeApp(AUTHOR_ID))
        .patch(`/api/trails/${TRAIL_ID}/notes/00000000-0000-4000-8000-000000000000`)
        .send({ body: "x" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/trails/:trailId/notes/:noteId", () => {
    it("hard-deletes the note when the author is removing it", async () => {
      const created = await request(makeApp(AUTHOR_ID))
        .post(`/api/trails/${TRAIL_ID}/notes`)
        .send({ body: "to delete" });
      const res = await request(makeApp(AUTHOR_ID))
        .delete(`/api/trails/${TRAIL_ID}/notes/${created.body.id}`);
      expect(res.status).toBe(200);
      expect(getMockSupa().rows("trail_notes")).toHaveLength(0);
    });

    it("soft-hides the note when a moderator removes it (audit-friendly)", async () => {
      const created = await request(makeApp(AUTHOR_ID))
        .post(`/api/trails/${TRAIL_ID}/notes`)
        .send({ body: "questionable" });
      const res = await request(makeApp(MOD_ID))
        .delete(`/api/trails/${TRAIL_ID}/notes/${created.body.id}`);
      expect(res.status).toBe(200);
      const stored = getMockSupa().rows("trail_notes");
      expect(stored).toHaveLength(1);
      expect(stored[0]!.hidden_at).not.toBeNull();
    });

    it("forbids a stranger from deleting someone else's note", async () => {
      const created = await request(makeApp(AUTHOR_ID))
        .post(`/api/trails/${TRAIL_ID}/notes`)
        .send({ body: "leave me" });
      const res = await request(makeApp(STRANGER_ID))
        .delete(`/api/trails/${TRAIL_ID}/notes/${created.body.id}`);
      expect(res.status).toBe(403);
      expect(getMockSupa().rows("trail_notes")).toHaveLength(1);
    });
  });
});
