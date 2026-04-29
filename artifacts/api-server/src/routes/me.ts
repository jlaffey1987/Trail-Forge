import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { z } from "zod";
import {
  SyncMeResponse,
  SaveTrailBody,
  ListMySavedTrailsResponse,
  CountSessionSavedTrailsResponse,
  MigrateSessionSavedTrailsBody,
  MigrateSessionSavedTrailsResponse,
} from "@workspace/api-zod";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";

/**
 * Body schema for `PUT /me/planner-route`. The trail order matters — we
 * persist the array exactly as sent so the user's chosen route reads back
 * identically from another device. `trailIds` is capped at 50 because the
 * planner UI can't usefully chain more than that and the cap keeps the
 * jsonb payload bounded.
 */
const PutPlannerRouteBody = z.object({
  trailIds: z.array(z.string().min(1)).max(50),
});

/**
 * Server-side mirror of trailforge's `isSyntheticPlaceholderTrail` helper.
 *
 * Returns true for the legacy 2-point ai-approximated placeholders that
 * the AI forum scanner used to persist when no GPX and no nearby OSM
 * track was available. We hide those rows from My Trails so users who
 * saved one in the past don't keep seeing a phantom straight line on
 * the map. Conservative criteria — only matches the exact shape the old
 * `approximateTrackFromLocation` fallback wrote (lat+0.005 offset,
 * identical longitude, exactly 2 waypoints).
 */
function isLegacySyntheticPlaceholder(
  trail: Record<string, unknown> | null,
): boolean {
  if (!trail) return false;
  if (trail.verification_status !== "ai-approximated") return false;
  const ptCount = trail.path_point_count;
  if (ptCount != null && typeof ptCount === "number" && ptCount !== 2) {
    return false;
  }
  const minLat = trail.bbox_min_lat;
  const maxLat = trail.bbox_max_lat;
  const minLng = trail.bbox_min_lng;
  const maxLng = trail.bbox_max_lng;
  if (
    typeof minLat !== "number" ||
    typeof maxLat !== "number" ||
    typeof minLng !== "number" ||
    typeof maxLng !== "number"
  ) {
    return false;
  }
  const latSpanM = Math.abs(maxLat - minLat) * 111_320;
  const lngSpanDeg = Math.abs(maxLng - minLng);
  return lngSpanDeg < 1e-6 && latSpanM >= 400 && latSpanM <= 700;
}

const router: IRouter = Router();

router.post("/me/sync", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const user = await clerkClient.users.getUser(auth.userId);
    const email =
      user.primaryEmailAddress?.emailAddress ??
      user.emailAddresses[0]?.emailAddress ??
      null;
    const displayName =
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
      user.username ||
      null;
    const avatarUrl = user.imageUrl ?? null;

    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("users")
      .upsert(
        {
          id: auth.userId,
          email,
          display_name: displayName,
          avatar_url: avatarUrl,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      )
      .select()
      .single();

    if (error) {
      // Tolerate missing-table state (migration not yet applied) so the UI
      // does not break — return a synthetic shape.
      if (
        error.code === "42P01" ||
        error.code === "PGRST205" ||
        /relation .* does not exist/i.test(error.message ?? "")
      ) {
        req.log.warn(
          "users table missing — apply migration 0002_users_and_owner.sql",
        );
        res.json(
          SyncMeResponse.parse({
            id: auth.userId,
            email,
            display_name: displayName,
            avatar_url: avatarUrl,
            created_at: new Date().toISOString(),
          }),
        );
        return;
      }
      req.log.error({ err: error }, "users upsert failed");
      res.status(500).json({ error: "Failed to upsert user" });
      return;
    }

    res.json(SyncMeResponse.parse(data));
  } catch (err) {
    req.log.error({ err }, "syncMe failed");
    res.status(500).json({ error: "Failed to sync user" });
  }
});

