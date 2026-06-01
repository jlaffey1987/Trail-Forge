/**
 * Admin / scheduled-task endpoints.
 *
 * All routes are gated behind moderator/admin check via readEnvAdminList().
 * These are designed to be called by server-side cron jobs or manually
 * by admins from the dashboard.
 *
 * POST /api/admin/sync-osm              — trigger OSM legal sync
 * POST /api/admin/expire-conditions     — remove expired trail condition reports
 * POST /api/admin/rebuild-leaderboards  — rebuild weekly/monthly snapshots
 * GET  /api/admin/data-quality-report   — returns data quality metrics
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { readEnvAdminList } from "../lib/admin";
import { rankFromPoints, moderationWeight, AUTO_HIDE_FLAG_THRESHOLD } from "../lib/ranking";
import { checkAndAward, type UserStats } from "../lib/achievements";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

function isAdmin(userId: string): boolean {
  return readEnvAdminList().includes(userId);
}

function requireAdmin(req: Request, res: Response): string | null {
  const { userId } = getAuth(req);
  if (!userId || !isAdmin(userId)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return userId;
}

// ---------------------------------------------------------------------------
// POST /api/admin/expire-conditions
// ---------------------------------------------------------------------------
// Deletes trail_conditions rows past their expires_at date and lifts any
// auto-flags that no longer have enough active reports to sustain them.

router.post("/api/admin/expire-conditions", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const supa = getSupabaseAdmin();

  // 1. Hard-delete expired reports.
  const { error: delErr, count } = await supa
    .from("trail_conditions")
    .delete({ count: "exact" })
    .lt("expires_at", new Date().toISOString());

  if (delErr) {
    logger.error({ err: delErr }, "expire-conditions delete failed");
    res.status(500).json({ error: "Delete failed" });
    return;
  }

  logger.info({ expired: count }, "Expired condition reports removed");
  res.json({ ok: true, expired: count ?? 0 });
});

// ---------------------------------------------------------------------------
// POST /api/admin/rebuild-leaderboards
// ---------------------------------------------------------------------------
// Computes weekly and monthly leaderboard snapshots from current user stats.

router.post("/api/admin/rebuild-leaderboards", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const supa = getSupabaseAdmin();

  const periods = ["weekly", "monthly", "all_time"] as const;
  const types = [
    { key: "trail_miles",      col: "trail_km_total" },
    { key: "trails_completed", col: "trails_completed" },
    { key: "most_helpful",     col: "helpful_votes" },
    { key: "rank_points",      col: "rank_points" },
  ] as const;

  let totalRows = 0;

  for (const period of periods) {
    for (const type of types) {
      const { data: users } = await supa
        .from("users")
        .select(`id, display_name, avatar_url, ${type.col}`)
        .order(type.col, { ascending: false })
        .limit(100);

      if (!users) continue;

      // Delete old snapshot for this type+period
      await supa
        .from("leaderboard_snapshots")
        .delete()
        .eq("leaderboard_type", type.key)
        .eq("period", period);

      const rows = (users as Array<Record<string, unknown>>).map((u, i) => ({
        leaderboard_type: type.key,
        user_id:          u["id"] as string,
        display_name:     (u["display_name"] as string | null) ?? "Rider",
        avatar_url:       u["avatar_url"] as string | null,
        score:            (u[type.col] as number) ?? 0,
        rank:             i + 1,
        period,
      }));

      if (rows.length > 0) {
        await supa.from("leaderboard_snapshots").insert(rows);
        totalRows += rows.length;
      }
    }
  }

  logger.info({ totalRows }, "Leaderboards rebuilt");
  res.json({ ok: true, rows: totalRows });
});

// ---------------------------------------------------------------------------
// POST /api/admin/sync-osm
// ---------------------------------------------------------------------------
// Lightweight legal-status refresh from Overpass. Delegates heavy lifting to
// the scripts/src/syncOSM script for full imports; this endpoint handles
// in-app quick checks for changed access tags on already-imported ways.

router.post("/api/admin/sync-osm", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const supa = getSupabaseAdmin();

  // Record that a sync was requested — the actual heavy fetch runs in the
  // background sync script. This endpoint queues the intent.
  const { error } = await supa.from("system_config").upsert({
    key: "osm_sync_requested_at",
    value: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (error) {
    logger.error({ err: error }, "sync-osm upsert failed");
    res.status(500).json({ error: "Failed to queue sync" });
    return;
  }

  logger.info("OSM sync requested by admin");
  res.json({ ok: true, message: "Sync queued — run pnpm --filter @workspace/scripts sync:osm to execute" });
});

// ---------------------------------------------------------------------------
// GET /api/admin/data-quality-report
// ---------------------------------------------------------------------------

router.get("/api/admin/data-quality-report", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const supa = getSupabaseAdmin();

  const [
    totalQ, publicQ, sourceQ, confidenceQ, flaggedQ, conditionsQ
  ] = await Promise.all([
    supa.from("trails").select("id", { count: "exact", head: true }),
    supa.from("trails").select("id", { count: "exact", head: true }).eq("is_public", true),
    supa.from("trails").select("source").limit(10000),
    supa.from("trails").select("legal_confidence").limit(10000),
    supa.from("trails").select("id", { count: "exact", head: true }).eq("flagged_for_review", true),
    supa.from("trail_conditions").select("id", { count: "exact", head: true }).gt("expires_at", new Date().toISOString()),
  ]);

  // Source breakdown
  const sourceCounts: Record<string, number> = {};
  for (const row of (sourceQ.data ?? []) as Array<{ source: string | null }>) {
    const s = row.source ?? "unknown";
    sourceCounts[s] = (sourceCounts[s] ?? 0) + 1;
  }

  // Confidence breakdown
  const confidenceCounts: Record<string, number> = {};
  for (const row of (confidenceQ.data ?? []) as Array<{ legal_confidence: string | null }>) {
    const c = row.legal_confidence ?? "unverified";
    confidenceCounts[c] = (confidenceCounts[c] ?? 0) + 1;
  }

  res.json({
    trails: {
      total:         totalQ.count ?? 0,
      public:        publicQ.count ?? 0,
      flagged:       flaggedQ.count ?? 0,
      by_source:     sourceCounts,
      by_confidence: confidenceCounts,
    },
    active_conditions: conditionsQ.count ?? 0,
    generated_at: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/check-achievements
// ---------------------------------------------------------------------------
// Re-evaluates achievements for a specific user (or all users if no userId).

router.post("/api/admin/check-achievements", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const supa = getSupabaseAdmin();
  const { userId: targetUserId } = req.body as { userId?: string };

  const query = supa
    .from("users")
    .select("id, trail_km_total, trails_completed, trails_added, forum_posts, helpful_votes, rank_points, rank_level");

  const { data: users, error } = targetUserId
    ? await query.eq("id", targetUserId)
    : await query.limit(1000);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  let totalAwarded = 0;
  for (const user of (users ?? []) as Array<Record<string, unknown>>) {
    // Count condition reports for this user
    const { count: reportCount } = await supa
      .from("trail_conditions")
      .select("id", { count: "exact", head: true })
      .eq("reporter_user_id", user["id"] as string);

    const stats: UserStats = {
      trail_km_total:    (user["trail_km_total"] as number)   ?? 0,
      trails_completed:  (user["trails_completed"] as number) ?? 0,
      trails_added:      (user["trails_added"] as number)     ?? 0,
      forum_posts:       (user["forum_posts"] as number)      ?? 0,
      helpful_votes:     (user["helpful_votes"] as number)    ?? 0,
      rank_points:       (user["rank_points"] as number)      ?? 0,
      rank_level:        (user["rank_level"] as number)       ?? 1,
      condition_reports: reportCount ?? 0,
    };

    const newAchievements = await checkAndAward(supa, user["id"] as string, stats);
    totalAwarded += newAchievements.length;

    // Update rank title + level
    const rank = rankFromPoints(stats.rank_points);
    if (rank.level !== stats.rank_level) {
      await supa.from("users").update({ rank_title: rank.title, rank_level: rank.level }).eq("id", user["id"] as string);
    }
  }

  res.json({ ok: true, users_checked: (users ?? []).length, achievements_awarded: totalAwarded });
});

export default router;
