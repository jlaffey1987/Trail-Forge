/** Grid-based trail clustering for country / regional map zoom. */

export interface GridClusterInput {
  center: { latitude: number; longitude: number };
  grade: number | null;
}

export interface GridCluster {
  latitude: number;
  longitude: number;
  count: number;
  grades: number[];
}

/**
 * Bucket trail centroids into a lat/lon grid. Cell size scales with viewport
 * so zoomed-out views get fewer, larger count bubbles.
 */
export function buildGridClusters(
  items: GridClusterInput[],
  latitudeDelta: number,
): GridCluster[] {
  if (items.length === 0) return [];

  const cellDeg = Math.max(0.06, latitudeDelta / 10);
  const buckets = new Map<
    string,
    { latSum: number; lonSum: number; count: number; grades: number[] }
  >();

  for (const item of items) {
    const latCell = Math.floor(item.center.latitude / cellDeg);
    const lonCell = Math.floor(item.center.longitude / cellDeg);
    const key = `${latCell}:${lonCell}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.latSum += item.center.latitude;
      existing.lonSum += item.center.longitude;
      existing.count += 1;
      if (item.grade != null) existing.grades.push(item.grade);
    } else {
      buckets.set(key, {
        latSum: item.center.latitude,
        lonSum: item.center.longitude,
        count: 1,
        grades: item.grade != null ? [item.grade] : [],
      });
    }
  }

  return [...buckets.values()].map((b) => ({
    latitude: b.latSum / b.count,
    longitude: b.lonSum / b.count,
    count: b.count,
    grades: b.grades,
  }));
}

/** Use grid clusters when the viewport is wide or has many trails. */
export function shouldUseGridClusters(
  latitudeDelta: number,
  trailCount: number,
): boolean {
  return latitudeDelta > 0.75 && trailCount > 80;
}
