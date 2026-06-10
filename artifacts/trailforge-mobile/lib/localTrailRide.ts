/**
 * Local / exploratory rides — no destination, trails ordered from GPS.
 */
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import type { MapTrail } from "@/lib/api";
import { setActiveNavRoute } from "@/lib/activeNavRoute";
import { trailMapCoordinates } from "@/lib/geo";
import {
  orderTrailIdsFromLocation,
  orientTrailPathToward,
  trailEntryPoint,
} from "@/lib/plannerCorridor";
import { fetchRoadRouteViaWaypoints } from "@/lib/navigationReroute";
import { navRouteCacheKey } from "@/lib/offlineNavRoute";
import type { NavRouteInput } from "@/lib/navigation";
import type { NavLatLng } from "@/lib/navigationReroute";
import type { NavTrailInput } from "@/lib/navigation";
import { getOfflineTrail } from "@/lib/offlineStore";
import {
  getPlannerState,
  plannerActions,
  type LocationPoint,
} from "@/store/routePlannerStore";

export function localRideTrailsFromStore(): MapTrail[] {
  const s = getPlannerState();
  const map = new Map(s.trailDetails.map((t) => [t.id, t]));
  return s.activeTrailIds.map((id) => map.get(id)).filter(Boolean) as MapTrail[];
}

export function launchLocalRideOnMap(): void {
  plannerActions.startLocalRide();
  router.push("/(tabs)/map");
}

export function toggleLocalRideTrail(trail: MapTrail): void {
  const s = getPlannerState();
  if (s.mapMode !== "localRide") return;

  plannerActions.mergeTrailDetails([trail]);
  const isActive = s.activeTrailIds.includes(trail.id);
  const nextIds = isActive
    ? s.activeTrailIds.filter((id) => id !== trail.id)
    : [...s.activeTrailIds, trail.id];

  plannerActions.setActiveTrailIds(nextIds);
  void Haptics.selectionAsync();
}