router.get("/me/saved-trails", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const sessionId =
    typeof req.query.sessionId === "string" ? req.query.sessionId : null;

  if (!auth.userId && !sessionId) {
    res.json(ListMySavedTrailsResponse.parse({ items: [] }));
    return;
  }

  try {
    const supa = getSupabaseAdmin();
    let q = supa
      .from("saved_trails")
      .select("trail_id, status, saved_at, trails(*)")
      .order("saved_at", { ascending: false });

    if (auth.userId) {
      q = q.eq("user_id", auth.userId);
    } else if (sessionId) {
      q = q.eq("session_id", sessionId);
    }

    const { data, error } = await q;
    if (error) {
      if (
        error.code === "42P01" ||
        error.code === "PGRST205" ||
        /relation .* does not exist/i.test(error.message ?? "")
      ) {
        res.json(ListMySavedTrailsResponse.parse({ items: [] }));
        return;
      }
      req.log.error({ err: error }, "fetchSavedTrails failed");
      res.status(500).json({ error: "Failed to fetch saved trails" });
      return;
    }

    type TrailRel = Record<string, unknown>;
    interface SavedTrailRow {
      trail_id: string;
      status: string | null;
      saved_at: string | null;
      trails: TrailRel | TrailRel[] | null;
    }
    const rows = (data ?? []) as SavedTrailRow[];
    const items = rows
      .map((row) => ({
        trail_id: row.trail_id,
        status: row.status,
        saved_at: row.saved_at,
        trail: Array.isArray(row.trails) ? (row.trails[0] ?? null) : row.trails,
      }))
      // Hide legacy synthetic 2-point AI placeholders that were persisted by
      // the old approximateTrackFromLocation fallback before it was removed.
      // Mirrors trailforge's `isSyntheticPlaceholderTrail` so a user who
      // saved a phantom trail in the past doesn't keep seeing it in My
      // Trails. Conservative — only drops rows that match all of:
      //   verification_status='ai-approximated' AND
      //   simplified path is 2 points (or unknown) AND
      //   bbox lng-span ~0 AND lat-span ~400-700m (the legacy 0.005° offset).
      .filter((it) => !isLegacySyntheticPlaceholder(it.trail));

    res.json(ListMySavedTrailsResponse.parse({ items }));
  } catch (err) {
    req.log.error({ err }, "saved-trails GET failed");
    res.status(500).json({ error: "Failed to fetch saved trails" });
  }
});

router.post("/me/saved-trails", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const parsed = SaveTrailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing trail id" });
    return;
  }

  const trailId = parsed.data.trailId;
  const sessionId = parsed.data.sessionId ?? null;

  if (!auth.userId && !sessionId) {
    res.status(400).json({ error: "Either Clerk session or sessionId required" });
    return;
  }

  try {
    const supa = getSupabaseAdmin();
    const row: Record<string, unknown> = {
      trail_id: trailId,
      status: "planned",
    };
    if (auth.userId) {
      row.user_id = auth.userId;
      row.session_id = null;
    } else {
      row.session_id = sessionId;
    }

    const onConflict = auth.userId ? "user_id,trail_id" : "session_id,trail_id";
    let { error } = await supa
      .from("saved_trails")
      .upsert(row, { onConflict });
    if (error) {
      // Older schema (no unique index) — fall back to plain insert; ignore dupes.
      if (error.code === "42P10" || /no.*unique.*constraint/i.test(error.message ?? "")) {
        const { error: insErr } = await supa.from("saved_trails").insert(row);
        if (insErr && insErr.code !== "23505") error = insErr;
        else error = null;
      }
    }
    if (error) {
      req.log.error({ err: error }, "saveTrail failed");
      res.status(500).json({ error: "Failed to save trail" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "saveTrail failed");
    res.status(500).json({ error: "Failed to save trail" });
  }
});

router.get("/me/saved-trails/count", async (req: Request, res: Response) => {
  const sessionId =
    typeof req.query.sessionId === "string" ? req.query.sessionId : "";
  if (!sessionId) {
    res.status(400).json({ error: "sessionId required" });
    return;
  }
  try {
    const supa = getSupabaseAdmin();
    const { count, error } = await supa
      .from("saved_trails")
      .select("trail_id", { count: "exact", head: true })
      .eq("session_id", sessionId);
    if (error) {
      res.json(CountSessionSavedTrailsResponse.parse({ count: 0 }));
      return;
    }
    res.json(
      CountSessionSavedTrailsResponse.parse({ count: count ?? 0 }),
    );
  } catch (err) {
    req.log.error({ err }, "count saved-trails failed");
    res.json(CountSessionSavedTrailsResponse.parse({ count: 0 }));
  }
});

