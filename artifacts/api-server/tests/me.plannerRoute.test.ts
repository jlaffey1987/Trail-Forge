/**
 * Cross-device planner-route sync — backend coverage.
 *
 * The Map / Planner persists each user's in-progress route to
 * `planner_routes` so a route built on phone A reappears on laptop B
 * after sign-in. These tests pin the contract the trailforge client
 * relies on:
 *
 *   PUT /api/me/planner-route   — owner upserts their singleton row
 *   GET /api/me/planner-route   — owner reads it back, hydrated with
 *                                 the trail rows in the saved order
 *
 * We exercise the round-trip across two `makeApp(USER)` instances
 * (each Express app is a fresh "device") sharing the same in-memory
 * `MockSupa` — that mirrors two devices hitting the same Postgres.
 */

import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const USER_A = "user_a_clerk";
const USER_B = "user_b_clerk";

const TRAIL_1 = "11111111-1111-4111-8111-111111111111";
const TRAIL_2 = "22222222-2222-4222-8222-222222222222";
const TRAIL_3 = "33333333-3333-4333-8333-333333333333";

function seedBase() {
  const supa = resetMockSupa();
  supa.seed("users", [
    { id: USER_A, display_name: "User A" },
    { id: USER_B, display_name: "User B" },
  ]);
  // All trails are public so visibility checks don't drop them from the
  // hydrated GET response — we want to verify the sync contract here,
  // not the visibility filter (that's covered in groupTrails.shares).
  supa.seed("trails", [
    {
      id: TRAIL_1,
      owner_user_id: USER_A,
      name: "Trail 1",
      is_public: true,
      deleted_at: null,
    },
    {
      id: TRAIL_2,
      owner_user_id: USER_A,
      name: "Trail 2",
      is_public: true,
      deleted_at: null,
    },
    {
      id: TRAIL_3,
      owner_user_id: USER_B,
      name: "Trail 3",
      is_public: true,
      deleted_at: null,
    },
  ]);
  supa.seed("planner_routes", []);
  return supa;
}

describe("PUT/GET /api/me/planner-route — auth", () => {
  beforeEach(seedBase);

  it("rejects an unauthenticated PUT with 401", async () => {
    const res = await request(makeApp())
      .put("/api/me/planner-route")
      .send({ trailIds: [TRAIL_1] });
    expect(res.status).toBe(401);
  });

  it("rejects an unauthenticated GET with 401", async () => {
    const res = await request(makeApp()).get("/api/me/planner-route");
    expect(res.status).toBe(401);
  });
});

