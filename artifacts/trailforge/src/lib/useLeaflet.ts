import { useEffect, useState } from "react";

let loadPromise: Promise<void> | null = null;

function loadLeaflet(): Promise<void> {
  if (window.L) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await import("leaflet/dist/leaflet.css");
    const L = await import("leaflet");
    window.L = L.default ?? L;
  })();
  return loadPromise;
}

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
    void loadLeaflet().then(() => setLoaded(true));
  }, []);

  return loaded;
}
