/**
 * Public route detail visibility — covers the cases the reviewer flagged:
 *
 *   1. A signed-out caller fetching a private route gets 404.
 *   2. The owner fetching their own private route gets 200 with full
 *      trail hydration.
 *   3. A public route whose embedded trail rows are all soft-deleted
 *      hydrates to `trails: []` with `hiddenTrailCount` reflecting the
 *      missing rows so the UI can show "X trails hidden".
 *
 * The mock supabase client supports `.in(col, ids).eq("deleted_at", null)`
 * via its generic `.eq` filter — the deleted trail simply won't match.
 */

import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { resetMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const OWNER = "user_owner";
const STRANGER = "user_stranger";

const ROUTE_PRIVATE = "route_private";
const ROUTE_PUBLIC = "route_public";

const TRAIL_VISIBLE = "11111111-1111-4111-8111-111111111111";
const TRAIL_DELETED = "22222222-2222-4222-8222-222222222222";

function seed() {
  const supa = resetMockSupa();
  supa.seed("users", [
    { id: OWNER, display_name: "Owner" },
    { id: STRANGER, display_name: "Stranger" },
  ]);
  supa.seed("trails", [
    {
      id: TRAIL_VISIBLE,
      owner_user_id: OWNER,
      name: "Visible",
      is_public: true,
      deleted_at: null,
    },
    {
      id: TRAIL_DELETED,
      owner_user_id: OWNER,
      name: "Soft-deleted",
      is_public: true,
      deleted_at: new Date().toISOString(),
    },
  ]);
  supa.seed("saved_routes", [
    {
      id: ROUTE_PRIVATE,
      user_id: OWNER,
      name: "Owner draft",
      trail_ids: [TRAIL_VISIBLE],
      ride_type: "adventure",
      is_public: false,
      likes_count: 0,
      comments_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    },
    {
      id: ROUTE_PUBLIC,
      user_id: OWNER,
      name: "Public route",
      trail_ids: [TRAIL_DELETED],
      ride_type: "adventure",
      is_public: true,
      likes_count: 0,
      comments_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    },
  ]);
  supa.seed("route_likes", []);
  return supa;
}

describe("GET /api/routes/:id — visibility", () => {
  beforeEach(seed);

  it("returns 404 when an anonymous viewer requests a private route", async () => {
    const res = await request(makeApp(null)).get(
      `/api/routes/${ROUTE_PRIVATE}`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when a signed-in stranger requests another user's private route", async () => {
    const res = await request(makeApp(STRANGER)).get(
      `/api/routes/${ROUTE_PRIVATE}`,
    );
    expect(res.status).toBe(404);
  });

  it("returns the route to the owner with hydrated trails", async () => {
    const res = await request(makeApp(OWNER)).get(
      `/api/routes/${ROUTE_PRIVATE}`,
    );
    expect(res.status).toBe(200);
    expect(res.body?.route?.id).toBe(ROUTE_PRIVATE);
    expect(Array.isArray(res.body?.route?.trails)).toBe(true);
    expect(res.body.route.trails).toHaveLength(1);
    expect(res.body.route.trails[0].id).toBe(TRAIL_VISIBLE);
  });

  it("hides soft-deleted trails and reflects them in hiddenTrailCount", async () => {
    const res = await request(makeApp(STRANGER)).get(
      `/api/routes/${ROUTE_PUBLIC}`,
    );
    expect(res.status).toBe(200);
    expect(res.body?.route?.trails).toHaveLength(0);
    expect(res.body?.route?.hiddenTrailCount).toBe(1);
  });
});
