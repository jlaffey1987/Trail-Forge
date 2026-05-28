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
import { isMissingTableError, isMissingColumnError } from "../lib/dbErrors";
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

    const upsertPayload = {
      id: auth.userId,
      email,
      display_name: displayName,
      avatar_url: avatarUrl,
      updated_at: new Date().toISOString(),
    };

    // Try the full select including premium fields (requires migration 0028).
    // Fall back to the pre-0028 column set if those columns don't exist yet.
    let { data, error } = await supa
      .from("users")
      .upsert(upsertPayload, { onConflict: "id" })
      .select("id, email, display_name, avatar_url, created_at, is_moderator, is_premium, preferred_bike_type")
      .single();

    if (error && isMissingColumnError(error)) {
      req.log.warn(
        "is_premium / preferred_bike_type columns missing — apply migration 0028_user_premium.sql",
      );
      ({ data, error } = await supa
        .from("users")
        .upsert(upsertPayload, { onConflict: "id" })
        .select("id, email, display_name, avatar_url, created_at, is_moderator")
        .single());
    }

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

// ---------------------------------------------------------------------------
// PATCH /me/preferences — persist user's preferred bike type (and future prefs)
// ---------------------------------------------------------------------------

const PatchPreferencesBody = z.object({
  preferred_bike_type: z.enum(["all", "adventure", "trail", "enduro"]).optional(),
});

router.patch("/me/preferences", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = PatchPreferencesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid preferences payload" });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.preferred_bike_type !== undefined) {
    updates.preferred_bike_type = parsed.data.preferred_bike_type;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No recognised preference fields supplied" });
    return;
  }

  const supa = getSupabaseAdmin();
  const { error } = await supa
    .from("users")
    .update(updates)
    .eq("id", auth.userId);

  if (error) {
    if (isMissingColumnError(error)) {
      req.log.warn("Preferences columns missing — apply migration 0028_user_premium.sql");
      res.json({ ok: true }); // silently succeed so the client isn't broken
      return;
    }
    req.log.error({ err: error }, "preferences update failed");
    res.status(500).json({ error: "Failed to update preferences" });
    return;
  }

  res.json({ ok: true });
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

// Planner route — per-user singleton (current in-progress route).

const PLANNER_TRAIL_COLUMNS = [
  "id",
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
].join(",");