router.post(
  "/me/saved-trails/migrate",
  async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = MigrateSessionSavedTrailsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "sessionId required" });
      return;
    }

    try {
      const supa = getSupabaseAdmin();
      const { data: rows, error: findErr } = await supa
        .from("saved_trails")
        .select("trail_id")
        .eq("session_id", parsed.data.sessionId);
      if (findErr) {
        if (
          findErr.code === "42P01" ||
          findErr.code === "PGRST205" ||
          /relation .* does not exist/i.test(findErr.message ?? "")
        ) {
          res.json(MigrateSessionSavedTrailsResponse.parse({ migrated: 0 }));
          return;
        }
        req.log.error({ err: findErr }, "migrate find failed");
        res.status(500).json({ error: "Failed to find session rows" });
        return;
      }
      if (!rows || rows.length === 0) {
        res.json(MigrateSessionSavedTrailsResponse.parse({ migrated: 0 }));
        return;
      }

      let migrated = 0;
      for (const row of rows) {
        const { error: upErr } = await supa
          .from("saved_trails")
          .upsert(
            {
              trail_id: row.trail_id as string,
              user_id: auth.userId,
              session_id: null,
              status: "planned",
            },
            { onConflict: "user_id,trail_id" },
          );
        if (!upErr) {
          migrated += 1;
        } else {
          // Fallback: plain UPDATE for the matching session-bound row.
          const { error: updErr } = await supa
            .from("saved_trails")
            .update({ user_id: auth.userId, session_id: null })
            .eq("session_id", parsed.data.sessionId)
            .eq("trail_id", row.trail_id as string);
          if (!updErr) migrated += 1;
        }
      }
      res.json(
        MigrateSessionSavedTrailsResponse.parse({ migrated }),
      );
    } catch (err) {
      req.log.error({ err }, "migrate failed");
      res.status(500).json({ error: "Failed to migrate saved trails" });
    }
  },
);

// ---------------------------------------------------------------------------
// Planner route — persisted ordered list of trail ids the user is building
// on the Map / Planner. Per-user singleton (one row per Clerk user id).
//
// Schema is in `supabase/migrations/0012_planner_routes.sql`. The same
// "missing table = soft no-op" tolerance the saved-trails endpoints use is
// applied here so the UI keeps working on a database that hasn't had the
// migration applied yet — the route then stays in localStorage only.
// ---------------------------------------------------------------------------

const PLANNER_TRAIL_COLUMNS = [
  "id",
  "user_id",
  "owner_user_id",
  "name",
  "type",
  "difficulty",
  "distance_km",
  "terrain",
  "legal_status",
  "is_public",
  "created_at",
  "bbox_min_lat",
  "bbox_max_lat",
  "bbox_min_lng",
  "bbox_max_lng",
  "description",
  "deleted_at",
  "gpx_object_path",
  "source",
  "source_url",
  "verification_status",
  "ai_grade",
  "ai_grade_rationale",
  "ai_grade_model",
  "ai_graded_at",
  "simplified_path",
  "path_geojson",
  "path_point_count",
  "elevation_profile",
  "elevation_gain_m",
  "elevation_loss_m",
].join(",");

function isMissingTableError(err: { code?: string; message?: string } | null) {
  if (!err) return false;
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    /relation .* does not exist/i.test(err.message ?? "")
  );
}

