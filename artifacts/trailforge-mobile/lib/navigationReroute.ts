/**
 * Off-route detection and road rerouting for TrailForge mobile navigation.
 *
 * Ported from artifacts/trailforge/src/lib/navigationReroute.ts, adapted to:
 *   - Use { latitude, longitude } instead of { lat, lng } (react-native-maps)
 *   - Call OSRM directly via fetch (no web routing.ts dependency)
 *   - Return simplified polyline rather than a full AssembledRoute
 *
 * Off-route logic mirrors the web: only auto-reroute on road sections; trail
 * deviations are flagged but not rerouted because off-road paths often diverge
 * from the stored polyline (GPS noise, multiple lines).
 */

export const OFF_ROUTE_THRESHOLD_M = 50;
export const REROUTE_COOLDOWN_MS = 10_000;
export const MAX_CONSECUTIVE_FAILURES = 3;

// OSRM public demo server — suitable for development / low-volume use.
const OSRM_BASE = "https://router.project-osrm.org";

import { haversineLatLng as haversineM } from "./geo";
export { haversineLatLng as haversineM, bearingDeg } from "./geo";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NavLatLng {
  latitude: number;
  longitude: number;
}

export type NavSectionKind = "road" | "trail";

export interface RerouteState {
  lastAttemptAt: number;
  consecutiveFailures: number;
  givenUp: boolean;
  status: "idle" | "recalculating" | "rerouted" | "failed" | "given-up";
}

export function initialRerouteState(): RerouteState {
  return {
    lastAttemptAt: 0,
    consecutiveFailures: 0,
    givenUp: false,
    status: "idle",
  };
}

// haversineM and bearingDeg are re-exported from lib/geo.ts above.

/**
 * Closest point on line segment [A, B] to point P.
 * Returns distance in metres.
 */
function distToSegmentM(p: NavLatLng, a: NavLatLng, b: NavLatLng): number {
  const ax = a.longitude, ay = a.latitude;
  const bx = b.longitude, by = b.latitude;
  const px = p.longitude, py = p.latitude;

  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const t = abx !== 0 || aby !== 0 ? (apx * abx + apy * aby) / (abx * abx + aby * aby) : 0;
  const tc = Math.max(0, Math.min(1, t));
  const cx = ax + tc * abx;
  const cy = ay + tc * aby;
  return haversineM(p, { latitude: cy, longitude: cx });
}

// ---------------------------------------------------------------------------
// Off-route detection
// ---------------------------------------------------------------------------

export interface OffRouteResult {
  offRoute: boolean;
  distanceM: number;
  nearestSectionKind: NavSectionKind | null;
  nearestSectionIdx: number;
}

export interface NavSection {
  kind: NavSectionKind;
  id: string;
  path: NavLatLng[];
}

export function isOffRoute(
  userPos: NavLatLng,
  sections: NavSection[],
): OffRouteResult {
  let bestDist = Infinity;
  let bestSectionIdx = -1;
  let bestSectionKind: NavSectionKind | null = null;

  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    const stride = Math.max(1, Math.floor(sec.path.length / 40));
    for (let i = 0; i < sec.path.length - 1; i += stride) {
      const d = distToSegmentM(userPos, sec.path[i], sec.path[i + 1]);
      if (d < bestDist) {
        bestDist = d;
        bestSectionIdx = si;
        bestSectionKind = sec.kind;
      }
    }
  }

  return {
    offRoute: bestDist > OFF_ROUTE_THRESHOLD_M,
    distanceM: bestDist,
    nearestSectionKind: bestSectionKind,
    nearestSectionIdx: bestSectionIdx,
  };
}

// ---------------------------------------------------------------------------
// Reroute state management
// ---------------------------------------------------------------------------

export function canAttemptReroute(state: RerouteState, nowMs: number): boolean {
  if (state.givenUp) return false;
  if (state.status === "recalculating") return false;
  return nowMs - state.lastAttemptAt >= REROUTE_COOLDOWN_MS;
}

export function shouldAutoReroute(result: OffRouteResult): boolean {
  if (!result.offRoute) return false;
  // Do NOT auto-reroute when the nearest section is a trail — the user may
  // simply be on a slightly different line.
  return result.nearestSectionKind === "road";
}

export function updateRerouteStateOnAttempt(
  state: RerouteState,
  nowMs: number,
): RerouteState {
  return { ...state, lastAttemptAt: nowMs, status: "recalculating" };
}

export function updateRerouteStateOnSuccess(state: RerouteState): RerouteState {
  return { ...state, consecutiveFailures: 0, givenUp: false, status: "rerouted" };
}

export function updateRerouteStateOnFailure(state: RerouteState): RerouteState {
  const failures = state.consecutiveFailures + 1;
  const givenUp = failures >= MAX_CONSECUTIVE_FAILURES;
  return { ...state, consecutiveFailures: failures, givenUp, status: givenUp ? "given-up" : "failed" };
}

export function resetRerouteState(): RerouteState {
  return initialRerouteState();
}

// ---------------------------------------------------------------------------
// OSRM road routing
// ---------------------------------------------------------------------------

export interface RoadRouteResult {
  ok: true;
  polyline: NavLatLng[];
  distanceM: number;
  durationS: number;
}

export interface RoadRouteError {
  ok: false;
  error: string;
}

export type RoadRouteResponse = RoadRouteResult | RoadRouteError;

export async function fetchRoadRoute(
  from: NavLatLng,
  to: NavLatLng,
  signal?: AbortSignal,
): Promise<RoadRouteResponse> {
  return fetchRoadRouteViaWaypoints([from, to], signal);
}

export async function fetchRoadRouteViaWaypoints(
  points: NavLatLng[],
  signal?: AbortSignal,
): Promise<RoadRouteResponse> {
  if (points.length < 2) {
    return { ok: false, error: "Need at least two points" };
  }
  const coords = points.map((p) => `${p.longitude},${p.latitude}`).join(";");
  const url = `${OSRM_BASE}/route/v1/driving/${coords}?overview=full&geometries=geojson`;

  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const json = (await res.json()) as {
      code: string;
      routes?: Array<{
        geometry: { coordinates: [number, number][] };
        distance: number;
        duration: number;
      }>;
    };
    if (json.code !== "Ok" || !json.routes?.[0]) {
      return { ok: false, error: "No road route found" };
    }
    const r = json.routes[0];
    return {
      ok: true,
      polyline: r.geometry.coordinates.map(([lon, lat]) => ({ latitude: lat, longitude: lon })),
      distanceM: r.distance,
      durationS: r.duration,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "Aborted" };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "OSRM request failed",
    };
  }
}
