import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { type Trail } from "@/lib/supabase";
import { type RouteEntry, type RouteWaypoint } from "@/lib/routing";

const STORAGE_KEY = "trailforge_planner_route";

// ---------------------------------------------------------------------------
// Storage shape
//
// We persist `{ ownerId, trails, waypoints, entryOrder }` so that we know
// which identity built the in-memory route.
//
// `ownerId === null`: anonymous local — fine to show to anyone on the device.
// A non-null ownerId belongs to a specific Clerk user and must never be
// displayed to (or auto-uploaded by) a different account on a shared device.
//
// `entryOrder` is the ordered list of `{kind:'trail'|'waypoint', id}` so we
// can interleave waypoints between trails (a campsite stop between trail 1
// and trail 2). If absent (older blobs, or array-only legacy), we fall back
// to "trails first, waypoints appended" — preserves Phase A semantics.
// ---------------------------------------------------------------------------

export type StoredEntryRef =
  | { kind: "trail"; id: string }
  | { kind: "waypoint"; id: string };

interface StoredRoute {
  ownerId: string | null;
  trails: Trail[];
  waypoints: RouteWaypoint[];
  entryOrder: StoredEntryRef[];
}

function emptyStored(): StoredRoute {
  return { ownerId: null, trails: [], waypoints: [], entryOrder: [] };
}

function loadStored(): StoredRoute {
  if (typeof window === "undefined") return emptyStored();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStored();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // Pre-Phase-A legacy: bare Trail[]. Treat as anonymous.
      const trails = parsed as Trail[];
      return {
        ownerId: null,
        trails,
        waypoints: [],
        entryOrder: trails.map((t) => ({ kind: "trail", id: t.id })),
      };
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const ownerId =
        typeof obj.ownerId === "string" && obj.ownerId.length > 0
          ? obj.ownerId
          : null;
      const trails = Array.isArray(obj.trails) ? (obj.trails as Trail[]) : [];
      const waypoints = Array.isArray(obj.waypoints)
        ? (obj.waypoints as RouteWaypoint[])
        : [];
      const order = Array.isArray(obj.entryOrder)
        ? (obj.entryOrder as StoredEntryRef[]).filter(
            (e) =>
              e &&
              typeof e === "object" &&
              (e.kind === "trail" || e.kind === "waypoint") &&
              typeof e.id === "string",
          )
        : null;
      // Default order: trails in their array order, then waypoints. Matches
      // Phase A's semantics where waypoints didn't exist yet.
      const fallback: StoredEntryRef[] = [
        ...trails.map((t) => ({ kind: "trail" as const, id: t.id })),
        ...waypoints.map((w) => ({ kind: "waypoint" as const, id: w.id })),
      ];
      return { ownerId, trails, waypoints, entryOrder: order ?? fallback };
    }
  } catch {
    /**/
  }
  return emptyStored();
}

const initial = loadStored();

// On boot we always start with an empty in-memory route and only surface the
// persisted data once Clerk has confirmed who is signed in. This avoids
// flashing a previous user's planner on a shared device and prevents any
// possibility of silently donating their route to whoever signs in next.
let routeTrails: Trail[] = [];
let routeWaypoints: RouteWaypoint[] = [];
let entryOrder: StoredEntryRef[] = [];
let localOwnerId: string | null = initial.ownerId;
let pendingRestore: StoredRoute | null =
  initial.trails.length > 0 || initial.waypoints.length > 0 ? initial : null;

const trailListeners = new Set<(trails: Trail[]) => void>();
const entryListeners = new Set<(entries: RouteEntry[]) => void>();

let currentUserId: string | null = null;
let hasAuthSettled = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 600;

function buildEntries(): RouteEntry[] {
  const trailById = new Map(routeTrails.map((t) => [t.id, t] as const));
  const wpById = new Map(routeWaypoints.map((w) => [w.id, w] as const));
  const out: RouteEntry[] = [];
  const seen = new Set<string>();
  for (const ref of entryOrder) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.kind === "trail") {
      const t = trailById.get(ref.id);
      if (t) out.push({ kind: "trail", trail: t });
    } else {
      const w = wpById.get(ref.id);
      if (w) out.push({ kind: "waypoint", waypoint: w });
    }
  }
  return out;
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    const payload: StoredRoute = {
      ownerId: localOwnerId,
      trails: routeTrails,
      waypoints: routeWaypoints,
      entryOrder,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /**/
  }
}

function clearStorage() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /**/
  }
}

