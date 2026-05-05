import { fetchTrailGpxByIds, type Trail } from "@/lib/supabase";
import { getTrailLatLngs } from "@/lib/trailLayer";

export interface GeoPoint {
  lat: number;
  lng: number;
  label?: string;
}

/**
 * A user-selected stop along the planned route. Distinct from trails — these
 * are arbitrary lat/lng pins (fuel stations, campsites, custom drops) the
 * rider wants to pass through. Persisted server-side so they sync across
 * devices alongside the trail order.
 */
export interface RouteWaypoint {
  id: string;
  lat: number;
  lng: number;
  name: string;
  /**
   * Where the waypoint came from. Drives the marker icon in PlannerMap and
   * NavigationView. `custom` is reserved for any future "drop pin here" UX.
   */
  kind: "fuel" | "campsite" | "custom";
  /** Optional OpenStreetMap node/way id, e.g. `node/1234`. Lets us de-dupe. */
  osmId?: string;
}

/**
 * Esri reference overlay tiles — labels (place names, road names, country
 * boundaries) painted on top of any base layer. Combined with the
 * `World_Imagery` satellite base it gives a "Google Maps Hybrid"-style view
 * so riders can see town names while planning a satellite route.
 *
 * `pane` is set to `"shadowPane"` so it draws above polylines but below
 * markers — labels stay legible without obscuring the start/end pins.
 */
export const HYBRID_LABEL_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
export const HYBRID_LABEL_TILE_ATTRIBUTION =
  "Labels © Esri";

export interface TurnStep {
  instruction: string;
  maneuver: string;
  modifier?: string;
  distanceM: number;
  durationS: number;
  streetName?: string;
  location: GeoPoint;
}

export interface RoadRoute {
  polyline: GeoPoint[];
  distanceKm: number;
  durationMin: number;
  steps: TurnStep[];
}

export type RouteSection =
  | { kind: "road"; index: number; from: GeoPoint; to: GeoPoint; route: RoadRoute; label: string }
  | { kind: "trail"; index: number; trail: Trail; polyline: GeoPoint[]; distanceKm: number; entry: GeoPoint; exit: GeoPoint }
  | { kind: "waypoint"; index: number; waypoint: RouteWaypoint; point: GeoPoint };

export interface AssembledRoute {
  start: GeoPoint;
  end: GeoPoint | null;
  sections: RouteSection[];
  totalDistanceKm: number;
  totalDurationMin: number;
  totalRoadKm: number;
  totalTrailKm: number;
  totalRoadDurationMin: number;
  totalTrailDurationMin: number;
  skippedTrails: string[]; // names of trails skipped due to missing GPX
  failedRoadSegments: number; // count of road segments that OSRM could not route
}

function capitalize(s: string) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatInstruction(type: string, modifier?: string, name?: string): string {
  const street = name && name.length > 0 ? ` onto ${name}` : "";
  const mod = modifier ? capitalize(modifier) : "";
  switch (type) {
    case "depart": return `Depart${street}`;
    case "arrive": return `Arrive at destination`;
    case "turn": return `Turn ${mod || ""}${street}`.trim().replace("  ", " ");
    case "merge": return `Merge ${mod || ""}${street}`.trim();
    case "on ramp": return `Take the ramp ${mod || ""}${street}`.trim();
    case "off ramp": return `Take the exit${street}`;
    case "fork": return `Keep ${mod || ""}${street}`.trim();
    case "end of road": return `Continue ${mod || ""}${street}`.trim();
    case "continue": return `Continue${street}`;
    case "roundabout": return `At the roundabout, take exit${street}`;
    case "rotary": return `Take the rotary${street}`;
    case "roundabout turn": return `At the roundabout turn ${mod || ""}${street}`.trim();
    case "exit roundabout": return `Exit roundabout${street}`;
    case "exit rotary": return `Exit rotary${street}`;
    case "use lane": return `Use lane${street}`;
    case "notification": return `Continue${street}`;
    default: return `${capitalize(type)}${street}`;
  }
}

export interface AddressSuggestion {
  /** Stable id from Nominatim (`place_id`) — used as React key. */
  id: string;
  /** Full display name from Nominatim, e.g. "9 High Street, Stranraer, …". */
  label: string;
  /** Short label (first 2-3 commas) for the summary line. */
  shortLabel: string;
  lat: number;
  lng: number;
}

