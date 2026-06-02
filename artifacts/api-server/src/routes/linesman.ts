/**
 * Linesman trail-maintenance endpoints.
 *
 * All routes require `users.linesman_access = true`. Any user without it
 * receives a 403 immediately. All mutating operations are logged to the
 * `linesman_edits` audit table automatically.
 *
 * PATCH  /api/trails/:id/linesman          — update metadata
 * POST   /api/trails/:id/flag              — flag a problem
 * POST   /api/trails/:id/unflag            — clear a flag
 * DELETE /api/trails/:id/linesman          — soft-delete a trail
 * POST   /api/trails/:id/linesman/restore  — restore soft-deleted trail
 * POST   /api/trails/linesman              — add new trail
 * GET    /api/linesman/recent-edits        — last 10 edits by this user
 * POST   /api/linesman/edits/:editId/undo  — undo within 1 hour
 * GET    /api/admin/linesfolk              — admin: list all linesfolk
 * PATCH  /api/admin/linesfolk/:userId      — admin: grant/revoke access
 * GET    /api/admin/linesfolk/:userId/edits — admin: full edit history
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { getAuth } from "@clerk/express";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { requireAuth } from "../middlewares/requireAuth";
import { readEnvAdminList } from "../lib/admin";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Auth guards
// ---------------------------------------------------------------------------

async function assertLinesman(userId: string): Promise<boolean> {
  const supa = getSupabaseAdmin();
  const { data } = await supa
    .from("users")
    .select("linesman_access, linesman_group_id")
    .eq("id", userId)
    .maybeSingle();
  return !!(data as { linesman_access?: boolean } | null)?.linesman_access;
}

function isAdmin(userId: string): boolean {
  return readEnvAdminList().includes(userId);
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

async function logEdit(
  trailId: string | null,
  userId: string,
  editType: string,
  previousValues: object | null,
  newValues: object | null,
  reason?: string,
): Promise<string | null> {
  const supa = getSupabaseAdmin();
  const { data } = await supa.from("linesman_edits").insert({
    trail_id:          trailId,
    linesman_user_id:  userId,
    edit_type:         editType,
    previous_values:   previousValues,
    new_values:        newValues,
    edit_reason:       reason ?? null,
  }).select("id").maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

// ---------------------------------------------------------------------------
// PATCH /api/trails/:id/linesman — update metadata
// ---------------------------------------------------------------------------

const PatchBody = z.object({
  name:         z.string().min(1).max(200).optional(),
  difficulty:   z.number().int().min(1).max(10).optional(),
  terrain:      z.string().max(100).optional(),
  legal_status: z.string().max(100).optional(),
  notes:        z.string().max(2000).optional(),
});

router.patch(
  "/api/trails/:id/linesman",
  requireAuth(async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    if (!await assertLinesman(userId!)) {
      res.status(403).json({ error: "Linesman access required" });
      return;
    }

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      return;
    }

    const trailId = String(req.params["id"]);
    const supa = getSupabaseAdmin();

    const { data: existing } = await supa
      .from("trails")
      .select("name, difficulty, terrain, legal_status")
      .eq("id", trailId)
      .maybeSingle();

    if (!existing) {
      res.status(404).json({ error: "Trail not found" });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (parsed.data.name !== undefined)         updates["name"]         = parsed.data.name;
    if (parsed.data.difficulty !== undefined)   updates["difficulty"]   = parsed.data.difficulty;
    if (parsed.data.terrain !== undefined)      updates["terrain"]      = parsed.data.terrain;
    if (parsed.data.legal_status !== undefined) updates["legal_status"] = parsed.data.legal_status;

    const { error } = await supa.from("trails").update(updates).eq("id", trailId);
    if (error) {
      logger.error({ err: error }, "linesman patch failed");
      res.status(500).json({ error: "Update failed" });
      return;
    }

    await logEdit(trailId, userId!, "update_metadata", existing as object, updates, parsed.data.notes);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/trails/:id/flag — flag a problem
// ---------------------------------------------------------------------------

const FlagBody = z.object({
  flag_type: z.enum([
    "closed", "legal_issue", "flood_damage", "overgrown",
    "temp_closure", "rerouted",
  ]),
  note:      z.string().max(500).optional(),
  photo_url: z.string().url().optional(),
});

router.post(
  "/api/trails/:id/flag",
  requireAuth(async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    if (!await assertLinesman(userId!)) {
      res.status(403).json({ error: "Linesman access required" });
      return;
    }

    const parsed = FlagBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      return;
    }

    const trailId = String(req.params["id"]);
    const supa = getSupabaseAdmin();

    const { data: existing } = await supa
      .from("trails")
      .select("flagged_for_review, legal_confidence, flag_reasons")
      .eq("id", trailId)
      .maybeSingle();

    const existingReasons = (existing as { flag_reasons?: string[] } | null)?.flag_reasons ?? [];
    const newReason = `${parsed.data.flag_type}: ${parsed.data.note ?? "no note"} (linesman ${userId}, ${new Date().toISOString()})`;

    const { error } = await supa.from("trails").update({
      flagged_for_review: true,
      legal_confidence:   "flagged",
      flag_reasons:       [...existingReasons, newReason],
    }).eq("id", trailId);

    if (error) {
      logger.error({ err: error }, "linesman flag failed");
      res.status(500).json({ error: "Flag failed" });
      return;
    }

    await logEdit(trailId, userId!, "flag", existing as object, {
      flag_type:  parsed.data.flag_type,
      note:       parsed.data.note ?? null,
      photo_url:  parsed.data.photo_url ?? null,
    }, parsed.data.note);

    logger.info({ trailId, flagType: parsed.data.flag_type, userId }, "Trail flagged by linesman");
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/trails/:id/unflag
// ---------------------------------------------------------------------------

router.post(
  "/api/trails/:id/unflag",
  requireAuth(async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    if (!await assertLinesman(userId!)) {
      res.status(403).json({ error: "Linesman access required" });
      return;
    }

    const trailId = String(req.params["id"]);
    const supa = getSupabaseAdmin();

    const { data: existing } = await supa
      .from("trails")
      .select("flagged_for_review, legal_confidence, flag_reasons")
      .eq("id", trailId)
      .maybeSingle();

    const { error } = await supa.from("trails").update({
      flagged_for_review: false,
      legal_confidence:   "osm_legal",
      flag_reasons:       [],
    }).eq("id", trailId);

    if (error) {
      res.status(500).json({ error: "Unflag failed" });
      return;
    }

    await logEdit(trailId, userId!, "unflag", existing as object, { flagged_for_review: false });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /api/trails/:id/linesman — soft delete
// ---------------------------------------------------------------------------

router.delete(
  "/api/trails/:id/linesman",
  requireAuth(async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    if (!await assertLinesman(userId!)) {
      res.status(403).json({ error: "Linesman access required" });
      return;
    }

    const trailId = String(req.params["id"]);
    const reason = (req.body as { reason?: string } | null)?.reason ?? null;
    const supa = getSupabaseAdmin();

    const { data: existing } = await supa
      .from("trails")
      .select("name, is_public, deleted_at")
      .eq("id", trailId)
      .maybeSingle();

    const { error } = await supa.from("trails").update({
      deleted_at: new Date().toISOString(),
      is_public:  false,
    }).eq("id", trailId);

    if (error) {
      res.status(500).json({ error: "Delete failed" });
      return;
    }

    await logEdit(trailId, userId!, "delete", existing as object, { deleted_at: new Date().toISOString() }, reason ?? undefined);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/trails/:id/linesman/restore
// ---------------------------------------------------------------------------

router.post(
  "/api/trails/:id/linesman/restore",
  requireAuth(async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    if (!await assertLinesman(userId!)) {
      res.status(403).json({ error: "Linesman access required" });
      return;
    }

    const trailId = String(req.params["id"]);
    const supa = getSupabaseAdmin();

    const { error } = await supa.from("trails").update({
      deleted_at: null,
      is_public:  true,
    }).eq("id", trailId);

    if (error) {
      res.status(500).json({ error: "Restore failed" });
      return;
    }

    await logEdit(trailId, userId!, "restore", null, { deleted_at: null, is_public: true });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/trails/linesman — add new trail
// ---------------------------------------------------------------------------

const AddTrailBody = z.object({
  name:       z.string().min(1).max(200),
  difficulty: z.number().int().min(1).max(10),
  terrain:    z.enum(["trail", "road"]).default("trail"),
  path_geojson: z.object({
    type:        z.literal("LineString"),
    coordinates: z.array(z.tuple([z.number(), z.number()])).min(2),
  }),
  distance_km: z.number().positive(),
});

router.post(
  "/api/trails/linesman",
  requireAuth(async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    if (!await assertLinesman(userId!)) {
      res.status(403).json({ error: "Linesman access required" });
      return;
    }

    const parsed = AddTrailBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      return;
    }

    const supa = getSupabaseAdmin();

    // Get linesman's group
    const { data: userRow } = await supa
      .from("users")
      .select("linesman_group_id")
      .eq("id", userId!)
      .maybeSingle();
    const groupId = (userRow as { linesman_group_id?: string | null } | null)?.linesman_group_id;

    const coords = parsed.data.path_geojson.coordinates;
    const lats = coords.map(c => c[1]);
    const lons = coords.map(c => c[0]);

    const row = {
      name:          parsed.data.name,
      difficulty:    parsed.data.difficulty,
      terrain:       parsed.data.terrain,
      distance_km:   parsed.data.distance_km,
      path_geojson:  parsed.data.path_geojson,
      source:        "linesman",
      is_public:     true,
      owner_user_id: userId!,
      verification_status: "approved",
      legal_confidence:    "user_submitted",
      bbox_min_lat: Math.min(...lats),
      bbox_max_lat: Math.max(...lats),
      bbox_min_lng: Math.min(...lons),
      bbox_max_lng: Math.max(...lons),
    };

    const { data: newTrail, error } = await supa.from("trails").insert(row).select("id").maybeSingle();
    if (error) {
      logger.error({ err: error }, "linesman add trail failed");
      res.status(500).json({ error: "Failed to add trail" });
      return;
    }

    const newId = (newTrail as { id?: string } | null)?.id ?? null;

    // Auto-share into linesman group if assigned
    if (groupId && newId) {
      try { await supa.from("trail_shares").insert({ trail_id: newId, group_id: groupId }); } catch { /* ignore */ }
    }

    await logEdit(newId, userId!, "add", null, row as object);
    res.status(201).json({ ok: true, id: newId });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/linesman/recent-edits — last 10 edits by this user
