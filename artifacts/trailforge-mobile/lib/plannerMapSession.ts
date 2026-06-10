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
import { formatSearchBbox, trailCentroid, trailMapCoordinates } from "@/lib/geo";
import { snapToPolyline } from "@/lib/polylineSnap";
import type { NavTrailInput } from "@/lib/navigation";
import {
  buildOptimalTrailSequence,
  difficultyToCorridorKm,
  filterTrailsByGrades,
  orderTrailIdsAlongRoute,
  orientTrailPathToward,
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
  styleToParams,
  type LocationPoint,
  type RideStyle,
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
    let prev: LocationPoint = s.from;
    for (const id of ordered) {
      const trail = detailsMap.get(id);
      if (trail) {
        waypoints.push(trailEntryPoint(trail, prev, s.to));
        const exit = orientTrailPathToward(trailMapCoordinates(trail), prev, s.to).at(-1);
        if (exit) {
          prev = { lat: exit.latitude, lon: exit.longitude, address: "" };
        }
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

/** Order and orient trails for navigation so legs flow toward the destination. */
export function prepareTrailsForNavigation(
  from: LocationPoint,
  to: LocationPoint,
  trails: MapTrail[],
): NavTrailInput[] {
  const ordered = buildOptimalTrailSequence(from, to, trails);
  let current: LocationPoint = from;
  const result: NavTrailInput[] = [];

  for (const t of ordered) {
    const pts = trailMapCoordinates(t);
    const oriented = orientTrailPathToward(pts, current, to);
    if (oriented.length >= 2) {
      const exit = oriented[oriented.length - 1];
      current = { lat: exit.latitude, lon: exit.longitude, address: "" };
    }
    result.push({
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

  return result;
}

/** Add up to `maxAdd` corridor trails (legacy — applies immediately). */
export async function suggestMoreTrailsAlongRoute(maxAdd = 4): Promise<number> {
  const picked = await pickTrailsAlongMapRoute(maxAdd);
  if (picked.length === 0) return 0;
  await applyMapTrailBatch(picked);
  return picked.length;
}

/** Preview trails to add on the map planner (no mutation). */
export async function pickTrailsAlongMapRoute(maxAdd = 4): Promise<MapTrail[]> {
  const s = getPlannerState();
  if (!s.from || !s.to || s.mapMode !== "planning") return [];

  const corridorKm = difficultyToCorridorKm(s.difficultyGrades);
  const pool = await fetchCorridorTrailPool(s.from, s.to, corridorKm, s.difficultyGrades);
  const exclude = new Set(s.activeTrailIds);
  return selectTrailsAlongCorridor(s.from, s.to, pool, {
    corridorKm,
    maxTrails: maxAdd,
    excludeIds: exclude,
  });
}

/** Merge picked trails into the map planner route and rebuild road geometry. */
export async function applyMapTrailBatch(picked: MapTrail[]): Promise<void> {
  if (picked.length === 0) return;
  const s = getPlannerState();
  if (!s.from || !s.to) return;

  plannerActions.mergeTrailDetails(picked);
  const detailsMap = new Map(getPlannerState().trailDetails.map((t) => [t.id, t]));
  for (const t of picked) detailsMap.set(t.id, t);
  const nextIds = orderTrailIdsAlongRoute(
    s.from,
    s.to,
    [...s.activeTrailIds, ...picked.map((t) => t.id)],
    detailsMap,
  );
  plannerActions.setActiveTrailIds(nextIds);
  await rebuildPlannerRoadRoute();
}

/** OSRM road line for route wizard (uses visible, non-skipped sections). */
export async function rebuildWizardRoadRoute(): Promise<void> {
  const s = getPlannerState();
  if (!s.from) return;
  const to = s.to ?? s.from;

  const visibleIds = s.trailDetails
    .filter((t) => !s.skippedIds.includes(t.id))
    .map((t) => t.id);

  plannerActions.setRebuildingRoute(true);
  try {
    const detailsMap = new Map(s.trailDetails.map((t) => [t.id, t]));
    const ordered = orderTrailIdsAlongRoute(s.from, to, visibleIds, detailsMap);

    const waypoints: NavLatLng[] = [
      { latitude: s.from.lat, longitude: s.from.lon },
    ];
    let prev: LocationPoint = s.from;
    for (const id of ordered) {
      const trail = detailsMap.get(id);
      if (trail) {
        waypoints.push(trailEntryPoint(trail, prev, to));
        const exit = orientTrailPathToward(trailMapCoordinates(trail), prev, to).at(-1);
        if (exit) {
          prev = { lat: exit.latitude, lon: exit.longitude, address: "" };
        }
      }
    }
    waypoints.push({ latitude: to.lat, longitude: to.lon });

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

/** Nearest trail within ~2 km of a map tap (for wizard add-by-tap). */
export async function findTrailNearCoordinate(
  lat: number,
  lon: number,
  style: RideStyle = "moderate",
): Promise<MapTrail | null> {
  const params = styleToParams(style);
  const grades = gradesUpToMax(params.maxGrade);
  const pad = 0.035;
  const bbox = formatSearchBbox(lat - pad, lon - pad, lat + pad, lon + pad);
  const res = await searchTrailsByBbox({ bbox, limit: 80 });
  const trails = filterTrailsByGrades(res.trails ?? [], grades).filter(
    (t) => t.terrain !== "road",
  );

  const pos = { latitude: lat, longitude: lon };
  let best: { trail: MapTrail; distM: number } | null = null;
  for (const t of trails) {
    const snap = snapToPolyline(trailMapCoordinates(t), pos);
    if (!snap || snap.distanceM > 2000) continue;
    if (!best || snap.distanceM < best.distM) {
      best = { trail: t, distM: snap.distanceM };
    }
  }
  return best?.trail ?? null;
}

function gradesUpToMax(maxGrade: number): number[] {
  const grades: number[] = [];
  for (let g = 1; g <= 10; g++) {
    if (g <= maxGrade) grades.push(g);
  }
  return grades;
}

function difficultyString(d: string | number | null | undefined): string | null {
  if (d == null) return null;
  return String(d);
}

async function fetchCorridorTrailPool(
  from: LocationPoint,
  to: LocationPoint,
  corridorKm: number,
  grades: number[],
): Promise<MapTrail[]> {
  const latPad = corridorKm / 111.32;
  const meanLat = (from.lat + to.lat) / 2;
  const lngPad =
    corridorKm / Math.max(0.01, 111.32 * Math.cos((meanLat * Math.PI) / 180));
  const minLat = Math.min(from.lat, to.lat) - latPad;
  const maxLat = Math.max(from.lat, to.lat) + latPad;
  const minLng = Math.min(from.lon, to.lon) - lngPad;
  const maxLng = Math.max(from.lon, to.lon) + lngPad;
  const bbox = formatSearchBbox(minLat, minLng, maxLat, maxLng);
  const bboxRes = await searchTrailsByBbox({ bbox, limit: 200 });
  return filterTrailsByGrades(bboxRes.trails ?? [], grades).filter(
    (t) => t.terrain !== "road",
  );
}

/** Route wizard — preview corridor picks (no mutation). */
export async function pickTrailsAlongWizardRoute(maxAdd = 4): Promise<MapTrail[]> {
  const state = getPlannerState();
  if (!state.from) return [];
  const to = state.to ?? state.from;
  const style = state.rideStyle ?? "moderate";
  const params = styleToParams(style);
  const grades = gradesUpToMax(params.maxGrade);
  const corridorKm = Math.min(30, params.corridorKm * 0.4);

  const excludeIds = new Set<string>();
  for (const t of state.trailDetails) {
    if (!state.skippedIds.includes(t.id)) excludeIds.add(t.id);
  }
  for (const id of state.skippedIds) excludeIds.add(id);

  const pool = await fetchCorridorTrailPool(state.from, to, params.corridorKm, grades);
  return selectTrailsAlongCorridor(state.from, to, pool, {
    corridorKm,
    maxTrails: maxAdd,
    excludeIds,
  });
}

/** Merge picked trails into wizard route and rebuild road line. */
export async function applyWizardTrailBatch(picked: MapTrail[]): Promise<void> {
  if (picked.length === 0) return;
  const state = getPlannerState();

  const mergedDetails = new Map(state.trailDetails.map((t) => [t.id, t]));
  for (const t of picked) mergedDetails.set(t.id, t);

  const mergedSuggestions = [...state.suggestions];
  for (const t of picked) {
    if (!mergedSuggestions.some((s) => s.trailId === t.id)) {
      mergedSuggestions.push({
        trailId: t.id,
        name: t.name,
        distance_km: t.distance_km ?? null,
        difficulty: difficultyString(t.difficulty),
        detourMeters: 0,
      });
    }
  }

  plannerActions.setSuggestions(mergedSuggestions, [...mergedDetails.values()]);
  await rebuildWizardRoadRoute();
}

/** Add one trail from a map tap in the wizard. */
export async function addTrailToWizardRoute(trail: MapTrail): Promise<void> {
  const state = getPlannerState();
  if (state.skippedIds.includes(trail.id)) {
    plannerActions.restoreSection(trail.id);
    await rebuildWizardRoadRoute();
    return;
  }
  if (state.trailDetails.some((t) => t.id === trail.id)) {
    return;
  }
  await applyWizardTrailBatch([trail]);
}

/** Route wizard — append corridor trails (legacy — applies immediately). */
export async function suggestMoreTrailsForWizard(maxAdd = 4): Promise<number> {
  const picked = await pickTrailsAlongWizardRoute(maxAdd);
  if (picked.length === 0) return 0;
  await applyWizardTrailBatch(picked);
  return picked.length;
}

/** Initial wizard fetch — API suggestions with corridor fallback along A→B (or loop). */
export async function fetchWizardTrailSuggestions(
  from: LocationPoint,
  to: LocationPoint,
  style: RideStyle,
): Promise<{ suggestions: import("@/lib/api").PlannerSuggestion[]; trails: MapTrail[] }> {
  const params = styleToParams(style);
  const grades = gradesUpToMax(params.maxGrade);

  const res = await getPlannerSuggestions({
    fromLat: from.lat,
    fromLon: from.lon,
    toLat: to.lat,
    toLon: to.lon,
    corridorKm: params.corridorKm,
    maxTrails: 8,
  });

  let trails: MapTrail[] = [];
  const apiIds = res.suggestions.map((s) => s.trailId);
  if (apiIds.length > 0) {
    const details = await searchTrailsByBbox({ ids: apiIds.join(","), limit: 50 });
    trails = (details.trails ?? []).filter((t) => t.terrain !== "road");
  }

  if (trails.length === 0) {
    const pool = await fetchCorridorTrailPool(from, to, params.corridorKm, grades);
    const picked = selectTrailsAlongCorridor(from, to, pool, {
      corridorKm: params.corridorKm * 0.35,
      maxTrails: 8,
    });
    trails = picked;
    return {
      suggestions: picked.map((t) => ({
        trailId: t.id,
        name: t.name,
        distance_km: t.distance_km ?? null,
        difficulty: difficultyString(t.difficulty),
        detourMeters: 0,
      })),
      trails: picked,
    };
  }

  return { suggestions: res.suggestions, trails };
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
