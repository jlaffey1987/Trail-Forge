/**
 * Rider gamification — update mileage, rank, and achievements when
 * trails are marked ridden / unmarked.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { checkAndAward, type Achievement, type UserStats } from "./achievements";
import { isMissingColumnError } from "./dbErrors";
import { POINTS, rankFromPoints } from "./ranking";

const COMPLETION_BONUS_POINTS = 10;

export interface RiderStatsPublic {
  trailKmTotal: number;
  trailsCompleted: number;
  trailsAdded: number;
  rankPoints: number;
  rankTitle: string;
  rankLevel: number;
  helpfulVotes: number;
  forumPosts: number;
  globalRank: number | null;
}

export interface GamificationApplyResult {
  stats: RiderStatsPublic;
  newAchievements: Array<{
    key: string;
    name: string;
    description: string;
    icon: string;
    colour: string;
  }>;
}

type UserRow = Record<string, unknown>;

async function fetchTrailDistanceKm(
  supa: SupabaseClient,
  trailId: string,
): Promise<number> {
  const { data } = await supa
    .from("trails")
    .select("distance_km")
    .eq("id", trailId)
    .maybeSingle();
  const km = (data as { distance_km?: number | null } | null)?.distance_km;
  return typeof km === "number" && Number.isFinite(km) && km > 0 ? km : 0;
}

async function countConditionReports(
  supa: SupabaseClient,
  userId: string,
): Promise<number> {
  const { count, error } = await supa
    .from("trail_conditions")
    .select("id", { count: "exact", head: true })
    .eq("reporter_user_id", userId);
  if (error) return 0;
  return count ?? 0;
}

function rowToStats(row: UserRow, conditionReports: number): UserStats {
  return {
    trail_km_total: (row.trail_km_total as number) ?? 0,
    trails_completed: (row.trails_completed as number) ?? 0,
    trails_added: (row.trails_added as number) ?? 0,
    forum_posts: (row.forum_posts as number) ?? 0,
    helpful_votes: (row.helpful_votes as number) ?? 0,
    rank_points: (row.rank_points as number) ?? 0,
    rank_level: (row.rank_level as number) ?? 1,
    condition_reports: conditionReports,
  };
}

function publicStats(row: UserRow, globalRank: number | null): RiderStatsPublic {
  return {
    trailKmTotal: (row.trail_km_total as number) ?? 0,
    trailsCompleted: (row.trails_completed as number) ?? 0,
    trailsAdded: (row.trails_added as number) ?? 0,
    rankPoints: (row.rank_points as number) ?? 0,
    rankTitle: (row.rank_title as string) ?? "Greenlaner",
    rankLevel: (row.rank_level as number) ?? 1,
    helpfulVotes: (row.helpful_votes as number) ?? 0,
    forumPosts: (row.forum_posts as number) ?? 0,
    globalRank,
  };
}

async function globalKmRank(
  supa: SupabaseClient,
  trailKmTotal: number,
): Promise<number | null> {
  const { count, error } = await supa
    .from("users")
    .select("id", { count: "exact", head: true })
    .gt("trail_km_total", trailKmTotal);
  if (error) {
    if (isMissingColumnError(error)) return null;
    return null;
  }
  return (count ?? 0) + 1;
}

async function loadUserRow(
  supa: SupabaseClient,
  userId: string,
): Promise<UserRow | null> {
  const cols =
    "id, trail_km_total, trails_completed, trails_added, forum_posts, helpful_votes, rank_points, rank_title, rank_level";
  const { data, error } = await supa
    .from("users")
    .select(cols)
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as UserRow;
}

function mapNewAchievements(earned: Achievement[]) {
  return earned.map((a) => ({
    key: a.key,
    name: a.name,
    description: a.description,
    icon: a.icon,
    colour: a.colour,
  }));
}

async function persistStatsAndAward(
  supa: SupabaseClient,
  userId: string,
  patch: {
    trail_km_total: number;
    trails_completed: number;
    rank_points: number;
    rank_title: string;
    rank_level: number;
  },
  baseRow: UserRow,
): Promise<GamificationApplyResult> {
  const { error } = await supa.from("users").update(patch).eq("id", userId);
  if (error && !isMissingColumnError(error)) {
    throw error;
  }

  const merged: UserRow = { ...baseRow, ...patch };
  const conditionReports = await countConditionReports(supa, userId);
  const stats = rowToStats(merged, conditionReports);
  const earned = await checkAndAward(supa, userId, stats);
  const globalRank = await globalKmRank(supa, patch.trail_km_total);

  return {
    stats: publicStats(merged, globalRank),
    newAchievements: mapNewAchievements(earned),
  };
}

/** First-time mark as ridden — adds km, completion count, and rank points. */
export async function applyCompletionAdded(
  supa: SupabaseClient,
  userId: string,
  trailId: string,
): Promise<GamificationApplyResult | null> {
  const row = await loadUserRow(supa, userId);
  if (!row) return null;

  const km = await fetchTrailDistanceKm(supa, trailId);
  const kmPoints = Math.floor(km * POINTS.PER_KM_RIDDEN);
  const nextKm = ((row.trail_km_total as number) ?? 0) + km;
  const nextCompleted = ((row.trails_completed as number) ?? 0) + 1;
  const nextPoints =
    ((row.rank_points as number) ?? 0) + kmPoints + COMPLETION_BONUS_POINTS;
  const rank = rankFromPoints(nextPoints);

  return persistStatsAndAward(
    supa,
    userId,
    {
      trail_km_total: Math.round(nextKm * 100) / 100,
      trails_completed: nextCompleted,
      rank_points: nextPoints,
      rank_title: rank.title,
      rank_level: rank.level,
    },
    row,
  );
}

/** Un-mark ridden — subtract km and completion credit (floored at zero). */
export async function applyCompletionRemoved(
  supa: SupabaseClient,
  userId: string,
  trailId: string,
): Promise<GamificationApplyResult | null> {
  const row = await loadUserRow(supa, userId);
  if (!row) return null;

  const km = await fetchTrailDistanceKm(supa, trailId);
  const kmPoints = Math.floor(km * POINTS.PER_KM_RIDDEN);
  const nextKm = Math.max(0, ((row.trail_km_total as number) ?? 0) - km);
  const nextCompleted = Math.max(0, ((row.trails_completed as number) ?? 0) - 1);
  const nextPoints = Math.max(
    0,
    ((row.rank_points as number) ?? 0) - kmPoints - COMPLETION_BONUS_POINTS,
  );
  const rank = rankFromPoints(nextPoints);

  return persistStatsAndAward(
    supa,
    userId,
    {
      trail_km_total: Math.round(nextKm * 100) / 100,
      trails_completed: nextCompleted,
      rank_points: nextPoints,
      rank_title: rank.title,
      rank_level: rank.level,
    },
    row,
  );
}

export async function loadRiderStatsPublic(
  supa: SupabaseClient,
  userId: string,
): Promise<RiderStatsPublic | null> {
  const row = await loadUserRow(supa, userId);
  if (!row) return null;
  const km = (row.trail_km_total as number) ?? 0;
  const globalRank = await globalKmRank(supa, km);
  return publicStats(row, globalRank);
}
