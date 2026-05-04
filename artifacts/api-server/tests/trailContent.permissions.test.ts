import { describe, it, beforeEach, expect } from "vitest";
import request from "supertest";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const TRAIL_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "user_owner";
const MOD_ID = "user_mod";
const RANDOM_ID = "user_random";

describe("GET /api/trails/:trailId/permissions", () => {
  beforeEach(() => {
    const supa = resetMockSupa();
    supa.seed("trails", [{ id: TRAIL_ID, owner_user_id: OWNER_ID, name: "Big Hill" }]);
    supa.seed("users", [
      { id: OWNER_ID, display_name: "Owner", is_moderator: false },
      { id: MOD_ID, display_name: "Mod", is_moderator: true },
      { id: RANDOM_ID, display_name: "Rando", is_moderator: false },
    ]);
  });

  it("rejects an invalid trail id with 400", async () => {
    const res = await request(makeApp()).get("/api/trails/not-a-uuid/permissions");
    expect(res.status).toBe(400);
  });

  it("returns all-false for an anonymous viewer", async () => {
    const res = await request(makeApp()).get(`/api/trails/${TRAIL_ID}/permissions`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isOwner: false, isModerator: false, canModerate: false, isUnowned: false, adoptedAt: null, adopter: null });
  });

  it("flags the trail owner as canModerate", async () => {
    const res = await request(makeApp(OWNER_ID)).get(`/api/trails/${TRAIL_ID}/permissions`);
    expect(res.body).toEqual({ isOwner: true, isModerator: false, canModerate: true, isUnowned: false, adoptedAt: null, adopter: null });
  });

  it("flags a global moderator as canModerate", async () => {
    const res = await request(makeApp(MOD_ID)).get(`/api/trails/${TRAIL_ID}/permissions`);
    expect(res.body).toEqual({ isOwner: false, isModerator: true, canModerate: true, isUnowned: false, adoptedAt: null, adopter: null });
  });

  it("returns all-false for an unrelated signed-in user", async () => {
    const res = await request(makeApp(RANDOM_ID)).get(`/api/trails/${TRAIL_ID}/permissions`);
    expect(res.body).toEqual({ isOwner: false, isModerator: false, canModerate: false, isUnowned: false, adoptedAt: null, adopter: null });
    // Sanity: seed wasn't consumed.
    expect(getMockSupa().rows("users")).toHaveLength(3);
  });
});
