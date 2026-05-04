import { useEffect, useRef, useState, useCallback } from "react";

type HeadingSource = "compass" | "gps" | "none";

interface HeadingState {
  heading: number;
  source: HeadingSource;
}

const LOW_PASS_ALPHA = 0.15;

function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function angleDiff(a: number, b: number): number {
  let d = normalizeAngle(b - a);
  if (d > 180) d -= 360;
  return d;
}

function smoothAngle(current: number, target: number, alpha: number): number {
  const diff = angleDiff(current, target);
  return normalizeAngle(current + diff * alpha);
}

export function useHeading(
  gpsHeadingDeg: number | null,
  active: boolean,
): HeadingState & { requestCompassPermission: () => Promise<void> } {
  const [state, setState] = useState<HeadingState>({ heading: 0, source: "none" });
  const smoothedRef = useRef(0);
  const compassAvailableRef = useRef(false);
  const latestCompassRef = useRef<number | null>(null);
  const permissionRequestedRef = useRef(false);

  const requestCompassPermission = useCallback(async () => {
    if (permissionRequestedRef.current) return;
    permissionRequestedRef.current = true;

    if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return;

    const doe = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    if (typeof doe.requestPermission === "function") {
      try {
        const result = await doe.requestPermission();
        if (result !== "granted") {
          compassAvailableRef.current = false;
          return;
        }
      } catch {
        compassAvailableRef.current = false;
        return;
      }
    }
  }, []);

  useEffect(() => {
    if (!active) {
      latestCompassRef.current = null;
      compassAvailableRef.current = false;
      permissionRequestedRef.current = false;
      return;
    }

    const handleOrientation = (e: DeviceOrientationEvent) => {
      let alpha: number | null = null;

      const abs = e as DeviceOrientationEvent & { webkitCompassHeading?: number };
      if (typeof abs.webkitCompassHeading === "number" && isFinite(abs.webkitCompassHeading)) {
        alpha = abs.webkitCompassHeading;
      } else if (e.absolute && typeof e.alpha === "number" && isFinite(e.alpha)) {
        alpha = normalizeAngle(360 - e.alpha);
      } else if (typeof e.alpha === "number" && isFinite(e.alpha)) {
        alpha = normalizeAngle(360 - e.alpha);
      }

      if (alpha !== null) {
        compassAvailableRef.current = true;
        latestCompassRef.current = alpha;
      }
    };

    window.addEventListener("deviceorientationabsolute", handleOrientation as EventListener, true);
    window.addEventListener("deviceorientation", handleOrientation, true);

    return () => {
      window.removeEventListener("deviceorientationabsolute", handleOrientation as EventListener, true);
      window.removeEventListener("deviceorientation", handleOrientation, true);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;

    let raf: number;
    let running = true;

    const tick = () => {
      if (!running) return;

      let rawHeading: number | null = null;
      let source: HeadingSource = "none";

      if (compassAvailableRef.current && latestCompassRef.current !== null) {
        rawHeading = latestCompassRef.current;
        source = "compass";
      } else if (gpsHeadingDeg !== null && isFinite(gpsHeadingDeg)) {
        rawHeading = gpsHeadingDeg;
        source = "gps";
      }

      if (rawHeading !== null) {
        smoothedRef.current = smoothAngle(smoothedRef.current, rawHeading, LOW_PASS_ALPHA);
        setState({ heading: Math.round(smoothedRef.current), source });
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [active, gpsHeadingDeg]);

  return { ...state, requestCompassPermission };
}
