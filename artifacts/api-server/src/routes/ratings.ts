/**
 * Trail star ratings — POST to submit, GET to list, GET /me to fetch caller's.
 *
 * Weighting rules (spec §1.2):
 *   rider within 2 grades of trail difficulty  → weight 1.0
 *   rider more than 2 grades ABOVE trail       → weight 0.3 (overconfident)
 *   rider BELOW trail difficulty               → excluded entirely
 *
 * Weighted average is recomputed on every mutating call.
 * quality_flagged = true when avg_stars < 2.5 AND rating_count >= 5.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { z } from "zod";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

// ── Validation ────────────────────────────────────────────────────────────────

const SubmitRatingBody = z.object({
  rider_difficulty: z.number().int().min(1).max(10),
  overall_stars:    z.number().int().min(1).max(5),
  scenery_stars:    z.number().int().min(1).max(5).optional().nullable(),
  surface_stars:    z.number().int().min(1).max(5).optional().nullable(),
  accuracy_stars:   z.number().int().min(1).max(5).optional().nullable(),
  fun_stars:        z.number().int().min(1).max(5).optional().nullable(),
  review_text:      z.string().max(500).optional().nullable(),
  ridden_at:        z.string().datetime().optional().nullable(),
  season:           z.enum(["spring","summer","autumn","winter"]).optional().nullable(),
});

// ── Weight helpers ────────────────────────────────────────────────────────────

function ratingWeight(riderGrade: number, trailGrade: number): number | null {
  if (riderGrade < trailGrade) return null;         // below difficulty — excluded
  if (riderGrade - trailGrade > 2) return 0.3;       // overconfident
  return 1.0;                                         // within 2 grades — full weight
}

/**
 * Recompute weighted averages for a trail and update the trails row.
 * Safe to call after every rating mutation.
 */
async function recomputeAverages(trailId: string): Promise<void> {
  const supa = getSupabaseAdmin();

  // Fetch trail's own difficulty
  const { data: trailRow } = await supa
    .from("trails")
    .select("difficulty")
    .eq("id", trailId)
    .single();

  const trailGrade = parseInt(String(trailRow?.difficulty ?? "5"), 10);

  // Fetch all ratings for this trail
  const { data: ratings } = await supa
    .from("trail_ratings")
    .select("overall_stars, scenery_stars, surface_stars, accuracy_stars, fun_stars, rider_difficulty")
    .eq("trail_id", trailId);

  if (!ratings || ratings.length === 0) {
    await supa
      .from("trails")
      .update({ avg_stars: null, rating_count: 0, quality_flagged: false })
      .eq("id", trailId);
    return;
  }

  let totalWeight = 0;
  let weightedOverall = 0;
  let weightedScenery = 0, sceneryW = 0;
  let weightedSurface = 0, surfaceW = 0;
  let weightedAccuracy = 0, accuracyW = 0;
  let weightedFun = 0, funW = 0;
  let includedCount = 0;

  for (const r of ratings) {
    const w = ratingWeight(r.rider_difficulty, trailGrade);
    if (w === null) continue; // excluded

    totalWeight      += w;
    weightedOverall  += r.overall_stars * w;
    includedCount++;

    if (r.scenery_stars  != null) { weightedScenery  += r.scenery_stars  * w; sceneryW  += w; }
    if (r.surface_stars  != null) { weightedSurface  += r.surface_stars  * w; surfaceW  += w; }
    if (r.accuracy_stars != null) { weightedAccuracy += r.accuracy_stars * w; accuracyW += w; }
    if (r.fun_stars      != null) { weightedFun      += r.fun_stars      * w; funW      += w; }
  }

  const avg = totalWeight > 0 ? weightedOverall / totalWeight : null;
  const flagged = avg != null && avg < 2.5 && includedCount >= 5;

  await supa.from("trails").update({
    avg_stars:          avg != null ? Math.round(avg * 10) / 10 : null,
    avg_scenery_stars:  sceneryW  > 0 ? Math.round((weightedScenery  / sceneryW)  * 10) / 10 : null,
    avg_surface_stars:  surfaceW  > 0 ? Math.round((weightedSurface  / surfaceW)  * 10) / 10 : null,
    avg_accuracy_stars: accuracyW > 0 ? Math.round((weightedAccuracy / accuracyW) * 10) / 10 : null,
    avg_fun_stars:      funW      > 0 ? Math.round((weightedFun      / funW)      * 10) / 10 : null,
    rating_count:       ratings.length,
    quality_flagged:    flagged,
    quality_flag_reason: flagged ? "Low weighted average from qualified riders" : null,
  }).eq("id", trailId);
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** GET /api/trails/:id/ratings — list ratings (public) */
router.get("/trails/:id/ratings", async (req: Request, res: Response) => {
  const trailId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!trailId) { res.status(400).json({ error: "Missing trail id" }); return; }

  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from("trail_ratings")
    .select("id, user_id, overall_stars, scenery_stars, surface_stars, accuracy_stars, fun_stars, review_text, season, ridden_at, created_at, rider_difficulty")
    .eq("trail_id", trailId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) { res.status(500).json({ error: "Query failed" }); return; }

  // Attach display names from users table
  const userIds = [...new Set((data ?? []).map(r => r.user_id))];
  const { data: users } = userIds.length
    ? await supa.from("users").select("id, display_name, avatar_url").in("id", userIds)
    : { data: [] };

  const userMap = new Map((users ?? []).map(u => [u.id, u]));
  const enriched = (data ?? []).map(r => ({
    ...r,
    display_name: userMap.get(r.user_id)?.display_name ?? null,
    avatar_url:   userMap.get(r.user_id)?.avatar_url   ?? null,
  }));

  res.json({ ratings: enriched });
});

