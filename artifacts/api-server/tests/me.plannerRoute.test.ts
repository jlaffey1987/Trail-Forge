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

// Private-trail visibility fixtures used by the visibility-filter suite
// at the bottom of the file. Distinct UUIDs from the public TRAIL_1..3
// so seedBase()'s public trails stay out of the way.
const PRIVATE_OTHER_OWNER = "44444444-4444-4444-8444-444444444444";
const PRIVATE_SHARED_IN_GROUP = "55555555-5555-4555-8555-555555555555";
const PRIVATE_SHARED_OUTSIDE_GROUP = "66666666-6666-4666-8666-666666666666";
const PRIVATE_OWNED_BY_CALLER = "77777777-7777-4777-8777-777777777777";

const GROUP_CALLER_IN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_CALLER_OUT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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

/**
 * Visibility filter on hydrated trails.
 *
 * `PUT /api/me/planner-route` doesn't validate that the caller can see
 * each trail id — the planner is the user's own scratchpad and we want
 * cheap writes. The real visibility boundary is enforced on `GET`:
 * `PLANNER_TRAIL_COLUMNS` rows are dropped from the hydrated response
 * unless the trail is public, owned by the caller, or shared into a
 * group the caller belongs to.
 *
 * Without that filter a curious user could PUT an arbitrary trail id
 * (guessed or scraped UUID) into their own planner row and read back
 * any private trail's metadata via the GET. This suite pins that
 * boundary across the three negative/positive cases.
 *
 * The trail ids must still appear in `trailIds` even when their rows
 * are dropped — the trailforge planner UI uses the id list to render
 * "trail no longer available" placeholders, so silently shrinking
 * `trailIds` would corrupt the saved order on the next PUT.
 */
describe("GET /api/me/planner-route — private-trail visibility filter", () => {
  beforeEach(() => {
    const supa = seedBase();
    supa.seed("groups", [
      { id: GROUP_CALLER_IN, name: "Caller's Group" },
      { id: GROUP_CALLER_OUT, name: "Outsider Group" },
    ]);
    // USER_A belongs to GROUP_CALLER_IN only. USER_B is in both groups so
    // they have permission to share into either; the read-side filter
    // depends solely on the *caller's* memberships.
    supa.seed("group_members", [
      { group_id: GROUP_CALLER_IN, user_id: USER_A, role: "member" },
      { group_id: GROUP_CALLER_IN, user_id: USER_B, role: "owner" },
      { group_id: GROUP_CALLER_OUT, user_id: USER_B, role: "owner" },
    ]);
    // Three private trails owned by USER_B (so USER_A is never the owner):
    //   - PRIVATE_OTHER_OWNER       — never shared anywhere
    //   - PRIVATE_SHARED_IN_GROUP   — shared into a group USER_A belongs to
    //   - PRIVATE_SHARED_OUTSIDE…   — shared into a group USER_A is NOT in
    supa.insertSeed("trails", {
      id: PRIVATE_OTHER_OWNER,
      owner_user_id: USER_B,
      name: "B's Solo Private Trail",
      is_public: false,
      deleted_at: null,
    });
    supa.insertSeed("trails", {
      id: PRIVATE_SHARED_IN_GROUP,
      owner_user_id: USER_B,
      name: "B's Trail Shared Into Caller's Group",
      is_public: false,
      deleted_at: null,
    });
    supa.insertSeed("trails", {
      id: PRIVATE_SHARED_OUTSIDE_GROUP,
      owner_user_id: USER_B,
      name: "B's Trail Shared Into Outsider Group",
      is_public: false,
      deleted_at: null,
    });
    supa.seed("trail_shares", [
      {
        trail_id: PRIVATE_SHARED_IN_GROUP,
        group_id: GROUP_CALLER_IN,
        shared_by_user_id: USER_B,
      },
      {
        trail_id: PRIVATE_SHARED_OUTSIDE_GROUP,
        group_id: GROUP_CALLER_OUT,
        shared_by_user_id: USER_B,
      },
    ]);
  });

  it("hydrates only the trails the caller is allowed to see, but echoes every id back so the client can render placeholders", async () => {
    // USER_A pushes a route mixing every visibility tier into their own
    // planner_routes row. The PUT accepts any id — the visibility check
    // is the GET handler's job. If that filter regresses, the GET would
    // happily hand back PRIVATE_OTHER_OWNER and
    // PRIVATE_SHARED_OUTSIDE_GROUP, which is the leak this test guards.
    const putRes = await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({
        trailIds: [
          PRIVATE_OTHER_OWNER,
          PRIVATE_SHARED_IN_GROUP,
          PRIVATE_SHARED_OUTSIDE_GROUP,
        ],
      });
    expect(putRes.status).toBe(200);

    const res = await request(makeApp(USER_A)).get("/api/me/planner-route");
    expect(res.status).toBe(200);
    // All three ids stay in `trailIds` so the client doesn't lose its
    // saved slot order on the next sync — placeholders render in their
    // place, but the order survives.
    expect(res.body.trailIds).toEqual([
      PRIVATE_OTHER_OWNER,
      PRIVATE_SHARED_IN_GROUP,
      PRIVATE_SHARED_OUTSIDE_GROUP,
    ]);
    // Only the trail shared into the group the caller belongs to has its
    // row hydrated. The other two private trails must NOT appear — neither
    // their metadata nor a shell row.
    const hydratedIds = (res.body.trails as Array<{ id: string }>).map(
      (t) => t.id,
    );
    expect(hydratedIds).toEqual([PRIVATE_SHARED_IN_GROUP]);
  });

  it("hydrates the caller's own private trail (owner override on the visibility filter)", async () => {
    // Owner override: the caller's own private trails must hydrate even
    // without is_public=true and without any group share, otherwise the
    // planner would be useless for trails you've drawn but not yet
    // published.
    getMockSupa().insertSeed("trails", {
      id: PRIVATE_OWNED_BY_CALLER,
      owner_user_id: USER_A,
      name: "A's Own Private Trail",
      is_public: false,
      deleted_at: null,
    });

    await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({ trailIds: [PRIVATE_OWNED_BY_CALLER, PRIVATE_OTHER_OWNER] });

    const res = await request(makeApp(USER_A)).get("/api/me/planner-route");
    expect(res.status).toBe(200);
    expect(res.body.trailIds).toEqual([
      PRIVATE_OWNED_BY_CALLER,
      PRIVATE_OTHER_OWNER,
    ]);
    // Own private trail hydrates; the other owner's private trail is
    // dropped from the hydrated payload.
    const hydratedIds = (res.body.trails as Array<{ id: string }>).map(
      (t) => t.id,
    );
    expect(hydratedIds).toEqual([PRIVATE_OWNED_BY_CALLER]);
  });

  it("does not leak a private trail just because the caller PUT its id into their own planner row", async () => {
    // The headline regression: a curious user discovers/guesses
    // PRIVATE_OTHER_OWNER's UUID and PUTs it into their own planner
    // route. Without the visibility filter, GET would happily return the
    // full trail row (name, bbox, gpx_object_path, …). With the filter,
    // `trailIds` echoes the id back but `trails` is empty.
    await request(makeApp(USER_A))
      .put("/api/me/planner-route")
      .send({ trailIds: [PRIVATE_OTHER_OWNER] });

    const res = await request(makeApp(USER_A)).get("/api/me/planner-route");
    expect(res.status).toBe(200);
    expect(res.body.trailIds).toEqual([PRIVATE_OTHER_OWNER]);
    expect(res.body.trails).toEqual([]);
  });
});