router.get("/me/planner-route", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("planner_routes")
      .select("trail_ids, updated_at")
      .eq("user_id", auth.userId)
      .maybeSingle();

    if (error) {
      if (isMissingTableError(error)) {
        // Migration 0012 not yet applied — behave as if the row is empty
        // so the client falls back to localStorage-only mode silently.
        res.json({ trailIds: [], trails: [], updatedAt: null });
        return;
      }
      req.log.error({ err: error }, "fetchPlannerRoute failed");
      res.status(500).json({ error: "Failed to fetch planner route" });
      return;
    }

    const rawIds = (data?.trail_ids ?? []) as unknown;
    const trailIds = Array.isArray(rawIds)
      ? rawIds.filter((v): v is string => typeof v === "string")
      : [];

    if (trailIds.length === 0) {
      res.json({
        trailIds: [],
        trails: [],
        updatedAt: data?.updated_at ?? null,
      });
      return;
    }

    // Hydrate the trail rows so the client can render the route immediately
    // on a fresh device. We project the same slim columns the Map tab uses
    // to keep the payload light. Soft-deleted trails are filtered out.
    //
    // SECURITY: this endpoint is server-mediated with the service-role key,
    // which bypasses RLS. We MUST therefore re-apply trail visibility here
    // — otherwise an authenticated caller could PUT arbitrary trail ids
    // into their own planner_routes row and read back any private trail's
    // metadata via the GET. Visibility model (matches /api/me/group-trails):
    //   - the trail is public (`is_public = true`), OR
    //   - the caller owns the trail (`owner_user_id = auth.userId`), OR
    //   - the trail is shared into a group the caller is a member of
    //     (`trail_shares` row joining `group_members`).
    const { data: trailRows, error: trailErr } = await supa
      .from("trails")
      .select(PLANNER_TRAIL_COLUMNS)
      .in("id", trailIds)
      .is("deleted_at", null);

    if (trailErr) {
      req.log.error({ err: trailErr }, "planner-route trail hydrate failed");
      res.json({
        trailIds,
        trails: [],
        updatedAt: data?.updated_at ?? null,
      });
      return;
    }

    const fetched = (trailRows as unknown as Array<Record<string, unknown>>) ?? [];
    const visibleIds = new Set<string>();
    const needsGroupCheck: string[] = [];
    for (const row of fetched) {
      const id = typeof row.id === "string" ? row.id : null;
      if (!id) continue;
      if (row.is_public === true || row.owner_user_id === auth.userId) {
        visibleIds.add(id);
      } else {
        needsGroupCheck.push(id);
      }
    }

    if (needsGroupCheck.length > 0) {
      const { data: memberships, error: mErr } = await supa
        .from("group_members")
        .select("group_id")
        .eq("user_id", auth.userId);
      if (mErr && !isMissingTableError(mErr)) {
        req.log.warn({ err: mErr }, "planner-route group_members load failed");
      }
      const groupIds = ((memberships ?? []) as Array<{ group_id: string }>)
        .map((m) => m.group_id);
      if (groupIds.length > 0) {
        const { data: shares, error: sErr } = await supa
          .from("trail_shares")
          .select("trail_id")
          .in("trail_id", needsGroupCheck)
          .in("group_id", groupIds);
        if (sErr && !isMissingTableError(sErr)) {
          req.log.warn({ err: sErr }, "planner-route trail_shares load failed");
        }
        for (const r of (shares ?? []) as Array<{ trail_id: string }>) {
          visibleIds.add(r.trail_id);
        }
      }
    }

    // Preserve the saved order — Supabase doesn't guarantee `IN (...)` order.
    // Trails the caller can't see are dropped from the hydrated `trails`
    // array but their ids stay in `trailIds` so the client can render a
    // placeholder ("unavailable trail") row in the planner.
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of fetched) {
      const id = row?.id;
      if (typeof id === "string" && visibleIds.has(id)) byId.set(id, row);
    }
    const ordered: Array<Record<string, unknown>> = [];
    for (const id of trailIds) {
      const row = byId.get(id);
      if (row) ordered.push(row);
    }

    res.json({
      trailIds,
      trails: ordered,
      updatedAt: data?.updated_at ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "planner-route GET failed");
    res.status(500).json({ error: "Failed to fetch planner route" });
  }
});

router.put("/me/planner-route", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = PutPlannerRouteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid trailIds payload" });
    return;
  }

  // De-dupe while preserving order — the client's reducer does the same
  // thing, but defend in depth so a buggy caller can't poison the row.
  const seen = new Set<string>();
  const trailIds: string[] = [];
  for (const id of parsed.data.trailIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    trailIds.push(id);
  }

  try {
    const supa = getSupabaseAdmin();
    const updatedAt = new Date().toISOString();
    const row = {
      user_id: auth.userId,
      trail_ids: trailIds,
      updated_at: updatedAt,
    };

    let { error } = await supa
      .from("planner_routes")
      .upsert(row, { onConflict: "user_id" });

    // First-sign-in race recovery: ClerkUserSync runs `/me/sync` and the
    // planner store's PUT from independent effects, so the planner upsert
    // can land before the `users` row exists. Stub-insert the user row
    // (id-only — `/me/sync` will backfill email/display_name/avatar in
    // the same flow) and retry once. Without this the FK violation would
    // only be retried on the user's next route edit.
    if (error?.code === "23503") {
      const { error: userErr } = await supa
        .from("users")
        .upsert(
          { id: auth.userId, updated_at: updatedAt },
          { onConflict: "id" },
        );
      if (!userErr) {
        const retry = await supa
          .from("planner_routes")
          .upsert(row, { onConflict: "user_id" });
        error = retry.error;
      }
    }

    if (error) {
      if (isMissingTableError(error)) {
        // Migration 0012 not yet applied — accept the write so the UI
        // doesn't surface an error, but flag it in the logs so operators
        // know to apply the migration to enable cross-device sync.
        req.log.warn(
          "planner_routes table missing — apply migration 0012_planner_routes.sql",
        );
        res.json({ updatedAt: null, persisted: false });
        return;
      }
      req.log.error({ err: error }, "planner-route upsert failed");
      res.status(500).json({ error: "Failed to save planner route" });
      return;
    }

    res.json({ updatedAt, persisted: true });
  } catch (err) {
    req.log.error({ err }, "planner-route PUT failed");
    res.status(500).json({ error: "Failed to save planner route" });
  }
});

export default router;
