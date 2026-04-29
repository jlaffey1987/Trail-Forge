import type { GeoPoint } from "@/lib/routing";

/**
 * Point-of-interest support for the Planner map. Riders need to find
 * petrol stations and campsites near their planned route — we hit
 * Overpass (free OSM API) for the relevant tags and surface results as
 * markers the user can drop into the route as waypoints.
 *
 * Two query modes:
 *   1. `bbox` — search within the currently visible map bounds. Used
 *      when the user has no route assembled yet (just looking around).
 *   2. `corridor` — search along an assembled route's polyline within
 *      a configurable distance. We do this by finding the polyline's
 *      bbox padded by `corridorKm`, fetching all POIs in that area,
 *      then filtering to those within `corridorKm` of the polyline.
 *
 * Overpass is rate-limited; callers should NOT auto-fire on map drag.
 * The Planner gates these requests behind explicit fuel/campsite buttons.
 */

export type PoiKind = "fuel" | "campsite";

export interface Poi {
  /** Stable id (`node/<id>` or `way/<id>` from Overpass). */
  id: string;
  kind: PoiKind;
  lat: number;
  lng: number;
  name: string;
  /** Optional brand (e.g. "BP", "Shell") shown as a subtitle. */
  brand?: string;
  /** Optional address fragment (street/town) for popups. */
  addressLine?: string;
}

interface OverpassNode {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassNode[];
}

/**
 * Endpoints rotate to spread load — the public mirrors throttle
 * aggressively. We try them in order on failure / 429.
 */
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const OVERPASS_TIMEOUT_S = 25;

function tagSelector(kind: PoiKind): string {
  if (kind === "fuel") return 'amenity=fuel';
  return 'tourism=camp_site';
}

function buildBboxQuery(kind: PoiKind, bbox: PoiBbox): string {
  const sel = tagSelector(kind);
  // bbox order in Overpass: south,west,north,east
  const bb = `${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng}`;
  return `[out:json][timeout:${OVERPASS_TIMEOUT_S}];
(
  node[${sel}](${bb});
  way[${sel}](${bb});
);
out center tags 200;`;
}

export interface PoiBbox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

async function postOverpass(query: string): Promise<OverpassResponse | null> {
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) continue;
      return (await res.json()) as OverpassResponse;
    } catch {
      continue;
    }
  }
  return null;
}

function elementToPoi(el: OverpassNode, kind: PoiKind): Poi | null {
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const tags = el.tags ?? {};
  const name =
    tags.name ||
    tags.brand ||
    tags.operator ||
    (kind === "fuel" ? "Fuel station" : "Campsite");
  const brand =
    kind === "fuel" ? tags.brand || tags.operator || undefined : undefined;
  const addrParts = [tags["addr:street"], tags["addr:city"]].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const addressLine = addrParts.length > 0 ? addrParts.join(", ") : undefined;
  return {
    id: `${el.type}/${el.id}`,
    kind,
    lat,
    lng,
    name,
    brand,
    addressLine,
  };
}

export async function searchPoisInBbox(
  kind: PoiKind,
  bbox: PoiBbox,
): Promise<Poi[]> {
  const data = await postOverpass(buildBboxQuery(kind, bbox));
  if (!data) return [];
  const out: Poi[] = [];
  const seen = new Set<string>();
  for (const el of data.elements) {
    const p = elementToPoi(el, kind);
    if (!p) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

const EARTH_RADIUS_M = 6_371_000;

function haversineMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const sLat = Math.sin(dLat / 2);
  const sLng = Math.sin(dLng / 2);
  const a =
    sLat * sLat +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * sLng * sLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distance from a point to the closest segment of a polyline (in metres).
 * Uses an equirectangular approximation around the test point — accurate
 * to <0.5% at the corridor distances we care about (<= 25km) and an
 * order of magnitude faster than per-segment haversine.
 */
export function distancePointToPolylineM(
  point: { lat: number; lng: number },
  polyline: Array<{ lat: number; lng: number }>,
): number {
  if (polyline.length === 0) return Infinity;
  if (polyline.length === 1) {
    return haversineMeters(point.lat, point.lng, polyline[0].lat, polyline[0].lng);
  }
  const lat0 = (point.lat * Math.PI) / 180;
  const cosLat0 = Math.cos(lat0);
  const toXY = (p: { lat: number; lng: number }) => ({
    x: ((p.lng - point.lng) * Math.PI / 180) * EARTH_RADIUS_M * cosLat0,
    y: ((p.lat - point.lat) * Math.PI / 180) * EARTH_RADIUS_M,
  });
  const P = { x: 0, y: 0 };
  let best = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const A = toXY(polyline[i]);
    const B = toXY(polyline[i + 1]);
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
      t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / lenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const cx = A.x + t * dx;
    const cy = A.y + t * dy;
    const ex = P.x - cx;
    const ey = P.y - cy;
    const d = Math.sqrt(ex * ex + ey * ey);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Find POIs near a route polyline. Concatenate every section polyline
 * the caller hands us into one big point list and search the padded
 * bbox; then filter to those within `corridorKm` of any segment.
 */
export async function searchPoisAlongRoute(
  kind: PoiKind,
  polyline: Array<{ lat: number; lng: number }>,
  corridorKm: number,
): Promise<Poi[]> {
  if (polyline.length < 2) return [];
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of polyline) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  const padDeg = corridorKm / 111; // ~111 km per degree
  const bbox: PoiBbox = {
    minLat: minLat - padDeg,
    maxLat: maxLat + padDeg,
    minLng: minLng - padDeg / Math.max(0.2, Math.cos((minLat * Math.PI) / 180)),
    maxLng: maxLng + padDeg / Math.max(0.2, Math.cos((maxLat * Math.PI) / 180)),
  };
  const candidates = await searchPoisInBbox(kind, bbox);
  const corridorM = corridorKm * 1000;
  return candidates.filter(
    (p) => distancePointToPolylineM({ lat: p.lat, lng: p.lng }, polyline) <= corridorM,
  );
}

/**
 * Convenience: build a single dense polyline from start/end + the road
 * legs of an assembled route's section list. Trail polylines and
 * waypoint hops are automatically incorporated by the caller via the
 * `polyline` parameter, but it's often handier to hand the planner
 * a quick start→end fallback when no route is assembled yet.
 */
export function pointsForCorridor(
  start: GeoPoint | null,
  end: GeoPoint | null,
  extras: Array<{ lat: number; lng: number }> = [],
): Array<{ lat: number; lng: number }> {
  const out: Array<{ lat: number; lng: number }> = [];
  if (start) out.push({ lat: start.lat, lng: start.lng });
  for (const e of extras) out.push(e);
  if (end) out.push({ lat: end.lat, lng: end.lng });
  return out;
}
