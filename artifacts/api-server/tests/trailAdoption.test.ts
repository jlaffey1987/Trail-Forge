import { describe, it, beforeEach, expect } from "vitest";
import request from "supertest";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const TRAIL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNED_TRAIL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADOPTER_ID = "user_adopter";
const OWNER_ID = "user_owner";
const PROPOSER_ID = "user_proposer";
const MOD_ID = "user_mod";

function seedBase() {
  const supa = resetMockSupa();
  supa.seed("trails", [
    {
      id: TRAIL_ID,
      owner_user_id: null,
      name: "Unowned Trail",
      difficulty: 3,
      type: "dirt",
      legal_status: "open",
      terrain: "gravel",
      is_public: true,
      adopted_at: null,
    },
    {
      id: OWNED_TRAIL_ID,
      owner_user_id: OWNER_ID,
      name: "Owned Trail",
      difficulty: 5,
      type: "singletrack",
      legal_status: "open",
      terrain: "dirt",
      is_public: true,
      adopted_at: null,
    },
  ]);
  supa.seed("users", [
    { id: ADOPTER_ID, display_name: "Adopter", avatar_url: null, is_moderator: false },
    { id: OWNER_ID, display_name: "Owner", avatar_url: null, is_moderator: false },
    { id: PROPOSER_ID, display_name: "Proposer", avatar_url: null, is_moderator: false },
    { id: MOD_ID, display_name: "Mod", avatar_url: null, is_moderator: true },
  ]);
  return supa;
}

describe("Trail adoption", () => {
  beforeEach(() => {
    seedBase();
  });

  describe("POST /api/trails/:trailId/adopt", () => {
    it("requires auth", async () => {
      const res = await request(makeApp())
        .post(`/api/trails/${TRAIL_ID}/adopt`)
        .send();
      expect(res.status).toBe(401);
    });

    it("succeeds on an unowned trail", async () => {
      const res = await request(makeApp(ADOPTER_ID))
        .post(`/api/trails/${TRAIL_ID}/adopt`)
        .send();
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.adoptedAt).toBeTruthy();
      expect(res.body.adopter).toMatchObject({
        id: ADOPTER_ID,
        display_name: "Adopter",
      });

      const trail = getMockSupa().rows("trails").find((t) => t.id === TRAIL_ID);
      expect(trail).toMatchObject({
        owner_user_id: ADOPTER_ID,
      });
      expect(trail!.adopted_at).toBeTruthy();

      const audit = getMockSupa().rows("trail_adoptions");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        trail_id: TRAIL_ID,
        adopted_by: ADOPTER_ID,
      });
    });

    it("fails on an already-owned trail (409)", async () => {
      const res = await request(makeApp(ADOPTER_ID))
        .post(`/api/trails/${OWNED_TRAIL_ID}/adopt`)
        .send();
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already has an owner/i);

      const trail = getMockSupa().rows("trails").find((t) => t.id === OWNED_TRAIL_ID);
      expect(trail!.owner_user_id).toBe(OWNER_ID);
    });

    it("fails if trail does not exist (404)", async () => {
      const res = await request(makeApp(ADOPTER_ID))
        .post("/api/trails/cccccccc-cccc-4ccc-8ccc-cccccccccccc/adopt")
        .send();
      expect(res.status).toBe(404);
    });

    it("returns 409 when two users race to adopt the same trail", async () => {
      const first = await request(makeApp(ADOPTER_ID))
        .post(`/api/trails/${TRAIL_ID}/adopt`)
        .send();
      expect(first.status).toBe(200);

      const second = await request(makeApp(PROPOSER_ID))
        .post(`/api/trails/${TRAIL_ID}/adopt`)
        .send();
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/already has an owner/i);

      const trail = getMockSupa().rows("trails").find((t) => t.id === TRAIL_ID);
      expect(trail!.owner_user_id).toBe(ADOPTER_ID);
    });
  });

  describe("GET /api/trails/:trailId/permissions — adoption info", () => {
    it("returns adopter info for an adopted trail", async () => {
      await request(makeApp(ADOPTER_ID))
        .post(`/api/trails/${TRAIL_ID}/adopt`)
        .send();

      const res = await request(makeApp())
        .get(`/api/trails/${TRAIL_ID}/permissions`)
        .send();
      expect(res.status).toBe(200);
      expect(res.body.isUnowned).toBe(false);
      expect(res.body.adoptedAt).toBeTruthy();
      expect(res.body.adopter).toMatchObject({
        id: ADOPTER_ID,
        display_name: "Adopter",
      });
    });

    it("returns null adopter for an unadopted trail", async () => {
      const res = await request(makeApp())
        .get(`/api/trails/${TRAIL_ID}/permissions`)
        .send();
      expect(res.status).toBe(200);
      expect(res.body.isUnowned).toBe(true);
      expect(res.body.adoptedAt).toBeNull();
      expect(res.body.adopter).toBeNull();
    });
  });
});

describe("Amendments with reason_category", () => {
  beforeEach(() => {
    seedBase();
  });

  it("persists reason_category on a new amendment", async () => {
    const res = await request(makeApp(PROPOSER_ID))
      .post(`/api/trails/${OWNED_TRAIL_ID}/amendments`)
      .send({
        proposedChanges: { difficulty: 7 },
        reason: "Surface has degraded",
        reasonCategory: "difficulty_change",
      });
    expect(res.status).toBe(200);
    expect(res.body.reason_category).toBe("difficulty_change");

    const stored = getMockSupa().rows("trail_amendments");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.reason_category).toBe("difficulty_change");
  });

  it("allows amendment without reason_category (backwards compatible)", async () => {
    const res = await request(makeApp(PROPOSER_ID))
      .post(`/api/trails/${OWNED_TRAIL_ID}/amendments`)
      .send({
        proposedChanges: { name: "Renamed" },
        reason: "Better name",
      });
    expect(res.status).toBe(200);
  });
});

describe("Removal amendment", () => {
  beforeEach(() => {
    seedBase();
  });

  it("creates a removal amendment with action=remove", async () => {
    const res = await request(makeApp(PROPOSER_ID))
      .post(`/api/trails/${OWNED_TRAIL_ID}/amendments`)
      .send({
        proposedChanges: { action: "remove" },
        reason: "Trail is on private land now",
        reasonCategory: "request_removal",
      });
    expect(res.status).toBe(200);
    expect(res.body.proposed_changes).toMatchObject({ action: "remove" });
    expect(res.body.reason_category).toBe("request_removal");
  });

  it("approving a removal amendment soft-deletes the trail", async () => {
    const createRes = await request(makeApp(PROPOSER_ID))
      .post(`/api/trails/${OWNED_TRAIL_ID}/amendments`)
      .send({
        proposedChanges: { action: "remove" },
        reason: "No longer lawful",
        reasonCategory: "request_removal",
      });
    expect(createRes.status).toBe(200);
    const amId = createRes.body.id;

    const approveRes = await request(makeApp(OWNER_ID))
      .post(`/api/trails/${OWNED_TRAIL_ID}/amendments/${amId}/approve`)
      .send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body).toMatchObject({ ok: true, applied: { action: "remove" } });

    const trail = getMockSupa().rows("trails").find((t) => t.id === OWNED_TRAIL_ID);
    expect(trail!.deleted_at).toBeTruthy();
    expect(trail!.is_public).toBe(false);

    const amendment = getMockSupa().rows("trail_amendments").find((a) => a.id === amId);
    expect(amendment!.status).toBe("approved");

    const audit = getMockSupa().rows("trail_amendment_history");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.previous_values).toMatchObject({ action: "remove", trail_was_visible: true });
  });
});
