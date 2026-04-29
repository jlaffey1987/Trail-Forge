import { test, expect, type Page } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";
import {
  loadE2EState,
  E2E_USER_EMAIL,
  E2E_USER_PASSWORD,
  E2E_USER_VERIFICATION_CODE,
} from "./global-setup";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// We re-use two existing JPEGs from `public/` as upload fixtures so we
// don't need to ship duplicate binaries just for the test. Both are real,
// decodable images (~20-36 KB), which is what `preparePhotoForUpload`
// expects to feed through `createImageBitmap` + `<canvas>.toBlob`.
const COVER_FIXTURE_A = path.resolve(
  __dirname,
  "..",
  "..",
  "public",
  "ride-640.jpg",
);
const COVER_FIXTURE_B = path.resolve(
  __dirname,
  "..",
  "..",
  "public",
  "ride2-640.jpg",
);

const TEST_GROUP_NAME = `[e2e] cover photo flow`;
const STRANGER_GROUP_NAME = `[e2e] cover photo stranger group`;
const STRANGER_OWNER_ID = "user_e2e_stranger_owner_synthetic";

interface SupaCleanup {
  callerUserId: string;
  ownedGroupIds: string[];
  strangerGroupIds: string[];
}

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the cover-photo e2e test",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Wipe any leftover groups from earlier runs so the test starts from a
 * known-good state. We tag both the owner-flow group and the stranger
 * group by name + owner id, which keeps cleanup idempotent without
 * needing migrations.
 */
async function cleanupTestGroups(callerUserId: string): Promise<void> {
  const supa = supabaseAdmin();
  const { data: owned } = await supa
    .from("groups")
    .select("id")
    .eq("name", TEST_GROUP_NAME)
    .eq("owner_user_id", callerUserId);
  for (const g of owned ?? []) {
    await supa.from("group_members").delete().eq("group_id", g.id);
    await supa.from("groups").delete().eq("id", g.id);
  }
  const { data: strangerGroups } = await supa
    .from("groups")
    .select("id")
    .eq("name", STRANGER_GROUP_NAME);
  for (const g of strangerGroups ?? []) {
    await supa.from("group_members").delete().eq("group_id", g.id);
    await supa.from("groups").delete().eq("id", g.id);
  }
}

/**
 * Provision a "stranger" group owned by a synthetic user and add the
 * caller as a regular MEMBER (not admin). This is the shape we need to
 * prove that 403-gating fires for the cover endpoints when the caller
 * is a member but lacks owner/admin role.
 */
async function provisionStrangerGroup(callerUserId: string): Promise<string> {
  const supa = supabaseAdmin();
  // Make sure the synthetic owner exists in `users` so the FK on `groups`
  // is satisfied. We never sign in as this user — they only exist as the
  // owner of the negative-control group.
  await supa.from("users").upsert(
    {
      id: STRANGER_OWNER_ID,
      email: `${STRANGER_OWNER_ID}@example.test`,
      display_name: "E2E Stranger Owner",
    },
    { onConflict: "id" },
  );
  const { data: g, error } = await supa
    .from("groups")
    .insert({
      name: STRANGER_GROUP_NAME,
      owner_user_id: STRANGER_OWNER_ID,
      cover_photo_key: null,
      discoverable: false,
    })
    .select("id")
    .single();
  if (error || !g) {
    throw new Error(
      `Failed to seed stranger group: ${error?.message ?? "no row"}`,
    );
  }
  // Owner row + caller-as-member row.
  await supa.from("group_members").insert([
    { group_id: g.id, user_id: STRANGER_OWNER_ID, role: "owner" },
    { group_id: g.id, user_id: callerUserId, role: "member" },
  ]);
  return g.id as string;
}

