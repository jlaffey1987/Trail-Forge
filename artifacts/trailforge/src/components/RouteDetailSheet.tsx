import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import type { Map as LMap, Polyline, CircleMarker, Layer } from "leaflet";
import { useLeaflet } from "@/lib/useLeaflet";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import TrailDetailSheet from "@/components/TrailDetailSheet";
import { type Trail } from "@/lib/supabase";
import {
  fetchPublishedRoute,
  likeRoute,
  listRouteComments,
  postRouteComment,
  updateRouteComment,
  deleteRouteComment,
  type RouteComment,
} from "@/lib/publishedRoutes";
import {
  RIDE_TYPE_LABEL,
  type SavedRouteSummary,
} from "@/lib/savedRoutes";
import {
  setRouteEntries,
  setActiveLoadedRoute,
} from "@/lib/plannerRouteStore";
import {
  HYBRID_LABEL_TILE_ATTRIBUTION,
  HYBRID_LABEL_TILE_URL,
  type RouteEntry,
} from "@/lib/routing";

// Mirror the global declaration pattern used in PlannerMap.tsx so
// `window.L` is typed against the installed `@types/leaflet` instead
// of leaking `any` into every component that touches the Leaflet API.
declare global {
  interface Window {
    L: typeof import("leaflet");
  }
}

const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
  6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
};

function trailColor(diff: number | null | undefined): string {
  return DIFFICULTY_COLORS[diff ?? 5] ?? "#fbbf24";
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "";
  }
}

interface Props {
  routeId: string;
  /**
   * Initial route shape from the Discover list — when present, the
   * sheet renders immediately with cached data and refetches in the
   * background to pick up like/comment counts that may have ticked up
   * since the list was last loaded.
   */
  initial?: SavedRouteSummary | null;
  onClose: () => void;
}

/**
 * Detail view for a published route — opened from Discover or via a
 * deep link. Renders a Leaflet polyline preview of every visible trail
 * in route order, the ordered trail list, like + comment threads, and
 * a "Follow this route" button that hands the route off to the planner.
 *
 * Visibility of each trail is enforced server-side; if the viewer
 * couldn't see one of the trails it's stripped from the response and
 * `hiddenTrailCount` triggers an inline "X trails hidden" notice so
 * the rider isn't left wondering why the polyline ends abruptly.
 */
