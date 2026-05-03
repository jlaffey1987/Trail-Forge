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
import {
  PLANNER_MAX_TRAILS,
  PLANNER_MAX_WAYPOINTS,
  PLANNER_MAX_ENTRIES,
} from "@workspace/planner-shared";

/**
 * Body schema for `PUT /me/planner-route`. The trail order matters — we
 * persist the array exactly as sent so the user's chosen route reads back
 * identically from another device. `trailIds` is capped at PLANNER_MAX_TRAILS
 * (defined in `@workspace/planner-shared` so the client mirrors the cap)
 * because the planner UI can't usefully chain more than that and the cap
 * keeps the jsonb payload bounded.
 *
 * `waypoints` (custom stops — fuel/campsite/custom pins picked off the
 * POI overlay) and `entryOrder` (the interleaved order of trails and
 * waypoints) are optional for backward-compat with the Phase-A client
 * that only knew about `trailIds`. When omitted the server stores
 * empty arrays and the client falls back to "trails only, in order".
 */
const PlannerWaypoint = z.object({
  id: z.string().min(1),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  name: z.string().min(1).max(200),
  kind: z.enum(["fuel", "campsite", "custom"]),
  osmId: z.string().min(1).max(100).optional(),
});
const PlannerEntryRef = z.object({
  kind: z.enum(["trail", "waypoint"]),
  id: z.string().min(1),
});
const PutPlannerRouteBody = z.object({
  trailIds: z.array(z.string().min(1)).max(PLANNER_MAX_TRAILS),
  waypoints: z.array(PlannerWaypoint).max(PLANNER_MAX_WAYPOINTS).optional(),
  entryOrder: z.array(PlannerEntryRef).max(PLANNER_MAX_ENTRIES).optional(),
});

