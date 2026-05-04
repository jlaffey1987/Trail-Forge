import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { resetMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const OWNER = "user_owner_lkz";
const STRANGER = "user_stranger_lkz";

const ROUTE_PRIVATE = "route_private_lkz";
const ROUTE_PUBLIC = "route_public_lkz";
const TRAIL = "11111111-1111-4111-8111-111111111111";

function seed() {
  const supa = resetMockSupa();
  supa.seed("users", [
    { id: OWNER, display_name: "Owner" },
    { id: STRANGER, display_name: "Stranger" },
  ]);
  supa.seed("trails", [
    { id: TRAIL, owner_user_id: OWNER, name: "T", is_public: true, deleted_at: null },
  ]);
  supa.seed("saved_routes", [
    {
      id: ROUTE_PRIVATE,
      user_id: OWNER,
      name: "Private",
      trail_ids: [TRAIL],
      ride_type: "bike",
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
      name: "Public",
      trail_ids: [TRAIL],
      ride_type: "bike",
      is_public: true,
      likes_count: 0,
      comments_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    },
  ]);
  supa.seed("route_likes", [
    { route_id: ROUTE_PRIVATE, user_id: STRANGER },
  ]);
  return supa;
}

describe("DELETE /api/routes/:id/like — visibility guard", () => {
  beforeEach(seed);

  it("returns 404 when a non-owner tries to unlike a private route", async () => {
    const supa = seed();
    const res = await request(makeApp(STRANGER)).delete(
      `/api/routes/${ROUTE_PRIVATE}/like`,
    );
    expect(res.status).toBe(404);
    const remaining = supa
      .rows("route_likes")
      .filter((r) => r.route_id === ROUTE_PRIVATE && r.user_id === STRANGER);
    expect(remaining.length).toBe(1);
  });

  it("returns 404 for a deleted/missing route id", async () => {
    const res = await request(makeApp(STRANGER)).delete(
      `/api/routes/route_does_not_exist/like`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp(null)).delete(
      `/api/routes/${ROUTE_PUBLIC}/like`,
    );
    expect(res.status).toBe(401);
  });

  it("succeeds (and is a no-op) for a public route the caller can see", async () => {
    const res = await request(makeApp(STRANGER)).delete(
      `/api/routes/${ROUTE_PUBLIC}/like`,
    );
    expect(res.status).toBe(200);
    expect(res.body?.liked).toBe(false);
  });
});