/**
 * Tagged result from `searchSuggestions`. Callers can distinguish
 * "Nominatim returned nothing for this query" (`status: "ok"` with an
 * empty array) from "we couldn't reach Nominatim" (`status: "error"`)
 * so the UI can show a retry hint instead of a misleading empty list.
 */
export type SuggestionsResult =
  | { status: "ok"; suggestions: AddressSuggestion[] }
  | { status: "error"; error: string };

/**
 * Public Nominatim has a 1 request-per-second usage policy. We enforce a
 * client-side minimum spacing well above that to stay friendly.
 */
const NOMINATIM_MIN_INTERVAL_MS = 1100;
/** Hard ceiling so a hung request can't hold the dropdown spinner forever. */
const NOMINATIM_TIMEOUT_MS = 8000;
/** Cache successful suggestion lookups for a short window so repeat
 * queries (rider deletes a character then retypes it) don't re-hit
 * Nominatim. We cap the cache to keep memory bounded. */
const SUGGESTIONS_CACHE_TTL_MS = 60_000;
const SUGGESTIONS_CACHE_MAX = 100;

const suggestionsCache = new Map<
  string,
  { at: number; result: SuggestionsResult }
>();
let lastNominatimAt = 0;
/** Single-flight: if the same query is already in flight, share the
 * promise instead of issuing a parallel request. */
const inflightSuggestions = new Map<string, Promise<SuggestionsResult>>();

function rememberSuggestions(key: string, result: SuggestionsResult): void {
  if (result.status !== "ok") return;
  suggestionsCache.set(key, { at: Date.now(), result });
  if (suggestionsCache.size > SUGGESTIONS_CACHE_MAX) {
    // Evict the oldest entry by insertion order. Map iteration is
    // insertion-ordered so the first key is the oldest.
    const firstKey = suggestionsCache.keys().next().value;
    if (firstKey !== undefined) suggestionsCache.delete(firstKey);
  }
}

function recallSuggestions(key: string): SuggestionsResult | null {
  const hit = suggestionsCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SUGGESTIONS_CACHE_TTL_MS) {
    suggestionsCache.delete(key);
    return null;
  }
  return hit.result;
}

// Serialized throttle: chain every caller onto a single promise so that
// concurrent invocations are guaranteed to be spaced by at least
// `NOMINATIM_MIN_INTERVAL_MS`. A naive `lastAt + setTimeout` check would
// let two parallel callers (e.g. start- and end-address fields both
// looking up at the same time) pass the elapsed check together and
// fire at the same instant.
let throttleNominatimChain: Promise<void> = Promise.resolve();
function throttleNominatim(): Promise<void> {
  const next = throttleNominatimChain.then(async () => {
    const elapsed = Date.now() - lastNominatimAt;
    if (elapsed < NOMINATIM_MIN_INTERVAL_MS) {
      await new Promise((r) =>
        setTimeout(r, NOMINATIM_MIN_INTERVAL_MS - elapsed),
      );
    }
    lastNominatimAt = Date.now();
  });
  // Swallow rejections in the chain itself so one bad caller can't
  // permanently break throttling for everyone after it. The caller still
  // sees the original rejection via its own `await`.
  throttleNominatimChain = next.catch(() => undefined);
  return next;
}

/**
 * Great-circle distance in km between two lat/lng pairs. Used to sort
 * autocomplete suggestions by proximity to a hint location.
 */
function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Build a viewbox string for Nominatim's `viewbox` parameter — biases
 * results toward the supplied centre without restricting them when paired
 * with `bounded=0`. We use ~2° (≈ 220km N/S, less E/W as latitude grows)
 * which feels right for "places near me" while still surfacing the next
 * notable town if the rider is searching for somewhere just outside the
 * box.
 */
function buildViewbox(center: { lat: number; lng: number }): string {
  const span = 2;
  const lonMin = center.lng - span;
  const latMax = center.lat + span;
  const lonMax = center.lng + span;
  const latMin = center.lat - span;
  return `${lonMin},${latMax},${lonMax},${latMin}`;
}