function emit() {
  for (const l of trailListeners) {
    try {
      l(routeTrails);
    } catch {
      /**/
    }
  }
  const entries = buildEntries();
  for (const l of entryListeners) {
    try {
      l(entries);
    } catch {
      /**/
    }
  }
}

/**
 * Push the current route up to the server, debounced. No-op when signed out.
 * Failures are swallowed (and logged) so a flaky network can't lose the
 * locally-cached route — the next successful PUT will reconcile.
 */
function scheduleCloudSync() {
  if (typeof window === "undefined") return;
  if (!currentUserId) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void pushRouteToCloud();
  }, SYNC_DEBOUNCE_MS);
}

async function pushRouteToCloud(): Promise<void> {
  if (!currentUserId) return;
  const trailIds = routeTrails.map((t) => t.id);
  const waypoints = routeWaypoints;
  try {
    const res = await fetch("/api/me/planner-route", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trailIds, waypoints, entryOrder }),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn("[plannerRouteStore] cloud sync failed:", res.status);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[plannerRouteStore] cloud sync error:", err);
  }
}

interface CloudPlannerRoute {
  trailIds: string[];
  trails: Trail[];
  waypoints?: RouteWaypoint[];
  entryOrder?: StoredEntryRef[];
  updatedAt: string | null;
}

async function fetchRouteFromCloudOnce(): Promise<
  | { ok: true; route: CloudPlannerRoute }
  | { ok: false; transient: boolean }
> {
  try {
    const res = await fetch("/api/me/planner-route", {
      credentials: "include",
    });
    if (!res.ok) {
      const transient = res.status >= 500;
      if (res.status !== 401) {
        // eslint-disable-next-line no-console
        console.warn("[plannerRouteStore] cloud fetch failed:", res.status);
      }
      return { ok: false, transient };
    }
    const route = (await res.json()) as CloudPlannerRoute;
    return { ok: true, route };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[plannerRouteStore] cloud fetch error:", err);
    return { ok: false, transient: true };
  }
}

async function fetchRouteFromCloud(): Promise<CloudPlannerRoute | null> {
  const first = await fetchRouteFromCloudOnce();
  if (first.ok) return first.route;
  if (!first.transient) return null;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const second = await fetchRouteFromCloudOnce();
  return second.ok ? second.route : null;
}

export function setPlannerRouteUserId(userId: string | null): void {
  if (hasAuthSettled && userId === currentUserId) return;

  const matchesLocal = localOwnerId === null || localOwnerId === userId;

  if (!matchesLocal) {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    routeTrails = [];
    routeWaypoints = [];
    entryOrder = [];
    localOwnerId = null;
    pendingRestore = null;
    clearStorage();
    emit();
  } else if (pendingRestore !== null) {
    routeTrails = pendingRestore.trails;
    routeWaypoints = pendingRestore.waypoints;
    entryOrder = pendingRestore.entryOrder;
    pendingRestore = null;
    emit();
  }

  currentUserId = userId;
  hasAuthSettled = true;

  if (!userId) return;

  const wasAlreadyClaimedByThisUser = localOwnerId === userId;
  const localSnapshot = {
    trails: routeTrails.slice(),
    waypoints: routeWaypoints.slice(),
    entryOrder: entryOrder.slice(),
  };

  void (async () => {
    const remote = await fetchRouteFromCloud();
    if (currentUserId !== userId) return;
    if (remote === null) return;

    function adoptRemote(r: CloudPlannerRoute) {
      const byId = new Map<string, Trail>();
      for (const t of r.trails) byId.set(t.id, t);
      routeTrails = r.trailIds.map((id) => {
        const hydrated = byId.get(id);
        if (hydrated) return hydrated;
        return {
          id,
          user_id: null,
          name: "Unavailable trail",
          type: null,
          difficulty: null,
          distance_km: null,
          terrain: null,
          legal_status: null,
          is_public: false,
          created_at: new Date().toISOString(),
        } satisfies Trail;
      });
      routeWaypoints = Array.isArray(r.waypoints) ? r.waypoints : [];
      entryOrder = Array.isArray(r.entryOrder) && r.entryOrder.length > 0
        ? r.entryOrder
        : [
            ...routeTrails.map((t) => ({ kind: "trail" as const, id: t.id })),
            ...routeWaypoints.map((w) => ({
              kind: "waypoint" as const,
              id: w.id,
            })),
          ];
      localOwnerId = userId;
      persist();
      emit();
    }

    if (wasAlreadyClaimedByThisUser) {
      adoptRemote(remote);
      return;
    }

    if (remote.trailIds.length > 0 || (remote.waypoints?.length ?? 0) > 0) {
      adoptRemote(remote);
      return;
    }

    localOwnerId = userId;
    if (
      routeTrails.length > 0 ||
      routeWaypoints.length > 0 ||
      localSnapshot.trails.length > 0 ||
      localSnapshot.waypoints.length > 0
    ) {
      persist();
      scheduleCloudSync();
    } else {
      persist();
    }
  })();
}

