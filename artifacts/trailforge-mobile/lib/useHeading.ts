/**
 * Mobile compass / heading hook using expo-location.
 *
 * On a real device `watchHeadingAsync` returns both magnetic and true
 * headings at roughly 5-20 Hz.  We apply the same low-pass filter and
 * dead-zone used in the web `useHeading` hook so the navigation map
 * rotates smoothly without jitter.
 *
 * When the device can't provide heading data (simulator, permission
 * denied) we fall back to the GPS course from `watchPositionAsync`,
 * which only updates when the user is moving.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as Location from "expo-location";

export type HeadingSource = "compass" | "gps" | "none";

export interface HeadingState {
  heading: number;        // degrees, 0 = north, clockwise
  accuracy: number;       // lower is better (device-reported)
  source: HeadingSource;
}

const LOW_PASS_ALPHA = 0.12;  // Slightly more responsive than web (mobile updates faster)
const DEAD_ZONE_DEG = 2;

function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function smoothAngle(current: number, raw: number, alpha: number): number {
  // Shortest-path interpolation across the 0/360 boundary.
  let diff = normalizeAngle(raw - current);
  if (diff > 180) diff -= 360;
  if (Math.abs(diff) < DEAD_ZONE_DEG) return current;
  return normalizeAngle(current + diff * alpha);
}

export function useHeading(active: boolean): HeadingState {
  const [state, setState] = useState<HeadingState>({
    heading: 0,
    accuracy: 999,
    source: "none",
  });

  const smoothedRef = useRef(0);
  const headingSubRef = useRef<Location.LocationSubscription | null>(null);
  const gpsSubRef = useRef<Location.LocationSubscription | null>(null);

  const stop = useCallback(() => {
    headingSubRef.current?.remove();
    headingSubRef.current = null;
    gpsSubRef.current?.remove();
    gpsSubRef.current = null;
  }, []);

  useEffect(() => {
    if (!active) {
      stop();
      setState({ heading: 0, accuracy: 999, source: "none" });
      return;
    }

    void (async () => {
      // Request foreground permission (recording already does this, but guard
      // here so navigation works standalone).
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;

      // --- Primary: compass heading ---
      try {
        headingSubRef.current = await Location.watchHeadingAsync((evt) => {
          // Prefer true heading; fall back to magnetic when true is unavailable
          // (-1 means unavailable on iOS).
          const raw =
            evt.trueHeading >= 0 ? evt.trueHeading : evt.magHeading;

          smoothedRef.current = smoothAngle(smoothedRef.current, raw, LOW_PASS_ALPHA);

          setState({
            heading: Math.round(smoothedRef.current),
            accuracy: evt.accuracy ?? 0,
            source: "compass",
          });
        });
      } catch {
        // Compass unavailable (e.g. Expo Go simulator) — fall through to GPS.
      }

      // --- Fallback: GPS course (only fires when moving) ---
      if (!headingSubRef.current) {
        try {
          gpsSubRef.current = await Location.watchPositionAsync(
            { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 5 },
            (loc) => {
              if (loc.coords.heading == null || loc.coords.heading < 0) return;
              smoothedRef.current = smoothAngle(
                smoothedRef.current,
                loc.coords.heading,
                LOW_PASS_ALPHA,
              );
              setState({
                heading: Math.round(smoothedRef.current),
                accuracy: 10,
                source: "gps",
              });
            },
          );
        } catch {
          // ignore — heading stays "none"
        }
      }
    })();

    return stop;
  }, [active, stop]);

  return state;
}
