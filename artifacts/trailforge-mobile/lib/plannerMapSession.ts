/**
 * Orchestrates planner → map sessions: suggest trails, browse corridor, rebuild road route.
 */
import { router } from "expo-router";

import {
  fetchPublicRouteDetail,
  getPlannerSuggestions,
  searchTrailsByBbox,
  type MapTrail,
} from "@/lib/api";
import { formatSearchBbox, trailCentroid } from "@/lib/geo";
import {
  difficultyToCorridorKm,
  filterTrailsByGrades,
  orderTrailIdsAlongRoute,
  selectTrailsAlongCorridor,
  trailEntryPoint,
} from "@/lib/plannerCorridor";
import {
  fetchRoadRouteViaWaypoints,
  type NavLatLng,
} from "@/lib/navigationReroute";
import {
  getPlannerState,
  plannerActions,
  type LocationPoint,
} from "@/store/routePlannerStore";

export async function rebuildPlannerRoadRoute(): Promise<void> {
  const s = getPlannerState();
  if (!s.from || !s.to) return;

  plannerActions.setRebuildingRoute(true);
  try {
    const detailsMap = new Map(s.trailDetails.map((t) => [t.id, t]));
    const ordered = orderTrailIdsAlongRoute(
      s.from,
      s.to,
      s.activeTrailIds,
      detailsMap,
    );
    if (ordered.join(",") !== s.activeTrailIds.join(",")) {
      plannerActions.setActiveTrailIds(ordered);
    }

    const waypoints: NavLatLng[] = [
      { latitude: s.from.lat, longitude: s.from.lon },
    ];
    for (const id of ordered) {
      const trail = detailsMap.get(id);
      if (trail) {
        waypoints.push(trailEntryPoint(trail, s.from));
      }
    }
    waypoints.push({ latitude: s.to.lat, longitude: s.to.lon });

    const route = await fetchRoadRouteViaWaypoints(waypoints);
    if (route.ok) {
      plannerActions.setRoadRoute(route.polyline, Math.round((route.distanceM / 1000) * 10) / 10);
    } else {
      plannerActions.setRoadRoute(null, null);
    }
  } finally {
    plannerActions.setRebuildingRoute(false);
  }
}

export async function launchSuggestTrip(
  from: LocationPoint,
  to: LocationPoint,
  difficultyGrades: number[],
): Promise<void> {
  plannerActions.startMapPlanning({
    from,
    to,
    difficultyGrades,
    source: "suggest",
  });
  plannerActions.setCalculating(true);

  try {
    const corridorKm = difficultyToCorridorKm(difficultyGrades);
    const res = await getPlannerSuggestions({
      fromLat: from.lat,
      fromLon: from.lon,
      toLat: to.lat,
      toLon: to.lon,
      corridorKm,
      maxTrails: 8,
    });

    const ids = res.suggestions.map((s) => s.trailId).join(",");
    const details = ids
      ? await searchTrailsByBbox({ ids, limit: 50 })
      : { trails: [] as MapTrail[] };

    let trails = filterTrailsByGrades(details.trails ?? [], difficultyGrades);

    if (trails.length === 0) {
      const latPad = corridorKm / 111.32;
      const meanLat = (from.lat + to.lat) / 2;
      const lngPad = corridorKm / Math.max(0.01, 111.32 * Math.cos((meanLat * Math.PI) / 180));
      const minLat = Math.min(from.lat, to.lat) - latPad;
      const maxLat = Math.max(from.lat, to.lat) + latPad;
      const minLng = Math.min(from.lon, to.lon) - lngPad;
      const maxLng = Math.max(from.lon, to.lon) + lngPad;
      const bbox = formatSearchBbox(minLat, minLng, maxLat, maxLng);
      const bboxRes = await searchTrailsByBbox({ bbox, limit: 200 });
      trails = filterTrailsByGrades(bboxRes.trails ?? [], difficultyGrades);
    }

    const apiOrder = res.suggestions
      .map((s) => s.trailId)
      .filter((id) => trails.some((t) => t.id === id));

    const picked =
      apiOrder.length > 0
        ? apiOrder
        : selectTrailsAlongCorridor(from, to, trails, {
            corridorKm,
            maxTrails: 8,
          }).map((t) => t.id);

    const pickedTrails = trails.filter((t) => picked.includes(t.id));
    plannerActions.setMapTrails(picked, picked, pickedTrails);
    await rebuildPlannerRoadRoute();
    router.push("/(tabs)/map");
  } catch (e) {
    plannerActions.setCalculating(false);
    throw e;
  }
}