/**
 * Server-side mirror of trailforge's `isSyntheticPlaceholderTrail` helper.
 *
 * Returns true for the legacy 2-point ai-approximated placeholders that
 * the AI forum scanner used to persist when no GPX and no nearby OSM
 * track was available.
 *
 * As of trailforge migration `0019_phantom_ai_trails_cleanup.sql` the
 * matching rows are soft-deleted (`deleted_at IS NOT NULL`) and a CHECK
 * constraint (`trails_no_phantom_ai_placeholder`) blocks new ones, so
 * the saved-trails join naturally hides them. This helper is retained
 * as defence-in-depth for environments where the migration has not yet
 * been applied (e.g. local dev DBs) and as documentation of the legacy
 * shape. Conservative criteria — only matches the exact shape the old
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
    // Try the wider select first (waypoints + entry_order from migration
    // 0017). If those columns aren't there yet (older deploy) fall back
    // to the original 0012 shape so the route still hydrates.
    let data: Record<string, unknown> | null = null;
    let error: { code?: string; message?: string } | null = null;
    {
      const wide = await supa
        .from("planner_routes")
        .select("trail_ids, waypoints, entry_order, updated_at")
        .eq("user_id", auth.userId)
        .maybeSingle();
      if (wide.error?.code === "42703") {
        const narrow = await supa
          .from("planner_routes")
          .select("trail_ids, updated_at")
          .eq("user_id", auth.userId)
          .maybeSingle();
        data = narrow.data as Record<string, unknown> | null;
        error = narrow.error;
      } else {
        data = wide.data as Record<string, unknown> | null;
        error = wide.error;
      }
    }

    if (error) {
      if (isMissingTableError(error)) {
        // Migration 0012 not yet applied — behave as if the row is empty
        // so the client falls back to localStorage-only mode silently.
        res.json({
          trailIds: [],
          trails: [],
          waypoints: [],
          entryOrder: [],
          updatedAt: null,
        });
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
    // Sanitize waypoints — service-role bypasses RLS but the column is
    // user-controlled, so re-validate shapes before echoing them back.
    const rawWps = (data?.waypoints ?? []) as unknown;
    const waypoints: Array<{
      id: string;
      lat: number;
      lng: number;
      name: string;
      kind: "fuel" | "campsite" | "custom";
      osmId?: string;
    }> = Array.isArray(rawWps)
      ? rawWps.flatMap((w) => {
          if (!w || typeof w !== "object") return [];
          const obj = w as Record<string, unknown>;
          const id = typeof obj.id === "string" ? obj.id : null;
          const lat = typeof obj.lat === "number" ? obj.lat : NaN;
          const lng = typeof obj.lng === "number" ? obj.lng : NaN;
          const name = typeof obj.name === "string" ? obj.name : "";
          const kind = obj.kind;
          if (
            !id ||
            !Number.isFinite(lat) ||
            !Number.isFinite(lng) ||
            !name ||
            (kind !== "fuel" && kind !== "campsite" && kind !== "custom")
          ) {
            return [];
          }
          const out: {
            id: string;
            lat: number;
            lng: number;
            name: string;
            kind: "fuel" | "campsite" | "custom";
            osmId?: string;
          } = { id, lat, lng, name, kind };
          if (typeof obj.osmId === "string") out.osmId = obj.osmId;
          return [out];
        })
      : [];
    const rawOrder = (data?.entry_order ?? []) as unknown;
    const entryOrder: Array<{ kind: "trail" | "waypoint"; id: string }> =
      Array.isArray(rawOrder)
        ? rawOrder.flatMap((r) => {
            if (!r || typeof r !== "object") return [];
            const obj = r as Record<string, unknown>;
            const kind = obj.kind;
            const id = typeof obj.id === "string" ? obj.id : null;
            if ((kind !== "trail" && kind !== "waypoint") || !id) return [];
            return [{ kind, id }];
          })
        : [];

    if (trailIds.length === 0) {
      res.json({
        trailIds: [],
        trails: [],
        waypoints,
        entryOrder,
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
        waypoints,
        entryOrder,
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
      waypoints,
      entryOrder,
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
  // Same de-dupe for waypoints (by id) — Overpass nodes are stable so
  // the client also de-dupes, but we defend in depth.
  const wpSeen = new Set<string>();
  const waypoints = (parsed.data.waypoints ?? []).filter((w) => {
    if (wpSeen.has(w.id)) return false;
    wpSeen.add(w.id);
    return true;
  });
  // Validate entryOrder: every ref must point to a known trail/waypoint.
  // Drop dangling refs rather than rejecting the whole write — the client
  // could legitimately race a remove-trail with a reorder.
  const trailIdSet = new Set(trailIds);
  const wpIdSet = new Set(waypoints.map((w) => w.id));
  const orderSeen = new Set<string>();
  const entryOrder = (parsed.data.entryOrder ?? []).filter((r) => {
    const key = `${r.kind}:${r.id}`;
    if (orderSeen.has(key)) return false;
    orderSeen.add(key);
    if (r.kind === "trail") return trailIdSet.has(r.id);
    return wpIdSet.has(r.id);
  });

  try {
    const supa = getSupabaseAdmin();
    const updatedAt = new Date().toISOString();
    const wideRow = {
      user_id: auth.userId,
      trail_ids: trailIds,
      waypoints,
      entry_order: entryOrder,
      updated_at: updatedAt,
    };
    const narrowRow = {
      user_id: auth.userId,
      trail_ids: trailIds,
      updated_at: updatedAt,
    };
    // Use the wide row when the columns exist; fall back to narrow if a
    // pre-0017 deploy is missing waypoints/entry_order. We keep `row` as
    // the active payload so the existing FK-recovery retry below stays
    // unchanged.
    let row: Record<string, unknown> = wideRow;

    let { error } = await supa
      .from("planner_routes")
      .upsert(row, { onConflict: "user_id" });
    if (error?.code === "PGRST204" || error?.code === "42703") {
      // Pre-0017 schema — drop waypoint columns and retry.
      row = narrowRow;
      const retry = await supa
        .from("planner_routes")
        .upsert(row, { onConflict: "user_id" });
      error = retry.error;
      if (!error) {
        req.log.warn(
          "planner_routes missing waypoints/entry_order columns — apply migration 0017_planner_route_waypoints.sql",
        );
      }
    }

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

// ---------------------------------------------------------------------------
// Saved routes — named library of routes (a rider can keep many).
//
// `planner_routes` (above) is a per-user singleton: their *current*
// in-progress route. `saved_routes` is the persistent library — riders
// save a built route under a name ("Welsh Weekend Loop") and can load
// it back into the planner later. Loading a saved route is a client-side
// operation: the client reads this row, replaces the planner store
// in-memory, then PUT /me/planner-route persists the swap.
//
// Schema is in `supabase/migrations/0018_saved_routes.sql`. Same
// missing-table tolerance as the planner-route endpoints so the UI
// degrades gracefully on a database that hasn't had the migration
// applied yet.
// ---------------------------------------------------------------------------

const PostSavedRouteBody = z.object({
  name: z.string().trim().min(1).max(200),
  trailIds: z.array(z.string().min(1)).max(PLANNER_MAX_TRAILS),
  waypoints: z.array(PlannerWaypoint).max(PLANNER_MAX_WAYPOINTS).optional(),
  entryOrder: z.array(PlannerEntryRef).max(PLANNER_MAX_ENTRIES).optional(),
  distanceKm: z.number().finite().nonnegative().nullable().optional(),
});

// PATCH only changes the name. We deliberately keep this narrow so it
// stays a one-tap rename and can't accidentally clobber the route
// payload — for that the rider can load + re-save (planned follow-up).
const PatchSavedRouteBody = z.object({
  name: z.string().trim().min(1).max(200),
});

const SAVED_ROUTES_PER_USER_LIMIT = 50;

interface SavedRouteRow {
  id: string;
  name: string;
  trail_ids: string[];
  waypoints: unknown;
  entry_order: unknown;
  distance_km: string | number | null;
  created_at: string;
}

router.get("/me/saved-routes", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("saved_routes")
      .select("id, name, trail_ids, waypoints, entry_order, distance_km, created_at")
      .eq("user_id", auth.userId)
      .order("created_at", { ascending: false });

    if (error) {
      if (isMissingTableError(error)) {
        // Migration 0018 not yet applied — pretend the rider has no
        // saved routes so the UI shows the empty state instead of an
        // error toast.
        res.json({ routes: [] });
        return;
      }
      req.log.error({ err: error }, "saved-routes GET failed");
      res.status(500).json({ error: "Failed to fetch saved routes" });
      return;
    }

    const rows = (data ?? []) as SavedRouteRow[];

    // Hydrate trails across ALL routes in one query so the My Trails
    // listing renders without N round trips. Same visibility model as
    // the planner-route GET above (public OR owned OR shared into a
    // group the rider belongs to) — strip trails the rider can't see.
    const allTrailIds = new Set<string>();
    for (const row of rows) {
      const ids = Array.isArray(row.trail_ids) ? row.trail_ids : [];
      for (const id of ids) {
        if (typeof id === "string") allTrailIds.add(id);
      }
    }

    let trailById = new Map<string, Record<string, unknown>>();
    if (allTrailIds.size > 0) {
      const { data: trailRows, error: trailErr } = await supa
        .from("trails")
        .select(PLANNER_TRAIL_COLUMNS)
        .in("id", Array.from(allTrailIds))
        .is("deleted_at", null);
      if (trailErr) {
        req.log.warn({ err: trailErr }, "saved-routes trail hydrate failed");
      } else {
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
          const { data: memberships } = await supa
            .from("group_members")
            .select("group_id")
            .eq("user_id", auth.userId);
          const groupIds = ((memberships ?? []) as Array<{ group_id: string }>)
            .map((m) => m.group_id);
          if (groupIds.length > 0) {
            const { data: shares } = await supa
              .from("trail_shares")
              .select("trail_id")
              .in("trail_id", needsGroupCheck)
              .in("group_id", groupIds);
            for (const r of (shares ?? []) as Array<{ trail_id: string }>) {
              visibleIds.add(r.trail_id);
            }
          }
        }
        for (const row of fetched) {
          const id = row?.id;
          if (typeof id === "string" && visibleIds.has(id)) {
            trailById.set(id, row);
          }
        }
      }
    }

    const routes = rows.map((row) => {
      const trailIds = Array.isArray(row.trail_ids)
        ? row.trail_ids.filter((id): id is string => typeof id === "string")
        : [];
      const trails: Array<Record<string, unknown>> = [];
      for (const id of trailIds) {
        const t = trailById.get(id);
        if (t) trails.push(t);
      }
      const waypoints = Array.isArray(row.waypoints) ? row.waypoints : [];
      const entryOrder = Array.isArray(row.entry_order) ? row.entry_order : [];
      const distance =
        row.distance_km == null
          ? null
          : typeof row.distance_km === "string"
            ? Number(row.distance_km)
            : row.distance_km;
      return {
        id: row.id,
        name: row.name,
        trailIds,
        trails,
        waypoints,
        entryOrder,
        distanceKm: Number.isFinite(distance as number) ? distance : null,
        createdAt: row.created_at,
      };
    });

    res.json({ routes });
  } catch (err) {
    req.log.error({ err }, "saved-routes GET failed");
    res.status(500).json({ error: "Failed to fetch saved routes" });
  }
});

router.post("/me/saved-routes", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = PostSavedRouteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid saved-route payload" });
    return;
  }

  if (parsed.data.trailIds.length === 0) {
    res.status(400).json({ error: "Cannot save an empty route" });
    return;
  }

  // De-dupe trailIds & waypoints; filter dangling entry_order refs.
  // Same defence-in-depth as PUT /me/planner-route.
  const seenTrails = new Set<string>();
  const trailIds: string[] = [];
  for (const id of parsed.data.trailIds) {
    if (seenTrails.has(id)) continue;
    seenTrails.add(id);
    trailIds.push(id);
  }
  const wpSeen = new Set<string>();
  const waypoints = (parsed.data.waypoints ?? []).filter((w) => {
    if (wpSeen.has(w.id)) return false;
    wpSeen.add(w.id);
    return true;
  });
  const trailIdSet = new Set(trailIds);
  const wpIdSet = new Set(waypoints.map((w) => w.id));
  const orderSeen = new Set<string>();
  const entryOrder = (parsed.data.entryOrder ?? []).filter((r) => {
    const key = `${r.kind}:${r.id}`;
    if (orderSeen.has(key)) return false;
    orderSeen.add(key);
    if (r.kind === "trail") return trailIdSet.has(r.id);
    return wpIdSet.has(r.id);
  });

  try {
    const supa = getSupabaseAdmin();

    // Cap per-user count so a buggy client (or motivated abuser) can't
    // fill the table. 50 named routes is well past anything a real
    // rider needs — when they hit it they can delete an old one.
    const { count, error: countErr } = await supa
      .from("saved_routes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", auth.userId);
    if (countErr && !isMissingTableError(countErr)) {
      req.log.warn({ err: countErr }, "saved-routes count failed");
    }
    if ((count ?? 0) >= SAVED_ROUTES_PER_USER_LIMIT) {
      res.status(409).json({
        error: `You've reached the limit of ${SAVED_ROUTES_PER_USER_LIMIT} saved routes. Delete one to save a new one.`,
      });
      return;
    }

    const now = new Date().toISOString();
    const insertRow = {
      user_id: auth.userId,
      name: parsed.data.name.trim(),
      trail_ids: trailIds,
      waypoints,
      entry_order: entryOrder,
      distance_km: parsed.data.distanceKm ?? null,
      created_at: now,
      updated_at: now,
    };

    let { data, error } = await supa
      .from("saved_routes")
      .insert(insertRow)
      .select("id, name, created_at")
      .single();

    // Mirror the planner-route FK-recovery: if /me/sync hasn't landed
    // yet the FK against users.id will fail; stub-insert the row and
    // retry once.
    if (error?.code === "23503") {
      const { error: userErr } = await supa
        .from("users")
        .upsert({ id: auth.userId, updated_at: now }, { onConflict: "id" });
      if (!userErr) {
        const retry = await supa
          .from("saved_routes")
          .insert(insertRow)
          .select("id, name, created_at")
          .single();
        data = retry.data;
        error = retry.error;
      }
    }

    if (error) {
      if (isMissingTableError(error)) {
        req.log.warn(
          "saved_routes table missing — apply migration 0018_saved_routes.sql",
        );
        res.status(503).json({
          error:
            "Saved routes aren't available yet on this database. Apply migration 0018.",
        });
        return;
      }
      req.log.error({ err: error }, "saved-routes insert failed");
      res.status(500).json({ error: "Failed to save route" });
      return;
    }

    if (!data) {
      res.status(500).json({ error: "Failed to save route" });
      return;
    }

    res.json({ id: data.id, name: data.name, createdAt: data.created_at });
  } catch (err) {
    req.log.error({ err }, "saved-routes POST failed");
    res.status(500).json({ error: "Failed to save route" });
  }
});

// PUT replaces the whole route payload (trails + waypoints + order +
// distance), keeping the id and re-using the name. Used by the
// "Update <name>" button when the rider edits a loaded saved route.
// Body shape matches POST so the client can reuse its build logic.
router.put("/me/saved-routes/:id", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = req.params.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 100) {
    res.status(400).json({ error: "Invalid route id" });
    return;
  }
  const parsed = PostSavedRouteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid saved-route payload" });
    return;
  }
  if (parsed.data.trailIds.length === 0) {
    res.status(400).json({ error: "Cannot save an empty route" });
    return;
  }

  // Same de-dupe as POST so an update can't smuggle duplicates past
  // the contract that a fresh save honours.
  const seenTrails = new Set<string>();
  const trailIds: string[] = [];
  for (const tId of parsed.data.trailIds) {
    if (seenTrails.has(tId)) continue;
    seenTrails.add(tId);
    trailIds.push(tId);
  }
  const wpSeen = new Set<string>();
  const waypoints = (parsed.data.waypoints ?? []).filter((w) => {
    if (wpSeen.has(w.id)) return false;
    wpSeen.add(w.id);
    return true;
  });
  const trailIdSet = new Set(trailIds);
  const wpIdSet = new Set(waypoints.map((w) => w.id));
  const orderSeen = new Set<string>();
  const entryOrder = (parsed.data.entryOrder ?? []).filter((r) => {
    const key = `${r.kind}:${r.id}`;
    if (orderSeen.has(key)) return false;
    orderSeen.add(key);
    if (r.kind === "trail") return trailIdSet.has(r.id);
    return wpIdSet.has(r.id);
  });

  try {
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("saved_routes")
      .update({
        name: parsed.data.name.trim(),
        trail_ids: trailIds,
        waypoints,
        entry_order: entryOrder,
        distance_km: parsed.data.distanceKm ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", auth.userId)
      .select("id, name, created_at")
      .single();

    if (error) {
      if ((error as { code?: string }).code === "PGRST116") {
        res.status(404).json({ error: "Route not found" });
        return;
      }
      if (isMissingTableError(error)) {
        res.status(503).json({
          error:
            "Saved routes aren't available yet on this database. Apply migration 0018.",
        });
        return;
      }
      req.log.error({ err: error }, "saved-routes update failed");
      res.status(500).json({ error: "Failed to update route" });
      return;
    }

    res.json({ id: data.id, name: data.name, createdAt: data.created_at });
  } catch (err) {
    req.log.error({ err }, "saved-routes PUT failed");
    res.status(500).json({ error: "Failed to update route" });
  }
});

router.patch("/me/saved-routes/:id", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = req.params.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 100) {
    res.status(400).json({ error: "Invalid route id" });
    return;
  }
  const parsed = PatchSavedRouteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid rename payload" });
    return;
  }

  try {
    const supa = getSupabaseAdmin();
    // Scope the update to (id, user_id) — same defence as DELETE so
    // a user can't rename someone else's row by guessing a uuid.
    // .select() returns the matched rows; if none match (wrong owner
    // or unknown id) we return 404.
    const { data, error } = await supa
      .from("saved_routes")
      .update({
        name: parsed.data.name.trim(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", auth.userId)
      .select("id, name")
      .single();

    if (error) {
      // PGRST116 = no rows found by .single(); treat as 404.
      if ((error as { code?: string }).code === "PGRST116") {
        res.status(404).json({ error: "Route not found" });
        return;
      }
      if (isMissingTableError(error)) {
        res.status(503).json({
          error:
            "Saved routes aren't available yet on this database. Apply migration 0018.",
        });
        return;
      }
      req.log.error({ err: error }, "saved-routes rename failed");
      res.status(500).json({ error: "Failed to rename route" });
      return;
    }

    res.json({ id: data.id, name: data.name });
  } catch (err) {
    req.log.error({ err }, "saved-routes PATCH failed");
    res.status(500).json({ error: "Failed to rename route" });
  }
});

router.delete("/me/saved-routes/:id", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = req.params.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 100) {
    res.status(400).json({ error: "Invalid route id" });
    return;
  }

  try {
    const supa = getSupabaseAdmin();
    // Scope the delete to (id, user_id) so a user can't delete another
    // rider's row even if they guess a uuid.
    const { error } = await supa
      .from("saved_routes")
      .delete()
      .eq("id", id)
      .eq("user_id", auth.userId);

    if (error) {
      if (isMissingTableError(error)) {
        res.json({ deleted: false });
        return;
      }
      req.log.error({ err: error }, "saved-routes delete failed");
      res.status(500).json({ error: "Failed to delete route" });
      return;
    }

    res.json({ deleted: true });
  } catch (err) {
    req.log.error({ err }, "saved-routes DELETE failed");
    res.status(500).json({ error: "Failed to delete route" });
  }
});

export default router;