/**
 * Round a coord to ~1km grid cells (0.01° ≈ 1.1km of latitude) so cached
 * results don't get reused for a rider who has moved meaningfully between
 * lookups but stay shared across GPS jitter on the same street.
 */
function roundForCacheKey(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Free-text address suggestions for the planner's start/end inputs. We hit
 * Nominatim's `/search` with either a viewbox proximity bias (when `near`
 * is supplied) or the default British Isles country bias, falling back to
 * a global query when nothing local matches. Capped at 5 results to keep
 * the dropdown tidy.
 *
 * Returns a tagged `SuggestionsResult`:
 *  - `status: "ok"` carries the (possibly empty) suggestion array. An
 *    empty array means Nominatim genuinely had no match for the query.
 *  - `status: "error"` means the request failed (network, timeout,
 *    rate-limit, 5xx). The UI should surface this to the rider with a
 *    retry affordance instead of an empty dropdown.
 *
 * Behaviour:
 *  - In-memory cache (60s, 100 entries) so repeated identical queries do
 *    not re-hit Nominatim — both faster for the rider and friendlier to
 *    the public service. The cache key includes a coarse-rounded `near`
 *    so a rider in Devon doesn't get cached London-area results.
 *  - Single-flight: identical concurrent queries share one promise.
 *  - Throttled to 1.1s between outbound requests to honour Nominatim's
 *    1 req/sec usage policy.
 *  - Per-request 8s timeout via `AbortController` — never leaves the
 *    dropdown spinning indefinitely on a flaky link.
 *  - When `near` is supplied, results are also sorted client-side by
 *    haversine distance so the closest place is always first regardless
 *    of Nominatim's internal ranking quirks.
 *
 * Callers MUST still pair this with a request-sequence guard so an
 * older still-pending request can't overwrite a newer one's results.
 */
