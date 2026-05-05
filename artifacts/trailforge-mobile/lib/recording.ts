/**
 * Ride recording: a thin wrapper around `expo-location` that buffers
 * positions in-memory (and exposes a subscribe API for the UI to render
 * live distance / speed / elevation) and registers a background location
 * task so the OS keeps feeding us samples when the screen is locked.
 *
 * Background recording requires:
 *   - "Always" location permission (iOS) / ACCESS_BACKGROUND_LOCATION
 *     (Android), both declared in `app.json`.
 *   - A development build (or production build) — Expo Go does NOT run
 *     `TaskManager.defineTask` callbacks in the background. In Expo Go
 *     we silently fall back to foreground watch.
 */
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

const LOCATION_TASK_NAME = "trailforge-ride-recording";

export interface RidePoint {
  lat: number;
  lon: number;
  altitude: number | null;
  speed: number | null;
  timestamp: number;
}

export interface RideStats {
  distanceMeters: number;
  durationSeconds: number;
  elevationGainMeters: number;
  pointCount: number;
}

type Listener = (points: RidePoint[], stats: RideStats) => void;

const listeners = new Set<Listener>();
let buffer: RidePoint[] = [];
let startedAt: number | null = null;
let foregroundSub: Location.LocationSubscription | null = null;

function pushPoint(p: RidePoint): void {
  buffer.push(p);
  notify();
}

function notify(): void {
  const stats = computeStats(buffer);
  for (const fn of listeners) {
    try {
      fn(buffer.slice(), stats);
    } catch {
      // ignore listener errors
    }
  }
}

function haversineMeters(a: RidePoint, b: RidePoint): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function computeStats(pts: RidePoint[]): RideStats {
  let distance = 0;
  let elevationGain = 0;
  for (let i = 1; i < pts.length; i++) {
    distance += haversineMeters(pts[i - 1], pts[i]);
    const a = pts[i - 1].altitude;
    const b = pts[i].altitude;
    if (a != null && b != null && b > a) elevationGain += b - a;
  }
  const duration =
    pts.length > 1
      ? Math.max(0, (pts[pts.length - 1].timestamp - pts[0].timestamp) / 1000)
      : 0;
  return {
    distanceMeters: distance,
    durationSeconds: duration,
    elevationGainMeters: elevationGain,
    pointCount: pts.length,
  };
}

// Background task runs in a separate JS context — it has its own copy of
// this module's state, so we persist samples through `TaskManager`'s data
// callback by pushing them onto the foreground buffer via a global event.
// In Expo Go this callback is never invoked.
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error || !data) return;
  const locations = (data as { locations?: Location.LocationObject[] })
    .locations;
  if (!locations) return;
  for (const loc of locations) {
    pushPoint({
      lat: loc.coords.latitude,
      lon: loc.coords.longitude,
      altitude: loc.coords.altitude,
      speed: loc.coords.speed,
      timestamp: loc.timestamp,
    });
  }
});

export async function startRecording(): Promise<{ ok: boolean; reason?: string }> {
  // Foreground first — required for both modes.
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return { ok: false, reason: "fg-denied" };
  buffer = [];
  startedAt = Date.now();

  foregroundSub = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      distanceInterval: 5,
      timeInterval: 2000,
    },
    (loc) => {
      pushPoint({
        lat: loc.coords.latitude,
        lon: loc.coords.longitude,
        altitude: loc.coords.altitude,
        speed: loc.coords.speed,
        timestamp: loc.timestamp,
      });
    },
  );

  // Try background — best-effort. Failure is fine; we still have the fg
  // watcher running.
  try {
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status === "granted") {
      const isRegistered = await TaskManager.isTaskRegisteredAsync(
        LOCATION_TASK_NAME,
      );
      if (!isRegistered) {
        await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
          accuracy: Location.Accuracy.High,
          distanceInterval: 10,
          deferredUpdatesInterval: 5000,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: "TrailForge — recording ride",
            notificationBody: "Tap to return to the app.",
            notificationColor: "#f0a832",
          },
        });
      }
    }
  } catch {
    // ignore — background recording is optional
  }

  return { ok: true };
}

export async function stopRecording(): Promise<{
  points: RidePoint[];
  stats: RideStats;
  startedAt: number | null;
}> {
  if (foregroundSub) {
    foregroundSub.remove();
    foregroundSub = null;
  }
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(
      LOCATION_TASK_NAME,
    );
    if (isRegistered) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    }
  } catch {
    // ignore
  }
  const result = {
    points: buffer.slice(),
    stats: computeStats(buffer),
    startedAt,
  };
  buffer = [];
  startedAt = null;
  notify();
  return result;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  // Push the current state immediately so late subscribers see live values.
  fn(buffer.slice(), computeStats(buffer));
  return () => {
    listeners.delete(fn);
  };
}

export function isRecording(): boolean {
  return foregroundSub !== null;
}
