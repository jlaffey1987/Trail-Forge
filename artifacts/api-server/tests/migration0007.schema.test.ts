/**
 * Migration 0007 schema presence guard.
 *
 * Migration `0007_ai_discovery.sql` adds:
 *   - `system_admins` table
 *   - `forum_sources` table
 *   - `ai_discovered_trails` table
 *   - `trails.source`, `trails.verification_status`, `trails.ai_grade`,
 *     `trails.ai_grade_rationale`, `trails.ai_grade_model`, and
 *     `trails.ai_graded_at` columns
 *
 * The API server silently degrades when these objects are absent, returning
 * "table missing — apply migration 0007" instead of real data. That means a
 * forgotten migration in a deployed environment shows up as empty admin
 * screens rather than an obvious build failure.
 *
 * This test runs against a real Supabase instance (configured via
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) and asserts that every table and
 * column introduced by migration 0007 actually exists. It is skipped when
 * the env vars are missing so the rest of the suite still runs in
 * environments without Supabase access.
 *
 * No test data is inserted — the test only reads `information_schema` to
 * confirm the DDL has been applied.
 */

import { describe, beforeAll, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const haveSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

const describeIfSupabase = haveSupabase ? describe : describe.skip;

describeIfSupabase("migration 0007 schema presence", () => {
  let admin: SupabaseClient;

  beforeAll(() => {
    admin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  const REQUIRED_TABLES = [
    "system_admins",
    "forum_sources",
    "ai_discovered_trails",
  ] as const;

  const REQUIRED_TRAIL_COLUMNS = [
    "source",
    "verification_status",
    "ai_grade",
    "ai_grade_rationale",
    "ai_grade_model",
    "ai_graded_at",
  ] as const;

  for (const table of REQUIRED_TABLES) {
    it(`table "${table}" exists`, async () => {
      const { data, error } = await admin
        .from(table)
        .select("*")
        .limit(0);

      expect(
        error,
        `Table "${table}" is missing — have you applied migration 0007_ai_discovery.sql? ` +
          `Error: ${error?.message ?? "none"}`,
      ).toBeNull();

      expect(data).toBeDefined();
    });
  }

  for (const column of REQUIRED_TRAIL_COLUMNS) {
    it(`trails.${column} column exists`, async () => {
      const { data, error } = await admin
        .from("trails")
        .select(column)
        .limit(0);

      expect(
        error,
        `Column "trails.${column}" is missing — have you applied migration 0007_ai_discovery.sql? ` +
          `Error: ${error?.message ?? "none"}`,
      ).toBeNull();

      expect(data).toBeDefined();
    });
  }
});

if (!haveSupabase) {
  describe("migration 0007 schema presence", () => {
    it.skip(
      "skipped — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to run",
      () => {},
    );
  });
}
