/**
 * Group-shared trail visibility — backend coverage.
 *
 * Exercises the share endpoints together so the contract between them
 * (owner-only mutation, member-only group targets, member-only readability,
 * soft-delete exclusion) can't silently regress and either leak private
 * trails to outsiders or hide them from the groups they were shared into:
 *
 *   GET  /api/trails/:trailId/shares      — owner reads its share list
 *   PUT  /api/trails/:trailId/shares      — owner replaces share list
 *   GET  /api/me/group-trails             — caller reads trails shared
 *                                           into groups they belong to
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const OWNER_ID = "user_owner";
const MEMBER_ID = "user_member";
const STRANGER_ID = "user_stranger";

const TRAIL_ID = "11111111-1111-4111-8111-111111111111";
const TRAIL_DELETED_ID = "44444444-4444-4444-8444-444444444444";
const TRAIL_OUTSIDE_ID = "55555555-5555-4555-8555-555555555555";

const GROUP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GROUP_OUTSIDE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function seedBase() {
  const supa = resetMockSupa();
  supa.seed("users", [
    { id: OWNER_ID, display_name: "Owner" },
    { id: MEMBER_ID, display_name: "Member" },
    { id: STRANGER_ID, display_name: "Stranger" },
  ]);
  supa.seed("groups", [
    { id: GROUP_A, name: "Group A" },
    { id: GROUP_B, name: "Group B" },
    { id: GROUP_OUTSIDE, name: "Outsider Group" },
  ]);
  // OWNER belongs to A and B (so they can share into either). MEMBER also
  // belongs to A so they can read trails shared into A. Nobody we care
  // about belongs to GROUP_OUTSIDE — it's the negative control.
  supa.seed("group_members", [
    { group_id: GROUP_A, user_id: OWNER_ID, role: "owner" },
    { group_id: GROUP_B, user_id: OWNER_ID, role: "member" },
    { group_id: GROUP_A, user_id: MEMBER_ID, role: "member" },
  ]);
  supa.seed("trails", [
    {
      id: TRAIL_ID,
      owner_user_id: OWNER_ID,
      name: "Owner's Private Trail",
      is_public: false,
      deleted_at: null,
    },
  ]);
  supa.seed("trail_shares", []);
  return supa;
}

describe("GET /api/trails/:trailId/shares — owner-only read", () => {
  beforeEach(() => {
    const supa = seedBase();
    supa.insertSeed("trail_shares", {
      trail_id: TRAIL_ID,
      group_id: GROUP_A,
      shared_by_user_id: OWNER_ID,
      shared_at: "2026-04-01T00:00:00Z",
    });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(makeApp()).get(`/api/trails/${TRAIL_ID}/shares`);
    expect(res.status).toBe(401);
  });

  it("returns the share list for the trail owner with the joined group name", async () => {
    const res = await request(makeApp(OWNER_ID)).get(`/api/trails/${TRAIL_ID}/shares`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      group_id: GROUP_A,
      name: "Group A",
    });
  });

  it("forbids non-owners from reading the share list (403)", async () => {
    const res = await request(makeApp(STRANGER_ID)).get(`/api/trails/${TRAIL_ID}/shares`);
    expect(res.status).toBe(403);
  });

  it("returns 404 for a trail the caller doesn't have access to (no row)", async () => {
    const res = await request(makeApp(OWNER_ID)).get(
      `/api/trails/99999999-9999-4999-8999-999999999999/shares`,
    );
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/trails/:trailId/shares — owner mutates share list", () => {
  beforeEach(() => {
    seedBase();
  });

  afterEach(() => {
    getMockSupa().forcedErrors.clear();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(makeApp())
      .put(`/api/trails/${TRAIL_ID}/shares`)
      .send({ group_ids: [GROUP_A] });
    expect(res.status).toBe(401);
  });

  it("creates new share rows for the owner's trail", async () => {
    const res = await request(makeApp(OWNER_ID))
      .put(`/api/trails/${TRAIL_ID}/shares`)
      .send({ group_ids: [GROUP_A, GROUP_B] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, added: 2, removed: 0 });

    const shares = getMockSupa().rows("trail_shares");
    expect(shares).toHaveLength(2);
    const groupIds = shares.map((r) => r.group_id).sort();
    expect(groupIds).toEqual([GROUP_A, GROUP_B].sort());
    for (const r of shares) {
      expect(r.trail_id).toBe(TRAIL_ID);
      expect(r.shared_by_user_id).toBe(OWNER_ID);
    }
  });

  it("reconciles the share list — adds missing groups and removes ones not in the payload", async () => {
    // Pre-existing share into A. After PUT [B] we should be left with B
    // only — A removed, B added.
    getMockSupa().insertSeed("trail_shares", {
      trail_id: TRAIL_ID,
      group_id: GROUP_A,
      shared_by_user_id: OWNER_ID,
    });

    const res = await request(makeApp(OWNER_ID))
      .put(`/api/trails/${TRAIL_ID}/shares`)
      .send({ group_ids: [GROUP_B] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, added: 1, removed: 1 });

    const shares = getMockSupa().rows("trail_shares");
    expect(shares).toHaveLength(1);
    expect(shares[0]!.group_id).toBe(GROUP_B);
  });

  it("clears every share when the payload is an empty group_ids array", async () => {
    getMockSupa().insertSeed("trail_shares", {
      trail_id: TRAIL_ID,
      group_id: GROUP_A,
      shared_by_user_id: OWNER_ID,
    });
    getMockSupa().insertSeed("trail_shares", {
      trail_id: TRAIL_ID,
      group_id: GROUP_B,
      shared_by_user_id: OWNER_ID,
    });

    const res = await request(makeApp(OWNER_ID))
      .put(`/api/trails/${TRAIL_ID}/shares`)
      .send({ group_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, added: 0, removed: 2 });
    expect(getMockSupa().rows("trail_shares")).toEqual([]);
  });

  it("forbids a non-owner from mutating the share list (403)", async () => {
    const res = await request(makeApp(MEMBER_ID))
      .put(`/api/trails/${TRAIL_ID}/shares`)
      .send({ group_ids: [GROUP_A] });
    expect(res.status).toBe(403);
    // No share rows leaked through.
    expect(getMockSupa().rows("trail_shares")).toEqual([]);
  });

  it("forbids the owner from sharing into a group they don't belong to (403)", async () => {
    // GROUP_OUTSIDE exists but OWNER_ID isn't a group_members row for it.
    const res = await request(makeApp(OWNER_ID))
      .put(`/api/trails/${TRAIL_ID}/shares`)
      .send({ group_ids: [GROUP_OUTSIDE] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/group you don't belong to/i);
    expect(getMockSupa().rows("trail_shares")).toEqual([]);
  });

  it("returns 404 for a trail that does not exist", async () => {
    const res = await request(makeApp(OWNER_ID))
      .put(`/api/trails/99999999-9999-4999-8999-999999999999/shares`)
      .send({ group_ids: [GROUP_A] });
    expect(res.status).toBe(404);
  });

  it("rejects an invalid trail id with 400", async () => {
    const res = await request(makeApp(OWNER_ID))
      .put(`/api/trails/not-a-uuid/shares`)
      .send({ group_ids: [] });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/me/group-trails — visibility for shared trails", () => {
  beforeEach(() => {
    seedBase();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(makeApp()).get("/api/me/group-trails");
    expect(res.status).toBe(401);
  });

  it("returns trails shared into a group the caller belongs to, decorated with shared_groups", async () => {
    // Owner shares TRAIL_ID into GROUP_A. MEMBER belongs to GROUP_A and
    // should now see it in /me/group-trails with the join hydrated.
    getMockSupa().insertSeed("trail_shares", {
      trail_id: TRAIL_ID,
      group_id: GROUP_A,
      shared_by_user_id: OWNER_ID,
    });

    const res = await request(makeApp(MEMBER_ID)).get("/api/me/group-trails");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    const items = res.body.items as Array<{
      id: string;
      shared_groups: Array<{ id: string; name: string }>;
    }>;
    const seen = items.find((t) => t.id === TRAIL_ID);
    expect(seen).toBeDefined();
    expect(seen!.shared_groups).toEqual([{ id: GROUP_A, name: "Group A" }]);
  });

  it("does NOT return trails shared only into groups the caller is not a member of", async () => {
    // A second trail is shared into GROUP_OUTSIDE — MEMBER isn't in that
    // group, so the row must not appear in their /me/group-trails feed.
    const supa = getMockSupa();
    supa.insertSeed("trails", {
      id: TRAIL_OUTSIDE_ID,
      owner_user_id: OWNER_ID,
      name: "Outside Trail",
      is_public: false,
      deleted_at: null,
    });
    supa.insertSeed("trail_shares", {
      trail_id: TRAIL_OUTSIDE_ID,
      group_id: GROUP_OUTSIDE,
      shared_by_user_id: OWNER_ID,
    });

    const res = await request(makeApp(MEMBER_ID)).get("/api/me/group-trails");
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ id: string }>;
    expect(items.find((t) => t.id === TRAIL_OUTSIDE_ID)).toBeUndefined();
  });

  it("excludes soft-deleted trails even when they're still shared into the caller's group", async () => {
    // Trail with deleted_at != null shared into GROUP_A. MEMBER must not
    // see it — otherwise we'd hand out a deep-link they can't open and
    // potentially leak a trail that has been retracted.
    const supa = getMockSupa();
    supa.insertSeed("trails", {
      id: TRAIL_DELETED_ID,
      owner_user_id: OWNER_ID,
      name: "Retracted Trail",
      is_public: false,
      deleted_at: "2026-04-01T00:00:00Z",
    });
    supa.insertSeed("trail_shares", {
      trail_id: TRAIL_DELETED_ID,
      group_id: GROUP_A,
      shared_by_user_id: OWNER_ID,
    });

    const res = await request(makeApp(MEMBER_ID)).get("/api/me/group-trails");
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ id: string }>;
    expect(items.find((t) => t.id === TRAIL_DELETED_ID)).toBeUndefined();
  });

  it("returns an empty list when the caller belongs to no groups and owns no private trails", async () => {
    const res = await request(makeApp(STRANGER_ID)).get("/api/me/group-trails");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("includes the caller's own private trails (decorated with empty shared_groups when not shared)", async () => {
    // Sanity check on the union semantics: even if MEMBER isn't in any
    // group with shared trails, their own private trails should still show
    // up in this feed. Switch perspective to OWNER, who has TRAIL_ID
    // private and unshared.
    const res = await request(makeApp(OWNER_ID)).get("/api/me/group-trails");
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{
      id: string;
      shared_groups: Array<{ id: string; name: string }>;
    }>;
    const own = items.find((t) => t.id === TRAIL_ID);
    expect(own).toBeDefined();
    expect(own!.shared_groups).toEqual([]);
  });
});
