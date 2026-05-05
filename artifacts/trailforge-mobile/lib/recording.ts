/**
 * Ride recording: a thin wrapper around `expo-location` that buffers
 * positions and exposes a subscribe API for the UI to render live
 * distance / speed / elevation. We register a background location task so
 * the OS keeps feeding us samples when the screen is locked.
 *
 * IMPORTANT: the background task runs in its OWN JS context. That means a
 * plain in-memory array would be a different array than the one the
 * foreground UI sees, and any samples collected while backgrounded would
 * be lost on the next cold start. We therefore persist every sample
 * straight to AsyncStorage; both contexts read/write the same key, and on
 * mount the foreground rehydrates so an interrupted ride survives a kill.
 *
 * Background recording requires:
 *   - "Always" location permission (iOS) / ACCESS_BACKGROUND_LOCATION
 *     (Android), both declared in `app.json`.
 *   - A development build (or production build) — Expo Go does NOT run
 *     `TaskManager.defineTask` callbacks in the background. In Expo Go
 *     we silently fall back to foreground watch.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

const LOCATION_TASK_NAME = "trailforge-ride-recording";
const STORAGE_KEY = "trailforge:active-ride";

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

interface PersistedRide {
  startedAt: number | null;
  points: RidePoint[];
}

type Listener = (points: RidePoint[], stats: RideStats) => void;

const listeners = new Set<Listener>();
let foregroundSub: Location.LocationSubscription | null = null;

// In-memory mirror of the persisted ride, so foreground listeners can be
// notified synchronously without an AsyncStorage round-trip every sample.
let buffer: RidePoint[] = [];
let startedAt: number | null = null;

// Per-context serialization. Both contexts (foreground UI + background
// TaskManager) share this storage key, but each has its own JS module
// instance and therefore its own queue. Cross-context atomicity comes
// from the OS lifecycle: when the app is backgrounded the foreground JS
// runtime is paused (Hermes/JSI suspends), so the bg task is the only
// writer; when the app is foregrounded the OS holds bg deliveries until
// the next deferredUpdatesInterval batch. To eliminate the residual
// risk that a single batch could collide we still chain every write
// through this promise queue so within a context appends are strictly
// serialized — no read-modify-write race against ourselves.
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

async function readPersisted(): Promise<PersistedRide> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { startedAt: null, points: [] };
    const parsed = JSON.parse(raw) as Partial<PersistedRide>;
    return {
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : null,
      points: Array.isArray(parsed.points) ? (parsed.points as RidePoint[]) : [],
    };
  } catch {
    return { startedAt: null, points: [] };
  }
}

async function writePersisted(state: PersistedRide): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // best-effort
  }
}

async function clearPersisted(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}

function appendPoints(newPoints: RidePoint[]): Promise<void> {
  if (newPoints.length === 0) return Promise.resolve();
  // Serialize the read-modify-write through the per-context queue so two
  // overlapping watcher callbacks can't both read the same prior state
  // and have the second clobber the first's points.
  return enqueue(async () => {
    const persisted = await readPersisted();
    const merged = [...persisted.points, ...newPoints];
    const next: PersistedRide = {
      startedAt: persisted.startedAt ?? startedAt,
      points: merged,
    };
    await writePersisted(next);
    buffer = merged;
    startedAt = next.startedAt;
    notify();
  });
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

// Background task — its own JS context, its own copy of this module's
// vars. Reaches into the persisted store via the same per-context queue
// so overlapping bg invocations can't race each other either.
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error || !data) return;
  const locations = (data as { locations?: Location.LocationObject[] })
    .locations;
  if (!locations || locations.length === 0) return;
  const newPoints: RidePoint[] = locations.map((loc) => ({
    lat: loc.coords.latitude,
    lon: loc.coords.longitude,
    altitude: loc.coords.altitude,
    speed: loc.coords.speed,
    timestamp: loc.timestamp,
  }));
  await enqueue(async () => {
    const persisted = await readPersisted();
    await writePersisted({
      startedAt: persisted.startedAt,
      points: [...persisted.points, ...newPoints],
    });
  });
});

/** Pull the persisted ride into the in-memory buffer and notify
 *  subscribers. Call this on app start (or recording-screen mount) to
 *  resume a ride that was interrupted by a process kill. */
export async function rehydrate(): Promise<void> {
  const persisted = await readPersisted();
  buffer = persisted.points;
  startedAt = persisted.startedAt;
  notify();
}

export async function startRecording(): Promise<{ ok: boolean; reason?: string }> {
  // Foreground first — required for both modes.
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return { ok: false, reason: "fg-denied" };
  buffer = [];
  startedAt = Date.now();
  await writePersisted({ startedAt, points: [] });

  foregroundSub = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      distanceInterval: 5,
      timeInterval: 2000,
    },
    (loc) => {
      void appendPoints([
        {
          lat: loc.coords.latitude,
          lon: loc.coords.longitude,
          altitude: loc.coords.altitude,
          speed: loc.coords.speed,
          timestamp: loc.timestamp,
        },
      ]);
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
  // Flush background-written samples one last time before clearing.
  const persisted = await readPersisted();
  const finalPoints = persisted.points;
  const result = {
    points: finalPoints.slice(),
    stats: computeStats(finalPoints),
    startedAt: persisted.startedAt ?? startedAt,
  };
  buffer = [];
  startedAt = null;
  await clearPersisted();
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
