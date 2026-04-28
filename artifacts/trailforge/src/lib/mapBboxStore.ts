import { type MapBbox } from "./supabase";

let current: MapBbox | null = null;
const listeners = new Set<(bbox: MapBbox | null) => void>();

export const mapBboxStore = {
  get(): MapBbox | null {
    return current;
  },
  set(bbox: MapBbox | null) {
    current = bbox;
    for (const l of listeners) {
      try {
        l(bbox);
      } catch {
        /* ignore */
      }
    }
  },
  subscribe(listener: (bbox: MapBbox | null) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
