import { useEffect, useState } from "react";

/**
 * Lazily inject Leaflet's CSS + JS once per page and report when `window.L`
 * is available. Idempotent: any number of components can call the hook;
 * only one script tag (id `leaflet-script`) is ever added.
 *
 * Returns `true` once `window.L` is loaded, `false` while loading.
 */
export function useLeaflet(): boolean {
  const [loaded, setLoaded] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return Boolean(window.L);
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.L) {
      setLoaded(true);
      return;
    }

    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    const existing = document.getElementById("leaflet-script") as HTMLScriptElement | null;
    if (existing) {
      // Another component is already loading it; just wait for it.
      const onLoad = () => setLoaded(true);
      if (window.L) {
        setLoaded(true);
      } else {
        existing.addEventListener("load", onLoad, { once: true });
      }
      return () => existing.removeEventListener("load", onLoad);
    }

    const script = document.createElement("script");
    script.id = "leaflet-script";
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => setLoaded(true);
    document.head.appendChild(script);
    return;
  }, []);

  return loaded;
}
