import { useMemo } from "react";
import type { Trail } from "@/lib/supabase";

const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
  6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
};

interface Props {
  trails: Trail[];
  /** Pixel width/height of the rendered SVG. Defaults to 88x56. */
  width?: number;
  height?: number;
  /** Stable test id appended to the wrapper for e2e selectors. */
  testIdSuffix?: string;
}

/**
 * Best-effort decoder for the `simplified_path` column. Mirrors the
 * RouteDetailSheet helper so a saved route's tiny My Routes thumbnail
 * can render without spinning up a Leaflet instance per card.
 */
function parseSimplifiedPath(
  raw: string | null | undefined,
): Array<[number, number]> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
      return parsed as Array<[number, number]>;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Lightweight SVG preview of a saved route's polyline. Renders one
 * coloured polyline per trail in route order so the rider can spot a
 * route at a glance from the My Routes list without waiting for the
 * Leaflet sheet to open. Coordinates come from `path_geojson` (or the
 * `simplified_path` fallback) — heavier `gpx_data` rows are not pulled
 * for the list, so the thumbnail is intentionally best-effort: empty
 * trails just contribute nothing to the bounding box.
 */
export default function RouteThumbnail({
  trails,
  width = 88,
  height = 56,
  testIdSuffix,
}: Props) {
  const segments = useMemo(() => {
    const out: Array<{ pts: Array<[number, number]>; color: string }> = [];
    for (const trail of trails) {
      const coords =
        (trail.path_geojson?.coordinates as Array<[number, number]> | undefined) ??
        parseSimplifiedPath(trail.simplified_path);
      if (!coords || coords.length === 0) continue;
      // GeoJSON is [lng, lat]. We keep that here; the projection step
      // below maps lng → x and lat → y.
      out.push({
        pts: coords,
        color: DIFFICULTY_COLORS[trail.difficulty ?? 5] ?? "#fbbf24",
      });
    }
    return out;
  }, [trails]);

  const bbox = useMemo(() => {
    let minLng = Infinity,
      minLat = Infinity,
      maxLng = -Infinity,
      maxLat = -Infinity;
    for (const seg of segments) {
      for (const [lng, lat] of seg.pts) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    if (!Number.isFinite(minLng)) return null;
    return { minLng, minLat, maxLng, maxLat };
  }, [segments]);

  const testId = testIdSuffix
    ? `route-thumbnail-${testIdSuffix}`
    : "route-thumbnail";

  if (!bbox) {
    return (
      <div
        className="bg-gradient-to-br from-stone-800 to-stone-900 rounded-md flex items-center justify-center text-stone-600"
        style={{ width, height }}
        data-testid={`${testId}-empty`}
        aria-label="No map preview available"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
          <path d="M9 3v15M15 6v15" />
        </svg>
      </div>
    );
  }

  // Add a small padding inside the SVG so polylines never sit flush
  // against the edge.
  const pad = 4;
  const lngSpan = Math.max(bbox.maxLng - bbox.minLng, 1e-6);
  const latSpan = Math.max(bbox.maxLat - bbox.minLat, 1e-6);
  // Equirectangular projection clamped to the box. Fine for thumbnails;
  // we don't need a true Mercator at this size.
  const project = (lng: number, lat: number): [number, number] => {
    const x = pad + ((lng - bbox.minLng) / lngSpan) * (width - 2 * pad);
    // Flip Y so north is up.
    const y = pad + (1 - (lat - bbox.minLat) / latSpan) * (height - 2 * pad);
    return [x, y];
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="rounded-md bg-gradient-to-br from-stone-800 to-stone-900"
      data-testid={testId}
      aria-label="Route map preview"
      role="img"
    >
      {segments.map((seg, idx) => {
        const points = seg.pts
          .map(([lng, lat]) => {
            const [x, y] = project(lng, lat);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ");
        return (
          <polyline
            key={idx}
            points={points}
            fill="none"
            stroke={seg.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.9}
          />
        );
      })}
    </svg>
  );
}