router.get("/me/planner-route", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const supa = getSupabaseAdmin();
    // Wide select first; fall back to narrow if pre-0017 schema.
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

    // Hydrate trail rows, enforcing visibility (public / owned / group-shared).
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

  const seen = new Set<string>();
  const trailIds: string[] = [];
  for (const id of parsed.data.trailIds) {
    if (seen.has(id)) continue;
    seen.add(id);
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

    // FK recovery: stub-insert user row if /me/sync hasn't landed yet.
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
// POST /me/planner/suggestions
// ---------------------------------------------------------------------------
// Returns trails along the corridor between two lat/lon points, sorted by
// along-track position so the list reads start → end geographically.
// This is the mobile-app endpoint that the web handles client-side via
// `selectTrailsAlongCorridor` + a Supabase bbox fetch.
// ---------------------------------------------------------------------------

const PlannerSuggestionsBody = z.object({
  fromLat: z.number().finite().min(-90).max(90),
  fromLon: z.number().finite().min(-180).max(180),
  toLat: z.number().finite().min(-90).max(90),
  toLon: z.number().finite().min(-180).max(180),
  /** Half-width of the corridor in km (defaults to 25 km). */
  corridorKm: z.number().finite().positive().max(200).optional(),
  /** Max suggestions to return (defaults to 8). */
  maxTrails: z.number().int().positive().max(30).optional(),
});

const KM_PER_DEG_LAT = 111.32;

router.post("/me/planner/suggestions", async (req: Request, res: Response) => {
  // Suggestions are useful even for unauthenticated users (guest planning),
  // so we don't require auth here.  Group-shared trails are excluded; only
  // public trails are surfaced in corridor suggestions.

  const parsed = PlannerSuggestionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid suggestions payload" });
    return;
  }

  const { fromLat, fromLon, toLat, toLon } = parsed.data;
  const corridorKm = parsed.data.corridorKm ?? 25;
  const maxTrails = parsed.data.maxTrails ?? 8;

  // Expand a bbox around the corridor with generous padding so we capture
  // trails near the edges of a curved real-world route.
  const corridorPadDeg = (corridorKm / KM_PER_DEG_LAT) * 1.3;
  const minLat = Math.min(fromLat, toLat) - corridorPadDeg;
  const maxLat = Math.max(fromLat, toLat) + corridorPadDeg;
  const minLon = Math.min(fromLon, toLon) - corridorPadDeg;
  const maxLon = Math.max(fromLon, toLon) + corridorPadDeg;

  try {
    const supa = getSupabaseAdmin();

    // Query trails whose bbox overlaps the corridor bbox.
    const { data, error } = await supa
      .from("trails")
      .select(
        "id, name, difficulty, distance_km, bbox_min_lat, bbox_max_lat, bbox_min_lng, bbox_max_lng",
      )
      .eq("is_public", true)
      .is("deleted_at", null)
      .neq("verification_status", "ai-approximated")
      .gte("bbox_max_lat", minLat)
      .lte("bbox_min_lat", maxLat)
      .gte("bbox_max_lng", minLon)
      .lte("bbox_min_lng", maxLon)
      .limit(600);

    if (error) {
      req.log.error({ err: error }, "planner suggestions query failed");
      res.status(500).json({ error: "Suggestions query failed" });
      return;
    }

    type Row = {
      id: string;
      name: string;
      difficulty: string | null;
      distance_km: number | null;
      bbox_min_lat: number | null;
      bbox_max_lat: number | null;
      bbox_min_lng: number | null;
      bbox_max_lng: number | null;
    };

    const rows = (data ?? []) as Row[];

    // --- corridor scoring (ported from artifacts/trailforge/src/lib/routing.ts) ---
    const meanLat = ((fromLat + toLat) / 2) * (Math.PI / 180);
    const kmPerDegLng = KM_PER_DEG_LAT * Math.cos(meanLat);
    const bx = (toLon - fromLon) * kmPerDegLng;
    const by = (toLat - fromLat) * KM_PER_DEG_LAT;
    const totalKm = Math.hypot(bx, by);

    type ScoredRow = Row & { alongKm: number; perpKm: number };
    const scored: ScoredRow[] = [];

    for (const t of rows) {
      const cLat =
        t.bbox_min_lat != null && t.bbox_max_lat != null
          ? (t.bbox_min_lat + t.bbox_max_lat) / 2
          : null;
      const cLon =
        t.bbox_min_lng != null && t.bbox_max_lng != null
          ? (t.bbox_min_lng + t.bbox_max_lng) / 2
          : null;
      if (cLat == null || cLon == null) continue;

      const px = (cLon - fromLon) * kmPerDegLng;
      const py = (cLat - fromLat) * KM_PER_DEG_LAT;
      let alongKm: number;
      let perpKm: number;

      if (totalKm < 0.01) {
        alongKm = 0;
        perpKm = Math.hypot(px, py);
      } else {
        const t01 = (px * bx + py * by) / (totalKm * totalKm);
        const tc = Math.max(0, Math.min(1, t01));
        perpKm = Math.hypot(px - tc * bx, py - tc * by);
        alongKm = tc * totalKm;
      }

      if (perpKm > corridorKm) continue;
      scored.push({ ...t, alongKm, perpKm });
    }

    // Bucket by along-track position → pick the closest-to-centreline trail
    // per bucket, then backfill with remaining closest trails.
    let selected: ScoredRow[];
    if (totalKm < 1 || maxTrails === 1) {
      selected = [...scored]
        .sort((a, b) => a.perpKm - b.perpKm)
        .slice(0, maxTrails);
    } else {
      const buckets: ScoredRow[][] = Array.from({ length: maxTrails }, () => []);
      for (const s of scored) {
        const idx = Math.min(
          maxTrails - 1,
          Math.max(0, Math.floor((s.alongKm / totalKm) * maxTrails)),
        );
        buckets[idx].push(s);
      }
      const picked: ScoredRow[] = [];
      const pickedIds = new Set<string>();
      for (const b of buckets) {
        if (b.length === 0) continue;
        b.sort((x, y) => x.perpKm - y.perpKm);
        picked.push(b[0]);
        pickedIds.add(b[0].id);
      }
      if (picked.length < maxTrails) {
        for (const s of scored.filter((s) => !pickedIds.has(s.id))
          .sort((a, b) => a.perpKm - b.perpKm)) {
          if (picked.length >= maxTrails) break;
          picked.push(s);
        }
      }
      selected = picked;
    }

    selected.sort((a, b) => a.alongKm - b.alongKm);

    const suggestions = selected.map((s) => ({
      trailId: s.id,
      name: s.name,
      distance_km: s.distance_km ?? null,
      difficulty: s.difficulty ?? null,
      detourMeters: Math.round(s.perpKm * 1000),
    }));

    res.json({ suggestions });
  } catch (err) {
    req.log.error({ err }, "planner/suggestions failed");
    res.status(500).json({ error: "Failed to compute suggestions" });
  }
});

// ---------------------------------------------------------------------------
// Map selection — lightweight cloud sync of the Map-tab trail selection.
// Uses the same `planner_routes`-style approach but simpler: just trail IDs.
// Table: `map_selections` with columns `user_id` (PK), `trail_ids` (jsonb),
// `updated_at` (timestamptz). Falls back gracefully if the table doesn't
// exist yet (migration not applied).
// ---------------------------------------------------------------------------

const MapSelectionBody = z.object({
  trailIds: z.array(z.string().uuid()).max(PLANNER_MAX_TRAILS),
});

router.get("/me/map-selection", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("map_selections")
      .select("trail_ids, updated_at")
      .eq("user_id", auth.userId)
      .maybeSingle();

    if (error) {
      if (isMissingTableError(error)) {
        res.json({ trailIds: [], trails: [], updatedAt: null });
        return;
      }
      req.log.error({ err: error }, "fetchMapSelection failed");
      res.status(500).json({ error: "Failed to fetch map selection" });
      return;
    }

    const rawIds = (data?.trail_ids ?? []) as unknown;
    const trailIds = Array.isArray(rawIds)
      ? rawIds.filter((v): v is string => typeof v === "string")
      : [];

    if (trailIds.length === 0) {
      res.json({ trailIds: [], trails: [], updatedAt: data?.updated_at ?? null });
      return;
    }

    const { data: trailRows, error: trailErr } = await supa
      .from("trails")
      .select(PLANNER_TRAIL_COLUMNS)
      .in("id", trailIds)
      .is("deleted_at", null);

    if (trailErr) {
      req.log.error({ err: trailErr }, "map-selection trail hydrate failed");
      res.json({ trailIds, trails: [], updatedAt: data?.updated_at ?? null });
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
        req.log.warn({ err: mErr }, "map-selection group_members load failed");
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
          req.log.warn({ err: sErr }, "map-selection trail_shares load failed");
        }
        for (const s of (shares ?? []) as Array<{ trail_id: string }>) {
          visibleIds.add(s.trail_id);
        }
      }
    }

    const byId = new Map<string, Record<string, unknown>>();
    for (const row of fetched) {
      const id = row.id as string;
      if (visibleIds.has(id)) byId.set(id, row);
    }
    const orderedTrails = trailIds
      .filter((id) => byId.has(id))
      .map((id) => byId.get(id)!);

    res.json({
      trailIds: orderedTrails.map((t) => t.id as string),
      trails: orderedTrails,
      updatedAt: data?.updated_at ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "map-selection GET failed");
    res.status(500).json({ error: "Failed to fetch map selection" });
  }
});