/** GET /api/trails/:id/ratings/me — caller's rating for this trail */
router.get("/trails/:id/ratings/me", requireAuth(async (req, res, userId) => {
  const trailId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!trailId) { res.status(400).json({ error: "Missing trail id" }); return; }

  const supa = getSupabaseAdmin();
  const { data } = await supa
    .from("trail_ratings")
    .select("*")
    .eq("trail_id", trailId)
    .eq("user_id", userId)
    .maybeSingle();

  res.json({ rating: data ?? null });
}));

/** POST /api/trails/:id/ratings — submit or update caller's rating */
router.post("/trails/:id/ratings", requireAuth(async (req, res, userId) => {
  const trailId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!trailId) { res.status(400).json({ error: "Missing trail id" }); return; }

  const parsed = SubmitRatingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid rating payload", detail: parsed.error.issues });
    return;
  }

  const supa = getSupabaseAdmin();
  const payload = {
    trail_id:        trailId,
    user_id:         userId,
    ...parsed.data,
  };

  const { data, error } = await supa
    .from("trail_ratings")
    .upsert(payload, { onConflict: "trail_id,user_id" })
    .select()
    .single();

  if (error) {
    req.log.error({ err: error }, "rating upsert failed");
    res.status(500).json({ error: "Failed to save rating" });
    return;
  }

  // Recompute weighted averages asynchronously (don't block response)
  void recomputeAverages(trailId).catch(e =>
    req.log.warn({ err: e }, "recomputeAverages failed"),
  );

  res.status(201).json({ rating: data });
}));

/** DELETE /api/trails/:id/ratings/me — remove caller's rating */
router.delete("/trails/:id/ratings/me", requireAuth(async (req, res, userId) => {
  const trailId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!trailId) { res.status(400).json({ error: "Missing trail id" }); return; }

  const supa = getSupabaseAdmin();
  await supa
    .from("trail_ratings")
    .delete()
    .eq("trail_id", trailId)
    .eq("user_id", userId);

  void recomputeAverages(trailId).catch(() => undefined);
  res.json({ ok: true });
}));

export default router;