/** Test-only / sign-out hook to reset cloud-sync state. */
export function resetPlannerRouteCloudState(): void {
  currentUserId = null;
  hasAuthSettled = false;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  pendingRestore = null;
}

export function getRouteTrails(): Trail[] {
  return routeTrails;
}

export function getRouteEntries(): RouteEntry[] {
  return buildEntries();
}

function noteWrite() {
  pendingRestore = null;
  localOwnerId = currentUserId;
}

/**
 * Replace the trail list. Keeps existing waypoints attached to whichever
 * preceding trail they followed when possible; waypoints whose anchor
 * trail is removed (or that come after the new trail list ends) are
 * appended at the end. Passing `[]` clears EVERYTHING (including
 * waypoints) — that's the "Clear route" semantic both panels expect.
 */
export function setRouteTrails(next: Trail[]) {
  if (next.length === 0) {
    routeTrails = [];
    routeWaypoints = [];
    entryOrder = [];
    noteWrite();
    persist();
    emit();
    scheduleCloudSync();
    return;
  }

  // Preserve waypoint placement relative to surviving trails. Strategy:
  //   1. Walk the OLD entryOrder. For each trail entry, if it survives in
  //      `next`, emit it; collect any subsequent waypoints "owned" by this
  //      trail (i.e. they follow it in the old order).
  //   2. Reorder the surviving trail entries to match `next`. Each surviving
  //      trail keeps its trailing waypoint cluster.
  //   3. New trails (not in old entries) get appended at the end with no
  //      waypoint cluster.
  //   4. Waypoints that were ahead of the first surviving trail (or whose
  //      anchor was removed) are appended at the very end so they don't get
  //      lost — the user can re-position them via the planner panel.
  const survivingIds = new Set(next.map((t) => t.id));
  const trailClusters = new Map<string, StoredEntryRef[]>();
  const orphanWaypoints: StoredEntryRef[] = [];
  let currentTrailId: string | null = null;
  for (const ref of entryOrder) {
    if (ref.kind === "trail") {
      if (survivingIds.has(ref.id)) {
        currentTrailId = ref.id;
        if (!trailClusters.has(ref.id)) trailClusters.set(ref.id, []);
      } else {
        currentTrailId = null;
      }
    } else {
      if (currentTrailId !== null) {
        const cluster = trailClusters.get(currentTrailId);
        if (cluster) cluster.push(ref);
      } else {
        orphanWaypoints.push(ref);
      }
    }
  }

  const newOrder: StoredEntryRef[] = [];
  for (const t of next) {
    newOrder.push({ kind: "trail", id: t.id });
    const cluster = trailClusters.get(t.id);
    if (cluster) newOrder.push(...cluster);
  }
  newOrder.push(...orphanWaypoints);

  routeTrails = next;
  // Drop waypoints whose ids no longer appear in newOrder — defensive, but
  // also keeps state consistent if a caller hand-edits routeWaypoints.
  const orderedWpIds = new Set(
    newOrder.filter((r) => r.kind === "waypoint").map((r) => r.id),
  );
  routeWaypoints = routeWaypoints.filter((w) => orderedWpIds.has(w.id));
  entryOrder = newOrder;
  noteWrite();
  persist();
  emit();
  scheduleCloudSync();
}

export function addRouteTrail(trail: Trail) {
  if (routeTrails.some((t) => t.id === trail.id)) return;
  routeTrails = [...routeTrails, trail];
  entryOrder = [...entryOrder, { kind: "trail", id: trail.id }];
  noteWrite();
  persist();
  emit();
  scheduleCloudSync();
}

export function removeRouteTrail(trailId: string) {
  routeTrails = routeTrails.filter((t) => t.id !== trailId);
  entryOrder = entryOrder.filter(
    (r) => !(r.kind === "trail" && r.id === trailId),
  );
  noteWrite();
  persist();
  emit();
  scheduleCloudSync();
}