router.put("/me/map-selection", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = MapSelectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid trailIds payload" });
    return;
  }

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
      .from("map_selections")
      .upsert(row, { onConflict: "user_id" });

    if (error?.code === "23503") {
      const { error: userErr } = await supa
        .from("users")
        .upsert(
          { id: auth.userId, updated_at: updatedAt },
          { onConflict: "id" },
        );
      if (!userErr) {
        const retry = await supa
          .from("map_selections")
          .upsert(row, { onConflict: "user_id" });
        error = retry.error;
      }
    }

    if (error) {
      if (isMissingTableError(error)) {
        req.log.warn(
          "map_selections table missing — apply migration to enable cross-device selection sync",
        );
        res.json({ updatedAt: null, persisted: false });
        return;
      }
      req.log.error({ err: error }, "map-selection upsert failed");
      res.status(500).json({ error: "Failed to save map selection" });
      return;
    }

    res.json({ updatedAt, persisted: true });
  } catch (err) {
    req.log.error({ err }, "map-selection PUT failed");
    res.status(500).json({ error: "Failed to save map selection" });
  }
});

// Saved routes — named library of routes (many per user).

// Ride-type tag offered by the Save dialog. Kept open-ended (any short
// string) so the planner UI can experiment with new categories without
// a server change — the Discover filter ribbon mirrors this set.
const RIDE_TYPES = [
  "adventure",
  "enduro",
  "trail",
  "green-laning",
  "other",
] as const;
const RideType = z.enum(RIDE_TYPES);

const PostSavedRouteBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  rideType: RideType.nullable().optional(),
  region: z.string().trim().max(120).nullable().optional(),
  isPublic: z.boolean().optional(),
  trailIds: z.array(z.string().min(1)).max(PLANNER_MAX_TRAILS),
  waypoints: z.array(PlannerWaypoint).max(PLANNER_MAX_WAYPOINTS).optional(),
  entryOrder: z.array(PlannerEntryRef).max(PLANNER_MAX_ENTRIES).optional(),
  distanceKm: z.number().finite().nonnegative().nullable().optional(),
});

const PatchSavedRouteBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  rideType: RideType.nullable().optional(),
  region: z.string().trim().max(120).nullable().optional(),
  isPublic: z.boolean().optional(),
});

const SAVED_ROUTES_PER_USER_LIMIT = 50;

/**
 * Replace the ordered (route_id, position, trail_id) rows for a route
 * in the normalized `route_trails` join table. Used by POST + PUT
 * /me/saved-routes so the join table stays the source of truth for
 * trail order while `saved_routes.trail_ids` is kept as a backwards-
 * compat mirror for a partial deploy. Failures are logged but
 * non-fatal — the mirror column means the read path still works even
 * if the join write fails.
 */
async function replaceRouteTrails(
  supa: ReturnType<typeof getSupabaseAdmin>,
  routeId: string,
  trailIds: string[],
  log: Request["log"],
): Promise<void> {
  try {
    const del = await supa
      .from("route_trails")
      .delete()
      .eq("route_id", routeId);
    if (del.error && !isMissingTableError(del.error)) {
      log.warn({ err: del.error }, "route_trails delete failed");
    }
    if (trailIds.length === 0) return;
    const rows = trailIds.map((trail_id, position) => ({
      route_id: routeId,
      position,
      trail_id,
    }));
    const ins = await supa.from("route_trails").insert(rows);
    if (ins.error && !isMissingTableError(ins.error)) {
      log.warn({ err: ins.error }, "route_trails insert failed");
    }
  } catch (err) {
    log.warn({ err }, "route_trails replace failed");
  }
}

/**
 * Load ordered trail ids for a set of route ids from the `route_trails`
 * join table. Returns a Map<routeId, trailId[]> with empty arrays for
 * routes that have no rows in the join table — callers fall back to
 * `saved_routes.trail_ids` for those (legacy rows written before
 * migration 0023). Sorting is done client-side because the supabase
 * client doesn't compose .in()+.order() ergonomically across rows.
 */
async function loadRouteTrailsMap(
  supa: ReturnType<typeof getSupabaseAdmin>,
  routeIds: string[],
  log: Request["log"],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (routeIds.length === 0) return out;
  try {
    const { data, error } = await supa
      .from("route_trails")
      .select("route_id, position, trail_id")
      .in("route_id", routeIds);
    if (error) {
      if (!isMissingTableError(error)) {
        log.warn({ err: error }, "route_trails load failed");
      }
      return out;
    }
    const grouped = new Map<
      string,
      Array<{ position: number; trail_id: string }>
    >();
    for (const r of (data ?? []) as Array<{
      route_id: string;
      position: number;
      trail_id: string;
    }>) {
      const arr = grouped.get(r.route_id) ?? [];
      arr.push({ position: r.position, trail_id: r.trail_id });
      grouped.set(r.route_id, arr);
    }
    for (const [routeId, rows] of grouped) {
      rows.sort((a, b) => a.position - b.position);
      out.set(
        routeId,
        rows.map((r) => r.trail_id),
      );
    }
  } catch (err) {
    log.warn({ err }, "route_trails load threw");
  }
  return out;
}

/**
 * Apply route_trails-derived ordered ids onto a SavedRouteRow before
 * it is shaped. Falls back to the row's `trail_ids` mirror when the
 * join table has no rows for this route (legacy data written before
 * migration 0023).
 */
function withNormalizedTrailIds(
  row: SavedRouteRow,
  byId: Map<string, string[]>,
): SavedRouteRow {
  const fromJoin = byId.get(row.id);
  if (fromJoin && fromJoin.length > 0) {
    return { ...row, trail_ids: fromJoin };
  }
  return row;
}

interface SavedRouteRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  ride_type: string | null;
  region: string | null;
  is_public: boolean | null;
  trail_ids: string[];
  waypoints: unknown;
  entry_order: unknown;
  distance_km: string | number | null;
  total_distance_km: string | number | null;
  likes_count: number | null;
  comments_count: number | null;
  created_at: string;
  updated_at?: string | null;
}

