/**
 * Rider profiles — gamertag-style public cards with mileage, rank, badges.
 *
 * GET /api/me/rider-profile           — caller's full profile + achievements
 * GET /api/users/:userId/rider-profile — public profile for community views
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";

import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { isMissingColumnError, isMissingTableError } from "../lib/dbErrors";
import { loadRiderStatsPublic } from "../lib/riderStats";

const router: IRouter = Router();

const PROFILE_COLS =
  "id, display_name, avatar_url, preferred_bike_type, bike_type, home_region, trail_km_total, trails_completed, trails_added, rank_points, rank_title, rank_level, created_at";

interface AchievementRow {
  achievement_key: string;
  achievement_name: string;
  achievement_description: string | null;
  badge_icon: string | null;
  badge_colour: string | null;
  earned_at: string;
}

function shapeAchievement(row: AchievementRow) {
  return {
    key: row.achievement_key,
    name: row.achievement_name,
    description: row.achievement_description,
    icon: row.badge_icon,
    colour: row.badge_colour,
    earnedAt: row.earned_at,
  };
}

function bikeLabel(preferred?: string | null, legacy?: string | null): string | null {
  const raw = preferred ?? legacy;
  if (!raw || raw === "all") return null;
  const map: Record<string, string> = {
    adventure: "Adventure bike",
    trail: "Trail / dual sport",
    enduro: "Enduro bike",
  };
  return map[raw] ?? raw;
}

async function buildProfilePayload(
  userId: string,
  viewerId: string | null,
  includeEmail: boolean,
) {
  const supa = getSupabaseAdmin();

  let { data: user, error } = await supa
    .from("users")
    .select(PROFILE_COLS + (includeEmail ? ", email" : ""))
    .eq("id", userId)
    .maybeSingle();

  if (error && isMissingColumnError(error)) {
    ({ data: user, error } = await supa
      .from("users")
      .select("id, display_name, avatar_url, preferred_bike_type, created_at")
      .eq("id", userId)
      .maybeSingle());
  }

  if (error || !user) return null;

  const stats = await loadRiderStatsPublic(supa, userId);

  const { data: achievementRows, error: achErr } = await supa
    .from("achievements")
    .select(
      "achievement_key, achievement_name, achievement_description, badge_icon, badge_colour, earned_at",
    )
    .eq("user_id", userId)
    .order("earned_at", { ascending: false });

  const achievements =
    achErr && isMissingTableError(achErr)
      ? []
      : ((achievementRows ?? []) as AchievementRow[]).map(shapeAchievement);

  const { data: recentCompletions } = await supa
    .from("trail_completions")
    .select("trail_id, completed_at, trails(id, name, difficulty, distance_km)")
    .eq("user_id", userId)
    .order("completed_at", { ascending: false })
    .limit(8);

  const recentTrails = (recentCompletions ?? []).map((row) => {
    const r = row as {
      trail_id: string;
      completed_at: string;
      trails: Record<string, unknown> | Record<string, unknown>[] | null;
    };
    const trail = Array.isArray(r.trails) ? r.trails[0] : r.trails;
    return {
      trailId: r.trail_id,
      completedAt: r.completed_at,
      name: (trail?.name as string) ?? "Trail",
      difficulty: trail?.difficulty ?? null,
      distanceKm: (trail?.distance_km as number | null) ?? null,
    };
  });

  const u = user as Record<string, unknown>;

  return {
    id: userId,
    isMe: viewerId === userId,
    displayName: (u.display_name as string | null) ?? "TrailForge rider",
    avatarUrl: (u.avatar_url as string | null) ?? null,
    email: includeEmail ? ((u.email as string | null) ?? null) : undefined,
    bikeLabel: bikeLabel(
      u.preferred_bike_type as string | null,
      u.bike_type as string | null,
    ),
    homeRegion: (u.home_region as string | null) ?? null,
    memberSince: (u.created_at as string | null) ?? null,
    stats: stats ?? {
      trailKmTotal: 0,
      trailsCompleted: 0,
      trailsAdded: 0,
      rankPoints: 0,
      rankTitle: "Greenlaner",
      rankLevel: 1,
      helpfulVotes: 0,
      forumPosts: 0,
      globalRank: null,
    },
    achievements,
    recentTrails,
  };
}

router.get("/api/me/rider-profile", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const profile = await buildProfilePayload(auth.userId, auth.userId, true);
    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }
    res.json({ profile });
  } catch (err) {
    req.log.error({ err }, "rider-profile GET failed");
    res.status(500).json({ error: "Failed to load profile" });
  }
});

router.get(
  "/api/users/:userId/rider-profile",
  async (req: Request, res: Response) => {
    const auth = getAuth(req);
    const userId = req.params.userId;
    if (typeof userId !== "string" || userId.length === 0 || userId.length > 128) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    try {
      const profile = await buildProfilePayload(
        userId,
        auth.userId ?? null,
        false,
      );
      if (!profile) {
        res.status(404).json({ error: "Rider not found" });
        return;
      }
      res.json({ profile });
    } catch (err) {
      req.log.error({ err }, "public rider-profile GET failed");
      res.status(500).json({ error: "Failed to load rider profile" });
    }
  },
);

export default router;
