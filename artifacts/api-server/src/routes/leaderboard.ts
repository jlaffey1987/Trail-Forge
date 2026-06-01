/**
 * Leaderboard + activity feed endpoints.
 *
 * GET /api/leaderboard?type=trail_miles&period=weekly   — paginated leaderboard
 * GET /api/feed?limit=30&offset=0                       — community activity feed
 * GET /api/collections                                  — trail collections list
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { isMissingTableError } from "../lib/dbErrors";

const router: IRouter = Router();

const LeaderboardQuery = z.object({
  type:   z.enum(["trail_miles", "trails_completed", "elevation", "most_helpful", "rank_points"]).default("rank_points"),
  period: z.enum(["weekly", "monthly", "all_time"]).default("all_time"),
  limit:  z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------------------
// GET /api/leaderboard
// ---------------------------------------------------------------------------

router.get("/api/leaderboard", async (req: Request, res: Response) => {
  const parsed = LeaderboardQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const { type, period, limit } = parsed.data;

  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from("leaderboard_snapshots")
    .select("rank, user_id, display_name, avatar_url, score")
    .eq("leaderboard_type", type)
    .eq("period", period)
    .order("rank", { ascending: true })
    .limit(limit);

  if (error) {
    if (isMissingTableError(error)) {
      res.json({ entries: [] });
      return;
    }
    res.status(500).json({ error: "Leaderboard unavailable" });
    return;
  }

  res.json({ entries: data ?? [] });
});

// ---------------------------------------------------------------------------
// GET /api/feed
// ---------------------------------------------------------------------------

const FeedQuery = z.object({
  limit:  z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get("/api/feed", async (req: Request, res: Response) => {
  const parsed = FeedQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const { limit, offset } = parsed.data;

  const supa = getSupabaseAdmin();

  // Build feed from achievements + trail completions
  const [achievementsRes, completionsRes] = await Promise.all([
    supa.from("achievements")
      .select("id, user_id, achievement_name, achievement_description, badge_colour, earned_at")
      .order("earned_at", { ascending: false })
      .range(offset, offset + limit - 1),
    supa.from("trail_completions")
      .select("id, user_id, trail_id, completed_at")
      .order("completed_at", { ascending: false })
      .range(offset, offset + limit - 1),
  ]);

  const events: object[] = [];

  for (const a of (achievementsRes.data ?? []) as Array<Record<string, unknown>>) {
    events.push({
      id:           a["id"],
      type:         "achievement",
      user_id:      a["user_id"],
      display_name: "Rider",
      avatar_url:   null,
      title:        `Earned: ${String(a["achievement_name"])}`,
      subtitle:     a["achievement_description"] as string | null,
      created_at:   a["earned_at"],
      icon:         "award",
      icon_color:   (a["badge_colour"] as string) ?? "#D97706",
    });
  }

  for (const c of (completionsRes.data ?? []) as Array<Record<string, unknown>>) {
    events.push({
      id:           c["id"],
      type:         "trail_completed",
      user_id:      c["user_id"],
      display_name: "Rider",
      avatar_url:   null,
      title:        "Completed a trail section",
      subtitle:     null,
      created_at:   c["completed_at"],
      icon:         "check-circle",
      icon_color:   "#22c55e",
    });
  }

  // Sort by date descending
  events.sort((a, b) => {
    const aDate = new Date((a as Record<string, string>)["created_at"]).getTime();
    const bDate = new Date((b as Record<string, string>)["created_at"]).getTime();
    return bDate - aDate;
  });

  res.json({ events: events.slice(0, limit) });
});

// ---------------------------------------------------------------------------
// GET /api/collections
// ---------------------------------------------------------------------------

router.get("/api/collections", async (req: Request, res: Response) => {
  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from("trail_collections")
    .select("id, name, description, region, difficulty_min, difficulty_max, total_distance_km, is_featured, is_official, cover_image_url")
    .order("is_featured", { ascending: false })
    .order("is_official", { ascending: false })
    .order("name");

  if (error) {
    if (isMissingTableError(error)) {
      res.json({ collections: [] });
      return;
    }
    res.status(500).json({ error: "Failed to load collections" });
    return;
  }

  res.json({ collections: data ?? [] });
});

export default router;