describe("PUT/GET /api/me/planner-route — cross-device round-trip", () => {
  beforeEach(seedBase);

  it("a route saved on one device is returned in order on a fresh GET on another", async () => {
    // Device 1 (user A): build a two-trail route.
    const putRes = await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({
        trailIds: [TRAIL_1, TRAIL_2],
        waypoints: [],
        entryOrder: [
          { kind: "trail", id: TRAIL_1 },
          { kind: "trail", id: TRAIL_2 },
        ],
      });
    expect(putRes.status).toBe(200);
    expect(putRes.body.persisted).toBe(true);
    expect(typeof putRes.body.updatedAt).toBe("string");

    // Device 2 (same user, fresh app instance — i.e. another sign-in):
    // GET hydrates the saved trail ids + the trail rows in the saved order.
    const getRes = await request(makeApp(USER_A)).get("/api/me/planner-route");
    expect(getRes.status).toBe(200);
    expect(getRes.body.trailIds).toEqual([TRAIL_1, TRAIL_2]);
    expect(
      (getRes.body.trails as Array<{ id: string }>).map((t) => t.id),
    ).toEqual([TRAIL_1, TRAIL_2]);
    // Server echoes back our entryOrder so waypoints can be interleaved.
    expect(getRes.body.entryOrder).toEqual([
      { kind: "trail", id: TRAIL_1 },
      { kind: "trail", id: TRAIL_2 },
    ]);
  });

  it("preserves the saved trail order even when stored ids are out of natural order", async () => {
    // Reverse order: T2 before T1. Supabase doesn't guarantee `IN (...)`
    // ordering, so the route handler must re-order from `trailIds`.
    await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({ trailIds: [TRAIL_2, TRAIL_1] });

    const res = await request(makeApp(USER_A)).get("/api/me/planner-route");
    expect(res.status).toBe(200);
    expect(res.body.trailIds).toEqual([TRAIL_2, TRAIL_1]);
    expect(
      (res.body.trails as Array<{ id: string }>).map((t) => t.id),
    ).toEqual([TRAIL_2, TRAIL_1]);
  });

  it("isolates planner routes between users — B never sees A's route", async () => {
    await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({ trailIds: [TRAIL_1] });

    const aRes = await request(makeApp(USER_A)).get("/api/me/planner-route");
    expect(aRes.body.trailIds).toEqual([TRAIL_1]);

    const bRes = await request(makeApp(USER_B)).get("/api/me/planner-route");
    expect(bRes.status).toBe(200);
    expect(bRes.body.trailIds).toEqual([]);
    expect(bRes.body.trails).toEqual([]);
  });

  it("removing a trail on device 2 propagates to device 1 on next GET", async () => {
    // Device 1: original route — T1, T2.
    await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({ trailIds: [TRAIL_1, TRAIL_2] });

    // Device 2 (same user): drop T1.
    await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({ trailIds: [TRAIL_2] });

    // Device 1 refreshes — sees the trimmed route, not the stale one.
    const refreshed = await request(makeApp(USER_A)).get(
      "/api/me/planner-route",
    );
    expect(refreshed.body.trailIds).toEqual([TRAIL_2]);
    expect(
      (refreshed.body.trails as Array<{ id: string }>).map((t) => t.id),
    ).toEqual([TRAIL_2]);

    // The upsert must collapse onto the single per-user row — anything
    // else would mean `GET` was reading stale duplicates.
    const stored = getMockSupa().rows("planner_routes");
    expect(stored).toHaveLength(1);
    expect(stored[0].user_id).toBe(USER_A);
    expect(stored[0].trail_ids).toEqual([TRAIL_2]);
  });

  it("reordering trails on device 2 propagates to device 1 on next GET", async () => {
    await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({ trailIds: [TRAIL_1, TRAIL_2] });

    // Device 2: swap order.
    await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({ trailIds: [TRAIL_2, TRAIL_1] });

    const res = await request(makeApp(USER_A)).get("/api/me/planner-route");
    expect(res.body.trailIds).toEqual([TRAIL_2, TRAIL_1]);
    expect(
      (res.body.trails as Array<{ id: string }>).map((t) => t.id),
    ).toEqual([TRAIL_2, TRAIL_1]);
  });

  it("round-trips waypoints and the interleaved entryOrder alongside trails", async () => {
    const wp = {
      id: "wp-fuel-1",
      lat: 53.6,
      lng: -2.5,
      name: "Shell Garage",
      kind: "fuel" as const,
    };
    await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({
        trailIds: [TRAIL_1, TRAIL_2],
        waypoints: [wp],
        entryOrder: [
          { kind: "trail", id: TRAIL_1 },
          { kind: "waypoint", id: wp.id },
          { kind: "trail", id: TRAIL_2 },
        ],
      });

    const res = await request(makeApp(USER_A)).get("/api/me/planner-route");
    expect(res.body.waypoints).toEqual([wp]);
    expect(res.body.entryOrder).toEqual([
      { kind: "trail", id: TRAIL_1 },
      { kind: "waypoint", id: wp.id },
      { kind: "trail", id: TRAIL_2 },
    ]);
  });

  it("hydrate-on-sign-in precedence: a previously-saved server route wins over an empty client", async () => {
    // Device 1: sign in and save a route.
    await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({
        trailIds: [TRAIL_1, TRAIL_2],
        entryOrder: [
          { kind: "trail", id: TRAIL_1 },
          { kind: "trail", id: TRAIL_2 },
        ],
      });

    // Device 2 boots cold (empty localStorage equivalent) and signs in —
    // the very first thing the planner store does is GET. A non-empty
    // server response must be returned in full so the client can adopt
    // it instead of staying empty.
    const hydrate = await request(makeApp(USER_A)).get(
      "/api/me/planner-route",
    );
    expect(hydrate.status).toBe(200);
    expect(hydrate.body.trailIds.length).toBeGreaterThan(0);
    expect(
      (hydrate.body.trails as Array<{ id: string }>).map((t) => t.id),
    ).toEqual([TRAIL_1, TRAIL_2]);
  });

  it("hydrate-on-sign-in for first-ever sign-in: empty server returns an empty payload so the client can claim local", async () => {
    // No prior PUT. The client store treats an empty server response as
    // "I'm the first device", keeps any local route, and PUTs it.
    const res = await request(makeApp(USER_A)).get("/api/me/planner-route");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      trailIds: [],
      trails: [],
      waypoints: [],
      entryOrder: [],
    });
    expect(res.body.updatedAt).toBeNull();
  });
});

describe("PUT/GET /api/me/planner-route — input hardening", () => {
  beforeEach(seedBase);

  it("rejects a malformed PUT body with 400", async () => {
    const res = await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({ trailIds: "not-an-array" });
    expect(res.status).toBe(400);
  });

  it("strips dangling entryOrder refs that don't point at a trail or waypoint we saved", async () => {
    await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({
        trailIds: [TRAIL_1],
        waypoints: [],
        entryOrder: [
          { kind: "trail", id: TRAIL_1 },
          // Dangling — TRAIL_2 isn't in trailIds. Server should drop it
          // rather than reject the whole write so the client can race a
          // remove with a reorder without losing the rest of the route.
          { kind: "trail", id: TRAIL_2 },
          { kind: "waypoint", id: "ghost" },
        ],
      });

    const res = await request(makeApp(USER_A)).get("/api/me/planner-route");
    expect(res.body.entryOrder).toEqual([{ kind: "trail", id: TRAIL_1 }]);
  });

  it("de-dupes repeated trail ids in the saved order", async () => {
    await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({ trailIds: [TRAIL_1, TRAIL_1, TRAIL_2] });

    const res = await request(makeApp(USER_A)).get("/api/me/planner-route");
    expect(res.body.trailIds).toEqual([TRAIL_1, TRAIL_2]);
  });
});
