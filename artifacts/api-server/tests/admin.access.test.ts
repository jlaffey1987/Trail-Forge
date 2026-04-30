/**
 * Admin gating + bootstrap explainer — backend coverage.
 *
 * The admin layer distinguishes four states (see `src/lib/admin.ts`):
 *
 *   - admin              caller is an admin via env or system_admins row
 *   - not-admin          admins exist but caller isn't one
 *   - no-admins          system_admins table exists but is empty AND env unset
 *   - migration-missing  system_admins table doesn't exist AND env unset
 *
 * Each state must surface a distinct, machine-readable response so the
 * frontend can render a useful explainer instead of an empty list / 403.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";
import { getAdminAccessState, explainAdminAccess } from "../src/lib/admin";

const ADMIN_USER = "user_admin";
const ENV_ADMIN_USER = "user_env_admin";
const RANDOM_USER = "user_random";

const ENV_KEY = "SYSTEM_ADMIN_USER_IDS";

function clearAdminEnv() {
  delete process.env[ENV_KEY];
}

beforeEach(() => {
  resetMockSupa();
  clearAdminEnv();
});

afterEach(() => {
  clearAdminEnv();
});

describe("getAdminAccessState", () => {
  it("returns migration-missing when the table is missing and env is unset", async () => {
    const supa = getMockSupa();
    supa.missingTables.add("system_admins");
    const state = await getAdminAccessState(RANDOM_USER);
    expect(state).toEqual({ kind: "migration-missing" });
  });

  it("returns not-admin (not migration-missing) when the table is missing but env has admins", async () => {
    process.env[ENV_KEY] = ENV_ADMIN_USER;
    const supa = getMockSupa();
    supa.missingTables.add("system_admins");
    // Different user → not-admin even though env list is populated.
    const state = await getAdminAccessState(RANDOM_USER);
    expect(state).toEqual({ kind: "not-admin" });
  });

  it("returns no-admins when the table is empty and env is unset", async () => {
    // Table exists but no rows seeded.
    getMockSupa().seed("system_admins", []);
    const state = await getAdminAccessState(RANDOM_USER);
    expect(state).toEqual({ kind: "no-admins" });
  });

  it("returns admin via=env when the user is in SYSTEM_ADMIN_USER_IDS", async () => {
    process.env[ENV_KEY] = `${ENV_ADMIN_USER},  another_user`;
    getMockSupa().seed("system_admins", []);
    const state = await getAdminAccessState(ENV_ADMIN_USER);
    expect(state).toEqual({ kind: "admin", via: "env" });
  });

  it("returns admin via=table when the user has a system_admins row", async () => {
    getMockSupa().seed("system_admins", [{ user_id: ADMIN_USER }]);
    const state = await getAdminAccessState(ADMIN_USER);
    expect(state).toEqual({ kind: "admin", via: "table" });
  });

  it("returns not-admin when admins exist but the caller isn't one", async () => {
    getMockSupa().seed("system_admins", [{ user_id: ADMIN_USER }]);
    const state = await getAdminAccessState(RANDOM_USER);
    expect(state).toEqual({ kind: "not-admin" });
  });
});

describe("explainAdminAccess", () => {
  it("maps each non-admin state to a distinct status + machine-readable code", () => {
    expect(explainAdminAccess({ kind: "migration-missing" })).toMatchObject({
      status: 503,
      code: "ADMIN_MIGRATION_MISSING",
    });
    expect(explainAdminAccess({ kind: "no-admins" })).toMatchObject({
      status: 503,
      code: "ADMIN_NOT_BOOTSTRAPPED",
    });
    expect(explainAdminAccess({ kind: "not-admin" })).toMatchObject({
      status: 403,
      code: "ADMIN_FORBIDDEN",
    });
  });

  it("includes a bootstrap hint mentioning SYSTEM_ADMIN_USER_IDS for non-admin states", () => {
    expect(explainAdminAccess({ kind: "no-admins" }).message).toMatch(/SYSTEM_ADMIN_USER_IDS/);
    expect(explainAdminAccess({ kind: "migration-missing" }).message).toMatch(
      /SYSTEM_ADMIN_USER_IDS|migration 0007/i,
    );
  });
});

describe("GET /api/admin/whoami", () => {
  it("returns signed-out for an anonymous viewer", async () => {
    const res = await request(makeApp()).get("/api/admin/whoami");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      isAdmin: false,
      signedIn: false,
      state: "signed-out",
    });
  });

  it("returns state=migration-missing when system_admins is missing", async () => {
    getMockSupa().missingTables.add("system_admins");
    const res = await request(makeApp(RANDOM_USER)).get("/api/admin/whoami");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      isAdmin: false,
      signedIn: true,
      state: "migration-missing",
      code: "ADMIN_MIGRATION_MISSING",
    });
    expect(res.body.message).toMatch(/migration 0007|SYSTEM_ADMIN_USER_IDS/);
  });

  it("returns state=no-admins when the table is empty", async () => {
    getMockSupa().seed("system_admins", []);
    const res = await request(makeApp(RANDOM_USER)).get("/api/admin/whoami");
    expect(res.body).toMatchObject({
      isAdmin: false,
      state: "no-admins",
      code: "ADMIN_NOT_BOOTSTRAPPED",
    });
  });

  it("returns isAdmin=true when the env grants access", async () => {
    process.env[ENV_KEY] = ENV_ADMIN_USER;
    const res = await request(makeApp(ENV_ADMIN_USER)).get("/api/admin/whoami");
    expect(res.body).toMatchObject({
      isAdmin: true,
      signedIn: true,
      state: "admin",
      code: "ADMIN_OK",
    });
  });

  it("returns isAdmin=true when a system_admins row matches", async () => {
    getMockSupa().seed("system_admins", [{ user_id: ADMIN_USER }]);
    const res = await request(makeApp(ADMIN_USER)).get("/api/admin/whoami");
    expect(res.body).toMatchObject({ isAdmin: true, state: "admin" });
  });

  it("returns isAdmin=false (not-admin) for a signed-in non-admin", async () => {
    getMockSupa().seed("system_admins", [{ user_id: ADMIN_USER }]);
    const res = await request(makeApp(RANDOM_USER)).get("/api/admin/whoami");
    expect(res.body).toMatchObject({ isAdmin: false, state: "not-admin" });
  });
});

describe("admin route gating returns structured 503/403", () => {
  it("returns 503 + ADMIN_MIGRATION_MISSING when the table is missing", async () => {
    getMockSupa().missingTables.add("system_admins");
    const res = await request(makeApp(RANDOM_USER)).get("/api/admin/forum-sources");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: "ADMIN_MIGRATION_MISSING",
      state: "migration-missing",
    });
    expect(res.body.error).toMatch(/migration 0007|SYSTEM_ADMIN_USER_IDS/);
  });

  it("returns 503 + ADMIN_NOT_BOOTSTRAPPED when no admins are configured at all", async () => {
    getMockSupa().seed("system_admins", []);
    const res = await request(makeApp(RANDOM_USER)).get("/api/admin/discovered-trails");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: "ADMIN_NOT_BOOTSTRAPPED",
      state: "no-admins",
    });
    expect(res.body.error).toMatch(/SYSTEM_ADMIN_USER_IDS/);
  });

  it("returns 403 + ADMIN_FORBIDDEN for a signed-in non-admin when admins exist", async () => {
    getMockSupa().seed("system_admins", [{ user_id: ADMIN_USER }]);
    const res = await request(makeApp(RANDOM_USER)).get("/api/admin/discovered-trails");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "ADMIN_FORBIDDEN",
      state: "not-admin",
    });
  });

  it("returns 401 when not signed in (auth before admin gating)", async () => {
    getMockSupa().seed("system_admins", [{ user_id: ADMIN_USER }]);
    const res = await request(makeApp()).get("/api/admin/discovered-trails");
    expect(res.status).toBe(401);
  });

  it("admins (via env) reach the handler", async () => {
    process.env[ENV_KEY] = ENV_ADMIN_USER;
    getMockSupa().seed("system_admins", []);
    getMockSupa().seed("ai_discovered_trails", []);
    const res = await request(makeApp(ENV_ADMIN_USER)).get(
      "/api/admin/discovered-trails?status=pending",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

describe("POST /api/trails/:id/grade-ai surfaces admin explainer to non-owners", () => {
  const TRAIL_ID = "11111111-1111-4111-8111-111111111111";

  it("returns the migration-missing hint when an admin-wannabe re-grades someone else's trail", async () => {
    getMockSupa().seed("trails", [{ id: TRAIL_ID, owner_user_id: ADMIN_USER, name: "Foo" }]);
    getMockSupa().missingTables.add("system_admins");
    const res = await request(makeApp(RANDOM_USER)).post(`/api/trails/${TRAIL_ID}/grade-ai`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: "ADMIN_MIGRATION_MISSING",
      state: "migration-missing",
    });
    expect(res.body.error).toMatch(/migration 0007|SYSTEM_ADMIN_USER_IDS/);
  });

  it("returns 403 with the owner-or-admin message when admins exist but caller is neither", async () => {
    getMockSupa().seed("trails", [{ id: TRAIL_ID, owner_user_id: ADMIN_USER, name: "Foo" }]);
    getMockSupa().seed("system_admins", [{ user_id: ADMIN_USER }]);
    const res = await request(makeApp(RANDOM_USER)).post(`/api/trails/${TRAIL_ID}/grade-ai`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "ADMIN_FORBIDDEN",
      state: "not-admin",
    });
    expect(res.body.error).toMatch(/owner or an admin/i);
  });
});
