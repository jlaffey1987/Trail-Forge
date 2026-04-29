/**
 * Self-service admin management — backend coverage for
 * GET / POST / DELETE /api/admin/admins.
 *
 * Covers:
 *   - 401 when unauthenticated
 *   - 403 when the caller is not an admin
 *   - 200 lists rows from system_admins (joined with users)
 *   - POST validates body, rejects duplicates, records granted_by
 *   - DELETE removes a row, idempotent for absent rows
 *   - DELETE refuses to let the last admin revoke themselves
 *   - DELETE allows self-revoke when other admins exist
 *   - DELETE allows revoking other admins freely
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const ADMIN_A = "user_admin_a";
const ADMIN_B = "user_admin_b";
const NOT_ADMIN = "user_not_admin";
const NEW_ADMIN = "user_freshly_added";

const ENV_SAVE = process.env.SYSTEM_ADMIN_USER_IDS;

function seedAdmins(rows: Array<{ user_id: string; granted_by?: string | null; note?: string | null }>) {
  const supa = resetMockSupa();
  supa.seed("users", [
    { id: ADMIN_A, email: "a@example.com", display_name: "Alice" },
    { id: ADMIN_B, email: "b@example.com", display_name: "Bob" },
    { id: NOT_ADMIN, email: "c@example.com", display_name: "Cara" },
    { id: NEW_ADMIN, email: "n@example.com", display_name: "Newt" },
  ]);
  supa.seed(
    "system_admins",
    rows.map((r, i) => ({
      user_id: r.user_id,
      granted_at: new Date(Date.now() - (rows.length - i) * 1000).toISOString(),
      granted_by: r.granted_by ?? null,
      note: r.note ?? null,
    })),
  );
  return supa;
}

beforeEach(() => {
  delete process.env.SYSTEM_ADMIN_USER_IDS;
});

afterEach(() => {
  if (ENV_SAVE === undefined) delete process.env.SYSTEM_ADMIN_USER_IDS;
  else process.env.SYSTEM_ADMIN_USER_IDS = ENV_SAVE;
});

describe("GET /api/admin/admins", () => {
  it("requires authentication", async () => {
    seedAdmins([{ user_id: ADMIN_A }]);
    const res = await request(makeApp(null)).get("/api/admin/admins");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin callers with 403", async () => {
    seedAdmins([{ user_id: ADMIN_A }]);
    const res = await request(makeApp(NOT_ADMIN)).get("/api/admin/admins");
    expect(res.status).toBe(403);
  });

  it("returns the current admin rows joined with users", async () => {
    seedAdmins([
      { user_id: ADMIN_A, granted_by: "system", note: "founder" },
      { user_id: ADMIN_B, granted_by: ADMIN_A, note: null },
    ]);
    const res = await request(makeApp(ADMIN_A)).get("/api/admin/admins");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const alice = res.body.items.find(
      (i: { user_id: string }) => i.user_id === ADMIN_A,
    );
    expect(alice).toMatchObject({
      user_id: ADMIN_A,
      granted_by: "system",
      note: "founder",
    });
    expect(alice.users).toMatchObject({ display_name: "Alice", email: "a@example.com" });
  });

  it("includes env-bootstrapped admin ids in the response", async () => {
    process.env.SYSTEM_ADMIN_USER_IDS = "env_admin_1, env_admin_2";
    seedAdmins([{ user_id: ADMIN_A }]);
    const res = await request(makeApp(ADMIN_A)).get("/api/admin/admins");
    expect(res.status).toBe(200);
    expect(res.body.envAdmins).toEqual(["env_admin_1", "env_admin_2"]);
  });

  it("returns null users metadata when the admin has no matching users row (no FK exists)", async () => {
    // Regression guard: `system_admins.user_id` has no FK to `users.id`,
    // so an admin row may legitimately reference a Clerk id that is not
    // (yet) mirrored into Supabase. The route must merge user metadata
    // app-side and tolerate the missing user row — never error.
    const supa = resetMockSupa();
    supa.seed("users", [
      { id: ADMIN_A, email: "a@example.com", display_name: "Alice" },
    ]);
    supa.seed("system_admins", [
      {
        user_id: ADMIN_A,
        granted_at: new Date(Date.now() - 2000).toISOString(),
        granted_by: null,
        note: null,
      },
      {
        user_id: "user_not_in_users_table",
        granted_at: new Date(Date.now() - 1000).toISOString(),
        granted_by: ADMIN_A,
        note: "added via API before user signed in",
      },
    ]);
    const res = await request(makeApp(ADMIN_A)).get("/api/admin/admins");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const known = res.body.items.find(
      (i: { user_id: string }) => i.user_id === ADMIN_A,
    );
    const unknown = res.body.items.find(
      (i: { user_id: string }) => i.user_id === "user_not_in_users_table",
    );
    expect(known.users).toMatchObject({ display_name: "Alice" });
    expect(unknown.users).toBeNull();
  });
});

describe("POST /api/admin/admins", () => {
  it("requires authentication", async () => {
    seedAdmins([{ user_id: ADMIN_A }]);
    const res = await request(makeApp(null))
      .post("/api/admin/admins")
      .send({ userId: NEW_ADMIN });
    expect(res.status).toBe(401);
  });

  it("rejects non-admin callers with 403", async () => {
    seedAdmins([{ user_id: ADMIN_A }]);
    const res = await request(makeApp(NOT_ADMIN))
      .post("/api/admin/admins")
      .send({ userId: NEW_ADMIN });
    expect(res.status).toBe(403);
    expect(getMockSupa().rows("system_admins")).toHaveLength(1);
  });

  it("rejects an empty / missing user id", async () => {
    seedAdmins([{ user_id: ADMIN_A }]);
    const res = await request(makeApp(ADMIN_A))
      .post("/api/admin/admins")
      .send({ userId: "   " });
    expect(res.status).toBe(400);
    expect(getMockSupa().rows("system_admins")).toHaveLength(1);
  });

  it("inserts a new admin row stamped with granted_by = caller", async () => {
    seedAdmins([{ user_id: ADMIN_A }]);
    const res = await request(makeApp(ADMIN_A))
      .post("/api/admin/admins")
      .send({ userId: NEW_ADMIN, note: "mod" });
    expect(res.status).toBe(200);
    const rows = getMockSupa().rows("system_admins");
    expect(rows).toHaveLength(2);
    const inserted = rows.find((r) => r.user_id === NEW_ADMIN);
    expect(inserted).toMatchObject({
      user_id: NEW_ADMIN,
      granted_by: ADMIN_A,
      note: "mod",
    });
  });

  it("returns 409 when the user is already an admin", async () => {
    seedAdmins([{ user_id: ADMIN_A }]);
    const res = await request(makeApp(ADMIN_A))
      .post("/api/admin/admins")
      .send({ userId: ADMIN_A });
    expect(res.status).toBe(409);
    expect(getMockSupa().rows("system_admins")).toHaveLength(1);
  });
});

describe("DELETE /api/admin/admins/:userId", () => {
  it("requires authentication", async () => {
    seedAdmins([{ user_id: ADMIN_A }, { user_id: ADMIN_B }]);
    const res = await request(makeApp(null)).delete(
      `/api/admin/admins/${ADMIN_B}`,
    );
    expect(res.status).toBe(401);
  });

  it("rejects non-admin callers with 403", async () => {
    seedAdmins([{ user_id: ADMIN_A }, { user_id: ADMIN_B }]);
    const res = await request(makeApp(NOT_ADMIN)).delete(
      `/api/admin/admins/${ADMIN_B}`,
    );
    expect(res.status).toBe(403);
    expect(getMockSupa().rows("system_admins")).toHaveLength(2);
  });

  it("removes the row when there is more than one admin", async () => {
    seedAdmins([{ user_id: ADMIN_A }, { user_id: ADMIN_B }]);
    const res = await request(makeApp(ADMIN_A)).delete(
      `/api/admin/admins/${ADMIN_B}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, removed: true });
    const rows = getMockSupa().rows("system_admins");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(ADMIN_A);
  });

  it("is idempotent when the row doesn't exist", async () => {
    seedAdmins([{ user_id: ADMIN_A }, { user_id: ADMIN_B }]);
    const res = await request(makeApp(ADMIN_A)).delete(
      "/api/admin/admins/user_never_existed",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, removed: false });
    expect(getMockSupa().rows("system_admins")).toHaveLength(2);
  });

  it("refuses to let the last admin revoke themselves", async () => {
    seedAdmins([{ user_id: ADMIN_A }]);
    const res = await request(makeApp(ADMIN_A)).delete(
      `/api/admin/admins/${ADMIN_A}`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only admin/i);
    expect(getMockSupa().rows("system_admins")).toHaveLength(1);
  });

  it("allows self-revoke when at least one other admin exists", async () => {
    seedAdmins([{ user_id: ADMIN_A }, { user_id: ADMIN_B }]);
    const res = await request(makeApp(ADMIN_A)).delete(
      `/api/admin/admins/${ADMIN_A}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, removed: true });
    const rows = getMockSupa().rows("system_admins");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(ADMIN_B);
  });

  it("allows an admin to revoke a different admin", async () => {
    seedAdmins([{ user_id: ADMIN_A }, { user_id: ADMIN_B }]);
    const res = await request(makeApp(ADMIN_B)).delete(
      `/api/admin/admins/${ADMIN_A}`,
    );
    expect(res.status).toBe(200);
    expect(getMockSupa().rows("system_admins")).toHaveLength(1);
  });
});
