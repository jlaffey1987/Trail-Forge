import { type Trail } from "@/lib/supabase";
import { type RouteWaypoint } from "@/lib/routing";
import { type StoredEntryRef } from "@/lib/plannerRouteStore";
import {
  listMySavedRoutes as gListMySavedRoutes,
  createMySavedRoute as gCreateMySavedRoute,
  replaceMySavedRoute as gReplaceMySavedRoute,
  patchMySavedRoute as gPatchMySavedRoute,
  deleteMySavedRoute as gDeleteMySavedRoute,
  type SaveRouteRequest,
  type PatchSavedRouteRequest,
  type SavedRouteCreateResponse,
  type PublicRouteSummary,
} from "@workspace/api-client-react";

export const RIDE_TYPES = [
  "adventure",
  "enduro",
  "trail",
  "green-laning",
  "other",
] as const;
export type RideType = (typeof RIDE_TYPES)[number];

export const RIDE_TYPE_LABEL: Record<RideType, string> = {
  adventure: "Adventure",
  enduro: "Enduro",
  trail: "Trail",
  "green-laning": "Green Laning",
  other: "Other",
};

export interface SavedRouteSummary {
  id: string;
  userId?: string;
  name: string;
  description: string | null;
  rideType: RideType | null;
  region: string | null;
  isPublic: boolean;
  trailIds: string[];
  trails: Trail[];
  waypoints: RouteWaypoint[];
  entryOrder: StoredEntryRef[];
  distanceKm: number | null;
  totalDistanceKm: number | null;
  likesCount: number;
  commentsCount: number;
  likedByMe: boolean;
  hiddenTrailCount: number;
  ownerName: string | null;
  ownerAvatar: string | null;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Body shape the planner sheet sends to POST/PUT /me/saved-routes.
 * Keeps the publish-flow fields optional so the legacy "Save" + "Update"
 * paths (which don't open the publish dialog) stay unchanged.
 */
export interface CreateBody {
  name: string;
  description?: string | null;
  rideType?: RideType | null;
  region?: string | null;
  isPublic?: boolean;
  trailIds: string[];
  waypoints: RouteWaypoint[];
  entryOrder: StoredEntryRef[];
  distanceKm: number | null;
}

interface CreateResponse {
  id: string;
  name: string;
  createdAt: string;
  route?: SavedRouteSummary;
}

export type CreateSavedRouteResult =
  | { status: "ok"; route: CreateResponse }
  | { status: "limit" }
  | { status: "error" };

function castSummary(r: PublicRouteSummary): SavedRouteSummary {
  // Generated type carries `unknown` for embedded trail/waypoint rows
  // (additionalProperties:true in the spec); the UI consumes them as
  // domain types after server-side hydration so a cast is safe.
  return r as unknown as SavedRouteSummary;
}

function toCreateResponse(
  r: SavedRouteCreateResponse,
): CreateResponse {
  return {
    id: r.id,
    name: r.name,
    createdAt:
      typeof r.createdAt === "string"
        ? r.createdAt
        : new Date(r.createdAt as unknown as string | number).toISOString(),
    route: r.route ? castSummary(r.route) : undefined,
  };
}

function toRequest(payload: CreateBody): SaveRouteRequest {
  return {
    name: payload.name,
    description: payload.description ?? undefined,
    rideType: payload.rideType ?? undefined,
    region: payload.region ?? undefined,
    isPublic: payload.isPublic,
    trailIds: payload.trailIds,
    waypoints: payload.waypoints as unknown as SaveRouteRequest["waypoints"],
    entryOrder:
      payload.entryOrder as unknown as SaveRouteRequest["entryOrder"],
    distanceKm: payload.distanceKm ?? undefined,
  };
}

function getStatus(err: unknown): number | null {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : null;
}

export async function listSavedRoutes(): Promise<SavedRouteSummary[]> {
  try {
    const res = await gListMySavedRoutes();
    return (res.routes ?? []).map(castSummary);
  } catch (err) {
    if (getStatus(err) === 401) return [];
    // eslint-disable-next-line no-console
    console.warn("[savedRoutes] list failed:", String(err));
    return [];
  }
}

export async function createSavedRoute(
  payload: CreateBody,
): Promise<CreateSavedRouteResult> {
  try {
    const res = await gCreateMySavedRoute(toRequest(payload));
    return { status: "ok", route: toCreateResponse(res) };
  } catch (err) {
    if (getStatus(err) === 409) return { status: "limit" };
    // eslint-disable-next-line no-console
    console.warn("[savedRoutes] create failed:", String(err));
    return { status: "error" };
  }
}

export type UpdateSavedRouteResult =
  | { status: "ok"; route: CreateResponse }
  | { status: "not-found" }
  | { status: "error" };

export async function updateSavedRoute(
  id: string,
  payload: CreateBody,
): Promise<UpdateSavedRouteResult> {
  try {
    const res = await gReplaceMySavedRoute(id, toRequest(payload));
    return { status: "ok", route: toCreateResponse(res) };
  } catch (err) {
    if (getStatus(err) === 404) return { status: "not-found" };
    // eslint-disable-next-line no-console
    console.warn("[savedRoutes] update failed:", String(err));
    return { status: "error" };
  }
}

export type RenameSavedRouteResult =
  | { status: "ok"; name: string }
  | { status: "not-found" }
  | { status: "error" };

/**
 * PATCH /me/saved-routes/:id — narrow metadata edits (name + publish
 * flow fields). Rename is the most common, hence the name, but the
 * same call also flips visibility/description/ride_type so the
 * "Publish" toggle in My Routes can ride on top of it.
 */
export async function renameSavedRoute(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    rideType?: RideType | null;
    isPublic?: boolean;
  },
): Promise<RenameSavedRouteResult> {
  try {
    const body: PatchSavedRouteRequest = {
      name: patch.name,
      description: patch.description ?? undefined,
      rideType: patch.rideType ?? undefined,
      isPublic: patch.isPublic,
    };
    const res = await gPatchMySavedRoute(id, body);
    return { status: "ok", name: res.name };
  } catch (err) {
    if (getStatus(err) === 404) return { status: "not-found" };
    // eslint-disable-next-line no-console
    console.warn("[savedRoutes] patch failed:", String(err));
    return { status: "error" };
  }
}

export async function deleteSavedRoute(id: string): Promise<boolean> {
  try {
    const res = await gDeleteMySavedRoute(id);
    return res.deleted === true;
  } catch {
    return false;
  }
}
