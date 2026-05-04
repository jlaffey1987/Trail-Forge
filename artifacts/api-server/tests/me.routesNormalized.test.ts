/**
 * Regression coverage for two third-round review demands:
 *
 *   1. POST /api/me/saved-routes must NOT count soft-deleted rows
 *      toward the per-user cap. A rider sitting at 50 saved routes who
 *      deletes one should be able to immediately save another. Round 2
 *      regressed this when the cap query stopped filtering on
 *      `deleted_at IS NULL`.
 *
 *   2. GET /api/routes/:id reads ordered trail ids from the normalized
 *      `route_trails` join table (migration 0023), not from the legacy
 *      `saved_routes.trail_ids` jsonb mirror. The mirror is kept only
 *      as a fallback for rows written before the migration ran.
 */

import { describe, expect, it } from "vitest";
import request from "supertest";
import { resetMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const OWNER = "user_owner";

const TRAIL_A = "11111111-1111-4111-8111-111111111111";
const TRAIL_B = "22222222-2222-4222-8222-222222222222";
const TRAIL_C = "33333333-3333-4333-8333-333333333333";

const SAVED_ROUTES_PER_USER_LIMIT = 50;

function isoNow(): string {
  return new Date().toISOString();
}

describe("POST /api/me/saved-routes — limit excludes soft-deleted", () => {
  it("allows a new save when all existing rows are soft-deleted", async () => {
    const supa = resetMockSupa();
    supa.seed("users", [{ id: OWNER, display_name: "Owner" }]);
    supa.seed("trails", [
      {
        id: TRAIL_A,
        owner_user_id: OWNER,
        name: "Alpha",
        is_public: true,
        deleted_at: null,
      },
    ]);
    // Pre-fill exactly the cap with rows that are all soft-deleted.
    const deletedAt = isoNow();
    const fill = Array.from(
      { length: SAVED_ROUTES_PER_USER_LIMIT },
      (_, i) => ({
        id: `route_old_${i}`,
        user_id: OWNER,
        name: `old ${i}`,
        trail_ids: [TRAIL_A],
        ride_type: "adventure",
        is_public: false,
        likes_count: 0,
        comments_count: 0,
        created_at: isoNow(),
        updated_at: isoNow(),
        deleted_at: deletedAt,
      }),
    );
    supa.seed("saved_routes", fill);

    const res = await request(makeApp(OWNER))
      .post("/api/me/saved-routes")
      .send({
        name: "Fresh route",
        trailIds: [TRAIL_A],
        waypoints: [],
        entryOrder: [{ kind: "trail", id: TRAIL_A }],
        rideType: "adventure",
      });

    expect(res.status).toBe(200);
    expect(res.body?.route?.name).toBe("Fresh route");
    // The new row landed in the table (the soft-deleted ones are still
    // there, untouched).
    const active = supa
      .rows("saved_routes")
      .filter((r) => r.deleted_at == null);
    expect(active.length).toBe(1);
    expect(active[0]?.name).toBe("Fresh route");
  });

  it("blocks the save when the active count is at the cap", async () => {
    const supa = resetMockSupa();
    supa.seed("users", [{ id: OWNER, display_name: "Owner" }]);
    supa.seed("trails", [
      {
        id: TRAIL_A,
        owner_user_id: OWNER,
        name: "Alpha",
        is_public: true,
        deleted_at: null,
      },
    ]);
    const fill = Array.from(
      { length: SAVED_ROUTES_PER_USER_LIMIT },
      (_, i) => ({
        id: `route_active_${i}`,
        user_id: OWNER,
        name: `active ${i}`,
        trail_ids: [TRAIL_A],
        ride_type: "adventure",
        is_public: false,
        likes_count: 0,
        comments_count: 0,
        created_at: isoNow(),
        updated_at: isoNow(),
        deleted_at: null,
      }),
    );
    supa.seed("saved_routes", fill);

    const res = await request(makeApp(OWNER))
      .post("/api/me/saved-routes")
      .send({
        name: "One too many",
        trailIds: [TRAIL_A],
        waypoints: [],
        entryOrder: [{ kind: "trail", id: TRAIL_A }],
        rideType: "adventure",
      });

    expect(res.status).toBe(409);
    expect(String(res.body?.error ?? "")).toMatch(/limit/i);
  });
});

describe("GET /api/routes/:id — normalized route_trails order", () => {
  it("uses route_trails order over the legacy trail_ids mirror", async () => {
    const supa = resetMockSupa();
    supa.seed("users", [{ id: OWNER, display_name: "Owner" }]);
    supa.seed("trails", [
      {
        id: TRAIL_A,
        owner_user_id: OWNER,
        name: "Alpha",
        is_public: true,
        deleted_at: null,
      },
      {
        id: TRAIL_B,
        owner_user_id: OWNER,
        name: "Bravo",
        is_public: true,
        deleted_at: null,
      },
      {
        id: TRAIL_C,
        owner_user_id: OWNER,
        name: "Charlie",
        is_public: true,
        deleted_at: null,
      },
    ]);
    const ROUTE_ID = "route_normalized";
    // Legacy mirror has [A, B] in one order; the normalized join table
    // disagrees and lists [C, A, B] — the API must trust the join.
    supa.seed("saved_routes", [
      {
        id: ROUTE_ID,
        user_id: OWNER,
        name: "Public mix",
        trail_ids: [TRAIL_A, TRAIL_B],
        ride_type: "adventure",
        is_public: true,
        likes_count: 0,
        comments_count: 0,
        created_at: isoNow(),
        updated_at: isoNow(),
        deleted_at: null,
      },
    ]);
    supa.seed("route_trails", [
      { route_id: ROUTE_ID, position: 0, trail_id: TRAIL_C },
      { route_id: ROUTE_ID, position: 1, trail_id: TRAIL_A },
      { route_id: ROUTE_ID, position: 2, trail_id: TRAIL_B },
    ]);

    const res = await request(makeApp(OWNER)).get(`/api/routes/${ROUTE_ID}`);
    expect(res.status).toBe(200);
    const trailIds = (res.body?.route?.trails ?? []).map(
      (t: { id: string }) => t.id,
    );
    expect(trailIds).toEqual([TRAIL_C, TRAIL_A, TRAIL_B]);
  });

  it("falls back to trail_ids mirror when route_trails has no rows", async () => {
    // Legacy data path — a row written before migration 0023 has no
    // route_trails entries; the API should still serve it via the jsonb
    // mirror.
    const supa = resetMockSupa();
    supa.seed("users", [{ id: OWNER, display_name: "Owner" }]);
    supa.seed("trails", [
      {
        id: TRAIL_A,
        owner_user_id: OWNER,
        name: "Alpha",
        is_public: true,
        deleted_at: null,
      },
    ]);
    const ROUTE_ID = "route_legacy";
    supa.seed("saved_routes", [
      {
        id: ROUTE_ID,
        user_id: OWNER,
        name: "Legacy mirror",
        trail_ids: [TRAIL_A],
        ride_type: "adventure",
        is_public: true,
        likes_count: 0,
        comments_count: 0,
        created_at: isoNow(),
        updated_at: isoNow(),
        deleted_at: null,
      },
    ]);
    supa.seed("route_trails", []);

    const res = await request(makeApp(OWNER)).get(`/api/routes/${ROUTE_ID}`);
    expect(res.status).toBe(200);
    const trailIds = (res.body?.route?.trails ?? []).map(
      (t: { id: string }) => t.id,
    );
    expect(trailIds).toEqual([TRAIL_A]);
  });

  it("POST /api/me/saved-routes mirrors trail order into route_trails", async () => {
    const supa = resetMockSupa();
    supa.seed("users", [{ id: OWNER, display_name: "Owner" }]);
    supa.seed("trails", [
      {
        id: TRAIL_A,
        owner_user_id: OWNER,
        name: "Alpha",
        is_public: true,
        deleted_at: null,
      },
      {
        id: TRAIL_B,
        owner_user_id: OWNER,
        name: "Bravo",
        is_public: true,
        deleted_at: null,
      },
    ]);
    supa.seed("saved_routes", []);
    supa.seed("route_trails", []);

    const res = await request(makeApp(OWNER))
      .post("/api/me/saved-routes")
      .send({
        name: "Two-trail route",
        trailIds: [TRAIL_B, TRAIL_A],
        waypoints: [],
        entryOrder: [
          { kind: "trail", id: TRAIL_B },
          { kind: "trail", id: TRAIL_A },
        ],
        rideType: "adventure",
      });

    expect(res.status).toBe(200);
    const newRouteId = res.body?.id as string;
    expect(typeof newRouteId).toBe("string");

    const joinRows = supa
      .rows("route_trails")
      .filter((r) => r.route_id === newRouteId)
      .sort((a, b) => (a.position as number) - (b.position as number));
    expect(joinRows.map((r) => r.trail_id)).toEqual([TRAIL_B, TRAIL_A]);
    expect(joinRows.map((r) => r.position)).toEqual([0, 1]);
  });
});
