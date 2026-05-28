/**
 * Cross-screen "what's visible on the map right now" store. The Map tab
 * publishes its current viewport bbox + the trail ids the user can see
 * on screen; the AI tab subscribes so chat replies can be grounded on
 * the trails the user is actually looking at (matches the web app's
 * "ground answers in nearby trails" behaviour).
 *
 * Tiny module-level singleton — no React context needed because the
 * data is short-lived (UI re-publishes on every map move) and listeners
 * only care about the latest snapshot.
 */
import { useEffect, useState } from "react";

export interface VisibleViewport {
  bbox: {
    minLat: number;
    minLng: number;
    maxLat: number;
    maxLng: number;
  } | null;
  trailIds: string[];
}

let current: VisibleViewport = { bbox: null, trailIds: [] };
const listeners = new Set<(v: VisibleViewport) => void>();

export function publishVisibleTrails(next: VisibleViewport): void {
  current = next;
  for (const fn of listeners) {
    try {
      fn(current);
    } catch {
      // ignore listener errors so a misbehaving subscriber can't
      // block subsequent ones
    }
  }
}

/**
 * Subscribe to viewport changes from any screen. Returns the latest
 * snapshot synchronously and re-renders on every publish.
 */
export function useVisibleTrails(): VisibleViewport {
  const [snapshot, setSnapshot] = useState<VisibleViewport>(current);
  useEffect(() => {
    listeners.add(setSnapshot);
    setSnapshot(current);
    return () => {
      listeners.delete(setSnapshot);
    };
  }, []);
  return snapshot;
}
