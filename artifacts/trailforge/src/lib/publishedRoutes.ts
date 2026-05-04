import {
  listPublicRoutes as gListPublicRoutes,
  getPublicRoute as gGetPublicRoute,
  likeRoute as gLikeRoute,
  unlikeRoute as gUnlikeRoute,
  listRouteComments as gListRouteComments,
  postRouteComment as gPostRouteComment,
  updateRouteComment as gUpdateRouteComment,
  deleteRouteComment as gDeleteRouteComment,
  type PublicRouteSummary,
  type RouteComment as GeneratedRouteComment,
  type RouteLikeResult,
  type ListPublicRoutesParams,
} from "@workspace/api-client-react";
import type { SavedRouteSummary, RideType } from "@/lib/savedRoutes";

/**
 * Discover-side helpers for the public /api/routes feed plus the
 * per-route like/comment endpoints. Wraps the OpenAPI-generated
 * orval client so the feed/detail/like/comment shapes stay in sync
 * with the spec in `lib/api-spec/openapi.yaml`. Errors are squashed
 * to nulls/empty arrays at this layer because the Discover UI treats
 * transport failures as "no data" rather than blowing up.
 */

export interface ListPublishedRoutesParams {
  rideType?: RideType | null;
  region?: string | null;
  q?: string;
  sort?: "recent" | "likes";
  limit?: number;
}

function castSummary(r: PublicRouteSummary): SavedRouteSummary {
  // The generated type carries `unknown` for the embedded trail rows
  // (additionalProperties:true in the spec); the Discover UI treats
  // them as `Trail` after server-side hydration so a cast is safe.
  return r as unknown as SavedRouteSummary;
}

function castComment(c: GeneratedRouteComment): RouteComment {
  return {
    id: c.id,
    routeId: c.routeId,
    userId: c.userId,
    parentId: c.parentId ?? null,
    body: c.body,
    createdAt:
      typeof c.createdAt === "string"
        ? c.createdAt
        : new Date(c.createdAt as unknown as string | number).toISOString(),
    authorName: c.authorName ?? null,
    authorAvatar: c.authorAvatar ?? null,
    mine: c.mine,
  };
}

export async function listPublishedRoutes(
  params: ListPublishedRoutesParams = {},
): Promise<SavedRouteSummary[]> {
  try {
    const query: ListPublicRoutesParams = {};
    if (params.rideType) query.rideType = params.rideType;
    if (params.region) query.region = params.region;
    if (params.q && params.q.trim()) query.q = params.q.trim();
    if (params.sort) query.sort = params.sort;
    if (params.limit) query.limit = params.limit;
    const res = await gListPublicRoutes(query);
    return (res.routes ?? []).map(castSummary);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[publishedRoutes] list failed:", String(err));
    return [];
  }
}

export async function fetchPublishedRoute(
  id: string,
): Promise<SavedRouteSummary | null> {
  try {
    const res = await gGetPublicRoute(id);
    return res.route ? castSummary(res.route) : null;
  } catch {
    // 404 / network / parse failures all surface to the UI the same
    // way — the sheet shows "Route not found".
    return null;
  }
}

export interface LikeResult {
  liked: boolean;
  likesCount: number;
}

export async function likeRoute(
  id: string,
  liked: boolean,
): Promise<LikeResult | null> {
  try {
    const res: RouteLikeResult = liked
      ? await gLikeRoute(id)
      : await gUnlikeRoute(id);
    return { liked: res.liked, likesCount: res.likesCount };
  } catch {
    return null;
  }
}

export interface RouteComment {
  id: string;
  routeId: string;
  userId: string;
  parentId: string | null;
  body: string;
  createdAt: string;
  authorName: string | null;
  authorAvatar: string | null;
  mine: boolean;
}

export async function listRouteComments(id: string): Promise<RouteComment[]> {
  try {
    const res = await gListRouteComments(id);
    return (res.comments ?? []).map(castComment);
  } catch {
    return [];
  }
}

export async function postRouteComment(
  id: string,
  body: string,
  parentId: string | null = null,
): Promise<RouteComment | null> {
  try {
    const res = await gPostRouteComment(id, { body, parentId });
    return res.comment ? castComment(res.comment) : null;
  } catch {
    return null;
  }
}

export async function updateRouteComment(
  id: string,
  commentId: string,
  body: string,
): Promise<RouteComment | null> {
  try {
    const res = await gUpdateRouteComment(id, commentId, { body });
    return res.comment ? castComment(res.comment) : null;
  } catch {
    return null;
  }
}

export async function deleteRouteComment(
  id: string,
  commentId: string,
): Promise<boolean> {
  try {
    const res = await gDeleteRouteComment(id, commentId);
    return res.deleted === true;
  } catch {
    return false;
  }
}