const SAVED_ROUTE_COLUMNS = [
  "id",
  "user_id",
  "name",
  "description",
  "ride_type",
  "region",
  "is_public",
  "trail_ids",
  "waypoints",
  "entry_order",
  "distance_km",
  "total_distance_km",
  "likes_count",
  "comments_count",
  "created_at",
  "updated_at",
].join(",");

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function regionFromTrails(
  trails: Array<Record<string, unknown>>,
): string | null {
  // Cheap denormalised "region": rounded centroid of the first trail's
  // bbox. Lets the Discover filter group routes by rough geography
  // without hitting a reverse-geocoder. Updated on every save so a
  // route stays attached to the right region after an edit.
  for (const t of trails) {
    const minLat = toNumber(t.bbox_min_lat);
    const maxLat = toNumber(t.bbox_max_lat);
    const minLng = toNumber(t.bbox_min_lng);
    const maxLng = toNumber(t.bbox_max_lng);
    if (
      minLat != null &&
      maxLat != null &&
      minLng != null &&
      maxLng != null
    ) {
      const lat = ((minLat + maxLat) / 2).toFixed(1);
      const lng = ((minLng + maxLng) / 2).toFixed(1);
      return `${lat},${lng}`;
    }
  }
  return null;
}

function shapeSavedRoute(
  row: SavedRouteRow,
  trailById: Map<string, Record<string, unknown>>,
  opts: {
    likedByMe?: boolean;
    hiddenTrailCount?: number;
    /**
     * Optional owner-display map keyed by user_id. When the caller
     * pre-hydrates this (e.g. the published-routes feed), the route
     * payload carries `ownerName` + `ownerAvatar` so Discover cards
     * and the route detail header can attribute the route without a
     * second round-trip.
     */
    ownerById?: Map<string, { name: string | null; avatar_url: string | null }>;
  } = {},
) {
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
  const total =
    toNumber(row.total_distance_km) ?? toNumber(row.distance_km);
  const hidden =
    opts.hiddenTrailCount ?? Math.max(0, trailIds.length - trails.length);
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description ?? null,
    rideType: row.ride_type ?? null,
    region: row.region ?? null,
    isPublic: row.is_public === true,
    trailIds,
    trails,
    waypoints,
    entryOrder,
    distanceKm: total,
    totalDistanceKm: total,
    likesCount: row.likes_count ?? 0,
    commentsCount: row.comments_count ?? 0,
    likedByMe: opts.likedByMe ?? false,
    hiddenTrailCount: hidden,
    ownerName: opts.ownerById?.get(row.user_id)?.name ?? null,
    ownerAvatar: opts.ownerById?.get(row.user_id)?.avatar_url ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

/**
 * Fetch display_name + avatar_url for a set of user ids and return a
 * lookup map. Empty input → empty map (no round-trip). Failures are
 * swallowed because owner attribution is decorative — the route list
 * still works without it.
 */
async function hydrateOwnerMap(
  supa: ReturnType<typeof getSupabaseAdmin>,
  userIds: Iterable<string>,
): Promise<Map<string, { name: string | null; avatar_url: string | null }>> {
  const ids = Array.from(new Set(userIds));
  const out = new Map<
    string,
    { name: string | null; avatar_url: string | null }
  >();
  if (ids.length === 0) return out;
  const { data } = await supa
    .from("users")
    .select("id, display_name, avatar_url")
    .in("id", ids);
  for (const u of (data ?? []) as Array<{
    id: string;
    display_name: string | null;
    avatar_url: string | null;
  }>) {
    out.set(u.id, { name: u.display_name, avatar_url: u.avatar_url });
  }
  return out;
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
      .select(SAVED_ROUTE_COLUMNS)
      .eq("user_id", auth.userId)
      .is("deleted_at", null)
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

    const rawRows = (data ?? []) as unknown as SavedRouteRow[];

    // Source of truth for trail order is the normalized `route_trails`
    // join table (migration 0023). The `saved_routes.trail_ids` jsonb
    // mirror is only used as a fallback for rows written before that
    // migration ran.
    const trailIdsByRoute = await loadRouteTrailsMap(
      supa,
      rawRows.map((r) => r.id),
      req.log,
    );
    const rows = rawRows.map((r) => withNormalizedTrailIds(r, trailIdsByRoute));

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

    // Pull liked-by-me set in one shot so My Routes can surface the
    // heart state on routes the rider has published and re-liked.
    let likedSet = new Set<string>();
    if (rows.length > 0) {
      const { data: likeRows } = await supa
        .from("route_likes")
        .select("route_id")
        .eq("user_id", auth.userId)
        .in(
          "route_id",
          rows.map((r) => r.id),
        );
      for (const r of (likeRows ?? []) as Array<{ route_id: string }>) {
        likedSet.add(r.route_id);
      }
    }

    const routes = rows.map((row) =>
      shapeSavedRoute(row, trailById, { likedByMe: likedSet.has(row.id) }),
    );

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
  if (parsed.data.isPublic === true && !parsed.data.rideType) {
    res.status(400).json({ error: "Pick a ride type before publishing" });
    return;
  }

  // De-dupe trailIds & waypoints; filter dangling entry_order refs.
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

    const { count, error: countErr } = await supa
      .from("saved_routes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", auth.userId)
      .is("deleted_at", null);
    if (countErr && !isMissingTableError(countErr)) {
      req.log.warn({ err: countErr }, "saved-routes count failed");
    }
    if ((count ?? 0) >= SAVED_ROUTES_PER_USER_LIMIT) {
      res.status(409).json({
        error: `You've reached the limit of ${SAVED_ROUTES_PER_USER_LIMIT} saved routes. Delete one to save a new one.`,
      });
      return;
    }

    let region: string | null = parsed.data.region ?? null;
    if (region == null && trailIds.length > 0) {
      const { data: bboxRows } = await supa
        .from("trails")
        .select("id, bbox_min_lat, bbox_max_lat, bbox_min_lng, bbox_max_lng")
        .in("id", trailIds);
      const byId = new Map<string, Record<string, unknown>>();
      for (const row of (bboxRows ?? []) as Array<Record<string, unknown>>) {
        if (typeof row.id === "string") byId.set(row.id, row);
      }
      const ordered = trailIds
        .map((id) => byId.get(id))
        .filter((x): x is Record<string, unknown> => Boolean(x));
      region = regionFromTrails(ordered);
    }

    const now = new Date().toISOString();
    const insertRow: Record<string, unknown> = {
      user_id: auth.userId,
      name: parsed.data.name.trim(),
      description: parsed.data.description?.trim() || null,
      ride_type: parsed.data.rideType ?? null,
      region,
      is_public: parsed.data.isPublic === true,
      trail_ids: trailIds,
      waypoints,
      entry_order: entryOrder,
      distance_km: parsed.data.distanceKm ?? null,
      total_distance_km: parsed.data.distanceKm ?? null,
      created_at: now,
      updated_at: now,
    };

    let { data, error } = await supa
      .from("saved_routes")
      .insert(insertRow)
      .select(SAVED_ROUTE_COLUMNS)
      .single();

    if (error?.code === "23503") {
      const { error: userErr } = await supa
        .from("users")
        .upsert({ id: auth.userId, updated_at: now }, { onConflict: "id" });
      if (!userErr) {
        const retry = await supa
          .from("saved_routes")
          .insert(insertRow)
          .select(SAVED_ROUTE_COLUMNS)
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

    const insertedRow = data as unknown as SavedRouteRow;
    await replaceRouteTrails(supa, insertedRow.id, trailIds, req.log);

    const route = shapeSavedRoute(insertedRow, new Map(), {
      likedByMe: false,
      hiddenTrailCount: 0,
    });
    res.json({
      id: route.id,
      name: route.name,
      createdAt: route.createdAt,
      route,
    });
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
  if (parsed.data.isPublic === true && !parsed.data.rideType) {
    res.status(400).json({ error: "Pick a ride type before publishing" });
    return;
  }

  // De-dupe trailIds & waypoints; filter dangling entry_order refs.
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

    let region: string | null = parsed.data.region ?? null;
    if (region == null && trailIds.length > 0) {
      const { data: bboxRows } = await supa
        .from("trails")
        .select("id, bbox_min_lat, bbox_max_lat, bbox_min_lng, bbox_max_lng")
        .in("id", trailIds);
      const byId = new Map<string, Record<string, unknown>>();
      for (const row of (bboxRows ?? []) as Array<Record<string, unknown>>) {
        if (typeof row.id === "string") byId.set(row.id, row);
      }
      const ordered = trailIds
        .map((tid) => byId.get(tid))
        .filter((x): x is Record<string, unknown> => Boolean(x));
      region = regionFromTrails(ordered);
    }

    const updateRow: Record<string, unknown> = {
      name: parsed.data.name.trim(),
      trail_ids: trailIds,
      waypoints,
      entry_order: entryOrder,
      distance_km: parsed.data.distanceKm ?? null,
      total_distance_km: parsed.data.distanceKm ?? null,
      region,
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.description !== undefined) {
      updateRow.description = parsed.data.description?.trim() || null;
    }
    if (parsed.data.rideType !== undefined) {
      updateRow.ride_type = parsed.data.rideType ?? null;
    }
    if (parsed.data.isPublic !== undefined) {
      updateRow.is_public = parsed.data.isPublic === true;
    }

    const { data, error } = await supa
      .from("saved_routes")
      .update(updateRow)
      .eq("id", id)
      .eq("user_id", auth.userId)
      .is("deleted_at", null)
      .select(SAVED_ROUTE_COLUMNS)
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

    await replaceRouteTrails(supa, id, trailIds, req.log);

    const route = shapeSavedRoute(
      data as unknown as SavedRouteRow,
      new Map(),
      { likedByMe: false, hiddenTrailCount: 0 },
    );
    res.json({
      id: route.id,
      name: route.name,
      createdAt: route.createdAt,
      route,
    });
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

    if (parsed.data.isPublic === true) {
      const { data: existing } = await supa
        .from("saved_routes")
        .select("trail_ids, ride_type")
        .eq("id", id)
        .eq("user_id", auth.userId)
        .is("deleted_at", null)
        .maybeSingle();
      const ex = existing as
        | { trail_ids: unknown; ride_type: string | null }
        | null;
      const trailCount = Array.isArray(ex?.trail_ids)
        ? ex!.trail_ids.length
        : 0;
      if (trailCount === 0) {
        res
          .status(400)
          .json({ error: "Cannot publish a route with no trails" });
        return;
      }
      const nextRideType =
        parsed.data.rideType !== undefined
          ? parsed.data.rideType
          : (ex?.ride_type ?? null);
      if (!nextRideType) {
        res
          .status(400)
          .json({ error: "Pick a ride type before publishing" });
        return;
      }
    }

    const updateRow: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.name !== undefined) {
      updateRow.name = parsed.data.name.trim();
    }
    if (parsed.data.description !== undefined) {
      updateRow.description = parsed.data.description?.trim() || null;
    }
    if (parsed.data.rideType !== undefined) {
      updateRow.ride_type = parsed.data.rideType ?? null;
    }
    if (parsed.data.region !== undefined) {
      updateRow.region = parsed.data.region ?? null;
    }
    if (parsed.data.isPublic !== undefined) {
      updateRow.is_public = parsed.data.isPublic === true;
    }

    const { data, error } = await supa
      .from("saved_routes")
      .update(updateRow)
      .eq("id", id)
      .eq("user_id", auth.userId)
      .is("deleted_at", null)
      .select(SAVED_ROUTE_COLUMNS)
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
      req.log.error({ err: error }, "saved-routes patch failed");
      res.status(500).json({ error: "Failed to update route" });
      return;
    }

    const route = shapeSavedRoute(
      data as unknown as SavedRouteRow,
      new Map(),
      { likedByMe: false, hiddenTrailCount: 0 },
    );
    res.json({ id: route.id, name: route.name, route });
  } catch (err) {
    req.log.error({ err }, "saved-routes PATCH failed");
    res.status(500).json({ error: "Failed to update route" });
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
    // Soft-delete: keep the row so likes/comments survive a misclick
    // and can be restored. The list/detail queries filter on
    // deleted_at IS NULL so the row disappears from the UI immediately.
    const { error } = await supa
      .from("saved_routes")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", auth.userId)
      .is("deleted_at", null);

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

// Published routes — Discover feed, likes, threaded comments.

async function hydrateVisibleTrailMap(
  supa: ReturnType<typeof getSupabaseAdmin>,
  trailIds: Set<string>,
  viewerUserId: string | null,
  log: Request["log"],
): Promise<Map<string, Record<string, unknown>>> {
  const trailById = new Map<string, Record<string, unknown>>();
  if (trailIds.size === 0) return trailById;
  const { data: trailRows, error: trailErr } = await supa
    .from("trails")
    .select(PLANNER_TRAIL_COLUMNS)
    .in("id", Array.from(trailIds))
    .is("deleted_at", null);
  if (trailErr) {
    log.warn({ err: trailErr }, "published-routes trail hydrate failed");
    return trailById;
  }
  const fetched = (trailRows as unknown as Array<Record<string, unknown>>) ?? [];
  const visibleIds = new Set<string>();
  const needsGroupCheck: string[] = [];
  for (const row of fetched) {
    const id = typeof row.id === "string" ? row.id : null;
    if (!id) continue;
    if (
      row.is_public === true ||
      (viewerUserId != null && row.owner_user_id === viewerUserId)
    ) {
      visibleIds.add(id);
    } else {
      needsGroupCheck.push(id);
    }
  }
  if (needsGroupCheck.length > 0 && viewerUserId != null) {
    const { data: memberships } = await supa
      .from("group_members")
      .select("group_id")
      .eq("user_id", viewerUserId);
    const groupIds = ((memberships ?? []) as Array<{ group_id: string }>).map(
      (m) => m.group_id,
    );
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
  return trailById;
}

const PUBLISHED_LIST_LIMIT = 50;

router.get("/routes", async (req: Request, res: Response) => {
  // Sign-in is optional — anonymous riders see public routes too.
  // The viewer's user id only matters for likedByMe + visibility of
  // private trails inside a public route.
  const auth = getAuth(req);
  const viewerUserId = auth.userId ?? null;

  const sortRaw =
    typeof req.query.sort === "string" ? req.query.sort : "recent";
  const sort: "recent" | "likes" =
    sortRaw === "likes" ? "likes" : "recent";
  const rideType =
    typeof req.query.rideType === "string" && req.query.rideType.length > 0
      ? req.query.rideType
      : null;
  const region =
    typeof req.query.region === "string" && req.query.region.length > 0
      ? req.query.region
      : null;
  const q =
    typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
  const limit = Math.min(
    PUBLISHED_LIST_LIMIT,
    Math.max(
      1,
      Number.isFinite(Number(req.query.limit))
        ? Number(req.query.limit)
        : PUBLISHED_LIST_LIMIT,
    ),
  );

  try {
    const supa = getSupabaseAdmin();
    let query = supa
      .from("saved_routes")
      .select(SAVED_ROUTE_COLUMNS)
      .eq("is_public", true)
      .is("deleted_at", null)
      .limit(limit);
    if (rideType) query = query.eq("ride_type", rideType);
    if (region) query = query.eq("region", region);
    if (q) query = query.ilike("name", `%${q}%`);
    if (sort === "likes") {
      query = query
        .order("likes_count", { ascending: false })
        .order("created_at", { ascending: false });
    } else {
      query = query.order("created_at", { ascending: false });
    }

    const { data, error } = await query;
    if (error) {
      if (isMissingTableError(error)) {
        res.json({ routes: [] });
        return;
      }
      req.log.error({ err: error }, "published-routes GET failed");
      res.status(500).json({ error: "Failed to fetch routes" });
      return;
    }

    const rawRows = (data ?? []) as unknown as SavedRouteRow[];
    // Normalize trail order from the `route_trails` join table — same
    // policy as the My Routes list above so private + public reads
    // stay consistent.
    const trailIdsByRoute = await loadRouteTrailsMap(
      supa,
      rawRows.map((r) => r.id),
      req.log,
    );
    const rows = rawRows.map((r) => withNormalizedTrailIds(r, trailIdsByRoute));

    const allTrailIds = new Set<string>();
    for (const row of rows) {
      const ids = Array.isArray(row.trail_ids) ? row.trail_ids : [];
      for (const id of ids) {
        if (typeof id === "string") allTrailIds.add(id);
      }
    }
    const trailById = await hydrateVisibleTrailMap(
      supa,
      allTrailIds,
      viewerUserId,
      req.log,
    );

    let likedSet = new Set<string>();
    if (viewerUserId && rows.length > 0) {
      const { data: likeRows } = await supa
        .from("route_likes")
        .select("route_id")
        .eq("user_id", viewerUserId)
        .in(
          "route_id",
          rows.map((r) => r.id),
        );
      for (const r of (likeRows ?? []) as Array<{ route_id: string }>) {
        likedSet.add(r.route_id);
      }
    }

    const ownerById = await hydrateOwnerMap(
      supa,
      rows.map((r) => r.user_id),
    );
    const routes = rows.map((row) =>
      shapeSavedRoute(row, trailById, {
        likedByMe: likedSet.has(row.id),
        ownerById,
      }),
    );
    res.json({ routes });
  } catch (err) {
    req.log.error({ err }, "published-routes GET failed");
    res.status(500).json({ error: "Failed to fetch routes" });
  }
});

router.get("/routes/:id", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const viewerUserId = auth.userId ?? null;
  const id = req.params.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 100) {
    res.status(400).json({ error: "Invalid route id" });
    return;
  }
  try {
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("saved_routes")
      .select(SAVED_ROUTE_COLUMNS)
      .eq("id", id)
      .is("deleted_at", null)
      .single();
    if (error || !data) {
      if (error && isMissingTableError(error)) {
        res.status(404).json({ error: "Route not found" });
        return;
      }
      res.status(404).json({ error: "Route not found" });
      return;
    }
    const rawRow = data as unknown as SavedRouteRow;
    if (!rawRow.is_public && rawRow.user_id !== viewerUserId) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    // Normalize trail order off the `route_trails` join table (with
    // jsonb mirror as fallback). Doing this BEFORE the visibility-
    // filtered hydrate keeps ordering authoritative even if the
    // mirror column is stale.
    const trailIdsByRoute = await loadRouteTrailsMap(
      supa,
      [rawRow.id],
      req.log,
    );
    const row = withNormalizedTrailIds(rawRow, trailIdsByRoute);

    const trailIds = Array.isArray(row.trail_ids)
      ? row.trail_ids.filter((x): x is string => typeof x === "string")
      : [];
    const trailById = await hydrateVisibleTrailMap(
      supa,
      new Set(trailIds),
      viewerUserId,
      req.log,
    );

    let likedByMe = false;
    if (viewerUserId) {
      const { data: likeRow } = await supa
        .from("route_likes")
        .select("route_id")
        .eq("route_id", id)
        .eq("user_id", viewerUserId)
        .maybeSingle();
      likedByMe = likeRow != null;
    }

    const ownerById = await hydrateOwnerMap(supa, [row.user_id]);
    const route = shapeSavedRoute(row, trailById, { likedByMe, ownerById });
    res.json({ route });
  } catch (err) {
    req.log.error({ err }, "published-routes detail failed");
    res.status(500).json({ error: "Failed to fetch route" });
  }
});

async function ensureRouteVisible(
  supa: ReturnType<typeof getSupabaseAdmin>,
  routeId: string,
  viewerUserId: string,
): Promise<{ ok: true; row: SavedRouteRow } | { ok: false; status: number }> {
  const { data, error } = await supa
    .from("saved_routes")
    .select("id, user_id, is_public, deleted_at")
    .eq("id", routeId)
    .maybeSingle();
  if (error || !data) return { ok: false, status: 404 };
  const row = data as unknown as SavedRouteRow & { deleted_at: string | null };
  if (row.deleted_at != null) return { ok: false, status: 404 };
  if (!row.is_public && row.user_id !== viewerUserId) {
    return { ok: false, status: 404 };
  }
  return { ok: true, row };
}

router.post("/routes/:id/like", async (req: Request, res: Response) => {
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
    const v = await ensureRouteVisible(supa, id, auth.userId);
    if (!v.ok) {
      res.status(v.status).json({ error: "Route not found" });
      return;
    }
    const { error } = await supa
      .from("route_likes")
      .upsert(
        { route_id: id, user_id: auth.userId },
        { onConflict: "route_id,user_id" },
      );
    if (error) {
      req.log.error({ err: error }, "route like failed");
      res.status(500).json({ error: "Failed to like" });
      return;
    }
    const { data: countRow } = await supa
      .from("saved_routes")
      .select("likes_count")
      .eq("id", id)
      .maybeSingle();
    res.json({
      liked: true,
      likesCount:
        (countRow as { likes_count: number } | null)?.likes_count ?? 0,
    });
  } catch (err) {
    req.log.error({ err }, "route like failed");
    res.status(500).json({ error: "Failed to like" });
  }
});

