import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { type Trail } from "@/lib/supabase";

const STORAGE_KEY = "trailforge_planner_route";

let routeTrails: Trail[] = loadInitial();
const listeners = new Set<(trails: Trail[]) => void>();

function loadInitial(): Trail[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as Trail[];
  } catch {/**/}
  return [];
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(routeTrails));
  } catch {/**/}
}

function emit() {
  for (const l of listeners) {
    try { l(routeTrails); } catch {/**/}
  }
}

export function getRouteTrails(): Trail[] {
  return routeTrails;
}

export function setRouteTrails(next: Trail[]) {
  routeTrails = next;
  persist();
  emit();
}

export function addRouteTrail(trail: Trail) {
  if (routeTrails.some((t) => t.id === trail.id)) return;
  routeTrails = [...routeTrails, trail];
  persist();
  emit();
}

export function removeRouteTrail(trailId: string) {
  routeTrails = routeTrails.filter((t) => t.id !== trailId);
  persist();
  emit();
}

export function isInRoute(trailId: string): boolean {
  return routeTrails.some((t) => t.id === trailId);
}

export function subscribeRouteTrails(listener: (trails: Trail[]) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** React hook for subscribing to the planner route store. */
export function useRouteTrails(): [Trail[], Dispatch<SetStateAction<Trail[]>>] {
  const [trails, setTrails] = useState<Trail[]>(routeTrails);
  useEffect(() => {
    return subscribeRouteTrails(setTrails);
  }, []);
  const setter: Dispatch<SetStateAction<Trail[]>> = (next) => {
    const resolved = typeof next === "function"
      ? (next as (prev: Trail[]) => Trail[])(routeTrails)
      : next;
    setRouteTrails(resolved);
  };
  return [trails, setter];
}
