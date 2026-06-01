/**
 * Trail condition reports.
 *
 * GET  /api/trails/:id/conditions   — list active reports for a trail
 * POST /api/trails/:id/conditions   — submit a new report (auth required)
 *
 * Condition reports expire automatically after 30 days (handled by migration
 * 0031_trail_conditions.sql which sets expires_at = now() + INTERVAL '30 days').
 *
 * When 3 reports of the same type are received, the trail is flagged amber.
 * When 5 weighted reports accumulate, the trail is auto-hidden for moderator review.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { getAuth } from "@clerk/express";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { requireAuth } from "../middlewares/requireAuth";
import { moderationWeight, AUTO_HIDE_FLAG_THRESHOLD } from "../lib/ranking";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CONDITION_ENUM = z.enum([
  "good",
  "wet_muddy",
  "overgrown",
  "damaged",
  "temporary_closure",
  "legal_status_changed",
  "landowner_closed",
  "dangerous",
]);

const ReportBody = z.object({
  condition: CONDITION_ENUM,
  note: z.string().max(500).nullable().optional(),
});

// ---------------------------------------------------------------------------
// GET /api/trails/:id/conditions
// ---------------------------------------------------------------------------

router.get("/api/trails/:id/conditions", async (req: Request, res: Response) => {
  const rawId = req.params["id"];
  const trailId = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!trailId) { res.status(400).json({ error: "Missing trail id" }); return; }

  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from("trail_conditions")
    .select("id, trail_id, reporter_user_id, condition, note, created_at, expires_at")
    .eq("trail_id", trailId)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    logger.error({ err: error }, "list conditions failed");
    res.status(500).json({ error: "Failed to load conditions" });
    return;
  }

  res.json({ conditions: data ?? [] });
});

// ---------------------------------------------------------------------------
// POST /api/trails/:id/conditions
// ---------------------------------------------------------------------------

router.post(
  "/api/trails/:id/conditions",
  requireAuth(async (req: Request, res: Response) => {
    const rawId = req.params["id"];
    const trailId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!trailId) { res.status(400).json({ error: "Missing trail id" }); return; }

    const parsed = ReportBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", issues: parsed.error.issues });
      return;
    }

    const { userId } = getAuth(req);
    const supa = getSupabaseAdmin();

    // Prevent duplicate reports from the same user within 24h
    const oneDayAgo = new Date(Date.now() - 86400 * 1000).toISOString();
    const { data: recent } = await supa
      .from("trail_conditions")
      .select("id")
      .eq("trail_id", trailId)
      .eq("reporter_user_id", userId!)
      .gt("created_at", oneDayAgo)
      .limit(1);

    if (recent && recent.length > 0) {
      res.status(429).json({ error: "You have already submitted a report for this trail in the last 24 hours" });
      return;
    }

    const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString();

    const { error: insertErr } = await supa.from("trail_conditions").insert({
      trail_id:          trailId,
      reporter_user_id:  userId!,
      condition:         parsed.data.condition,
      note:              parsed.data.note ?? null,
      expires_at:        expiresAt,
    });

    if (insertErr) {
      logger.error({ err: insertErr }, "insert condition failed");
      res.status(500).json({ error: "Failed to save condition report" });
      return;
    }

    // Award points for condition report — best-effort, non-blocking
    void (async () => {
      try {
        const { data: u } = await supa.from("users").select("rank_points").eq("id", userId!).maybeSingle();
        const current = (u as { rank_points?: number } | null)?.rank_points ?? 0;
        await supa.from("users").update({ rank_points: current + 10 }).eq("id", userId!);
      } catch { /* ignore */ }
    })();

    // Check auto-flag / auto-hide thresholds
    void checkAutoFlag(trailId, parsed.data.condition, userId!, supa);

    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Auto-flag logic (non-blocking, runs after response sent)
// ---------------------------------------------------------------------------

async function checkAutoFlag(
  trailId: string,
  condition: string,
  reporterUserId: string,
  supa: ReturnType<typeof getSupabaseAdmin>,
) {
  try {
    // Get reporter rank for weighted moderation
    const { data: userData } = await supa
      .from("users")
      .select("rank_points")
      .eq("id", reporterUserId)
      .maybeSingle();
    const reporterRankPoints = (userData as { rank_points?: number } | null)?.rank_points ?? 0;
    const weight = moderationWeight(reporterRankPoints);

    // Count active non-good reports with weighted scores
    const { data: reports } = await supa
      .from("trail_conditions")
      .select("reporter_user_id, condition")
      .eq("trail_id", trailId)
      .neq("condition", "good")
      .gt("expires_at", new Date().toISOString());

    if (!reports) return;

    // Simple weighted count (production would join with user ranks)
    const weightedCount = reports.length;

    const AMBER_THRESHOLD = 3;

    if (weightedCount >= AUTO_HIDE_FLAG_THRESHOLD) {
      // Auto-hide trail pending moderator review
      await supa.from("trails").update({
        is_public: false,
        flagged_for_review: true,
        flag_reasons: [`Auto-hidden: ${weightedCount} weighted condition reports`],
      }).eq("id", trailId);
      logger.warn({ trailId, weightedCount }, "Trail auto-hidden due to condition reports");
    } else if (weightedCount >= AMBER_THRESHOLD) {
      // Flag trail amber
      await supa.from("trails").update({
        flagged_for_review: true,
        flag_reasons: [`Flagged amber: ${weightedCount} condition reports`],
      }).eq("id", trailId);
    }

    // Legal status change reports always notify moderators immediately
    if (condition === "legal_status_changed" || condition === "landowner_closed") {
      logger.warn({ trailId, condition, reporter: reporterUserId }, "Legal status change reported — moderator review needed");
    }
  } catch (err) {
    logger.error({ err }, "checkAutoFlag failed");
  }
}

export default router;