export async function searchSuggestions(
  query: string,
  near?: { lat: number; lng: number } | null,
): Promise<SuggestionsResult> {
  const q = query.trim();
  if (q.length < 2) return { status: "ok", suggestions: [] };

  const proximity =
    near && Number.isFinite(near.lat) && Number.isFinite(near.lng)
      ? { lat: near.lat, lng: near.lng }
      : null;
  const cacheKey = proximity
    ? `${q}|${roundForCacheKey(proximity.lat)},${roundForCacheKey(proximity.lng)}`
    : q;

  const cached = recallSuggestions(cacheKey);
  if (cached) return cached;

  const existing = inflightSuggestions.get(cacheKey);
  if (existing) return existing;

  const promise = (async (): Promise<SuggestionsResult> => {
    const tryFetch = async (
      url: string,
    ): Promise<{ ok: true; rows: AddressSuggestion[] } | { ok: false; error: string }> => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        NOMINATIM_TIMEOUT_MS,
      );
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) {
          return {
            ok: false,
            error: `Nominatim returned ${res.status}`,
          };
        }
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data)) return { ok: true, rows: [] };
        const rows: AddressSuggestion[] = [];
        for (const row of data) {
          const lat = parseFloat(String(row.lat));
          const lng = parseFloat(String(row.lon));
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
          const label =
            typeof row.display_name === "string" ? row.display_name : "";
          if (!label) continue;
          const id =
            row.place_id != null
              ? String(row.place_id)
              : `${lat.toFixed(5)},${lng.toFixed(5)}`;
          const shortLabel = label.split(",").slice(0, 3).join(",").trim();
          rows.push({ id, label, shortLabel, lat, lng });
        }
        return { ok: true, rows };
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return { ok: false, error: "Nominatim request timed out" };
        }
        return {
          ok: false,
          error:
            err instanceof Error ? err.message : "Nominatim request failed",
        };
      } finally {
        clearTimeout(timer);
      }
    };

    const sortByProximity = (rows: AddressSuggestion[]): AddressSuggestion[] => {
      if (!proximity) return rows;
      return [...rows].sort(
        (a, b) =>
          haversineKm(proximity, { lat: a.lat, lng: a.lng }) -
          haversineKm(proximity, { lat: b.lat, lng: b.lng }),
      );
    };

    try {
      await throttleNominatim();
      // When we have a proximity hint, bias by viewbox (unbounded so we
      // can still surface places just outside it) and drop the country
      // restriction — the rider may be near a border. Otherwise fall
      // back to the existing British Isles bias.
      const localUrl = proximity
        ? `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&viewbox=${encodeURIComponent(buildViewbox(proximity))}&bounded=0&addressdetails=0`
        : `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&countrycodes=gb,ie&addressdetails=0`;
      const local = await tryFetch(localUrl);
      if (!local.ok) {
        return { status: "error", error: local.error };
      }
      if (local.rows.length > 0) {
        const result: SuggestionsResult = {
          status: "ok",
          suggestions: sortByProximity(local.rows),
        };
        rememberSuggestions(cacheKey, result);
        return result;
      }
      await throttleNominatim();
      const global = await tryFetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&addressdetails=0`,
      );
      if (!global.ok) {
        return { status: "error", error: global.error };
      }
      const result: SuggestionsResult = {
        status: "ok",
        suggestions: sortByProximity(global.rows),
      };
      rememberSuggestions(cacheKey, result);
      return result;
    } catch (err) {
      return {
        status: "error",
        error:
          err instanceof Error ? err.message : "Couldn't reach Nominatim",
      };
    }
  })();

  inflightSuggestions.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inflightSuggestions.delete(cacheKey);
  }
}

export async function geocode(query: string): Promise<GeoPoint | null> {
  const q = query.trim();
  if (!q) return null;
  const tryFetch = async (url: string) => {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
      label: data[0].display_name as string,
    } as GeoPoint;
  };
  try {
    // Bias to the British Isles (UK + Ireland) first; fall back to a
    // worldwide search if nothing matches there.
    const local = await tryFetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1&countrycodes=gb,ie`
    );
    if (local) return local;
    return await tryFetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`
    );
  } catch {
    return null;
  }
}

/**
 * Reverse geocode a lat/lng to a human-readable address via Nominatim.
 * Used by the planner's "Use my current location" button so the start
 * input shows a real place name instead of bare coordinates.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<GeoPoint | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Bail out after a short timeout so the planner's "Locating…" chip can
  // never hang indefinitely on a flaky network — we always resolve to at
  // worst the bare-coordinate label.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat.toFixed(
        6,
      )}&lon=${lng.toFixed(6)}&zoom=16&addressdetails=0`,
      { headers: { Accept: "application/json" }, signal: ctrl.signal },
    );
    if (!res.ok) {
      return { lat, lng, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
    }
    const data = await res.json();
    const label =
      typeof data?.display_name === "string" && data.display_name.length > 0
        ? (data.display_name as string)
        : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    return { lat, lng, label };
  } catch {
    return { lat, lng, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function getRoadRoute(coords: GeoPoint[]): Promise<RoadRoute | null> {
  if (coords.length < 2) return null;
  const coordStr = coords.map((c) => `${c.lng.toFixed(6)},${c.lat.toFixed(6)}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&steps=true&geometries=geojson`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.routes || data.routes.length === 0) return null;
    const route = data.routes[0];

    const polyline: GeoPoint[] = (route.geometry.coordinates as [number, number][]).map(
      ([lng, lat]) => ({ lat, lng })
    );

    const steps: TurnStep[] = [];
    for (const leg of route.legs) {
      for (const step of leg.steps) {
        const m = step.maneuver;
        const lng = m.location[0];
        const lat = m.location[1];
        steps.push({
          instruction: formatInstruction(m.type, m.modifier, step.name),
          maneuver: m.type,
          modifier: m.modifier,
          distanceM: step.distance,
          durationS: step.duration,
          streetName: step.name,
          location: { lat, lng },
        });
      }
    }

    return {
      polyline,
      distanceKm: route.distance / 1000,
      durationMin: route.duration / 60,
      steps,
    };
  } catch {
    return null;
  }
}

const TRAIL_SPEED_KMH = 25;

/**
 * One ordered stop in the planner. Either a trail (off-road segment with a
 * known polyline) or a custom waypoint (a fuel/campsite/custom pin the
 * rider wants to pass through).
 *
 * `entries` lets `assembleMultiModalRoute` weave waypoints into the same
 * road graph that connects the trails — a waypoint between two trails
 * becomes an extra road leg in the assembled section list.
 */
export type RouteEntry =
  | { kind: "trail"; trail: Trail }
  | { kind: "waypoint"; waypoint: RouteWaypoint };

export function orderTrailsNearestNeighbour(
  start: GeoPoint,
  trails: Trail[],
): Trail[] {
  if (trails.length <= 1) return trails;

  const withGeom: Trail[] = [];
  const withoutGeom: Trail[] = [];
  for (const t of trails) {
    const pts = getTrailLatLngs(t);
    if (pts.length >= 2) withGeom.push(t);
    else withoutGeom.push(t);
  }

  if (withGeom.length <= 1) return [...withGeom, ...withoutGeom];

  const remaining = [...withGeom];
  const ordered: Trail[] = [];
  let current = start;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    let bestReversed = false;

    for (let i = 0; i < remaining.length; i++) {
      const pts = getTrailLatLngs(remaining[i]);
      const entry: GeoPoint = { lat: pts[0][0], lng: pts[0][1] };
      const exit: GeoPoint = { lat: pts[pts.length - 1][0], lng: pts[pts.length - 1][1] };

      const dEntry = haversineM(current, entry);
      const dExit = haversineM(current, exit);
      const d = Math.min(dEntry, dExit);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
        bestReversed = dExit < dEntry;
      }
    }

    const picked = remaining.splice(bestIdx, 1)[0];
    ordered.push(picked);

    const pts = getTrailLatLngs(picked);
    if (bestReversed) {
      current = { lat: pts[0][0], lng: pts[0][1] };
    } else {
      current = { lat: pts[pts.length - 1][0], lng: pts[pts.length - 1][1] };
    }
  }

  return [...ordered, ...withoutGeom];
}

