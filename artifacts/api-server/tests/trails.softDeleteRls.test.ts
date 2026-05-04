/**
 * Soft-delete visibility contract — migration 0005.
 *
 * Migration `0005_member_trails.sql` introduced `trails.deleted_at` and
 * tightened the public-read RLS policies on `trails`, `trail_notes`,
 * `trail_photos`, and `trail_amendments` so that anonymous (anon-key)
 * clients can no longer see soft-deleted trails or any of their attached
 * notes / photos / amendments. The API server (service role) must still
 * be able to see them so moderators can inspect, restore, or hard-delete.
 *
 * This test exercises that contract end-to-end against a real Supabase
 * instance (the same one configured via SUPABASE_URL / SUPABASE_ANON_KEY
 * / SUPABASE_SERVICE_ROLE_KEY) so any future tweak to those policies
 * trips the build instead of silently leaking deleted trails or hiding
 * them from moderators.
 *
 * It is skipped when the env vars are missing so the rest of the test
 * suite still runs in environments without Supabase access (e.g. a
 * minimal CI image with mocks only).
 *
 * Test data is fully self-contained and cleaned up in `afterAll`:
 *   - a `users` row keyed by a `__rls_test__` Clerk-style id
 *   - one `trails` row tagged `__rls_test__: …` in the name
 *   - one `trail_notes` row attached to that trail
 *   - one `trail_photos` row attached to that trail
 *   - one `trail_amendments` row attached to that trail
 * Trail deletion cascades to the notes, photos, and amendments via the FK
 * `ON DELETE CASCADE` declared in `0004_trail_content.sql`, and the user
 * is removed last so the FKs unwind cleanly.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const haveSupabase = Boolean(
  SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY,
);

const describeIfSupabase = haveSupabase ? describe : describe.skip;

const TEST_TAG = "__rls_test__";
const trailId = randomUUID();
const noteId = randomUUID();
const photoId = randomUUID();
const amendmentId = randomUUID();
const userId = `user_${TEST_TAG}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

let admin: SupabaseClient;
let anon: SupabaseClient;

describeIfSupabase("trails soft-delete RLS (migration 0005)", () => {
  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    anon = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Seed user — Clerk-style text PK. trail_notes / trail_photos
    // require this row to exist for their author_user_id FK.
    const userIns = await admin.from("users").insert({
      id: userId,
      email: `${TEST_TAG}@example.invalid`,
      display_name: "RLS Test User",
    });
    if (userIns.error) throw new Error(`seed users failed: ${userIns.error.message}`);

    // Seed trail — public, not yet deleted.
    const trailIns = await admin.from("trails").insert({
      id: trailId,
      name: `${TEST_TAG} trail ${trailId}`,
      type: "enduro",
      difficulty: 3,
      distance_km: 1.0,
      terrain: "Test",
      legal_status: "BOAT",
      is_public: true,
      owner_user_id: userId,
    });
    if (trailIns.error) throw new Error(`seed trails failed: ${trailIns.error.message}`);

    // Seed a note + photo attached to the trail.
    const noteIns = await admin.from("trail_notes").insert({
      id: noteId,
      trail_id: trailId,
      author_user_id: userId,
      body: `${TEST_TAG} note body`,
      kind: "info",
    });
    if (noteIns.error) throw new Error(`seed trail_notes failed: ${noteIns.error.message}`);

    const photoIns = await admin.from("trail_photos").insert({
      id: photoId,
      trail_id: trailId,
      author_user_id: userId,
      storage_key: `${TEST_TAG}/${trailId}.jpg`,
      caption: `${TEST_TAG} caption`,
    });
    if (photoIns.error) throw new Error(`seed trail_photos failed: ${photoIns.error.message}`);

    const amendIns = await admin.from("trail_amendments").insert({
      id: amendmentId,
      trail_id: trailId,
      author_user_id: userId,
      proposed_changes: { difficulty: 5 },
      reason: `${TEST_TAG} amendment reason`,
      status: "pending",
    });
    if (amendIns.error) throw new Error(`seed trail_amendments failed: ${amendIns.error.message}`);
  }, 30_000);

  afterAll(async () => {
    if (!admin) return;
    // Trail delete cascades to notes / photos via ON DELETE CASCADE.
    await admin.from("trails").delete().eq("id", trailId);
    await admin.from("users").delete().eq("id", userId);
  }, 30_000);

  it("baseline: anon can see the public trail and its note + photo + amendment while alive", async () => {
    const t = await anon.from("trails").select("id, deleted_at").eq("id", trailId).maybeSingle();
    expect(t.error).toBeNull();
    expect(t.data?.id).toBe(trailId);
    expect(t.data?.deleted_at).toBeNull();

    const n = await anon.from("trail_notes").select("id").eq("id", noteId).maybeSingle();
    expect(n.error).toBeNull();
    expect(n.data?.id).toBe(noteId);

    const p = await anon.from("trail_photos").select("id").eq("id", photoId).maybeSingle();
    expect(p.error).toBeNull();
    expect(p.data?.id).toBe(photoId);

    const a = await anon.from("trail_amendments").select("id").eq("id", amendmentId).maybeSingle();
    expect(a.error).toBeNull();
    expect(a.data?.id).toBe(amendmentId);
  });

  it("after soft-delete: anon cannot see the trail or its note + photo + amendment", async () => {
    const upd = await admin
      .from("trails")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", trailId);
    expect(upd.error).toBeNull();

    const t = await anon.from("trails").select("id").eq("id", trailId).maybeSingle();
    expect(t.error).toBeNull();
    expect(t.data).toBeNull();

    const n = await anon.from("trail_notes").select("id").eq("id", noteId).maybeSingle();
    expect(n.error).toBeNull();
    expect(n.data).toBeNull();

    const p = await anon.from("trail_photos").select("id").eq("id", photoId).maybeSingle();
    expect(p.error).toBeNull();
    expect(p.data).toBeNull();

    const a = await anon.from("trail_amendments").select("id").eq("id", amendmentId).maybeSingle();
    expect(a.error).toBeNull();
    expect(a.data).toBeNull();
  });

  it("after soft-delete: service role still sees the trail + note + photo + amendment", async () => {
    const t = await admin
      .from("trails")
      .select("id, deleted_at")
      .eq("id", trailId)
      .maybeSingle();
    expect(t.error).toBeNull();
    expect(t.data?.id).toBe(trailId);
    expect(t.data?.deleted_at).not.toBeNull();

    const n = await admin
      .from("trail_notes")
      .select("id, trail_id")
      .eq("id", noteId)
      .maybeSingle();
    expect(n.error).toBeNull();
    expect(n.data?.id).toBe(noteId);
    expect(n.data?.trail_id).toBe(trailId);

    const p = await admin
      .from("trail_photos")
      .select("id, trail_id")
      .eq("id", photoId)
      .maybeSingle();
    expect(p.error).toBeNull();
    expect(p.data?.id).toBe(photoId);
    expect(p.data?.trail_id).toBe(trailId);

    const a = await admin
      .from("trail_amendments")
      .select("id, trail_id")
      .eq("id", amendmentId)
      .maybeSingle();
    expect(a.error).toBeNull();
    expect(a.data?.id).toBe(amendmentId);
    expect(a.data?.trail_id).toBe(trailId);
  });
});

if (!haveSupabase) {
  // Surface the skip in test output so a missing-env CI run is obvious
  // rather than appearing as a silent pass.
  describe("trails soft-delete RLS (migration 0005)", () => {
    it.skip(
      "skipped — set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY to run",
      () => {},
    );
  });
}