export default function RouteDetailSheet({ routeId, initial, onClose }: Props) {
  const { isSignedIn, isModerator } = useCurrentUser();
  const [, setLocation] = useLocation();
  const leafletReady = useLeaflet();

  const [route, setRoute] = useState<SavedRouteSummary | null>(initial ?? null);
  const [loading, setLoading] = useState(!initial);
  const [liking, setLiking] = useState(false);

  const [comments, setComments] = useState<RouteComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentDraft, setCommentDraft] = useState("");
  const [replyTo, setReplyTo] = useState<RouteComment | null>(null);
  const [postingComment, setPostingComment] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [openTrail, setOpenTrail] = useState<Trail | null>(null);

  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LMap | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fetched = await fetchPublishedRoute(routeId);
      if (cancelled) return;
      if (fetched) setRoute(fetched);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [routeId, isSignedIn]);

  useEffect(() => {
    let cancelled = false;
    setCommentsLoading(true);
    void (async () => {
      const list = await listRouteComments(routeId);
      if (cancelled) return;
      setComments(list);
      setCommentsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [routeId]);

  useEffect(() => {
    if (!leafletReady) return;
    if (!mapEl.current) return;
    if (!route) return;
    const L = window.L;
    if (!mapRef.current) {
      const map = L.map(mapEl.current, {
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: false,
      }).setView([54, -2], 6);
      // Mirror PlannerMap's tile setup so the preview pulls from the same
      // Esri satellite + hybrid label sources as the rest of the app. The
      // service worker (`public/sw.js`) caches `server.arcgisonline.com`
      // tiles, so a route the rider has already viewed elsewhere paints
      // instantly here without hitting the network.
      L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { attribution: "Tiles © Esri", maxZoom: 19 },
      ).addTo(map);
      L.tileLayer(HYBRID_LABEL_TILE_URL, {
        attribution: HYBRID_LABEL_TILE_ATTRIBUTION,
        maxZoom: 19,
        pane: "shadowPane",
        opacity: 0.95,
      }).addTo(map);
      mapRef.current = map;
    }
    const map = mapRef.current;
    // Clear previous polylines/markers before re-drawing.
    map.eachLayer((layer: Layer) => {
      if (layer instanceof L.Polyline || layer instanceof L.CircleMarker) {
        map.removeLayer(layer as Polyline | CircleMarker);
      }
    });
    const allLatLngs: Array<[number, number]> = [];
    let order = 0;
    for (const trail of route.trails) {
      const coords =
        (trail.path_geojson?.coordinates as Array<[number, number]> | undefined) ??
        parseSimplifiedPath(trail.simplified_path);
      if (!coords || coords.length === 0) continue;
      // GeoJSON is [lng, lat]; Leaflet wants [lat, lng].
      const latlngs = coords.map(([lng, lat]) => [lat, lng] as [number, number]);
      allLatLngs.push(...latlngs);
      const color = trailColor(trail.difficulty);
      L.polyline(latlngs, { color, weight: 4, opacity: 0.85 }).addTo(map);
      // Tiny numbered marker at each trail's start so the rider can
      // see the order at a glance.
      order += 1;
      const start = latlngs[0]!;
      L.circleMarker(start, {
        radius: 9,
        color: "#1a0e05",
        weight: 2,
        fillColor: color,
        fillOpacity: 1,
      })
        .addTo(map)
        .bindTooltip(String(order), {
          permanent: true,
          direction: "center",
          className: "tf-route-detail-marker",
        });
    }
    if (allLatLngs.length > 0) {
      map.fitBounds(allLatLngs, { padding: [20, 20] });
    }
  }, [leafletReady, route]);

  // Tear down the Leaflet instance when the sheet unmounts so a
  // re-open starts fresh.
  useEffect(() => {
    return () => {
      const map = mapRef.current;
      if (map) {
        map.remove();
        mapRef.current = null;
      }
    };
  }, []);

  const handleToggleLike = useCallback(async () => {
    if (!route) return;
    if (!isSignedIn) {
      setLocation("/sign-in");
      return;
    }
    setLiking(true);
    const next = !route.likedByMe;
    // Optimistic flip so the count animates immediately.
    setRoute((cur) =>
      cur
        ? {
            ...cur,
            likedByMe: next,
            likesCount: Math.max(0, cur.likesCount + (next ? 1 : -1)),
          }
        : cur,
    );
    const result = await likeRoute(route.id, next);
    setLiking(false);
    if (!result) {
      // Roll back on failure — leaves the UI honest about server state.
      setRoute((cur) =>
        cur
          ? {
              ...cur,
              likedByMe: !next,
              likesCount: Math.max(0, cur.likesCount + (next ? -1 : 1)),
            }
          : cur,
      );
      return;
    }
    setRoute((cur) =>
      cur ? { ...cur, likedByMe: result.liked, likesCount: result.likesCount } : cur,
    );
  }, [route, isSignedIn, setLocation]);

  const handlePostComment = useCallback(async () => {
    if (!route) return;
    if (!isSignedIn) {
      setLocation("/sign-in");
      return;
    }
    const trimmed = commentDraft.trim();
    if (trimmed.length === 0) return;
    setPostingComment(true);
    setCommentError(null);
    const created = await postRouteComment(
      route.id,
      trimmed,
      replyTo?.id ?? null,
    );
    setPostingComment(false);
    if (!created) {
      setCommentError("Couldn't post comment");
      return;
    }
    setComments((prev) => [...prev, created]);
    setRoute((cur) =>
      cur ? { ...cur, commentsCount: cur.commentsCount + 1 } : cur,
    );
    setCommentDraft("");
    setReplyTo(null);
  }, [commentDraft, replyTo, route, isSignedIn, setLocation]);

  const handleDeleteComment = useCallback(
    async (comment: RouteComment) => {
      const ok = await deleteRouteComment(routeId, comment.id);
      if (!ok) return;
      setComments((prev) => prev.filter((c) => c.id !== comment.id));
      setRoute((cur) =>
        cur
          ? { ...cur, commentsCount: Math.max(0, cur.commentsCount - 1) }
          : cur,
      );
    },
    [routeId],
  );

  const handleEditComment = useCallback(
    async (comment: RouteComment, body: string): Promise<boolean> => {
      const trimmed = body.trim();
      if (trimmed.length === 0 || trimmed === comment.body) return false;
      const updated = await updateRouteComment(routeId, comment.id, trimmed);
      if (!updated) return false;
      setComments((prev) =>
        prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)),
      );
      return true;
    },
    [routeId],
  );

  const handleFollowRoute = useCallback(() => {
    if (!route) return;
    if (!isSignedIn) {
      setLocation("/sign-in");
      return;
    }
    if (route.trails.length === 0) return;
    const trailById = new Map<string, Trail>(
      route.trails.map((t) => [t.id, t]),
    );
    const wpById = new Map(route.waypoints.map((w) => [w.id, w]));
    const order =
      route.entryOrder.length > 0
        ? route.entryOrder
        : [
            ...route.trailIds.map((id) => ({ kind: "trail" as const, id })),
            ...route.waypoints.map((w) => ({
              kind: "waypoint" as const,
              id: w.id,
            })),
          ];
    const entries: RouteEntry[] = [];
    for (const ref of order) {
      if (ref.kind === "trail") {
        const t = trailById.get(ref.id);
        if (t) entries.push({ kind: "trail", trail: t });
      } else {
        const w = wpById.get(ref.id);
        if (w) entries.push({ kind: "waypoint", waypoint: w });
      }
    }
    setRouteEntries(entries);
    setActiveLoadedRoute(route.id, route.name);
    setLocation("/planner");
  }, [route, isSignedIn, setLocation]);

  const topLevel = comments.filter((c) => !c.parentId);
  const childrenOf = (id: string) =>
    comments.filter((c) => c.parentId === id);

  return (
    <>
    <div
      className="fixed inset-0 z-[2600] flex items-end justify-center"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Route detail"
      data-testid="route-detail-sheet"
    >
      <div
        className="w-full max-w-md bg-[hsl(22,15%,9%)] border-t border-amber-500/30 rounded-t-2xl flex flex-col"
        style={{ maxHeight: "92vh" }}
      >
        <div className="flex items-start justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-amber-400 uppercase tracking-widest truncate">
              {route?.name ?? "Loading…"}
            </h3>
            {route && (
              <>
                <div className="flex flex-wrap items-center gap-1.5 mt-1">
                  {route.rideType && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wider text-amber-300 bg-amber-900/30 border border-amber-500/30">
                      {RIDE_TYPE_LABEL[route.rideType]}
                    </span>
                  )}
                  <span className="text-[11px] text-stone-400">
                    {route.trails.length} trail
                    {route.trails.length !== 1 ? "s" : ""}
                  </span>
                  {route.totalDistanceKm != null && (
                    <>
                      <span className="text-[11px] text-stone-600">·</span>
                      <span className="text-[11px] text-amber-400">
                        {route.totalDistanceKm.toFixed(1)} km
                      </span>
                    </>
                  )}
                </div>
                {route.ownerName && (
                  <p
                    className="text-[10px] text-stone-500 mt-0.5 truncate"
                    data-testid="route-detail-owner"
                  >
                    by {route.ownerName}
                  </p>
                )}
              </>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close route detail"
            data-testid="route-detail-close"
            className="w-8 h-8 rounded-full bg-stone-800 flex items-center justify-center text-stone-400 hover:text-stone-200 transition-colors shrink-0 ml-2"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {loading && !route ? (
            <div className="text-center py-10 text-xs text-stone-500">
              Loading route…
            </div>
          ) : !route ? (
            <div className="text-center py-10 text-xs text-stone-500">
              Couldn't load this route.
            </div>
          ) : (
            <>
              {/* Map polyline preview */}
              <div
                ref={mapEl}
                className="w-full h-48 bg-stone-900"
                data-testid="route-detail-map"
              />

              {route.hiddenTrailCount > 0 && (
                <div
                  className="mx-4 mt-3 px-3 py-2 rounded-lg bg-amber-900/30 border border-amber-500/30 text-[11px] text-amber-200"
                  data-testid="route-detail-hidden-notice"
                >
                  {route.hiddenTrailCount} trail
                  {route.hiddenTrailCount !== 1 ? "s" : ""} hidden — you don't
                  have access to {route.hiddenTrailCount === 1 ? "it" : "them"}.
                </div>
              )}

              {route.description && (
                <p
                  className="px-4 mt-3 text-xs text-stone-300 whitespace-pre-line"
                  data-testid="route-detail-description"
                >
                  {route.description}
                </p>
              )}

              {/* Action row: like + follow-route */}
              <div className="px-4 mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleToggleLike()}
                  disabled={liking}
                  data-testid="route-detail-like"
                  className={
                    "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border transition-colors disabled:opacity-50 " +
                    (route.likedByMe
                      ? "border-red-500/50 text-red-300 bg-red-500/10"
                      : "border-stone-700 text-stone-300 hover:border-red-500/40")
                  }
                >
                  <svg
                    viewBox="0 0 24 24"
                    className={`w-4 h-4 ${route.likedByMe ? "fill-red-500 stroke-red-500" : "stroke-current"}`}
                    fill="none"
                    strokeWidth="2"
                  >
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                  </svg>
                  {route.likesCount}
                </button>
                <button
                  type="button"
                  onClick={handleFollowRoute}
                  disabled={route.trails.length === 0}
                  data-testid="route-detail-follow"
                  className="flex-1 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
                  style={{
                    background:
                      route.trails.length === 0
                        ? "hsl(22,15%,16%)"
                        : "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)",
                  }}
                >
                  Follow this route
                </button>
              </div>

              {/* Ordered trail list */}
              <div className="px-4 mt-4">
                <h4 className="text-[11px] font-bold uppercase tracking-widest text-stone-400 mb-2">
                  Trails in order
                </h4>
                {route.trails.length === 0 ? (
                  <p className="text-xs text-stone-500">
                    No visible trails in this route.
                  </p>
                ) : (
                  <ol className="space-y-2" data-testid="route-detail-trail-list">
                    {route.trails.map((trail, idx) => {
                      const diff = trail.difficulty ?? 5;
                      return (
                        <li key={trail.id}>
                          <button
                            type="button"
                            onClick={() => setOpenTrail(trail)}
                            data-testid={`route-detail-trail-${trail.id}`}
                            aria-label={`Open ${trail.name} details`}
                            className="w-full text-left flex items-center gap-2 bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-lg p-2 hover:border-amber-500/40 transition-colors"
                          >
                            <span className="text-[11px] font-bold text-stone-500 w-5 text-center">
                              {idx + 1}
                            </span>
                            <span
                              className="w-5 h-5 rounded text-[10px] font-bold text-black flex items-center justify-center shrink-0"
                              style={{ backgroundColor: trailColor(diff) }}
                            >
                              {diff}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm text-stone-100 truncate font-semibold">
                                {trail.name}
                              </p>
                              <p className="text-[10px] text-stone-500">
                                {trail.distance_km != null
                                  ? `${trail.distance_km.toFixed(1)} km · `
                                  : ""}
                                {trail.legal_status || trail.type || "Trail"}
                              </p>
                            </div>
                            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-stone-500 shrink-0" fill="none" strokeWidth="2.2">
                              <polyline points="9 18 15 12 9 6" />
                            </svg>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>

              {/* Comments */}
              <div className="px-4 mt-5 mb-4">
                <h4 className="text-[11px] font-bold uppercase tracking-widest text-stone-400 mb-2">
                  Comments ({route.commentsCount})
                </h4>
                {commentsLoading ? (
                  <p className="text-xs text-stone-500">Loading…</p>
                ) : topLevel.length === 0 ? (
                  <p className="text-xs text-stone-500">No comments yet.</p>
                ) : (
                  <div
                    className="space-y-3"
                    data-testid="route-detail-comments"
                  >
                    {topLevel.map((c) => (
                      <CommentBlock
                        key={c.id}
                        comment={c}
                        replies={childrenOf(c.id)}
                        canModerate={isModerator}
                        onReply={setReplyTo}
                        onDelete={handleDeleteComment}
                        onEdit={handleEditComment}
                      />
                    ))}
                  </div>
                )}

                {/* Composer */}
                <div className="mt-3">
                  {replyTo && (
                    <div className="flex items-center justify-between text-[10px] text-stone-500 mb-1">
                      <span>
                        Replying to {replyTo.authorName ?? "rider"}
                      </span>
                      <button
                        type="button"
                        onClick={() => setReplyTo(null)}
                        className="text-amber-400 hover:text-amber-300"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  <textarea
                    value={commentDraft}
                    onChange={(e) => {
                      setCommentDraft(e.target.value);
                      if (commentError) setCommentError(null);
                    }}
                    rows={2}
                    maxLength={2000}
                    placeholder={
                      isSignedIn
                        ? "Add a comment…"
                        : "Sign in to comment"
                    }
                    disabled={!isSignedIn || postingComment}
                    data-testid="route-detail-comment-input"
                    className="w-full px-3 py-2 rounded-lg bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] text-stone-100 text-xs placeholder-stone-600 focus:outline-none focus:border-amber-500/60 resize-none disabled:opacity-60"
                  />
                  {commentError && (
                    <p className="text-[10px] text-red-400 mt-1">
                      {commentError}
                    </p>
                  )}
                  <div className="flex justify-end mt-1">
                    <button
                      type="button"
                      onClick={() =>
                        isSignedIn
                          ? void handlePostComment()
                          : setLocation("/sign-in")
                      }
                      disabled={
                        postingComment ||
                        (isSignedIn && commentDraft.trim().length === 0)
                      }
                      data-testid="route-detail-comment-submit"
                      className="px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
                      style={{
                        background:
                          "linear-gradient(135deg, #d4870c, #f0a832)",
                      }}
                    >
                      {postingComment
                        ? "Posting…"
                        : isSignedIn
                          ? "Post"
                          : "Sign in"}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
    {openTrail && (
      <TrailDetailSheet
        trail={openTrail}
        onClose={() => setOpenTrail(null)}
      />
    )}
    </>
  );
}

function CommentBlock({
  comment,
  replies,
  canModerate,
  onReply,
  onDelete,
  onEdit,
}: {
  comment: RouteComment;
  replies: RouteComment[];
  canModerate: boolean;
  onReply: (c: RouteComment) => void;
  onDelete: (c: RouteComment) => void;
  onEdit: (c: RouteComment, body: string) => Promise<boolean>;
}) {
  return (
    <div data-testid={`route-detail-comment-${comment.id}`}>
      <CommentRow
        comment={comment}
        canModerate={canModerate}
        onReply={onReply}
        onDelete={onDelete}
        onEdit={onEdit}
      />
      {replies.length > 0 && (
        <div className="ml-5 mt-2 space-y-2 border-l border-stone-800 pl-3">
          {replies.map((r) => (
            <div
              key={r.id}
              data-testid={`route-detail-comment-${r.id}`}
            >
              <CommentRow
                comment={r}
                canModerate={canModerate}
                onDelete={onDelete}
                onEdit={onEdit}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Single comment row (top-level or reply). Owns its own edit-mode
 * state so toggling one comment's editor doesn't disturb siblings.
 */
function CommentRow({
  comment,
  canModerate,
  onReply,
  onDelete,
  onEdit,
}: {
  comment: RouteComment;
  canModerate: boolean;
  onReply?: (c: RouteComment) => void;
  onDelete: (c: RouteComment) => void;
  onEdit: (c: RouteComment, body: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft(comment.body);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft(comment.body);
  };
  const saveEdit = async () => {
    setSaving(true);
    const ok = await onEdit(comment, draft);
    setSaving(false);
    if (ok) setEditing(false);
  };

  return (
    <div className="bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-lg p-2">
      <div className="flex items-baseline justify-between gap-2 mb-0.5">
        <span className="text-[11px] font-bold text-stone-200 truncate">
          {comment.authorName ?? "Rider"}
        </span>
        <span className="text-[10px] text-stone-500 shrink-0">
          {formatTimeAgo(comment.createdAt)}
        </span>
      </div>
      {editing ? (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            className="w-full bg-[hsl(22,15%,9%)] border border-amber-500/30 rounded-md px-2 py-1 text-xs text-stone-100 placeholder-stone-600 focus:outline-none focus:border-amber-500"
            data-testid={`route-detail-comment-edit-input-${comment.id}`}
          />
          <div className="flex gap-2 mt-1 text-[10px]">
            <button
              type="button"
              onClick={saveEdit}
              disabled={saving || draft.trim().length === 0}
              className="text-amber-400 hover:text-amber-300 disabled:opacity-50"
              data-testid={`route-detail-comment-edit-save-${comment.id}`}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="text-stone-400 hover:text-stone-300"
              data-testid={`route-detail-comment-edit-cancel-${comment.id}`}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <p className="text-xs text-stone-200 whitespace-pre-line break-words">
          {comment.body}
        </p>
      )}
      {!editing && (
        <div className="flex gap-3 mt-1 text-[10px]">
          {onReply && (
            <button
              type="button"
              onClick={() => onReply(comment)}
              className="text-amber-400 hover:text-amber-300"
              data-testid={`route-detail-comment-reply-${comment.id}`}
            >
              Reply
            </button>
          )}
          {comment.mine && (
            <>
              <button
                type="button"
                onClick={startEdit}
                className="text-amber-400 hover:text-amber-300"
                data-testid={`route-detail-comment-edit-${comment.id}`}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => onDelete(comment)}
                className="text-red-400 hover:text-red-300"
                data-testid={`route-detail-comment-delete-${comment.id}`}
              >
                Delete
              </button>
            </>
          )}
          {/* Moderator-only "Hide" affordance — surfaced on others'
              comments so a moderator can take a row down without
              switching to an admin view. The server re-checks
              `users.is_moderator` and soft-hides via `hidden_at`,
              so the UI flag is purely a hint. */}
          {!comment.mine && canModerate && (
            <button
              type="button"
              onClick={() => onDelete(comment)}
              className="text-red-400 hover:text-red-300"
              data-testid={`route-detail-comment-hide-${comment.id}`}
              title="Hide this comment as a moderator"
            >
              Hide
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Best-effort decoder for the `simplified_path` column. Some trails
 * persist it as a JSON-stringified `[ [lng,lat], ... ]`; older rows
 * may store a polyline-encoded string. We try JSON first and fall
 * back to ignoring the field — the polyline preview is best-effort.
 */
function parseSimplifiedPath(
  raw: string | null | undefined,
): Array<[number, number]> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
      return parsed as Array<[number, number]>;
    }
  } catch {
    /* fall through */
  }
  return null;
}
