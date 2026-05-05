import { test, expect, type APIRequestContext } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { loadE2EState } from "./global-setup";
import {
  cleanupAllTrailContent,
  cleanupSecondaryAuthorContent,
  ensureSecondaryAuthor,
  restoreTrail,
  signInAsE2EUser,
  snapshotTrail,
  supabaseAdmin,
  type TrailSnapshot,
  SECONDARY_AUTHOR_ID,
} from "./helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Reuse a real public JPEG so `preparePhotoForUpload` (which goes through
// `createImageBitmap` + `<canvas>.toBlob`) actually has decodable pixels.
const PHOTO_FIXTURE = path.resolve(
  __dirname,
  "..",
  "..",
  "public",
  "ride-640.jpg",
);

interface NoteRow {
  id: string;
}
interface PhotoRow {
  id: string;
  storage_key: string;
}
interface AmendmentRow {
  id: string;
}

async function seedNoteByOther(
  trailId: string,
  body: string,
): Promise<NoteRow> {
  const supa = supabaseAdmin();
  const { data, error } = await supa
    .from("trail_notes")
    .insert({
      trail_id: trailId,
      author_user_id: SECONDARY_AUTHOR_ID,
      body,
      kind: "info",
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`seedNoteByOther failed: ${error?.message ?? "no data"}`);
  }
  return data as NoteRow;
}

async function seedPhotoByOther(
  trailId: string,
): Promise<PhotoRow> {
  const supa = supabaseAdmin();
  // Storage key matches the convention enforced by the API. We never
  // actually upload bytes for this seed — the moderator-hide path only
  // touches the DB row, not object storage. The frontend renders a
  // broken <img> for the brief moment the row exists, which is fine.
  const fakeKey = `trails/${trailId}/photos/${crypto.randomUUID()}.jpg`;
  const { data, error } = await supa
    .from("trail_photos")
    .insert({
      trail_id: trailId,
      author_user_id: SECONDARY_AUTHOR_ID,
      storage_key: fakeKey,
      width: 800,
      height: 600,
    })
    .select("id, storage_key")
    .single();
  if (error || !data) {
    throw new Error(`seedPhotoByOther failed: ${error?.message ?? "no data"}`);
  }
  return data as PhotoRow;
}

async function seedAmendmentByOther(
  trailId: string,
  proposed: Record<string, unknown>,
  reason: string,
): Promise<AmendmentRow> {
  const supa = supabaseAdmin();
  const { data, error } = await supa
    .from("trail_amendments")
    .insert({
      trail_id: trailId,
      author_user_id: SECONDARY_AUTHOR_ID,
      proposed_changes: proposed,
      reason,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `seedAmendmentByOther failed: ${error?.message ?? "no data"}`,
    );
  }
  return data as AmendmentRow;
}

async function moderatorHide(
  request: APIRequestContext,
  url: string,
): Promise<void> {
  const res = await request.delete(url);
  expect(
    res.ok(),
    `moderator DELETE ${url} returned ${res.status()}`,
  ).toBe(true);
}

