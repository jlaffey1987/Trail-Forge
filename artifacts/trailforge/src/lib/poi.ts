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
  /**
   * Distance from the planned route polyline (metres). Only set when
   * the POI was returned from a corridor search; used in popups so the
   * rider can see "0.4 km from your route" before adding the stop.
   */
  routeDistanceM?: number;
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
/** Per-request network ceiling. Slightly above OVERPASS_TIMEOUT_S to give
 * the server's own timeout a chance to respond cleanly first. */
const OVERPASS_NETWORK_TIMEOUT_MS = 30_000;
/** Honour Overpass usage policy by spacing client requests. */
const OVERPASS_MIN_INTERVAL_MS = 2000;
/** Cache POI lookups so a rider toggling Fuel → Campsites → Fuel doesn't
 * re-hit Overpass each time, and so flipping panels keeps results warm. */
const POI_CACHE_TTL_MS = 5 * 60_000;
const POI_CACHE_MAX = 40;

export interface PoiBbox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/**
 * Tagged result from the Overpass-backed POI helpers. Lets callers
 * distinguish a genuinely empty area ("no fuel stations within these
 * bounds") from a service outage so the planner can show a retry
 * affordance instead of a misleading empty map.
 */
export type PoiSearchResult =
  | { status: "ok"; pois: Poi[] }
  | { status: "error"; error: string };

const poiCache = new Map<
  string,
  { at: number; result: PoiSearchResult }
>();
let lastOverpassAt = 0;
const inflightPoi = new Map<string, Promise<PoiSearchResult>>();

function rememberPoi(key: string, result: PoiSearchResult): void {
  if (result.status !== "ok") return;
  poiCache.set(key, { at: Date.now(), result });
  if (poiCache.size > POI_CACHE_MAX) {
    const firstKey = poiCache.keys().next().value;
    if (firstKey !== undefined) poiCache.delete(firstKey);
  }
}

function recallPoi(key: string): PoiSearchResult | null {
  const hit = poiCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > POI_CACHE_TTL_MS) {
    poiCache.delete(key);
    return null;
  }
  return hit.result;
}

// Serialized throttle: chain every caller onto a single promise so that
// concurrent invocations are guaranteed to be spaced by at least
// `OVERPASS_MIN_INTERVAL_MS`. Without serialization, two concurrent
// callers (e.g. fuel + campsite buttons tapped quickly) could both pass
// the elapsed check together and fire side-by-side.
let throttleOverpassChain: Promise<void> = Promise.resolve();
function throttleOverpass(): Promise<void> {
  const next = throttleOverpassChain.then(async () => {
    const elapsed = Date.now() - lastOverpassAt;
    if (elapsed < OVERPASS_MIN_INTERVAL_MS) {
      await new Promise((r) =>
        setTimeout(r, OVERPASS_MIN_INTERVAL_MS - elapsed),
      );
    }
    lastOverpassAt = Date.now();
  });
  // See routing.ts/throttleNominatim — swallow chain-level rejections so
  // a single bad caller can't permanently break throttling for everyone
  // queued behind it.
  throttleOverpassChain = next.catch(() => undefined);
  return next;
}

function tagSelector(kind: PoiKind): string {
  if (kind === "fuel") return 'amenity=fuel';
  return 'tourism=camp_site';
}

/** Round bbox coordinates to ~3 decimal places (~110m) for cache keying.
 * Riders panning the map by a few pixels shouldn't bust the cache. */
function bboxCacheKey(kind: PoiKind, bbox: PoiBbox): string {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return `bbox:${kind}:${r(bbox.minLat)},${r(bbox.minLng)},${r(bbox.maxLat)},${r(bbox.maxLng)}`;
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

async function postOverpass(
  query: string,
): Promise<{ ok: true; data: OverpassResponse } | { ok: false; error: string }> {
  let lastError = "Couldn't reach Overpass";
  for (const url of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      OVERPASS_NETWORK_TIMEOUT_MS,
    );
    try {
      await throttleOverpass();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      if (!res.ok) {
        // 429 / 504 are common Overpass rate-limit / overload responses;
        // try the next mirror but remember the most recent reason for the
        // caller-facing error message if every mirror fails.
        lastError =
          res.status === 429
            ? "Overpass is rate-limiting our requests"
            : `Overpass returned ${res.status}`;
        continue;
      }
      const data = (await res.json()) as OverpassResponse;
      return { ok: true, data };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        lastError = "Overpass request timed out";
      } else if (err instanceof Error) {
        lastError = err.message;
      }
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError };
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

/**
 * Run a bbox POI search, returning a tagged result. Successful lookups
 * (including genuinely-empty ones) are cached for `POI_CACHE_TTL_MS`,
 * keyed by kind + rounded bbox so a small map nudge doesn't bust it.
 * Concurrent identical lookups are deduped via a single-flight map.
 */
export async function searchPoisInBbox(
  kind: PoiKind,
  bbox: PoiBbox,
): Promise<PoiSearchResult> {
  const key = bboxCacheKey(kind, bbox);
  const cached = recallPoi(key);
  if (cached) return cached;

  const existing = inflightPoi.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<PoiSearchResult> => {
    const res = await postOverpass(buildBboxQuery(kind, bbox));
    if (!res.ok) return { status: "error", error: res.error };
    const out: Poi[] = [];
    const seen = new Set<string>();
    for (const el of res.data.elements) {
      const p = elementToPoi(el, kind);
      if (!p) continue;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
    const result: PoiSearchResult = { status: "ok", pois: out };
    rememberPoi(key, result);
    return result;
  })();

  inflightPoi.set(key, promise);
  try {
    return await promise;
  } finally {
    inflightPoi.delete(key);
  }
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
 *
 * Returns the same tagged shape as `searchPoisInBbox` so a service
 * outage propagates through the corridor filter unchanged and the
 * caller can show a retry hint instead of a silent empty list.
 */
export async function searchPoisAlongRoute(
  kind: PoiKind,
  polyline: Array<{ lat: number; lng: number }>,
  corridorKm: number,
): Promise<PoiSearchResult> {
  if (polyline.length < 2) return { status: "ok", pois: [] };
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
  const res = await searchPoisInBbox(kind, bbox);
  if (res.status !== "ok") return res;
  const corridorM = corridorKm * 1000;
  const out: Poi[] = [];
  for (const p of res.pois) {
    const d = distancePointToPolylineM(
      { lat: p.lat, lng: p.lng },
      polyline,
    );
    if (d <= corridorM) {
      // Stamp the distance so the planner UI can show "0.4 km from
      // route" in the marker popup. Sorting by it puts the most
      // route-relevant POIs near the top of any list view.
      out.push({ ...p, routeDistanceM: d });
    }
  }
  out.sort(
    (a, b) => (a.routeDistanceM ?? Infinity) - (b.routeDistanceM ?? Infinity),
  );
  return { status: "ok", pois: out };
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