router.delete("/routes/:id/like", async (req: Request, res: Response) => {
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
    const v = await ensureRouteVisible(supa, id, auth.userId);
    if (!v.ok) {
      res.status(v.status).json({ error: "Route not found" });
      return;
    }
    const { error } = await supa
      .from("route_likes")
      .delete()
      .eq("route_id", id)
      .eq("user_id", auth.userId);
    if (error) {
      req.log.error({ err: error }, "route unlike failed");
      res.status(500).json({ error: "Failed to unlike" });
      return;
    }
    const { data: countRow } = await supa
      .from("saved_routes")
      .select("likes_count")
      .eq("id", id)
      .maybeSingle();
    res.json({
      liked: false,
      likesCount:
        (countRow as { likes_count: number } | null)?.likes_count ?? 0,
    });
  } catch (err) {
    req.log.error({ err }, "route unlike failed");
    res.status(500).json({ error: "Failed to unlike" });
  }
});

interface RouteCommentRow {
  id: string;
  route_id: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  hidden_at: string | null;
  hidden_reason: string | null;
  created_at: string;
}

const PostCommentBody = z.object({
  body: z.string().trim().min(1).max(2000),
  parentId: z.string().min(1).max(100).nullable().optional(),
});

router.get("/routes/:id/comments", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const viewerUserId = auth.userId ?? null;
  const id = req.params.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 100) {
    res.status(400).json({ error: "Invalid route id" });
    return;
  }
  try {
    const supa = getSupabaseAdmin();
    // Verify the rider can see the route at all before exposing
    // comments. We accept anonymous viewers for public routes.
    const { data: routeRow } = await supa
      .from("saved_routes")
      .select("id, user_id, is_public, deleted_at")
      .eq("id", id)
      .maybeSingle();
    if (!routeRow) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    const r = routeRow as { user_id: string; is_public: boolean; deleted_at: string | null };
    if (r.deleted_at != null || (!r.is_public && r.user_id !== viewerUserId)) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    const { data, error } = await supa
      .from("route_comments")
      .select(
        "id, route_id, user_id, parent_id, body, hidden_at, hidden_reason, created_at",
      )
      .eq("route_id", id)
      .is("hidden_at", null)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) {
      if (isMissingTableError(error)) {
        res.json({ comments: [] });
        return;
      }
      req.log.error({ err: error }, "route comments GET failed");
      res.status(500).json({ error: "Failed to load comments" });
      return;
    }
    const rows = (data ?? []) as RouteCommentRow[];

    // Attach a display name + avatar from the users table so the
    // comment list doesn't render "userid_2abc...". One round-trip,
    // hand-joined client-side.
    let userById = new Map<string, { name: string | null; avatar_url: string | null }>();
    if (rows.length > 0) {
      const ids = Array.from(new Set(rows.map((r) => r.user_id)));
      const { data: users } = await supa
        .from("users")
        .select("id, display_name, avatar_url")
        .in("id", ids);
      for (const u of (users ?? []) as Array<{
        id: string;
        display_name: string | null;
        avatar_url: string | null;
      }>) {
        userById.set(u.id, {
          name: u.display_name,
          avatar_url: u.avatar_url,
        });
      }
    }

    const comments = rows.map((row) => ({
      id: row.id,
      routeId: row.route_id,
      userId: row.user_id,
      parentId: row.parent_id,
      body: row.body,
      createdAt: row.created_at,
      authorName: userById.get(row.user_id)?.name ?? null,
      authorAvatar: userById.get(row.user_id)?.avatar_url ?? null,
      mine: viewerUserId != null && row.user_id === viewerUserId,
    }));
    res.json({ comments });
  } catch (err) {
    req.log.error({ err }, "route comments GET failed");
    res.status(500).json({ error: "Failed to load comments" });
  }
});