test.describe("trail detail extras @e2e", () => {
  let trailId: string;
  let trailSnapshot: TrailSnapshot;

  test.beforeAll(async () => {
    const state = loadE2EState();
    trailId = state.trailId;
    await ensureSecondaryAuthor();
    trailSnapshot = await snapshotTrail(trailId);
  });

  test.beforeEach(async () => {
    // Each test starts from a clean trail content slate so the count
    // assertions are deterministic.
    await cleanupAllTrailContent(trailId);
  });

  test.afterEach(async () => {
    await cleanupSecondaryAuthorContent(trailId);
    // Approve-amendment mutates the trail row — restore it so neighbouring
    // specs see the original difficulty/legal_status/etc.
    await restoreTrail(trailId, trailSnapshot);
  });

  test("uploads a photo, the thumbnail renders, then the author deletes it", async ({
    page,
  }) => {
    await signInAsE2EUser(page);

    await page.goto(`/discover?trail=${trailId}`);
    await expect(page.getByTestId("trail-detail-name")).toBeVisible({
      timeout: 30_000,
    });
    const counts = page.getByTestId("trail-detail-counts");
    await expect(counts).toHaveText(
      /0 notes\s*·\s*0 photos\s*·\s*0 pending edits/,
    );

    await page.getByTestId("trail-tab-photos").click();
    const panel = page.getByTestId("trail-photos-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("0 photos")).toBeVisible();

    // Drive the (visually hidden) <input type="file"> directly so the
    // upload-url → PUT → finalize round trip kicks in exactly like a
    // real file pick would.
    await panel.getByTestId("photo-file-input").setInputFiles(PHOTO_FIXTURE);

    // Once the round trip lands the panel re-renders with the new
    // thumbnail. The exact id is server-assigned. The thumbnail wrapper
    // is the only `<div>` carrying a `photo-…` test id (input, button,
    // and upload-status testids hang off non-div elements).
    const thumb = panel.locator('div[data-testid^="photo-"]').first();
    await expect(thumb).toBeVisible({ timeout: 30_000 });
    const thumbTestId = await thumb.getAttribute("data-testid");
    expect(thumbTestId).toMatch(/^photo-[0-9a-f-]+$/);
    const photoId = thumbTestId!.slice("photo-".length);

    // The <img> src must be the storage-objects path so the proxy can
    // serve it publicly.
    const img = thumb.locator("img");
    await expect(img).toBeVisible();
    const src = await img.getAttribute("src");
    expect(src).toContain(`/api/storage/objects/trails/${trailId}/photos/`);
    // The browser actually decoded the bytes — i.e. the presigned PUT +
    // public ACL stamp worked end-to-end.
    await expect
      .poll(
        async () =>
          img.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    await expect(panel.getByText("1 photo")).toBeVisible();
    await expect(counts).toHaveText(
      /0 notes\s*·\s*1 photos\s*·\s*0 pending edits/,
    );
    await expect(
      page.getByTestId("trail-tab-photos").getByText("1", { exact: true }),
    ).toBeVisible();

    // The author's X button removes the row and the count drops back
    // to zero. Auto-confirm the window.confirm() prompt.
    page.once("dialog", (d) => void d.accept());
    await panel.getByTestId(`photo-delete-${photoId}`).click();
    await expect(thumb).toHaveCount(0);
    await expect(panel.getByText("0 photos")).toBeVisible();
    await expect(counts).toHaveText(
      /0 notes\s*·\s*0 photos\s*·\s*0 pending edits/,
    );
  });

  test("trail owner moderator-hides another rider's note, photo, and amendment", async ({
    page,
  }) => {
    // Seed one note + one photo + one pending amendment authored by a
    // *different* user. The X-button affordances are author-only, so the
    // hide path is exercised through the API (which the e2e user can hit
    // because they own the trail and therefore satisfy `canModerate`).
    const noteBody = `seeded other-rider note · ${Date.now()}`;
    const note = await seedNoteByOther(trailId, noteBody);
    const photo = await seedPhotoByOther(trailId);
    const am = await seedAmendmentByOther(
      trailId,
      { difficulty: 8 },
      `seeded other-rider edit · ${Date.now()}`,
    );

    await signInAsE2EUser(page);
    await page.goto(`/discover?trail=${trailId}`);
    await expect(page.getByTestId("trail-detail-name")).toBeVisible({
      timeout: 30_000,
    });

    // Counts include all three before any hide happens.
    await expect(page.getByTestId("trail-detail-counts")).toHaveText(
      /1 notes\s*·\s*1 photos\s*·\s*1 pending edits/,
    );

    await page.getByTestId("trail-tab-notes").click();
    await expect(page.getByTestId(`note-${note.id}`)).toBeVisible();
    // Owner is not the author, so no per-row delete button is rendered.
    await expect(
      page.getByTestId(`note-delete-${note.id}`),
    ).toHaveCount(0);

    await page.getByTestId("trail-tab-photos").click();
    await expect(page.getByTestId(`photo-${photo.id}`)).toBeVisible();
    await expect(
      page.getByTestId(`photo-delete-${photo.id}`),
    ).toHaveCount(0);

    await page.getByTestId("trail-tab-amendments").click();
    await expect(page.getByTestId(`amendment-${am.id}`)).toBeVisible();

    // Trail owners are accepted as moderators by the note/photo DELETE
    // routes — no need to flip an extra `is_moderator` bit.

    // ---- Hide the note via the API (uses the e2e user's session). ----
    await moderatorHide(
      page.request,
      `/api/trails/${trailId}/notes/${note.id}`,
    );
    // ---- Hide the photo. ----
    await moderatorHide(
      page.request,
      `/api/trails/${trailId}/photos/${photo.id}`,
    );

    // The pending-amendment count is driven by the amendment's status,
    // not a hidden_at flag, so we exercise the moderator path that does
    // exist for amendments — reject — and verify the badge updates.
    page.once("dialog", (d) => void d.accept(""));
    await page.getByTestId(`amendment-reject-${am.id}`).click();
    await expect(
      page
        .getByTestId(`amendment-${am.id}`)
        .getByTestId(`amendment-status-${am.id}`),
    ).toHaveText(/rejected/i);

    // Re-navigate so the activity counts on the header refetch fresh — the
    // sheet recomputes counts on mount, not via realtime, and a soft
    // page.reload() doesn't reliably re-open the sheet from ?trail=…
    await page.goto(`/discover?trail=${trailId}`);
    await expect(page.getByTestId("trail-detail-name")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("trail-detail-counts")).toHaveText(
      /0 notes\s*·\s*0 photos\s*·\s*0 pending edits/,
    );

    // Verify the rows themselves are gone from the visible lists.
    await page.getByTestId("trail-tab-notes").click();
    await expect(page.getByTestId(`note-${note.id}`)).toHaveCount(0);
    await page.getByTestId("trail-tab-photos").click();
    await expect(page.getByTestId(`photo-${photo.id}`)).toHaveCount(0);

    // The hidden rows are still in the DB (audit trail) with hidden_at
    // populated — the API just filters them out of the list response.
    const supa = supabaseAdmin();
    const { data: hiddenNote } = await supa
      .from("trail_notes")
      .select("hidden_at")
      .eq("id", note.id)
      .single();
    expect(hiddenNote?.hidden_at).not.toBeNull();
    const { data: hiddenPhoto } = await supa
      .from("trail_photos")
      .select("hidden_at")
      .eq("id", photo.id)
      .single();
    expect(hiddenPhoto?.hidden_at).not.toBeNull();
  });

  test("approving an amendment applies the proposed changes to the trail; rejecting leaves the trail untouched", async ({
    page,
  }) => {
    // Two pending amendments authored by the other rider — one to be
    // approved (the "Apply" path that mutates the trail row) and one
    // to be rejected.
    const targetDifficulty =
      (trailSnapshot.difficulty ?? 5) === 9 ? 3 : 9;
    const approveAm = await seedAmendmentByOther(
      trailId,
      { difficulty: targetDifficulty },
      `approve me · ${Date.now()}`,
    );
    const rejectAm = await seedAmendmentByOther(
      trailId,
      { terrain: "boggy-clay" },
      `reject me · ${Date.now()}`,
    );

    await signInAsE2EUser(page);
    await page.goto(`/discover?trail=${trailId}`);
    await expect(page.getByTestId("trail-detail-name")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("trail-detail-counts")).toHaveText(
      /0 notes\s*·\s*0 photos\s*·\s*2 pending edits/,
    );

    await page.getByTestId("trail-tab-amendments").click();
    const approveRow = page.getByTestId(`amendment-${approveAm.id}`);
    const rejectRow = page.getByTestId(`amendment-${rejectAm.id}`);
    await expect(approveRow).toBeVisible();
    await expect(rejectRow).toBeVisible();

    // ---- Approve the first one. ----
    await approveRow.getByTestId(`amendment-approve-${approveAm.id}`).click();
    await expect(
      approveRow.getByTestId(`amendment-status-${approveAm.id}`),
    ).toHaveText(/approved/i);
    // Approve / Reject buttons disappear once status is no longer pending.
    await expect(
      approveRow.getByTestId(`amendment-approve-${approveAm.id}`),
    ).toHaveCount(0);

    // The trail row in the DB now reflects the proposed difficulty.
    const supa = supabaseAdmin();
    const { data: appliedTrail } = await supa
      .from("trails")
      .select("difficulty, terrain")
      .eq("id", trailId)
      .single();
    expect(appliedTrail?.difficulty).toBe(targetDifficulty);
    // The other amendment hasn't been decided yet, so terrain is still the
    // original value.
    expect(appliedTrail?.terrain).toBe(trailSnapshot.terrain);

    // ---- Reject the second one with a decision reason. ----
    page.once("dialog", (d) => void d.accept("Not enough evidence"));
    await rejectRow.getByTestId(`amendment-reject-${rejectAm.id}`).click();
    await expect(
      rejectRow.getByTestId(`amendment-status-${rejectAm.id}`),
    ).toHaveText(/rejected/i);
    await expect(rejectRow.getByText(/Not enough evidence/)).toBeVisible();

    // Trail's terrain wasn't touched by the rejected amendment.
    const { data: finalTrail } = await supa
      .from("trails")
      .select("terrain")
      .eq("id", trailId)
      .single();
    expect(finalTrail?.terrain).toBe(trailSnapshot.terrain);

    // Header counts dropped to 0 pending edits (both decided).
    await expect(page.getByTestId("trail-detail-counts")).toHaveText(
      /0 notes\s*·\s*0 photos\s*·\s*0 pending edits/,
    );
  });

  test("anonymous viewers can read a public trail's detail sheet but get no compose affordances", async ({
    page,
  }) => {
    // Pre-seed one note authored by the other rider so the read path
    // actually has something to render for the signed-out viewer.
    const noteBody = `public-readable note · ${Date.now()}`;
    const note = await seedNoteByOther(trailId, noteBody);
    await seedAmendmentByOther(
      trailId,
      { difficulty: 6 },
      `public-readable edit · ${Date.now()}`,
    );

    // No sign-in step. Wait for Clerk to load and confirm we're signed-out
    // before asserting on the gated affordances.
    await page.goto("/");
    await page.waitForFunction(
      () =>
        Boolean(
          (window as unknown as { Clerk?: { loaded?: boolean } }).Clerk
            ?.loaded,
        ),
      undefined,
      { timeout: 30_000 },
    );
    const isSignedIn = await page.evaluate(() =>
      Boolean((window as unknown as { Clerk?: { user?: unknown } }).Clerk?.user),
    );
    expect(isSignedIn).toBe(false);

    await page.goto(`/discover?trail=${trailId}`);
    await expect(page.getByTestId("trail-detail-name")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("trail-detail-counts")).toHaveText(
      /1 notes\s*·\s*0 photos\s*·\s*1 pending edits/,
    );

    // Notes tab: list is visible, the seeded note renders, but the
    // compose box is replaced with a sign-in prompt.
    await page.getByTestId("trail-tab-notes").click();
    const notesPanel = page.getByTestId("trail-notes-panel");
    await expect(notesPanel.getByText(noteBody)).toBeVisible();
    await expect(notesPanel.getByTestId("note-input")).toHaveCount(0);
    await expect(notesPanel.getByTestId("note-submit")).toHaveCount(0);
    await expect(
      notesPanel.getByText(/Sign in to add a note/i),
    ).toBeVisible();

    // Photos tab: empty state + sign-in caption, no upload button.
    await page.getByTestId("trail-tab-photos").click();
    const photosPanel = page.getByTestId("trail-photos-panel");
    await expect(photosPanel).toBeVisible();
    await expect(photosPanel.getByTestId("photo-upload-btn")).toHaveCount(0);
    await expect(photosPanel.getByTestId("photo-file-input")).toHaveCount(0);
    await expect(photosPanel.getByText(/Sign in to upload/i)).toBeVisible();

    // Amendments tab: existing pending amendment is readable but no
    // "Propose Edit" button and no approve/reject moderator controls.
    await page.getByTestId("trail-tab-amendments").click();
    const amPanel = page.getByTestId("trail-amendments-panel");
    await expect(amPanel.getByText(/public-readable edit/)).toBeVisible();
    await expect(amPanel.getByTestId("amendment-toggle-form")).toHaveCount(0);
    await expect(
      amPanel.getByText(/Sign in to propose/i),
    ).toBeVisible();
    await expect(
      amPanel.locator('[data-testid^="amendment-approve-"]'),
    ).toHaveCount(0);
    await expect(
      amPanel.locator('[data-testid^="amendment-reject-"]'),
    ).toHaveCount(0);

    // Sanity: the seeded note is still there in the DB after the read.
    const supa = supabaseAdmin();
    const { data: stillThere } = await supa
      .from("trail_notes")
      .select("id")
      .eq("id", note.id)
      .single();
    expect(stillThere?.id).toBe(note.id);
  });
});
