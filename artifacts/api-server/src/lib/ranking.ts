/**
 * Rider rank system.
 *
 * Points are accumulated from riding, contributing trails, reporting
 * conditions, and community engagement.  The rank_title and rank_level
 * are derived purely from the cumulative rank_points total.
 */

export interface RankTier {
  level: number;
  title: string;
  minPoints: number;
  maxPoints: number;
}

export const RANK_TIERS: RankTier[] = [
  { level: 1, title: "Greenlaner",      minPoints: 0,     maxPoints: 99 },
  { level: 2, title: "Trail Rider",     minPoints: 100,   maxPoints: 499 },
  { level: 3, title: "Adventure Rider", minPoints: 500,   maxPoints: 1499 },
  { level: 4, title: "Trail Veteran",   minPoints: 1500,  maxPoints: 3999 },
  { level: 5, title: "Trail Master",    minPoints: 4000,  maxPoints: 7999 },
  { level: 6, title: "Trail Legend",    minPoints: 8000,  maxPoints: 14999 },
  { level: 7, title: "Trail God",       minPoints: 15000, maxPoints: Infinity },
];

export function rankFromPoints(points: number): RankTier {
  for (let i = RANK_TIERS.length - 1; i >= 0; i--) {
    if (points >= RANK_TIERS[i].minPoints) return RANK_TIERS[i];
  }
  return RANK_TIERS[0];
}

// Points awarded for each action.
export const POINTS = {
  PER_KM_RIDDEN:              1,
  COMPLETE_NAMED_COLLECTION:  50,
  ADD_TRAIL:                  30,
  CONDITION_REPORT:           10,
  FORUM_POST:                 5,
  HELPFUL_VOTE_RECEIVED:      3,
  FIRST_RIDER_NEW_TRAIL:      25,
} as const;

/**
 * Community moderation vote weighting based on rank.
 * Used when aggregating flag reports against a trail.
 */
export function moderationWeight(rankPoints: number): number {
  if (rankPoints >= 5000) return 3;
  if (rankPoints >= 1000) return 2;
  if (rankPoints >= 100)  return 1;
  return 1;
}

/** Weighted flag threshold that triggers auto-hide pending moderator review. */
export const AUTO_HIDE_FLAG_THRESHOLD = 10;