async function signInAsE2EUser(page: Page): Promise<void> {
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
  // Same MFA-aware programmatic sign-in as the trail-detail spec — the
  // dev Clerk instance enforces password + email_code, and the
  // "+clerk_test" addresses accept the static "424242" code.
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

test.describe("group cover photo flow @e2e", () => {
  let cleanup: SupaCleanup;

  test.beforeEach(async () => {
    const { userId } = loadE2EState();
    cleanup = {
      callerUserId: userId,
      ownedGroupIds: [],
      strangerGroupIds: [],
    };
    await cleanupTestGroups(userId);
  });

  test.afterEach(async () => {
    await cleanupTestGroups(cleanup.callerUserId);
  });

  test("owner can upload, replace, and remove a group cover (card + dialog stay in sync)", async ({
    page,
  }) => {
    await signInAsE2EUser(page);

    // Land on /trails — that's where GroupsSection lives.
    await page.goto("/trails");
    await expect(page.getByTestId("groups-section")).toBeVisible({
      timeout: 30_000,
    });

    // ---- Create a fresh test group via the UI ----
    await page.getByTestId("groups-create-btn").click();
    const createDialog = page.getByTestId("create-group-dialog");
    await expect(createDialog).toBeVisible();
    await page.getByTestId("create-group-name").fill(TEST_GROUP_NAME);
    await page.getByTestId("create-group-submit").click();

    // CreateGroupDialog auto-opens the GroupDetailDialog on success.
    const dialog = page.getByTestId("group-detail-dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // No cover yet.
    await expect(dialog.getByTestId("group-cover-empty")).toBeVisible();
    await expect(dialog.getByTestId("group-cover-image")).toHaveCount(0);

    // ---- Upload the first cover ----
    await dialog
      .getByTestId("group-cover-input")
      .setInputFiles(COVER_FIXTURE_A);

    // Wait for the upload + finalize round trip — once it finalizes the
    // empty placeholder is replaced by the cover <img>.
    const coverImg = dialog.getByTestId("group-cover-image");
    await expect(coverImg).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId("group-cover-empty")).toHaveCount(0);

    const firstSrc = await coverImg.getAttribute("src");
    expect(firstSrc).toBeTruthy();
    expect(firstSrc).toContain("/api/storage/objects/groups/");
    expect(firstSrc).toContain("/cover/");

    // The image must actually load — i.e. the ACL stamp + storage proxy
    // worked end-to-end. naturalWidth>0 is the canonical "image decoded
    // successfully" signal.
    await expect
      .poll(
        async () =>
          coverImg.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // Capture the group id from the API response so we can verify that
    // closing + reopening still shows the same cover, and clean it up
    // afterwards. The card test id is `group-card-<id>` so we can also
    // pin assertions to it.
    const groupRow = await supabaseAdmin()
      .from("groups")
      .select("id")
      .eq("name", TEST_GROUP_NAME)
      .eq("owner_user_id", cleanup.callerUserId)
      .single();
    const groupId = groupRow.data?.id as string;
    expect(groupId).toBeTruthy();
    cleanup.ownedGroupIds.push(groupId);

    // ---- Close the dialog: card on the Groups list must show the cover ----
    await dialog.getByTestId("group-detail-close").click();
    await expect(dialog).toHaveCount(0);

    const cardCover = page.getByTestId(`group-card-cover-${groupId}`);
    await expect(cardCover).toBeVisible({ timeout: 15_000 });
    const cardImg = cardCover.locator("img");
    const cardFirstSrc = await cardImg.getAttribute("src");
    expect(cardFirstSrc).toBe(firstSrc);
    await expect
      .poll(
        async () =>
          cardImg.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // ---- Reopen the dialog and REPLACE the cover ----
    await page.getByTestId(`group-card-${groupId}`).click();
    await expect(dialog).toBeVisible();
    await expect(coverImg).toBeVisible();

    await dialog
      .getByTestId("group-cover-input")
      .setInputFiles(COVER_FIXTURE_B);

    // The src must change to a different storage key. We poll because the
    // round trip (PUT to GCS + finalize POST + dialog refresh) is async.
    await expect
      .poll(async () => coverImg.getAttribute("src"), { timeout: 30_000 })
      .not.toBe(firstSrc);
    const secondSrc = await coverImg.getAttribute("src");
    expect(secondSrc).toContain("/api/storage/objects/groups/");
    await expect
      .poll(
        async () =>
          coverImg.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // Close + verify the card now shows the replacement.
    await dialog.getByTestId("group-detail-close").click();
    await expect(cardCover).toBeVisible();
    await expect
      .poll(async () => cardImg.getAttribute("src"), { timeout: 15_000 })
      .toBe(secondSrc);

    // ---- Reopen + REMOVE the cover ----
    await page.getByTestId(`group-card-${groupId}`).click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("group-cover-remove-btn").click();

    // After removal the empty placeholder is back and the cover <img> is
    // unmounted.
    await expect(dialog.getByTestId("group-cover-empty")).toBeVisible({
      timeout: 15_000,
    });
    await expect(dialog.getByTestId("group-cover-image")).toHaveCount(0);

    // Close — card must no longer have a cover thumbnail.
    await dialog.getByTestId("group-detail-close").click();
    await expect(page.getByTestId(`group-card-${groupId}`)).toBeVisible();
    await expect(
      page.getByTestId(`group-card-cover-${groupId}`),
    ).toHaveCount(0);
  });

  test("non-admin members cannot mutate the cover (API returns 403)", async ({
    page,
  }) => {
    // Provision a group the e2e user is a MEMBER of (not owner/admin), so
    // the cover endpoints should refuse all three verbs with 403.
    const strangerGroupId = await provisionStrangerGroup(cleanup.callerUserId);
    cleanup.strangerGroupIds.push(strangerGroupId);

    await signInAsE2EUser(page);

    // We hit the API directly via Playwright's request fixture so the
    // browser session cookies / Clerk JWT are reused but we don't have to
    // build a UI flow that intentionally drives a forbidden action.
    const upload = await page.request.post(
      `/api/groups/${strangerGroupId}/cover/upload-url`,
    );
    expect(upload.status()).toBe(403);

    const finalize = await page.request.post(
      `/api/groups/${strangerGroupId}/cover`,
      { data: { storageKey: `groups/${strangerGroupId}/cover/fake.jpg` } },
    );
    expect(finalize.status()).toBe(403);

    const remove = await page.request.delete(
      `/api/groups/${strangerGroupId}/cover`,
    );
    expect(remove.status()).toBe(403);

    // Cover never got set.
    const supa = supabaseAdmin();
    const { data } = await supa
      .from("groups")
      .select("cover_photo_key")
      .eq("id", strangerGroupId)
      .single();
    expect(data?.cover_photo_key).toBeNull();
  });
});
