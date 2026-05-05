import { useEffect, useState } from "react";

export interface NearbyLocation {
  lat: number;
  lng: number;
}

export type NearbySource = "gps" | "fallback";

export interface NearbyLocationState {
  near: NearbyLocation | null;
  source: NearbySource | null;
}

interface CachedPosition {
  lat: number;
  lng: number;
  at: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const GPS_TIMEOUT_MS = 8000;
const GPS_MAX_AGE_MS = 60_000;

let cachedPosition: CachedPosition | null = null;
let inflight: Promise<CachedPosition | null> | null = null;
const subscribers = new Set<(pos: CachedPosition | null) => void>();

function notify(pos: CachedPosition | null): void {
  for (const cb of subscribers) cb(pos);
}

function isFresh(pos: CachedPosition | null): pos is CachedPosition {
  return !!pos && Date.now() - pos.at <= CACHE_TTL_MS;
}

async function permissionGranted(): Promise<boolean | null> {
  if (
    typeof navigator === "undefined" ||
    !("permissions" in navigator) ||
    !navigator.permissions?.query
  ) {
    return null;
  }
  try {
    const status = await navigator.permissions.query({
      name: "geolocation" as PermissionName,
    });
    if (status.state === "granted") return true;
    if (status.state === "denied") return false;
    return null;
  } catch {
    return null;
  }
}

function readCurrentPosition(highAccuracy: boolean): Promise<CachedPosition | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          at: Date.now(),
        });
      },
      () => resolve(null),
      {
        enableHighAccuracy: highAccuracy,
        timeout: GPS_TIMEOUT_MS,
        maximumAge: GPS_MAX_AGE_MS,
      },
    );
  });
}

/**
 * Externally-callable: prime the shared cache with a position the rider
 * already authorised (e.g. by clicking "Use my current location" on the
 * Planner). Lets the autocomplete proximity bias kick in immediately
 * without re-prompting or re-fetching GPS.
 */
export function primeNearbyLocation(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  cachedPosition = { lat, lng, at: Date.now() };
  notify(cachedPosition);
}

/**
 * Best-effort proximity hint for the rider's current location. Used to
 * bias address autocomplete toward nearby places.
 *
 * Strategy:
 *  - Returns the module-level cached position immediately if fresh
 *    (5 min TTL) so re-mounts and multiple inputs share one fetch.
 *  - On first use per session, only fires `getCurrentPosition` when the
 *    geolocation permission is already `granted`. This keeps the
 *    autocomplete from triggering an unsolicited permission prompt —
 *    riders explicitly grant location via the "Use my current location"
 *    button on the Planner, which calls `primeNearbyLocation`.
 *  - If `permissions.query` is unavailable (older browsers), we skip the
 *    background fetch entirely; the cache will be populated lazily by
 *    explicit calls to `primeNearbyLocation`.
 *
 * Optional `fallback` lets the caller supply a coarse hint (e.g. the
 * planner's saved start coords) used only when no live GPS is available.
 */
export function useNearbyLocation(
  fallback?: NearbyLocation | null,
): NearbyLocationState {
  const [pos, setPos] = useState<CachedPosition | null>(() =>
    isFresh(cachedPosition) ? cachedPosition : null,
  );

  useEffect(() => {
    let cancelled = false;

    const onUpdate = (next: CachedPosition | null) => {
      if (cancelled) return;
      setPos(isFresh(next) ? next : null);
    };
    subscribers.add(onUpdate);

    if (!isFresh(cachedPosition)) {
      const fetchIfAllowed = async () => {
        if (inflight) {
          const result = await inflight;
          if (!cancelled) onUpdate(result);
          return;
        }
        const allowed = await permissionGranted();
        if (allowed !== true) return;
        inflight = readCurrentPosition(false).then((result) => {
          if (result) {
            cachedPosition = result;
            notify(result);
          }
          return result;
        });
        try {
          await inflight;
        } finally {
          inflight = null;
        }
      };
      void fetchIfAllowed();
    }

    return () => {
      cancelled = true;
      subscribers.delete(onUpdate);
    };
  }, []);

  if (pos) {
    return { near: { lat: pos.lat, lng: pos.lng }, source: "gps" };
  }
  if (fallback && Number.isFinite(fallback.lat) && Number.isFinite(fallback.lng)) {
    return { near: { lat: fallback.lat, lng: fallback.lng }, source: "fallback" };
  }
  return { near: null, source: null };
}
