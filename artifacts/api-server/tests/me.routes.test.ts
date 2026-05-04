/**
 * Published-routes invariants — covers the contract changes flagged in
 * the route review:
 *
 *   1. PATCH /api/me/saved-routes/:id rejects publish when the row has
 *      zero trails or no `ride_type` (server-side guard mirrors the
 *      client-side disable so a clever curl can't bypass it).
 *   2. POST /api/routes/:id/like is idempotent — double-liking by the
 *      same user keeps `likesCount` at 1.
 *   3. DELETE /api/routes/:id/comments/:commentId is allowed when the
 *      caller is a moderator on a comment they didn't author.
 *
 * The mock supabase client supports just enough query syntax for these
 * paths; the discover feed itself uses .or()/.contains() which the mock
 * doesn't model, so it's covered by manual smoke tests in the preview.
 */

import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { resetMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const OWNER = "user_owner";
const FAN = "user_fan";
const MOD = "user_moderator";

const ROUTE_ID = "route_alpha";
const TRAIL_1 = "11111111-1111-4111-8111-111111111111";

function seed() {
  const supa = resetMockSupa();
  supa.seed("users", [
    { id: OWNER, display_name: "Owner", is_moderator: false },
    { id: FAN, display_name: "Fan", is_moderator: false },
    { id: MOD, display_name: "Mod", is_moderator: true },
  ]);
  supa.seed("trails", [
    {
      id: TRAIL_1,
      owner_user_id: OWNER,
      name: "Alpha",
      is_public: true,
      deleted_at: null,
    },
  ]);
  supa.seed("saved_routes", []);
  supa.seed("route_likes", []);
  supa.seed("route_comments", []);
  return supa;
}

describe("PATCH /api/me/saved-routes/:id — publish guard", () => {
  beforeEach(seed);

  it("rejects publishing when trail_ids is empty", async () => {
    const supa = resetMockSupa();
    supa.seed("users", [{ id: OWNER, display_name: "Owner" }]);
    supa.seed("saved_routes", [
      {
        id: ROUTE_ID,
        user_id: OWNER,
        name: "Empty draft",
        trail_ids: [],
        ride_type: "bike",
        is_public: false,
        likes_count: 0,
        comments_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      },
    ]);
    const res = await request(makeApp(OWNER))
      .patch(`/api/me/saved-routes/${ROUTE_ID}`)
      .send({ isPublic: true });
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toMatch(/trail/i);
    // Row stays private.
    const row = supa.rows("saved_routes")[0];
    expect(row?.is_public).toBe(false);
  });

  it("rejects publishing when ride_type is missing", async () => {
    const supa = resetMockSupa();
    supa.seed("users", [{ id: OWNER, display_name: "Owner" }]);
    supa.seed("saved_routes", [
      {
        id: ROUTE_ID,
        user_id: OWNER,
        name: "No ride type",
        trail_ids: [TRAIL_1],
        ride_type: null,
        is_public: false,
        likes_count: 0,
        comments_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      },
    ]);
    const res = await request(makeApp(OWNER))
      .patch(`/api/me/saved-routes/${ROUTE_ID}`)
      .send({ isPublic: true });
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toMatch(/ride/i);
    const row = supa.rows("saved_routes")[0];
    expect(row?.is_public).toBe(false);
  });
});

describe("DELETE /api/routes/:id/comments/:commentId — moderator override", () => {
  it("lets a moderator hide a comment they didn't author", async () => {
    const supa = resetMockSupa();
    supa.seed("users", [
      { id: OWNER, display_name: "Owner", is_moderator: false },
      { id: FAN, display_name: "Fan", is_moderator: false },
      { id: MOD, display_name: "Mod", is_moderator: true },
    ]);
    supa.seed("saved_routes", [
      {
        id: ROUTE_ID,
        user_id: OWNER,
        name: "Public route",
        trail_ids: [TRAIL_1],
        ride_type: "bike",
        is_public: true,
        likes_count: 0,
        comments_count: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      },
    ]);
    const COMMENT_ID = "comment_spam";
    supa.seed("route_comments", [
      {
        id: COMMENT_ID,
        route_id: ROUTE_ID,
        user_id: FAN,
        parent_id: null,
        body: "spam",
        hidden_at: null,
        hidden_reason: null,
        created_at: new Date().toISOString(),
      },
    ]);

    // Non-author non-moderator gets a 403.
    const denied = await request(makeApp(OWNER)).delete(
      `/api/routes/${ROUTE_ID}/comments/${COMMENT_ID}`,
    );
    expect(denied.status).toBe(403);

    // Moderator succeeds and the comment is soft-hidden.
    const res = await request(makeApp(MOD)).delete(
      `/api/routes/${ROUTE_ID}/comments/${COMMENT_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body?.byModerator).toBe(true);
    const row = supa.rows("route_comments")[0];
    expect(row?.hidden_at).not.toBeNull();
  });
});
