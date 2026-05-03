import { expect, type Page } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  E2E_USER_EMAIL,
  E2E_USER_PASSWORD,
  E2E_USER_VERIFICATION_CODE,
} from "./global-setup";

export function supabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for e2e tests",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Drives the same MFA-aware programmatic Clerk sign-in the other e2e specs
 * use. The dev Clerk instance enforces password + email_code; the
 * "+clerk_test" addresses accept the static "424242" code.
 */
export async function signInAsE2EUser(page: Page): Promise<void> {
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { Clerk?: { loaded?: boolean } }).Clerk?.loaded,
      ),
    undefined,
    { timeout: 30_000 },
  );
  const result = await page.evaluate(
    async ({ identifier, password, code }) => {
      type Attempt = {
        status: string;
        createdSessionId: string | null;
        supportedSecondFactors?: { strategy: string }[];
        prepareSecondFactor: (p: { strategy: string }) => Promise<Attempt>;
        attemptSecondFactor: (p: {
          strategy: string;
          code: string;
        }) => Promise<Attempt>;
      };
      const w = window as unknown as {
        Clerk: {
          client: { signIn: { create: (p: unknown) => Promise<Attempt> } };
          setActive: (p: { session: string }) => Promise<void>;
        };
      };
      try {
        let attempt = await w.Clerk.client.signIn.create({
          strategy: "password",
          identifier,
          password,
        });
        if (attempt.status === "needs_second_factor") {
          await attempt.prepareSecondFactor({ strategy: "email_code" });
          attempt = await attempt.attemptSecondFactor({
            strategy: "email_code",
            code,
          });
        }
        if (attempt.status !== "complete" || !attempt.createdSessionId) {
          return { ok: false, status: attempt.status };
        }
        await w.Clerk.setActive({ session: attempt.createdSessionId });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    {
      identifier: E2E_USER_EMAIL,
      password: E2E_USER_PASSWORD,
      code: E2E_USER_VERIFICATION_CODE,
    },
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { Clerk?: { user?: unknown } }).Clerk?.user,
      ),
    undefined,
    { timeout: 15_000 },
  );
}

export const SECONDARY_AUTHOR_ID = "user_e2e_secondary_author_synthetic";

/**
 * Provisions a synthetic "other rider" user row so we can seed notes /
 * photos / amendments from a non-owner and exercise the moderator-hide
 * paths through the API. We never sign in as this user.
 */
export async function ensureSecondaryAuthor(): Promise<string> {
  const supa = supabaseAdmin();
  const { error } = await supa.from("users").upsert(
    {
      id: SECONDARY_AUTHOR_ID,
      email: `${SECONDARY_AUTHOR_ID}@example.test`,
      display_name: "E2E Other Rider",
    },
    { onConflict: "id" },
  );
  if (error) {
    throw new Error(`Failed to upsert secondary author: ${error.message}`);
  }
  return SECONDARY_AUTHOR_ID;
}

/**
 * Removes any notes / photos / amendments authored by the secondary user
 * on the given trail so each test case starts clean.
 */
export async function cleanupSecondaryAuthorContent(
  trailId: string,
): Promise<void> {
  const supa = supabaseAdmin();
  await supa
    .from("trail_notes")
    .delete()
    .eq("trail_id", trailId)
    .eq("author_user_id", SECONDARY_AUTHOR_ID);
  await supa
    .from("trail_photos")
    .delete()
    .eq("trail_id", trailId)
    .eq("author_user_id", SECONDARY_AUTHOR_ID);
  await supa
    .from("trail_amendments")
    .delete()
    .eq("trail_id", trailId)
    .eq("author_user_id", SECONDARY_AUTHOR_ID);
}

/**
 * Wipes every row of trail content on the given trail (any author). Used
 * between tests in the same file so the count assertions all start at 0.
 */
export async function cleanupAllTrailContent(trailId: string): Promise<void> {
  const supa = supabaseAdmin();
  await supa.from("trail_notes").delete().eq("trail_id", trailId);
  await supa.from("trail_photos").delete().eq("trail_id", trailId);
  await supa.from("trail_amendments").delete().eq("trail_id", trailId);
}

/**
 * Snapshots the original (mutable) trail fields the amendment-approve
 * path overwrites so we can restore them after the test.
 */
export interface TrailSnapshot {
  name: string | null;
  difficulty: number | null;
  type: string | null;
  legal_status: string | null;
  terrain: string | null;
}

export async function snapshotTrail(trailId: string): Promise<TrailSnapshot> {
  const supa = supabaseAdmin();
  const { data, error } = await supa
    .from("trails")
    .select("name, difficulty, type, legal_status, terrain")
    .eq("id", trailId)
    .single();
  if (error || !data) {
    throw new Error(`snapshotTrail failed: ${error?.message ?? "no data"}`);
  }
  return data as TrailSnapshot;
}

/**
 * Toggles the e2e user's `is_moderator` flag. The trail-content DELETE
 * routes (note / photo) require moderator status — they explicitly do not
 * accept "trail owner" as sufficient — so the moderator-hide test flips
 * the bit on, runs, and flips it back off in afterEach.
 */
export async function setUserModerator(
  userId: string,
  isModerator: boolean,
): Promise<void> {
  const supa = supabaseAdmin();
  const { error } = await supa
    .from("users")
    .update({ is_moderator: isModerator })
    .eq("id", userId);
  if (error) {
    throw new Error(`setUserModerator failed: ${error.message}`);
  }
}

export async function restoreTrail(
  trailId: string,
  snap: TrailSnapshot,
): Promise<void> {
  const supa = supabaseAdmin();
  const { error } = await supa.from("trails").update(snap).eq("id", trailId);
  if (error) {
    throw new Error(`restoreTrail failed: ${error.message}`);
  }
}
