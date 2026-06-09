/** latitudeDelta below which trail polylines replace cluster markers. */
export const POLYLINE_ZOOM_DELTA = 0.35;

export function shouldShowTrailPolylines(latitudeDelta: number): boolean {
  return latitudeDelta <= POLYLINE_ZOOM_DELTA;
}

export function shouldClusterTrails(latitudeDelta: number): boolean {
  return latitudeDelta > POLYLINE_ZOOM_DELTA;
}

/** Cluster / dot colours aligned with the map difficulty legend. */
export function gradeClusterColor(grade: number | null | undefined): string {
  if (grade == null) return "#FFB300";
  if (grade <= 3) return "#00C853";
  if (grade <= 6) return "#FFB300";
  if (grade <= 8) return "#FF6D00";
  return "#D50000";
}

export function clusterColorFromGrades(grades: Array<number | null | undefined>): string {
  const valid = grades.filter((g): g is number => typeof g === "number" && Number.isFinite(g));
  if (valid.length === 0) return "#FFB300";
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  return gradeClusterColor(Math.round(avg));
}

export function clusterBubbleSize(count: number): {
  outer: number;
  inner: number;
  fontSize: number;
} {
  if (count >= 50) return { outer: 84, inner: 64, fontSize: 20 };
  if (count >= 25) return { outer: 78, inner: 58, fontSize: 19 };
  if (count >= 15) return { outer: 72, inner: 54, fontSize: 18 };
  if (count >= 10) return { outer: 66, inner: 50, fontSize: 17 };
  if (count >= 6) return { outer: 58, inner: 44, fontSize: 16 };
  return { outer: 50, inner: 38, fontSize: 15 };
}