export function addLocalRideTrail(trail: MapTrail): void {
  const s = getPlannerState();
  if (s.mapMode !== "localRide") return;
  plannerActions.mergeTrailDetails([trail]);
  if (s.activeTrailIds.includes(trail.id)) return;
  plannerActions.setActiveTrailIds([...s.activeTrailIds, trail.id]);
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

export function removeLocalRideTrail(trailId: string): void {
  const s = getPlannerState();
  if (s.mapMode !== "localRide") return;
  plannerActions.setActiveTrailIds(s.activeTrailIds.filter((id) => id !== trailId));
  void Haptics.selectionAsync();
}

export function autoOrderLocalRideTrails(userPos: LocationPoint): void {
  const s = getPlannerState();
  if (s.mapMode !== "localRide" || s.activeTrailIds.length <= 1) return;
  const detailsMap = new Map(s.trailDetails.map((t) => [t.id, t]));
  const ordered = orderTrailIdsFromLocation(userPos, s.activeTrailIds, detailsMap);
  plannerActions.setActiveTrailIds(ordered);
}

/** Preview road links between selected trails (and loop return). */
export async function rebuildLocalRidePreviewRoute(
  userPos: LocationPoint,
): Promise<void> {
  const s = getPlannerState();
  if (s.mapMode !== "localRide" || s.activeTrailIds.length === 0) {
    plannerActions.setRoadRoute(null, null);
    return;
  }

  plannerActions.setRebuildingRoute(true);
  try {
    const trails = localRideTrailsFromStore();
    const loop = s.localRideLoop;
    const waypoints: NavLatLng[] = [
      { latitude: userPos.lat, longitude: userPos.lon },
    ];
    let prev: LocationPoint = userPos;

    for (let i = 0; i < trails.length; i++) {
      const t = trails[i];
      const pts = trailMapCoordinates(t);
      const nextTrail = trails[i + 1];
      let towardPoint: LocationPoint = prev;
      if (nextTrail) {
        const nextPts = trailMapCoordinates(nextTrail);
        const mid = nextPts[Math.floor(nextPts.length / 2)] ?? nextPts[0];
        if (mid) {
          towardPoint = { lat: mid.latitude, lon: mid.longitude, address: "" };
        }
      } else if (loop) {
        towardPoint = userPos;
      } else if (pts.length > 0) {
        const last = pts[pts.length - 1];
        towardPoint = { lat: last.latitude, lon: last.longitude, address: "" };
      }

      waypoints.push(trailEntryPoint(t, prev, towardPoint));
      const oriented = orientTrailPathToward(pts, prev, towardPoint);
      const exit = oriented.at(-1);
      if (exit) {
        prev = { lat: exit.latitude, lon: exit.longitude, address: "" };
      }
    }

    waypoints.push(
      loop
        ? { latitude: userPos.lat, longitude: userPos.lon }
        : { latitude: prev.lat, longitude: prev.lon },
    );

    const route = await fetchRoadRouteViaWaypoints(waypoints);
    if (route.ok) {
      plannerActions.setRoadRoute(
        route.polyline,
        Math.round((route.distanceM / 1000) * 10) / 10,
      );
    } else {
      plannerActions.setRoadRoute(null, null);
    }
  } finally {
    plannerActions.setRebuildingRoute(false);
  }
}

async function enrichTrailFromOffline(trail: MapTrail): Promise<MapTrail> {
  const offline = await getOfflineTrail(trail.id);
  if (!offline?.path?.length) return trail;
  return {
    ...trail,
    path: offline.path,
    name: trail.name || offline.name,
    difficulty: trail.difficulty ?? offline.difficulty,
    distance_km: trail.distance_km ?? offline.distance_km,
  };
}

function prepareLocalTrailsForNavigation(
  start: LocationPoint,
  trails: MapTrail[],
  loop: boolean,
): { navTrails: NavTrailInput[]; end: NavLatLng } {
  let current: LocationPoint = start;
  const navTrails: NavTrailInput[] = [];
  let end: NavLatLng = { latitude: start.lat, longitude: start.lon };

  for (let i = 0; i < trails.length; i++) {
    const t = trails[i];
    const pts = trailMapCoordinates(t);
    const nextTrail = trails[i + 1];
    let towardPoint: LocationPoint = current;
    if (nextTrail) {
      const nextPts = trailMapCoordinates(nextTrail);
      const mid = nextPts[Math.floor(nextPts.length / 2)] ?? nextPts[0];
      if (mid) {
        towardPoint = { lat: mid.latitude, lon: mid.longitude, address: "" };
      }
    } else if (loop) {
      towardPoint = start;
    } else if (pts.length > 0) {
      const last = pts[pts.length - 1];
      towardPoint = { lat: last.latitude, lon: last.longitude, address: "" };
    }
    const oriented = orientTrailPathToward(pts, current, towardPoint);
    if (oriented.length >= 2) {
      end = oriented[oriented.length - 1];
      current = { lat: end.latitude, lon: end.longitude, address: "" };
    }
    navTrails.push({
      id: t.id,
      name: t.name,
      difficulty: t.difficulty,
      distance_km: t.distance_km ?? null,
      path: t.path,
      path_geojson: t.path_geojson,
      simplified_path: t.simplified_path,
      pathOverride: oriented.length >= 2 ? oriented : undefined,
    });
  }

  return { navTrails, end };
}

/** Build nav input for offline pack or preview (respects manual order + loop). */
export async function buildLocalRideNavInput(
  userPos: LocationPoint,
): Promise<NavRouteInput> {
  const s = getPlannerState();
  const trails = localRideTrailsFromStore();
  if (trails.length === 0) {
    throw new Error("Select at least one trail to ride.");
  }

  const enriched = await Promise.all(trails.map(enrichTrailFromOffline));
  const loop = s.localRideLoop;
  const { navTrails, end } = prepareLocalTrailsForNavigation(userPos, enriched, loop);
  const trailIds = enriched.map((t) => t.id);

  return {
    from: {
      latitude: userPos.lat,
      longitude: userPos.lon,
      label: userPos.address || "You",
    },
    to: loop
      ? {
          latitude: userPos.lat,
          longitude: userPos.lon,
          label: "Start (loop)",
        }
      : {
          latitude: end.latitude,
          longitude: end.longitude,
          label: "End of ride",
        },
    trails: navTrails,
    localRide: true,
    localRideLoop: loop,
    cacheKey: navRouteCacheKey(trailIds, { loop }),
  };
}

/** Start navigation for a local ride from current GPS. */
export async function startLocalRideNavigation(
  userPos: LocationPoint,
): Promise<void> {
  const input = await buildLocalRideNavInput(userPos);
  setActiveNavRoute(input);
  router.push("/navigate");
}

/** Single trail from detail — navigate from current location. */
export async function startSingleTrailNavigation(
  trail: MapTrail,
  userPos: LocationPoint,
): Promise<void> {
  const enriched = await enrichTrailFromOffline(trail);
  const { navTrails, end } = prepareLocalTrailsForNavigation(userPos, [enriched], false);

  setActiveNavRoute({
    from: {
      latitude: userPos.lat,
      longitude: userPos.lon,
      label: userPos.address || "You",
    },
    to: {
      latitude: end.latitude,
      longitude: end.longitude,
      label: "End of trail",
    },
    trails: navTrails,
    localRide: true,
    cacheKey: navRouteCacheKey([trail.id]),
  });

  router.push("/navigate");
}
