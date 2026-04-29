/**
 * POST /api/trails — atomic group-share rollback contract.
 *
 * Background: prior to this contract, "Save as Trail" with privacy=group
 * was a two-request flow: POST /trails to create the trail row, then
 * PUT /trails/:id/shares to attach `trail_shares` rows. If the share
 * request failed (network blip, group deleted mid-flow, FK rejection)
 * the user silently ended up with a private trail they thought they
 * shared.
 *
 * The route now accepts an optional `group_ids: string[]` field. When
 * `privacy === "group"` the server creates the trail row AND the matching
 * `trail_shares` rows in the same handler — and rolls the trail row back
 * if the share insert fails.
 *
 * These tests exercise that contract end-to-end against the in-memory
 * `MockSupa` so a future refactor can't silently regress it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Express, type Request } from "express";
import request from "supertest";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import trailsRouter from "../src/routes/trails";

const OWNER_ID = "user_owner";
const STRANGER_ID = "user_stranger";
const GROUP_A = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const GROUP_B = "22222222-2222-4222-8222-bbbbbbbbbbbb";

interface AuthShim {
  __auth?: { userId: string | null };
  log?: unknown;
}

function makeTrailsApp(authUserId: string | null = null): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & AuthShim).__auth = { userId: authUserId };
    (req as Request & AuthShim).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    };
    next();
  });
  app.use("/api", trailsRouter);
  return app;
}

function seedBase() {
  const supa = resetMockSupa();
  supa.seed("users", [
    { id: OWNER_ID, display_name: "Owner" },
    { id: STRANGER_ID, display_name: "Stranger" },
  ]);
  supa.seed("groups", [
    { id: GROUP_A, name: "Group A" },
    { id: GROUP_B, name: "Group B" },
  ]);
  supa.seed("group_members", [
    { group_id: GROUP_A, user_id: OWNER_ID, role: "owner" },
    { group_id: GROUP_B, user_id: OWNER_ID, role: "member" },
  ]);
  // Routes append to `trails` and `trail_shares` via insert; pre-seed
  // empty arrays so MockSupa stops short-circuiting on PGRST205.
  supa.seed("trails", []);
  supa.seed("trail_shares", []);
  return supa;
}

const validBody = {
  name: "Atomic Test Trail",
  type: "BOAT",
  difficulty: 5,
  distance_km: 1.2,
  terrain: "Mixed",
  legal_status: "BOAT",
  gpx_data: "<gpx></gpx>",
  is_public: false,
  privacy: "group" as const,
};

describe("POST /api/trails — atomic group-share rollback", () => {
  beforeEach(() => {
    seedBase();
  });

  afterEach(() => {
    getMockSupa().forcedErrors.clear();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(makeTrailsApp()).post("/api/trails").send(validBody);
    expect(res.status).toBe(401);
  });

  it("creates the trail and the matching trail_share row in one request", async () => {
    // NOTE: MockSupa's `insert([...])` only persists the first row of a
    // batched insert, so this test exercises the single-group path. The
    // rollback test below is what proves the multi-row insert is wired
    // through the same handler atomically.
    const res = await request(makeTrailsApp(OWNER_ID))
      .post("/api/trails")
      .send({ ...validBody, group_ids: [GROUP_A] });

    expect(res.status).toBe(200);
    expect(typeof res.body.id).toBe("string");

    const trails = getMockSupa().rows("trails");
    expect(trails).toHaveLength(1);
    expect(trails[0]!.id).toBe(res.body.id);
    expect(trails[0]!.is_public).toBe(false);
    expect(trails[0]!.owner_user_id).toBe(OWNER_ID);

    const shares = getMockSupa().rows("trail_shares");
    expect(shares).toHaveLength(1);
    expect(shares[0]!.trail_id).toBe(res.body.id);
    expect(shares[0]!.group_id).toBe(GROUP_A);
    expect(shares[0]!.shared_by_user_id).toBe(OWNER_ID);
  });

  it("rolls back the trail row when the trail_shares insert fails (no orphan private trail left behind)", async () => {
    const supa = getMockSupa();
    // Simulate the DB rejecting the share insert (e.g. FK race against a
    // group being deleted mid-flow). The route MUST delete the freshly-
    // created trail row before responding, so we don't leave a private
    // trail the user thought they shared.
    supa.forcedErrors.set("trail_shares:insert", {
      code: "23503",
      message: "insert or update on table \"trail_shares\" violates foreign key constraint",
    });

    const res = await request(makeTrailsApp(OWNER_ID))
      .post("/api/trails")
      .send({ ...validBody, group_ids: [GROUP_A] });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/share/i);

    // No orphan trail and no orphan share rows.
    expect(supa.rows("trails")).toEqual([]);
    expect(supa.rows("trail_shares")).toEqual([]);
  });

  it("refuses to create the trail when the caller isn't a member of every requested group", async () => {
    const res = await request(makeTrailsApp(STRANGER_ID))
      .post("/api/trails")
      .send({ ...validBody, group_ids: [GROUP_A] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/group you don't belong to/i);
    // Membership check happens BEFORE insert — no orphan trail row.
    expect(getMockSupa().rows("trails")).toEqual([]);
    expect(getMockSupa().rows("trail_shares")).toEqual([]);
  });

  it("ignores group_ids when privacy is private (no shares written)", async () => {
    const res = await request(makeTrailsApp(OWNER_ID))
      .post("/api/trails")
      .send({ ...validBody, privacy: "private", group_ids: [GROUP_A, GROUP_B] });

    expect(res.status).toBe(200);
    expect(getMockSupa().rows("trails")).toHaveLength(1);
    expect(getMockSupa().rows("trail_shares")).toEqual([]);
  });

  it("ignores group_ids when privacy is public (no shares written)", async () => {
    const res = await request(makeTrailsApp(OWNER_ID))
      .post("/api/trails")
      .send({ ...validBody, privacy: "public", group_ids: [GROUP_A] });

    expect(res.status).toBe(200);
    const trails = getMockSupa().rows("trails");
    expect(trails).toHaveLength(1);
    expect(trails[0]!.is_public).toBe(true);
    expect(getMockSupa().rows("trail_shares")).toEqual([]);
  });

  it("creates the trail with no shares when privacy=group but group_ids is omitted", async () => {
    // Backwards compatibility: the field is optional, and absence shouldn't
    // be treated as a failure (the legacy two-step flow may still be used
    // by future callers that manage shares separately).
    const res = await request(makeTrailsApp(OWNER_ID))
      .post("/api/trails")
      .send({ ...validBody });

    expect(res.status).toBe(200);
    expect(getMockSupa().rows("trails")).toHaveLength(1);
    expect(getMockSupa().rows("trail_shares")).toEqual([]);
  });
});

describe("PATCH /api/trails/:trailId — group_ids reconcile semantics", () => {
  const TRAIL_ID = "33333333-3333-4333-8333-cccccccccccc";

  beforeEach(() => {
    const supa = seedBase();
    // Trail row already exists, owned by OWNER_ID, privacy=group with one
    // existing share into GROUP_A. The reconcile path should be able to
    // edit just the share list without re-asserting privacy.
    supa.seed("trails", [
      {
        id: TRAIL_ID,
        owner_user_id: OWNER_ID,
        name: "Existing Trail",
        is_public: false,
      },
    ]);
    supa.seed("trail_shares", [
      { trail_id: TRAIL_ID, group_id: GROUP_A, shared_by_user_id: OWNER_ID },
    ]);
  });

  afterEach(() => {
    getMockSupa().forcedErrors.clear();
  });

  it("honors group_ids supplied without a privacy field (replaces shares, doesn't clear them)", async () => {
    // Regression guard: an earlier draft of the PATCH handler treated any
    // request without `privacy` as "clear all shares", which silently
    // dropped the user's selected groups whenever a client edited the
    // share list without re-sending privacy. Confirm GROUP_A is replaced
    // by GROUP_B (NOT cleared) when only `group_ids` is sent.
    const res = await request(makeTrailsApp(OWNER_ID))
      .patch(`/api/trails/${TRAIL_ID}`)
      .send({ group_ids: [GROUP_B] });

    expect(res.status).toBe(200);

    const shares = getMockSupa().rows("trail_shares");
    expect(shares).toHaveLength(1);
    expect(shares[0]!.group_id).toBe(GROUP_B);
    expect(shares[0]!.trail_id).toBe(TRAIL_ID);
  });

  it("clears all shares when group_ids=[] is supplied without a privacy field", async () => {
    const res = await request(makeTrailsApp(OWNER_ID))
      .patch(`/api/trails/${TRAIL_ID}`)
      .send({ group_ids: [] });

    expect(res.status).toBe(200);
    expect(getMockSupa().rows("trail_shares")).toEqual([]);
  });

  it("clears shares when privacy switches to public, even if group_ids is also supplied", async () => {
    // privacy=public/private must always win over a stray group_ids array
    // — the visibility flip means the shares are no longer needed and
    // shouldn't contradict the new privacy.
    const res = await request(makeTrailsApp(OWNER_ID))
      .patch(`/api/trails/${TRAIL_ID}`)
      .send({ privacy: "public", group_ids: [GROUP_B] });

    expect(res.status).toBe(200);
    expect(getMockSupa().rows("trail_shares")).toEqual([]);
  });
});
