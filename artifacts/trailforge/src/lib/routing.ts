import type { Trail } from "@/lib/supabase";
import { parseGPX } from "@/lib/gpx";

export interface GeoPoint {
  lat: number;
  lng: number;
  label?: string;
}

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
  | { kind: "trail"; index: number; trail: Trail; polyline: GeoPoint[]; distanceKm: number; entry: GeoPoint; exit: GeoPoint };

export interface AssembledRoute {
  start: GeoPoint;
  end: GeoPoint;
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
    // Bias to GB first
    const gb = await tryFetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1&countrycodes=gb`
    );
    if (gb) return gb;
    // Fall back to global
    return await tryFetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`
    );
  } catch {
    return null;
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

export async function assembleMultiModalRoute(
  start: GeoPoint,
  end: GeoPoint,
  trails: Trail[],
  onProgress?: (step: number, total: number, label: string) => void
): Promise<AssembledRoute> {
  const sections: RouteSection[] = [];
  let totalRoadKm = 0;
  let totalTrailKm = 0;
  let totalRoadDurationMin = 0;
  let totalTrailDurationMin = 0;
  const skippedTrails: string[] = [];
  let failedRoadSegments = 0;

  let currentPoint: GeoPoint = start;
  let sectionIdx = 0;

  const totalSteps = trails.length * 2 + 1;
  let stepNo = 0;

  for (let i = 0; i < trails.length; i++) {
    const trail = trails[i];
    const waypoints = parseGPX(trail.gpx_data);
    if (waypoints.length < 2) {
      skippedTrails.push(trail.name);
      continue;
    }

    const trailEntry: GeoPoint = { lat: waypoints[0].lat, lng: waypoints[0].lon };
    const trailExit: GeoPoint = { lat: waypoints[waypoints.length - 1].lat, lng: waypoints[waypoints.length - 1].lon };

    // Road from current point to trail entry
    stepNo++;
    onProgress?.(stepNo, totalSteps, `Routing roads to ${trail.name}`);
    const roadRoute = await getRoadRoute([currentPoint, trailEntry]);
    if (roadRoute) {
      const fromLabel = i === 0 ? (start.label || "Start") : `Trail ${i} exit`;
      sections.push({
        kind: "road",
        index: sectionIdx++,
        from: currentPoint,
        to: trailEntry,
        route: roadRoute,
        label: `${fromLabel} → ${trail.name} entry`,
      });
      totalRoadKm += roadRoute.distanceKm;
      totalRoadDurationMin += roadRoute.durationMin;
    } else {
      failedRoadSegments++;
    }

    // Trail itself
    stepNo++;
    onProgress?.(stepNo, totalSteps, `Adding ${trail.name}`);
    const trailPolyline: GeoPoint[] = waypoints.map((w) => ({ lat: w.lat, lng: w.lon }));
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

    // Throttle slightly to be polite to public OSRM
    await new Promise((r) => setTimeout(r, 250));
  }

  // Final road segment to end
  stepNo++;
  onProgress?.(stepNo, totalSteps, `Routing final road to ${end.label || "destination"}`);
  const finalRoute = await getRoadRoute([currentPoint, end]);
  if (finalRoute) {
    const fromLabel = trails.length === 0 ? (start.label || "Start") : `Trail ${trails.length} exit`;
    sections.push({
      kind: "road",
      index: sectionIdx++,
      from: currentPoint,
      to: end,
      route: finalRoute,
      label: `${fromLabel} → ${end.label || "Destination"}`,
    });
    totalRoadKm += finalRoute.distanceKm;
    totalRoadDurationMin += finalRoute.durationMin;
  } else {
    failedRoadSegments++;
  }

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