export async function launchFindTrailsOnMap(
  from: LocationPoint,
  to: LocationPoint,
  difficultyGrades: number[],
): Promise<void> {
  plannerActions.startMapPlanning({
    from,
    to,
    difficultyGrades,
    source: "browse",
  });
  plannerActions.setMapTrails([], [], []);
  await rebuildPlannerRoadRoute();
  router.push("/(tabs)/map");
}

export async function toggleTrailOnRoute(trail: MapTrail): Promise<void> {
  const s = getPlannerState();
  if (s.mapMode !== "planning" || !s.from || !s.to) return;

  plannerActions.mergeTrailDetails([trail]);

  const isActive = s.activeTrailIds.includes(trail.id);
  let nextIds: string[];

  if (isActive) {
    nextIds = s.activeTrailIds.filter((id) => id !== trail.id);
  } else {
    nextIds = [...s.activeTrailIds, trail.id];
  }

  const detailsMap = new Map(getPlannerState().trailDetails.map((t) => [t.id, t]));
  detailsMap.set(trail.id, trail);
  nextIds = orderTrailIdsAlongRoute(s.from, s.to, nextIds, detailsMap);

  plannerActions.mergeTrailDetails([trail]);
  plannerActions.setActiveTrailIds(nextIds);
  await rebuildPlannerRoadRoute();
}

export function activeTrailsFromStore(): MapTrail[] {
  const s = getPlannerState();
  const map = new Map(s.trailDetails.map((t) => [t.id, t]));
  return s.activeTrailIds.map((id) => map.get(id)).filter(Boolean) as MapTrail[];
}

function orderTrailsByIds(trails: MapTrail[], ids: string[]): MapTrail[] {
  const map = new Map(trails.map((t) => [t.id, t]));
  const ordered: MapTrail[] = [];
  for (const id of ids) {
    const t = map.get(id);
    if (t) ordered.push(t);
  }
  return ordered.length > 0 ? ordered : trails;
}

/** Open a saved route draft on the map tab for viewing or editing. */
export async function launchSavedRouteOnMap(routeId: string): Promise<void> {
  const detail = await fetchPublicRouteDetail(routeId);
  const idsCsv = detail.trailIds.join(",");
  let trails = detail.trails ?? [];
  if (idsCsv && trails.length < detail.trailIds.length) {
    const res = await searchTrailsByBbox({ ids: idsCsv, limit: 200 });
    trails = orderTrailsByIds(res.trails ?? [], detail.trailIds);
  } else if (detail.trailIds.length) {
    trails = orderTrailsByIds(trails, detail.trailIds);
  }

  if (trails.length === 0) {
    throw new Error("This route has no trails to show on the map.");
  }

  const fromWp = detail.waypoints?.find((w) => w.id === "from");
  const toWp = detail.waypoints?.find((w) => w.id === "to");
  const firstCentroid = trailCentroid(trails[0]);
  const lastCentroid = trailCentroid(trails[trails.length - 1]);

  const from =
    fromWp?.lat != null && fromWp?.lon != null
      ? { lat: fromWp.lat, lon: fromWp.lon, address: fromWp.label ?? detail.name }
      : firstCentroid
        ? { lat: firstCentroid.latitude, lon: firstCentroid.longitude, address: detail.name }
        : null;
  const to =
    toWp?.lat != null && toWp?.lon != null
      ? { lat: toWp.lat, lon: toWp.lon, address: toWp.label ?? "Route end" }
      : lastCentroid
        ? { lat: lastCentroid.latitude, lon: lastCentroid.longitude, address: "Route end" }
        : null;

  if (!from || !to) {
    throw new Error("Could not place this route on the map.");
  }
  const activeIds = detail.trailIds.filter((id) => trails.some((t) => t.id === id));

  plannerActions.startMapPlanning({
    from,
    to,
    difficultyGrades: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    source: "browse",
  });
  plannerActions.setSavedRouteName(detail.name);
  plannerActions.setMapTrails(activeIds, [], trails);
  plannerActions.setCalculating(false);
  await rebuildPlannerRoadRoute();
  if (getPlannerState().routeReady) {
    plannerActions.requestOpenRouteActions();
  }
  router.push("/(tabs)/map");
}