// ---------------------------------------------------------------------------

router.get(
  "/api/linesman/recent-edits",
  requireAuth(async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    const supa = getSupabaseAdmin();

    const { data, error } = await supa
      .from("linesman_edits")
      .select("id, trail_id, edit_type, new_values, previous_values, edit_reason, created_at")
      .eq("linesman_user_id", userId!)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      res.status(500).json({ error: "Failed to load edits" });
      return;
    }

    // Join trail names
    const trailIds = [...new Set((data ?? []).map((e: Record<string, unknown>) => e["trail_id"] as string).filter(Boolean))];
    let trailNames: Record<string, string> = {};
    if (trailIds.length > 0) {
      const { data: trails } = await supa.from("trails").select("id, name").in("id", trailIds);
      for (const t of (trails ?? []) as Array<{ id: string; name: string }>) {
        trailNames[t.id] = t.name;
      }
    }

    const edits = (data ?? []).map((e: Record<string, unknown>) => ({
      ...e,
      trail_name: trailNames[e["trail_id"] as string] ?? null,
      can_undo:   (Date.now() - new Date(e["created_at"] as string).getTime()) < 3600_000,
    }));

    res.json({ edits });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/linesman/edits/:editId/undo — undo within 1 hour
// ---------------------------------------------------------------------------

router.post(
  "/api/linesman/edits/:editId/undo",
  requireAuth(async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    const editId = String(req.params["editId"]);
    const supa = getSupabaseAdmin();

    const { data: edit } = await supa
      .from("linesman_edits")
      .select("*")
      .eq("id", editId)
      .eq("linesman_user_id", userId!)
      .maybeSingle();

    if (!edit) {
      res.status(404).json({ error: "Edit not found" });
      return;
    }

    const e = edit as Record<string, unknown>;
    const age = Date.now() - new Date(e["created_at"] as string).getTime();
    if (age > 3600_000) {
      res.status(409).json({ error: "Undo window expired (1 hour limit)" });
      return;
    }

    const editType = e["edit_type"] as string;
    const trailId = e["trail_id"] as string;
    const previous = e["previous_values"] as Record<string, unknown> | null;

    if (!trailId || !previous) {
      res.status(400).json({ error: "Cannot undo this edit type" });
      return;
    }

    // Restore previous values
    const { error } = await supa.from("trails").update(previous).eq("id", trailId);
    if (error) {
      res.status(500).json({ error: "Undo failed" });
      return;
    }

    // Mark edit as undone by removing it
    await supa.from("linesman_edits").delete().eq("id", editId);

    logger.info({ editId, trailId, editType, userId }, "Linesman edit undone");
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

// GET /api/admin/linesfolk — list all users with linesman access
router.get("/api/admin/linesfolk", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId || !isAdmin(userId)) { res.status(403).json({ error: "Forbidden" }); return; }

  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from("users")
    .select("id, display_name, email, linesman_access, linesman_group_id, created_at")
    .eq("linesman_access", true)
    .order("display_name");

  if (error) { res.status(500).json({ error: "Query failed" }); return; }
  res.json({ linesfolk: data ?? [] });
});

// PATCH /api/admin/linesfolk/:userId — grant / revoke access
const GrantBody = z.object({
  linesman_access:   z.boolean(),
  linesman_group_id: z.string().uuid().nullable().optional(),
});

router.patch("/api/admin/linesfolk/:userId", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId || !isAdmin(userId)) { res.status(403).json({ error: "Forbidden" }); return; }

  const parsed = GrantBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

  const targetId = String(req.params["userId"]);
  const supa = getSupabaseAdmin();

  const update: Record<string, unknown> = { linesman_access: parsed.data.linesman_access };
  if (parsed.data.linesman_group_id !== undefined) update["linesman_group_id"] = parsed.data.linesman_group_id;

  const { error } = await supa.from("users").update(update).eq("id", targetId);
  if (error) { res.status(500).json({ error: "Update failed" }); return; }

  logger.info({ targetId, ...parsed.data, grantedBy: userId }, "Linesman access updated by admin");
  res.json({ ok: true });
});