export async function assembleMultiModalRoute(
  start: GeoPoint,
  end: GeoPoint | null,
  trailsOrEntries: Trail[] | RouteEntry[],
  onProgress?: (step: number, total: number, label: string) => void,
): Promise<AssembledRoute> {
  // Backwards compatible: callers can pass a plain `Trail[]` (existing
  // PlannerTab behaviour). We normalize to entries internally.
  const entries: RouteEntry[] = Array.isArray(trailsOrEntries)
    ? (trailsOrEntries as ReadonlyArray<unknown>).map((item) => {
        if (item && typeof item === "object" && "kind" in (item as Record<string, unknown>)) {
          return item as RouteEntry;
        }
        return { kind: "trail", trail: item as Trail };
      })
    : [];

  const sections: RouteSection[] = [];
  let totalRoadKm = 0;
  let totalTrailKm = 0;
  let totalRoadDurationMin = 0;
  let totalTrailDurationMin = 0;
  const skippedTrails: string[] = [];
  let failedRoadSegments = 0;

  let currentPoint: GeoPoint = start;
  let currentLabel: string = start.label || "Start";
  let sectionIdx = 0;
  let trailCount = 0;

  const totalSteps = entries.length * 2 + (end ? 1 : 0);
  let stepNo = 0;

  // Trails coming from the slim Map-tab fetch don't carry `gpx_data`. We
  // need the full GPX here to build the trail polyline, so lazy-fetch it
  // for any trail that's missing it before we start assembling.
  const trailsNeedingHydration = entries
    .filter((e): e is Extract<RouteEntry, { kind: "trail" }> => e.kind === "trail")
    .map((e) => e.trail);
  const missingGpxIds = Array.from(
    new Set(trailsNeedingHydration.filter((t) => t.gpx_data == null).map((t) => t.id)),
  );
  let hydratedById = new Map<string, Trail>();
  if (missingGpxIds.length > 0) {
    onProgress?.(0, totalSteps, "Loading trail data");
    const gpxMap = await fetchTrailGpxByIds(missingGpxIds);
    for (const t of trailsNeedingHydration) {
      const g = gpxMap.get(t.id);
      hydratedById.set(t.id, g != null ? { ...t, gpx_data: g } : t);
    }
  }

  for (const entry of entries) {
    if (entry.kind === "waypoint") {
      const wpPoint: GeoPoint = {
        lat: entry.waypoint.lat,
        lng: entry.waypoint.lng,
        label: entry.waypoint.name,
      };

      stepNo++;
      onProgress?.(stepNo, totalSteps, `Routing roads to ${entry.waypoint.name}`);
      const roadRoute = await getRoadRoute([currentPoint, wpPoint]);
      if (roadRoute) {
        sections.push({
          kind: "road",
          index: sectionIdx++,
          from: currentPoint,
          to: wpPoint,
          route: roadRoute,
          label: `${currentLabel} → ${entry.waypoint.name}`,
        });
        totalRoadKm += roadRoute.distanceKm;
        totalRoadDurationMin += roadRoute.durationMin;
      } else {
        failedRoadSegments++;
      }

      stepNo++;
      onProgress?.(stepNo, totalSteps, `Adding stop ${entry.waypoint.name}`);
      sections.push({
        kind: "waypoint",
        index: sectionIdx++,
        waypoint: entry.waypoint,
        point: wpPoint,
      });
      currentPoint = wpPoint;
      currentLabel = entry.waypoint.name;
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }

    // Trail entry
    const trail = hydratedById.get(entry.trail.id) ?? entry.trail;
    const latlngs = getTrailLatLngs(trail);
    if (latlngs.length < 2) {
      skippedTrails.push(trail.name);
      stepNo += 2;
      continue;
    }
    trailCount++;

    const dToFirst = haversineM(currentPoint, { lat: latlngs[0][0], lng: latlngs[0][1] });
    const dToLast = haversineM(currentPoint, { lat: latlngs[latlngs.length - 1][0], lng: latlngs[latlngs.length - 1][1] });
    const useReversed = dToLast < dToFirst;
    const orientedPts = useReversed ? [...latlngs].reverse() : latlngs;

    const trailEntry: GeoPoint = { lat: orientedPts[0][0], lng: orientedPts[0][1] };
    const trailExit: GeoPoint = { lat: orientedPts[orientedPts.length - 1][0], lng: orientedPts[orientedPts.length - 1][1] };

    stepNo++;
    onProgress?.(stepNo, totalSteps, `Routing roads to ${trail.name}`);
    const roadRoute = await getRoadRoute([currentPoint, trailEntry]);
    if (roadRoute) {
      sections.push({
        kind: "road",
        index: sectionIdx++,
        from: currentPoint,
        to: trailEntry,
        route: roadRoute,
        label: `${currentLabel} → ${trail.name} entry`,
      });
      totalRoadKm += roadRoute.distanceKm;
      totalRoadDurationMin += roadRoute.durationMin;
    } else {
      failedRoadSegments++;
    }

    stepNo++;
    onProgress?.(stepNo, totalSteps, `Adding ${trail.name}`);
    const trailPolyline: GeoPoint[] = orientedPts.map(([lat, lng]) => ({ lat, lng }));
    const trailKm = trail.distance_km ?? 0;
    sections.push({
      kind: "trail",
      index: sectionIdx++,
      trail,
      polyline: trailPolyline,
      distanceKm: trailKm,
      entry: trailEntry,
      exit: trailExit,
    });
    totalTrailKm += trailKm;
    totalTrailDurationMin += (trailKm / TRAIL_SPEED_KMH) * 60;

    currentPoint = trailExit;
    currentLabel = `${trail.name} exit`;
    await new Promise((r) => setTimeout(r, 250));
  }

  if (end) {
    stepNo++;
    onProgress?.(stepNo, totalSteps, `Routing final road to ${end.label || "destination"}`);
    const finalRoute = await getRoadRoute([currentPoint, end]);
    if (finalRoute) {
      sections.push({
        kind: "road",
        index: sectionIdx++,
        from: currentPoint,
        to: end,
        route: finalRoute,
        label: `${currentLabel} → ${end.label || "Destination"}`,
      });
      totalRoadKm += finalRoute.distanceKm;
      totalRoadDurationMin += finalRoute.durationMin;
    } else {
      failedRoadSegments++;
    }
  }

  // Keep the unused trailCount lint-clean; it documents the parsed trail
  // count even though the value isn't surfaced in AssembledRoute today.
  void trailCount;

  return {
    start,
    end,
    sections,
    totalDistanceKm: totalRoadKm + totalTrailKm,
    totalDurationMin: totalRoadDurationMin + totalTrailDurationMin,
    totalRoadKm,
    totalTrailKm,
    totalRoadDurationMin,
    totalTrailDurationMin,
    skippedTrails,
    failedRoadSegments,
  };
}