router.post("/routes/:id/comments", async (req: Request, res: Response) => {
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
  const parsed = PostCommentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid comment payload" });
    return;
  }
  try {
    const supa = getSupabaseAdmin();
    const v = await ensureRouteVisible(supa, id, auth.userId);
    if (!v.ok) {
      res.status(v.status).json({ error: "Route not found" });
      return;
    }
    const parentId = parsed.data.parentId ?? null;
    if (parentId) {
      const { data: parentRow } = await supa
        .from("route_comments")
        .select("id, route_id, hidden_at")
        .eq("id", parentId)
        .maybeSingle();
      const pr = parentRow as { route_id: string; hidden_at: string | null } | null;
      if (!pr || pr.route_id !== id || pr.hidden_at != null) {
        res.status(400).json({ error: "Parent comment not found on this route" });
        return;
      }
    }
    const now = new Date().toISOString();
    const insertRow = {
      route_id: id,
      user_id: auth.userId,
      parent_id: parentId,
      body: parsed.data.body.trim(),
      created_at: now,
    };
    let { data, error } = await supa
      .from("route_comments")
      .insert(insertRow)
      .select(
        "id, route_id, user_id, parent_id, body, hidden_at, hidden_reason, created_at",
      )
      .single();
    if (error?.code === "23503") {
      const { error: userErr } = await supa
        .from("users")
        .upsert({ id: auth.userId, updated_at: now }, { onConflict: "id" });
      if (!userErr) {
        const retry = await supa
          .from("route_comments")
          .insert(insertRow)
          .select(
            "id, route_id, user_id, parent_id, body, hidden_at, hidden_reason, created_at",
          )
          .single();
        data = retry.data;
        error = retry.error;
      }
    }
    if (error || !data) {
      req.log.error({ err: error }, "route comment insert failed");
      res.status(500).json({ error: "Failed to post comment" });
      return;
    }
    const row = data as RouteCommentRow;
    res.json({
      comment: {
        id: row.id,
        routeId: row.route_id,
        userId: row.user_id,
        parentId: row.parent_id,
        body: row.body,
        createdAt: row.created_at,
        mine: true,
      },
    });
  } catch (err) {
    req.log.error({ err }, "route comment insert failed");
    res.status(500).json({ error: "Failed to post comment" });
  }
});

