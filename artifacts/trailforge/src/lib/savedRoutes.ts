import { type Trail } from "@/lib/supabase";
import { type RouteWaypoint } from "@/lib/routing";
import { type StoredEntryRef } from "@/lib/plannerRouteStore";

export interface SavedRouteSummary {
  id: string;
  name: string;
  trailIds: string[];
  trails: Trail[];
  waypoints: RouteWaypoint[];
  entryOrder: StoredEntryRef[];
  distanceKm: number | null;
  createdAt: string;
}

interface ListResponse {
  routes: SavedRouteSummary[];
}

interface CreateBody {
  name: string;
  trailIds: string[];
  waypoints: RouteWaypoint[];
  entryOrder: StoredEntryRef[];
  distanceKm: number | null;
}

interface CreateResponse {
  id: string;
  name: string;
  createdAt: string;
}

export type CreateSavedRouteResult =
  | { status: "ok"; route: CreateResponse }
  | { status: "limit" }
  | { status: "error" };

export async function listSavedRoutes(): Promise<SavedRouteSummary[]> {
  const res = await fetch("/api/me/saved-routes", { credentials: "include" });
  if (!res.ok) {
    if (res.status === 401) return [];
    // eslint-disable-next-line no-console
    console.warn("[savedRoutes] list failed:", res.status);
    return [];
  }
  const body = (await res.json()) as ListResponse;
  return body.routes ?? [];
}

export async function createSavedRoute(
  payload: CreateBody,
): Promise<CreateSavedRouteResult> {
  let res: Response;
  try {
    res = await fetch("/api/me/saved-routes", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[savedRoutes] create network error:", err);
    return { status: "error" };
  }
  // 409 = per-user route count limit. The server returns a friendly
  // message but we only care about the status here so the caller can
  // route to its dedicated "limit reached" UI.
  if (res.status === 409) return { status: "limit" };
  if (!res.ok) {
    // eslint-disable-next-line no-console
    console.warn("[savedRoutes] create failed:", res.status);
    return { status: "error" };
  }
  try {
    const route = (await res.json()) as CreateResponse;
    return { status: "ok", route };
  } catch {
    return { status: "error" };
  }
}

export async function deleteSavedRoute(id: string): Promise<boolean> {
  const res = await fetch(
    `/api/me/saved-routes/${encodeURIComponent(id)}`,
    { method: "DELETE", credentials: "include" },
  );
  return res.ok;
}
