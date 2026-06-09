/** Rank tiers — mirrors api-server/src/lib/ranking.ts for progress UI. */
export const RANK_TIERS = [
  { level: 1, title: "Greenlaner", minPoints: 0, maxPoints: 99 },
  { level: 2, title: "Trail Rider", minPoints: 100, maxPoints: 499 },
  { level: 3, title: "Adventure Rider", minPoints: 500, maxPoints: 1499 },
  { level: 4, title: "Trail Veteran", minPoints: 1500, maxPoints: 3999 },
  { level: 5, title: "Trail Master", minPoints: 4000, maxPoints: 7999 },
  { level: 6, title: "Trail Legend", minPoints: 8000, maxPoints: 14999 },
  { level: 7, title: "Trail God", minPoints: 15000, maxPoints: Infinity },
] as const;

export function rankProgress(rankPoints: number): {
  current: (typeof RANK_TIERS)[number];
  next: (typeof RANK_TIERS)[number] | null;
  progress: number;
  pointsToNext: number | null;
} {
  let current: (typeof RANK_TIERS)[number] = RANK_TIERS[0];
  for (const tier of RANK_TIERS) {
    if (rankPoints >= tier.minPoints) current = tier;
  }
  const currentIdx = RANK_TIERS.findIndex((t) => t.level === current.level);
  const next =
    currentIdx >= 0 && currentIdx < RANK_TIERS.length - 1
      ? RANK_TIERS[currentIdx + 1]
      : null;
  if (!next || !Number.isFinite(current.maxPoints)) {
    return { current, next: null, progress: 1, pointsToNext: null };
  }
  const span = next.minPoints - current.minPoints;
  const progress = span > 0 ? (rankPoints - current.minPoints) / span : 1;
  return {
    current,
    next,
    progress: Math.min(1, Math.max(0, progress)),
    pointsToNext: Math.max(0, next.minPoints - rankPoints),
  };
}
