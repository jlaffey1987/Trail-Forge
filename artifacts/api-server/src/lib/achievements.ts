/**
 * Achievement engine.
 *
 * checkAndAward() evaluates all achievement rules against a user's current
 * stats and inserts any newly-earned achievements.  It is idempotent — the
 * achievements table has a UNIQUE(user_id, achievement_key) constraint.
 */

import { type SupabaseClient } from "@supabase/supabase-js";

export interface Achievement {
  key: string;
  name: string;
  description: string;
  icon: string;
  colour: string;
  /** Returns true when this achievement should be awarded. */
  test: (stats: UserStats) => boolean;
}

export interface UserStats {
  trail_km_total: number;
  trails_completed: number;
  trails_added: number;
  forum_posts: number;
  helpful_votes: number;
  rank_points: number;
  rank_level: number;
  condition_reports: number;
}

export const ACHIEVEMENTS: Achievement[] = [
  // Distance milestones
  { key: "first_km",      name: "First Kilometre",   description: "Ride your first km off-road",            icon: "map-pin",      colour: "#22c55e", test: s => s.trail_km_total >= 1 },
  { key: "10km",          name: "10km Club",          description: "Ride 10 km of trails",                  icon: "trending-up",  colour: "#22c55e", test: s => s.trail_km_total >= 10 },
  { key: "50km",          name: "50km Explorer",      description: "Ride 50 km of trails",                  icon: "compass",      colour: "#3b82f6", test: s => s.trail_km_total >= 50 },
  { key: "100km",         name: "Century Rider",      description: "Ride 100 km of trails",                 icon: "award",        colour: "#3b82f6", test: s => s.trail_km_total >= 100 },
  { key: "500km",         name: "Adventurer",         description: "Ride 500 km of trails",                 icon: "star",         colour: "#f59e0b", test: s => s.trail_km_total >= 500 },
  { key: "1000km",        name: "Trail Master",       description: "Ride 1,000 km of trails",               icon: "zap",          colour: "#f59e0b", test: s => s.trail_km_total >= 1000 },
  { key: "5000km",        name: "Trail Legend",       description: "Ride 5,000 km of trails",               icon: "shield",       colour: "#ef4444", test: s => s.trail_km_total >= 5000 },

  // Completion milestones
  { key: "first_trail",   name: "First Trail",        description: "Complete your first trail section",     icon: "check-circle", colour: "#22c55e", test: s => s.trails_completed >= 1 },
  { key: "10_trails",     name: "Trail Collector",    description: "Complete 10 trail sections",            icon: "list",         colour: "#3b82f6", test: s => s.trails_completed >= 10 },
  { key: "50_trails",     name: "Trail Hunter",       description: "Complete 50 trail sections",            icon: "target",       colour: "#f59e0b", test: s => s.trails_completed >= 50 },
  { key: "100_trails",    name: "Century Trails",     description: "Complete 100 trail sections",           icon: "layers",       colour: "#ef4444", test: s => s.trails_completed >= 100 },

  // Community contributions
  { key: "first_report",  name: "Condition Reporter", description: "Submit your first trail condition report", icon: "alert-circle", colour: "#3b82f6", test: s => s.condition_reports >= 1 },
  { key: "10_reports",    name: "Trail Guardian",     description: "Submit 10 condition reports",           icon: "shield",       colour: "#f59e0b", test: s => s.condition_reports >= 10 },
  { key: "first_trail_added", name: "Trail Maker",   description: "Add your first trail to TrailForge",    icon: "plus-circle",  colour: "#8b5cf6", test: s => s.trails_added >= 1 },
  { key: "10_trails_added",   name: "Trail Builder",  description: "Add 10 trails to TrailForge",           icon: "tool",         colour: "#8b5cf6", test: s => s.trails_added >= 10 },
  { key: "helpful",       name: "Helpful Rider",      description: "Receive 10 helpful votes from the community", icon: "thumbs-up", colour: "#22c55e", test: s => s.helpful_votes >= 10 },
  { key: "very_helpful",  name: "Community Legend",   description: "Receive 100 helpful votes",             icon: "heart",        colour: "#ef4444", test: s => s.helpful_votes >= 100 },

  // Rank milestones
  { key: "trail_rider",   name: "Trail Rider",        description: "Reach Trail Rider rank (100 points)",   icon: "chevrons-up",  colour: "#3b82f6", test: s => s.rank_points >= 100 },
  { key: "trail_veteran", name: "Trail Veteran",      description: "Reach Trail Veteran rank (1,500 points)", icon: "award",      colour: "#f59e0b", test: s => s.rank_points >= 1500 },
  { key: "trail_master",  name: "Trail Master",       description: "Reach Trail Master rank (4,000 points)", icon: "star",       colour: "#ef4444", test: s => s.rank_points >= 4000 },
];

/**
 * Check which achievements the user has not yet earned and award them.
 * Returns the list of newly-awarded achievements.
 */
export async function checkAndAward(
  supa: SupabaseClient,
  userId: string,
  stats: UserStats,
): Promise<Achievement[]> {
  // Load already-earned achievement keys
  const { data: existing } = await supa
    .from("achievements")
    .select("achievement_key")
    .eq("user_id", userId);

  const earned = new Set((existing ?? []).map((r: Record<string, string>) => r["achievement_key"]));
  const newlyEarned: Achievement[] = [];

  for (const achievement of ACHIEVEMENTS) {
    if (earned.has(achievement.key)) continue;
    if (!achievement.test(stats)) continue;

    const { error } = await supa.from("achievements").insert({
      user_id:                 userId,
      achievement_key:         achievement.key,
      achievement_name:        achievement.name,
      achievement_description: achievement.description,
      badge_icon:              achievement.icon,
      badge_colour:            achievement.colour,
    });

    if (!error) newlyEarned.push(achievement);
  }

  return newlyEarned;
}
