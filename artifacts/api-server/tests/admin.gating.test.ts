/**
 * Admin gating + AI grading column shape — migration 0007 regression guard.
 *
 * Migration `0007_ai_discovery.sql` is responsible for:
 *   - the `system_admins` table (read by `isSystemAdmin()`)
 *   - the `forum_sources` and `ai_discovered_trails` tables
 *   - the `trails.source`, `trails.verification_status`, `trails.ai_grade`,
 *     `trails.ai_grade_rationale`, `trails.ai_grade_model`, and
 *     `trails.ai_graded_at` columns
 *
 * The route handlers tolerate the migration being absent (they degrade to
 * "table missing" or "column missing" responses instead of throwing). That
 * tolerance means a regression — for example a future migration accidentally
 * dropping `ai_grade`, or the env-var fallback in `isSystemAdmin()` getting
 * inverted — would slip past `pnpm typecheck` and the existing UI tests.
 *
 * This file locks the contract in:
 *   - `isSystemAdmin()` honours both the `SYSTEM_ADMIN_USER_IDS` env var
 *     fallback AND the `system_admins` row, individually and together,
 *     and returns false for every other user
 *   - `GET /api/admin/forum-sources` returns 401 for anonymous, 403 for a
 *     signed-in non-admin, and 200 for an admin (regardless of whether the
 *     admin grant came from the env fallback or the table)
 *   - `GET /api/me/trails` round-trips the AI grading columns on the trail
 *     row, so a future migration that drops any of them trips this test
 *
 * Anthropic's package is mocked at the top because importing the `ai`
 * router pulls in `@workspace/integrations-anthropic-ai`, whose client
 * throws at module-load if the AI integration env vars are not set — they
 * aren't in the test environment.
 */

import { vi, beforeEach, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import express, { type Express, type Request } from "express";
import { resetMockSupa, getMockSupa } from "./helpers/setup";

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {
    messages: { create: vi.fn(async () => ({ content: [] })) },
  },
  batchProcess: vi.fn(),
  batchProcessWithSSE: vi.fn(),
  isRateLimitError: () => false,
}));

// Imported AFTER the mock so the ai router (and its anthropic dep) loads
// against the stub above instead of the real client.
const { isSystemAdmin } = await import("../src/lib/admin");
const { default: aiRouter } = await import("../src/routes/ai");
const { default: trailsRouter } = await import("../src/routes/trails");

function makeAdminApp(authUserId: string | null = null): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { __auth?: { userId: string | null } }).__auth = {
      userId: authUserId,
    };
    (req as Request & { log?: unknown }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    };
    next();
  });
  app.use("/api", aiRouter);
  app.use("/api", trailsRouter);
  return app;
}

const ADMIN_ENV_USER = "user_env_admin";
const ADMIN_ROW_USER = "user_row_admin";
const ADMIN_BOTH_USER = "user_both_admin";
const NORMAL_USER = "user_normal";

const ENV_KEY = "SYSTEM_ADMIN_USER_IDS";
const SAVED_ENV = process.env[ENV_KEY];

beforeEach(() => {
  resetMockSupa();
  // Default: env grants ADMIN_ENV_USER and ADMIN_BOTH_USER.
  process.env[ENV_KEY] = `${ADMIN_ENV_USER},${ADMIN_BOTH_USER}`;
  // Default: table grants ADMIN_ROW_USER and ADMIN_BOTH_USER.
  getMockSupa().seed("system_admins", [
    { user_id: ADMIN_ROW_USER, granted_at: new Date().toISOString() },
    { user_id: ADMIN_BOTH_USER, granted_at: new Date().toISOString() },
  ]);
  getMockSupa().seed("forum_sources", []);
});