export function isInRoute(trailId: string): boolean {
  return routeTrails.some((t) => t.id === trailId);
}

/**
 * Insert a waypoint into the ordered route. If the route is empty (no
 * trails yet) the waypoint goes at position 0. If a `nearestTrailId` is
 * provided we slot the waypoint immediately after that trail entry —
 * matches the "stop between trail 1 and trail 2" mental model the POI
 * buttons promise. Without `nearestTrailId` we append at the end.
 */
export function addRouteWaypoint(
  waypoint: RouteWaypoint,
  opts?: { afterTrailId?: string | null },
) {
  // De-dupe by id (Overpass nodes are stable) so re-tapping the same POI
  // marker doesn't quietly create two waypoints in the route.
  if (routeWaypoints.some((w) => w.id === waypoint.id)) return;

  routeWaypoints = [...routeWaypoints, waypoint];

  const ref: StoredEntryRef = { kind: "waypoint", id: waypoint.id };
  let inserted = false;
  if (opts?.afterTrailId) {
    const idx = entryOrder.findIndex(
      (r) => r.kind === "trail" && r.id === opts.afterTrailId,
    );
    if (idx >= 0) {
      // Skip past any waypoints that already follow this trail so the
      // newest stop sits at the END of that trail's cluster.
      let insertAt = idx + 1;
      while (
        insertAt < entryOrder.length &&
        entryOrder[insertAt].kind === "waypoint"
      ) {
        insertAt++;
      }
      entryOrder = [
        ...entryOrder.slice(0, insertAt),
        ref,
        ...entryOrder.slice(insertAt),
      ];
      inserted = true;
    }
  }
  if (!inserted) entryOrder = [...entryOrder, ref];

  noteWrite();
  persist();
  emit();
  scheduleCloudSync();
}

export function removeRouteWaypoint(waypointId: string) {
  routeWaypoints = routeWaypoints.filter((w) => w.id !== waypointId);
  entryOrder = entryOrder.filter(
    (r) => !(r.kind === "waypoint" && r.id === waypointId),
  );
  noteWrite();
  persist();
  emit();
  scheduleCloudSync();
}

export function isWaypointInRoute(waypointId: string): boolean {
  return routeWaypoints.some((w) => w.id === waypointId);
}

/**
 * Replace the entire ordered list. Used by the planner's drag-to-reorder
 * UI which can shuffle trails AND waypoints together. The caller must
 * provide entries that reference existing trails/waypoints — we don't
 * accept new waypoint payloads here, only re-orderings.
 */
export function setRouteEntries(entries: RouteEntry[]) {
  const newTrails: Trail[] = [];
  const newWps: RouteWaypoint[] = [];
  const newOrder: StoredEntryRef[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.kind === "trail") {
      const key = `trail:${e.trail.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      newTrails.push(e.trail);
      newOrder.push({ kind: "trail", id: e.trail.id });
    } else {
      const key = `waypoint:${e.waypoint.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      newWps.push(e.waypoint);
      newOrder.push({ kind: "waypoint", id: e.waypoint.id });
    }
  }
  routeTrails = newTrails;
  routeWaypoints = newWps;
  entryOrder = newOrder;
  noteWrite();
  persist();
  emit();
  scheduleCloudSync();
}

export function subscribeRouteTrails(
  listener: (trails: Trail[]) => void,
): () => void {
  trailListeners.add(listener);
  return () => {
    trailListeners.delete(listener);
  };
}

export function subscribeRouteEntries(
  listener: (entries: RouteEntry[]) => void,
): () => void {
  entryListeners.add(listener);
  return () => {
    entryListeners.delete(listener);
  };
}

/** React hook for subscribing to the trail-only view of the route store. */
export function useRouteTrails(): [Trail[], Dispatch<SetStateAction<Trail[]>>] {
  const [trails, setTrails] = useState<Trail[]>(routeTrails);
  useEffect(() => {
    return subscribeRouteTrails(setTrails);
  }, []);
  const setter: Dispatch<SetStateAction<Trail[]>> = (next) => {
    const resolved =
      typeof next === "function"
        ? (next as (prev: Trail[]) => Trail[])(routeTrails)
        : next;
    setRouteTrails(resolved);
  };
  return [trails, setter];
}

/** React hook for the full ordered list including waypoints. */
export function useRouteEntries(): RouteEntry[] {
  const [entries, setEntries] = useState<RouteEntry[]>(buildEntries());
  useEffect(() => {
    return subscribeRouteEntries(setEntries);
  }, []);
  return entries;
}