export function formatDistance(m: number): string {
  if (m < 50) return `${Math.round(m)} m`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

export function formatDurationMin(min: number): string {
  if (min < 1) return "<1 min";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// Haversine distance in meters between two lat/lng points
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ---------------------------------------------------------------------------
// Corridor-based trail suggestions ("Suggest trails for this trip")
//
// Given a planned start (A) and end (B), pick a small, well-spaced set of
// trails that fall within a corridor around the great-circle line A→B.
// Used by the Planner's "Suggest trails for this trip" affordance — the
// rider supplies addresses + filters and we surface the most likely
// candidates without making them pan around the map.
//
// Geometry is done with an equirectangular projection centred on the
// mean latitude of A,B (km/° ≈ 111.32 for latitude, 111.32·cos(lat) for
// longitude). For UK/Ireland trips (max ~1000 km) this is accurate to
// well under our 15 km corridor half-width — the cross-track error from
// flat-Earth approximation at 55°N over a 1000 km baseline is < 1 km.
// ---------------------------------------------------------------------------

const KM_PER_DEG_LAT = 111.32;
/** Default half-width of the suggestion corridor, in km. */
export const SUGGEST_CORRIDOR_KM = 15;
/** Default cap on the number of trails returned by `selectTrailsAlongCorridor`. */
export const SUGGEST_MAX_TRAILS = 5;

export interface CorridorSelectionOptions {
  /** Half-width of the corridor (perpendicular distance) in km. Defaults to {@link SUGGEST_CORRIDOR_KM}. */
  corridorKm?: number;
  /** Maximum number of trails to return. Defaults to {@link SUGGEST_MAX_TRAILS}. */
  maxTrails?: number;
  /** Trail ids to skip (e.g. trails already manually added by the rider). */
  excludeIds?: ReadonlySet<string>;
}

function trailMidpoint(trail: Trail): GeoPoint | null {
  // Slim trails carry a bbox without needing GPX hydration — use that
  // to avoid forcing every candidate through `getTrailLatLngs` (which
  // can fall back to parsing GPX).
  const minLat = trail.bbox_min_lat;
  const maxLat = trail.bbox_max_lat;
  const minLng = trail.bbox_min_lng;
  const maxLng = trail.bbox_max_lng;
  if (
    minLat != null &&
    maxLat != null &&
    minLng != null &&
    maxLng != null &&
    Number.isFinite(minLat) &&
    Number.isFinite(maxLat) &&
    Number.isFinite(minLng) &&
    Number.isFinite(maxLng)
  ) {
    return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
  }
  const pts = getTrailLatLngs(trail);
  if (pts.length === 0) return null;
  const m = pts[Math.floor(pts.length / 2)];
  return { lat: m[0], lng: m[1] };
}

interface ScoredCandidate {
  trail: Trail;
  alongKm: number;
  perpendicularKm: number;
}

/**
 * Pick a spaced selection of trails that lie within `corridorKm` of the
 * great-circle line from `start` to `end`. Up to `maxTrails` are returned
 * in along-track order (start → end) so the planner list reads
 * geographically left-to-right.
 *
 * Algorithm:
 *  1. Project each trail's mid-point onto the A→B line in a local
 *     equirectangular frame; reject anything whose perpendicular distance
 *     exceeds `corridorKm`.
 *  2. Bucket survivors by along-track progress (`maxTrails` buckets).
 *  3. From each bucket pick the trail closest to the corridor centre.
 *  4. Backfill any unfilled slots from leftovers sorted by perpendicular
 *     distance — keeps the count up when riders' trips are short or the
 *     candidates cluster in a few hot-spots.
 */
export function selectTrailsAlongCorridor(
  start: GeoPoint,
  end: GeoPoint,
  trails: Trail[],
  opts: CorridorSelectionOptions = {},
): Trail[] {
  const corridorKm = Math.max(0, opts.corridorKm ?? SUGGEST_CORRIDOR_KM);
  const maxTrails = Math.max(0, Math.floor(opts.maxTrails ?? SUGGEST_MAX_TRAILS));
  const excludeIds = opts.excludeIds ?? new Set<string>();
  if (maxTrails === 0 || trails.length === 0) return [];

  const meanLat = ((start.lat + end.lat) / 2) * (Math.PI / 180);
  const kmPerDegLng = KM_PER_DEG_LAT * Math.cos(meanLat);
  const bx = (end.lng - start.lng) * kmPerDegLng;
  const by = (end.lat - start.lat) * KM_PER_DEG_LAT;
  const totalKm = Math.hypot(bx, by);

  const scored: ScoredCandidate[] = [];
  for (const t of trails) {
    if (excludeIds.has(t.id)) continue;
    const m = trailMidpoint(t);
    if (!m) continue;
    const px = (m.lng - start.lng) * kmPerDegLng;
    const py = (m.lat - start.lat) * KM_PER_DEG_LAT;
    let alongKm: number;
    let perpKm: number;
    if (totalKm < 0.01) {
      // Degenerate "trip" with start ≈ end — treat distance from start as
      // the perpendicular score so closeness to the pin still wins.
      alongKm = 0;
      perpKm = Math.hypot(px, py);
    } else {
      const t01 = (px * bx + py * by) / (totalKm * totalKm);
      const tc = Math.max(0, Math.min(1, t01));
      const cx = tc * bx;
      const cy = tc * by;
      perpKm = Math.hypot(px - cx, py - cy);
      alongKm = tc * totalKm;
    }
    if (perpKm > corridorKm) continue;
    scored.push({ trail: t, alongKm, perpendicularKm: perpKm });
  }

  if (scored.length === 0) return [];

  // Short trips (or maxTrails=1) — no point bucketing, just take the
  // closest-to-centreline candidates.
  if (totalKm < 1 || maxTrails === 1) {
    return [...scored]
      .sort((a, b) => a.perpendicularKm - b.perpendicularKm)
      .slice(0, maxTrails)
      .sort((a, b) => a.alongKm - b.alongKm)
      .map((s) => s.trail);
  }

  const buckets: ScoredCandidate[][] = Array.from({ length: maxTrails }, () => []);
  for (const s of scored) {
    const idx = Math.min(
      maxTrails - 1,
      Math.max(0, Math.floor((s.alongKm / totalKm) * maxTrails)),
    );
    buckets[idx].push(s);
  }

  const picked: ScoredCandidate[] = [];
  const pickedIds = new Set<string>();
  for (const b of buckets) {
    if (b.length === 0) continue;
    b.sort((x, y) => x.perpendicularKm - y.perpendicularKm);
    picked.push(b[0]);
    pickedIds.add(b[0].trail.id);
  }

  if (picked.length < maxTrails) {
    const leftovers = scored
      .filter((s) => !pickedIds.has(s.trail.id))
      .sort((a, b) => a.perpendicularKm - b.perpendicularKm);
    for (const s of leftovers) {
      if (picked.length >= maxTrails) break;
      picked.push(s);
      pickedIds.add(s.trail.id);
    }
  }

  picked.sort((a, b) => a.alongKm - b.alongKm);
  return picked.map((s) => s.trail);
}

export function maneuverArrow(type: string, modifier?: string): string {
  // Returns SVG path data for a maneuver arrow
  if (type === "depart") return "M12 2L12 22M5 9l7-7 7 7";
  if (type === "arrive") return "M5 12h14M12 5l7 7-7 7"; // checkered placeholder uses different render
  if (modifier?.includes("left") && modifier?.includes("sharp")) return "M14 4l-8 8 8 8M6 12h14";
  if (modifier?.includes("right") && modifier?.includes("sharp")) return "M10 4l8 8-8 8M18 12H4";
  if (modifier?.includes("left") && modifier?.includes("slight")) return "M5 17L17 5M9 5h8v8";
  if (modifier?.includes("right") && modifier?.includes("slight")) return "M19 17L7 5M15 5h-8v8";
  if (modifier === "left") return "M9 5l-7 7 7 7M2 12h20";
  if (modifier === "right") return "M15 5l7 7-7 7M22 12H2";
  if (modifier === "uturn") return "M3 10h11a4 4 0 0 1 4 4v2M3 10l4-4M3 10l4 4";
  if (type === "roundabout" || type === "rotary") return "M12 2a10 10 0 1 0 10 10";
  return "M5 12h14M12 5l-7 7 7 7"; // straight
}