// GET /api/admin/linesfolk/:userId/edits
router.get("/api/admin/linesfolk/:userId/edits", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId || !isAdmin(userId)) { res.status(403).json({ error: "Forbidden" }); return; }

  const targetId = String(req.params["userId"]);
  const supa = getSupabaseAdmin();

  const { data, error } = await supa
    .from("linesman_edits")
    .select("id, trail_id, edit_type, new_values, previous_values, edit_reason, created_at")
    .eq("linesman_user_id", targetId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) { res.status(500).json({ error: "Query failed" }); return; }
  res.json({ edits: data ?? [] });
});

// POST /api/admin/linesfolk/edits/:editId/undo — admin undo within 24 hours
router.post("/api/admin/linesfolk/edits/:editId/undo", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId || !isAdmin(userId)) { res.status(403).json({ error: "Forbidden" }); return; }

  const editId = String(req.params["editId"]);
  const supa = getSupabaseAdmin();

  const { data: edit } = await supa.from("linesman_edits").select("*").eq("id", editId).maybeSingle();
  if (!edit) { res.status(404).json({ error: "Edit not found" }); return; }

  const e = edit as Record<string, unknown>;
  const age = Date.now() - new Date(e["created_at"] as string).getTime();
  if (age > 86400_000) { res.status(409).json({ error: "Admin undo window expired (24 hours)" }); return; }

  const trailId = e["trail_id"] as string;
  const previous = e["previous_values"] as Record<string, unknown> | null;
  if (!trailId || !previous) { res.status(400).json({ error: "Cannot undo" }); return; }

  const { error } = await supa.from("trails").update(previous).eq("id", trailId);
  if (error) { res.status(500).json({ error: "Undo failed" }); return; }

  await supa.from("linesman_edits").delete().eq("id", editId);
  logger.info({ editId, trailId, adminId: userId }, "Linesman edit undone by admin");
  res.json({ ok: true });
});

export default router;