router.patch(
  "/routes/:id/comments/:commentId",
  async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { id, commentId } = req.params as Record<string, string>;
    const parsed = z
      .object({ body: z.string().trim().min(1).max(2000) })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid comment payload" });
      return;
    }
    try {
      const supa = getSupabaseAdmin();
      const { data, error } = await supa
        .from("route_comments")
        .update({ body: parsed.data.body.trim() })
        .eq("id", commentId)
        .eq("route_id", id)
        .eq("user_id", auth.userId)
        .is("hidden_at", null)
        .select(
          "id, route_id, user_id, parent_id, body, hidden_at, hidden_reason, created_at",
        )
        .single();
      if (error || !data) {
        res.status(404).json({ error: "Comment not found" });
        return;
      }
      const row = data as RouteCommentRow;
      res.json({
        comment: {
          id: row.id,
          routeId: row.route_id,
          userId: row.user_id,
          parentId: row.parent_id,
          body: row.body,
          createdAt: row.created_at,
          mine: true,
        },
      });
    } catch (err) {
      req.log.error({ err }, "route comment patch failed");
      res.status(500).json({ error: "Failed to update comment" });
    }
  },
);

router.delete(
  "/routes/:id/comments/:commentId",
  async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { id, commentId } = req.params as Record<string, string>;
    try {
      const supa = getSupabaseAdmin();
      const { data: commentRow } = await supa
        .from("route_comments")
        .select("user_id, hidden_at")
        .eq("id", commentId)
        .eq("route_id", id)
        .maybeSingle();
      const row = commentRow as
        | { user_id: string; hidden_at: string | null }
        | null;
      if (!row || row.hidden_at != null) {
        res.status(404).json({ error: "Comment not found" });
        return;
      }
      const isAuthor = row.user_id === auth.userId;
      let isModerator = false;
      if (!isAuthor) {
        const { data: viewer } = await supa
          .from("users")
          .select("is_moderator")
          .eq("id", auth.userId)
          .maybeSingle();
        isModerator = !!(viewer as { is_moderator?: boolean } | null)
          ?.is_moderator;
      }
      if (!isAuthor && !isModerator) {
        res
          .status(403)
          .json({ error: "Only the author or a moderator can hide this comment" });
        return;
      }
      const hidePayload = {
        hidden_at: new Date().toISOString(),
        hidden_reason: isAuthor ? "deleted_by_author" : "hidden_by_moderator",
      };
      const { error } = await supa
        .from("route_comments")
        .update(hidePayload)
        .eq("id", commentId)
        .eq("route_id", id)
        .is("hidden_at", null);
      if (error) {
        req.log.error({ err: error }, "route comment delete failed");
        res.status(500).json({ error: "Failed to delete comment" });
        return;
      }
      await supa
        .from("route_comments")
        .update(hidePayload)
        .eq("route_id", id)
        .eq("parent_id", commentId)
        .is("hidden_at", null);
      res.json({ deleted: true, byModerator: !isAuthor });
    } catch (err) {
      req.log.error({ err }, "route comment delete failed");
      res.status(500).json({ error: "Failed to delete comment" });
    }
  },
);

export default router;