afterEach(() => {
  if (SAVED_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = SAVED_ENV;
});

describe("isSystemAdmin()", () => {
  it("returns false for the empty string", async () => {
    expect(await isSystemAdmin("")).toBe(false);
  });

  it("returns true when the user id is only in SYSTEM_ADMIN_USER_IDS", async () => {
    expect(await isSystemAdmin(ADMIN_ENV_USER)).toBe(true);
  });

  it("returns true when the user id is only in the system_admins table", async () => {
    expect(await isSystemAdmin(ADMIN_ROW_USER)).toBe(true);
  });

  it("returns true when the user id is in both the env var and the table", async () => {
    expect(await isSystemAdmin(ADMIN_BOTH_USER)).toBe(true);
  });

  it("returns false when the user id is in neither the env var nor the table", async () => {
    expect(await isSystemAdmin(NORMAL_USER)).toBe(false);
  });

  it("ignores whitespace around the comma-separated env entries", async () => {
    process.env[ENV_KEY] = `  ${ADMIN_ENV_USER}  ,  another_admin  `;
    expect(await isSystemAdmin(ADMIN_ENV_USER)).toBe(true);
    expect(await isSystemAdmin("another_admin")).toBe(true);
  });

  it("falls back to env-only when the system_admins table is missing (migration not applied)", async () => {
    getMockSupa().missingTables.add("system_admins");
    // Env-only admin still works — guards a freshly-deployed environment that
    // hasn't run migration 0007 yet.
    expect(await isSystemAdmin(ADMIN_ENV_USER)).toBe(true);
    // Without an env grant, a missing table means "not an admin", not a 500.
    expect(await isSystemAdmin(ADMIN_ROW_USER)).toBe(false);
    expect(await isSystemAdmin(NORMAL_USER)).toBe(false);
  });

  it("treats an unset SYSTEM_ADMIN_USER_IDS env var as no env grants", async () => {
    delete process.env[ENV_KEY];
    expect(await isSystemAdmin(ADMIN_ENV_USER)).toBe(false);
    expect(await isSystemAdmin(ADMIN_ROW_USER)).toBe(true);
  });
});

describe("admin-gated routes — GET /api/admin/forum-sources", () => {
  it("returns 401 when the request is anonymous", async () => {
    const res = await request(makeAdminApp(null)).get("/api/admin/forum-sources");
    expect(res.status).toBe(401);
  });

  it("returns 403 when the signed-in user is not an admin", async () => {
    const res = await request(makeAdminApp(NORMAL_USER)).get("/api/admin/forum-sources");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  it("returns 200 for an env-fallback admin", async () => {
    getMockSupa().seed("forum_sources", [
      {
        id: "fs1",
        label: "Test Forum",
        url: "https://example.com/feed.rss",
        kind: "rss",
        disabled: false,
      },
    ]);
    const res = await request(makeAdminApp(ADMIN_ENV_USER)).get("/api/admin/forum-sources");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].label).toBe("Test Forum");
  });

  it("returns 200 for a system_admins-row admin", async () => {
    const res = await request(makeAdminApp(ADMIN_ROW_USER)).get("/api/admin/forum-sources");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});

describe("GET /api/admin/whoami", () => {
  it("returns isAdmin:false and signedIn:false for anonymous requests", async () => {
    const res = await request(makeAdminApp(null)).get("/api/admin/whoami");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isAdmin: false, signedIn: false });
  });

  it("returns isAdmin:false for a signed-in non-admin", async () => {
    const res = await request(makeAdminApp(NORMAL_USER)).get("/api/admin/whoami");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isAdmin: false, signedIn: true, userId: NORMAL_USER });
  });

  it("returns isAdmin:true for an admin (env or table)", async () => {
    const envRes = await request(makeAdminApp(ADMIN_ENV_USER)).get("/api/admin/whoami");
    expect(envRes.body).toMatchObject({ isAdmin: true, signedIn: true });
    const rowRes = await request(makeAdminApp(ADMIN_ROW_USER)).get("/api/admin/whoami");
    expect(rowRes.body).toMatchObject({ isAdmin: true, signedIn: true });
  });
});

describe("trails row shape — migration 0007 AI grading columns", () => {
  // The point of this block is to lock in that the `trails` row carries the
  // columns added by migration 0007. If a future migration drops any of
  // them, the round-trip below will fail because the projected row will be
  // missing the key entirely (mock supa's `select("*")` returns whatever is
  // on the row).
  const REQUIRED_AI_COLUMNS = [
    "source",
    "verification_status",
    "ai_grade",
    "ai_grade_rationale",
    "ai_grade_model",
    "ai_graded_at",
  ] as const;

  it("round-trips source / verification_status / ai_grade* on GET /api/me/trails", async () => {
    const supa = getMockSupa();
    const trailRow = {
      id: "trail-001",
      owner_user_id: NORMAL_USER,
      name: "Test Trail",
      created_at: new Date().toISOString(),
      // Migration 0007 columns:
      source: "ai-forum",
      source_url: "https://forum.example.com/threads/test",
      verification_status: "ai-approximated",
      ai_grade: 7,
      ai_grade_rationale: "steep, rocky, two stream crossings",
      ai_grade_model: "claude-sonnet-4-6",
      ai_graded_at: new Date().toISOString(),
    };
    supa.seed("trails", [trailRow]);

    const res = await request(makeAdminApp(NORMAL_USER)).get("/api/me/trails");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0] as Record<string, unknown>;
    for (const col of REQUIRED_AI_COLUMNS) {
      expect(
        Object.prototype.hasOwnProperty.call(item, col),
        `Expected /api/me/trails to surface trails.${col} (migration 0007). ` +
          `If this column was intentionally removed, update this test.`,
      ).toBe(true);
    }
    expect(item.source).toBe("ai-forum");
    expect(item.verification_status).toBe("ai-approximated");
    expect(item.ai_grade).toBe(7);
    expect(item.ai_grade_model).toBe("claude-sonnet-4-6");
  });
});
