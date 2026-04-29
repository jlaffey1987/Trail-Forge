import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { type Trail } from "@/lib/supabase";

const STORAGE_KEY = "trailforge_planner_route";

// ---------------------------------------------------------------------------
// Storage shape
//
// We persist `{ ownerId, trails }` so that we know which identity built the
// in-memory route. `ownerId === null` means "anonymous local" — fine to show
// to anyone on the device. A non-null ownerId belongs to a specific Clerk
// user and must never be displayed to (or auto-uploaded by) a different
// account on a shared device. For backward compatibility a bare array is
// treated as anonymous.
// ---------------------------------------------------------------------------

interface StoredRoute {
  ownerId: string | null;
  trails: Trail[];
}

function loadStored(): StoredRoute {
  if (typeof window === "undefined") return { ownerId: null, trails: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ownerId: null, trails: [] };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { ownerId: null, trails: parsed as Trail[] };
    }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.trails)) {
      const ownerId =
        typeof parsed.ownerId === "string" && parsed.ownerId.length > 0
          ? parsed.ownerId
          : null;
      return { ownerId, trails: parsed.trails as Trail[] };
    }
  } catch {/**/}
  return { ownerId: null, trails: [] };
}

const initial = loadStored();

// On boot we always start with an empty in-memory route and only surface the
// persisted data once Clerk has confirmed who is signed in. This avoids
// flashing a previous user's planner on a shared device and prevents any
// possibility of silently donating their route to whoever signs in next.
let routeTrails: Trail[] = [];
let localOwnerId: string | null = initial.ownerId;
let pendingRestore: Trail[] | null = initial.trails.length > 0 ? initial.trails : null;

const listeners = new Set<(trails: Trail[]) => void>();

let currentUserId: string | null = null;
let hasAuthSettled = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 600;

function persist() {
  if (typeof window === "undefined") return;
  try {
    const payload: StoredRoute = { ownerId: localOwnerId, trails: routeTrails };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {/**/}
}

function clearStorage() {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(STORAGE_KEY); } catch {/**/}
}

function emit() {
  for (const l of listeners) {
    try { l(routeTrails); } catch {/**/}
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
  try {
    const res = await fetch("/api/me/planner-route", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trailIds }),
    });
    if (!res.ok) {
      // Don't surface to the user — localStorage still has the route.
      // 401 just means the session isn't fully ready yet; we'll re-sync
      // on the next change.
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
  updatedAt: string | null;
}

async function fetchRouteFromCloudOnce(): Promise<
  { ok: true; route: CloudPlannerRoute }
  | { ok: false; transient: boolean }
> {
  try {
    const res = await fetch("/api/me/planner-route", {
      credentials: "include",
    });
    if (!res.ok) {
      // 401 = session not ready; not really transient — re-runs on next
      // setPlannerRouteUserId. 5xx and network errors are worth a retry.
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

/**
 * Hydrate the cloud route, retrying once after a short delay on a
 * transient failure. Without this a single 5xx or offline blip during
 * sign-in would leave the user without their route until the next
 * auth-state change.
 */
async function fetchRouteFromCloud(): Promise<CloudPlannerRoute | null> {
  const first = await fetchRouteFromCloudOnce();
  if (first.ok) return first.route;
  if (!first.transient) return null;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const second = await fetchRouteFromCloudOnce();
  return second.ok ? second.route : null;
}

/**
 * Tell the store which Clerk user is currently signed in. Pass `null` when
 * the user signs out (or for anonymous sessions). On first call, surface
 * the previously-persisted route only if it actually belonged to this
 * identity (anonymous local for `null`, matching `ownerId` for a signed-in
 * user). On any account switch — A → null, A → B, null → B-with-foreign-data
 * — drop the previous identity's local data immediately so it cannot leak
 * to or be auto-uploaded by the new account.
 *
 * After identity is established and `userId !== null`, hydrate from the
 * cloud (server wins if non-empty), otherwise push the now-claimed local
 * route up so the next device can pick it up.
 */
export function setPlannerRouteUserId(userId: string | null): void {
  // Skip duplicate calls once auth has settled and the id hasn't changed.
  if (hasAuthSettled && userId === currentUserId) return;

  // The persisted route is "ours" iff it was anonymous (any identity is
  // welcome to claim it) or it was last saved by exactly this user.
  const matchesLocal = localOwnerId === null || localOwnerId === userId;

  if (!matchesLocal) {
    // Previous owner was a different signed-in user — drop everything,
    // including the in-memory state that was held back at boot.
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    routeTrails = [];
    localOwnerId = null;
    pendingRestore = null;
    clearStorage();
    emit();
  } else if (pendingRestore !== null) {
    // Same identity (or anonymous-to-anonymous) and we held the data back
    // at boot for verification — surface it now.
    routeTrails = pendingRestore;
    pendingRestore = null;
    emit();
  }

  currentUserId = userId;
  hasAuthSettled = true;

  if (!userId) {
    // Anonymous mode — nothing else to do. Local-only writes will continue
    // to persist (with `ownerId: null`) and survive reloads on this device.
    return;
  }

  // Capture whether this user has previously synced with the cloud on this
  // device. This is the key to disambiguating two cloud-empty cases:
  //   - "first sign-in adoption" (no prior claim): push local route up so
  //     anonymous-built trails are adopted into the new cloud row.
  //   - "explicit clear from another device" (already claimed): treat the
  //     empty cloud as authoritative and clear local. Without this, a stale
  //     local copy on Device B would silently re-upload after Device A
  //     cleared the route.
  const wasAlreadyClaimedByThisUser = localOwnerId === userId;

  // Hydrate from cloud asynchronously. Snapshot the (now-trustworthy) local
  // route up-front so a write that arrives during the in-flight fetch can
  // still be pushed.
  const localSnapshot = routeTrails.slice();
  void (async () => {
    const remote = await fetchRouteFromCloud();
    // The user might have signed out (or switched accounts) while the fetch
    // was in flight — bail in that case.
    if (currentUserId !== userId) return;

    if (remote === null) {
      // Couldn't reach the cloud (network/5xx after retry, or 401). Keep
      // whatever's in memory; the next mutation will trigger another PUT.
      return;
    }

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
      localOwnerId = userId;
      persist();
      emit();
    }

    if (wasAlreadyClaimedByThisUser) {
      // The user has prior cloud history on this device, so the cloud row
      // is the source of truth — including the empty case (a clear from
      // another device must propagate, not be undone by stale local).
      adoptRemote(remote);
      return;
    }

    // First sign-in for this account on this device. Server-wins if the
    // cloud already has data (cross-device restore); otherwise push the
    // local snapshot up to seed the new account.
    if (remote.trailIds.length > 0) {
      adoptRemote(remote);
      return;
    }

    localOwnerId = userId;
    if (routeTrails.length > 0 || localSnapshot.length > 0) {
      persist();
      scheduleCloudSync();
    } else {
      // Even an empty route benefits from being persisted with the right
      // owner so future reloads-without-network don't trip the ownership
      // check above.
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

function noteWrite() {
  // Any user-driven write supersedes the held-back boot data: keeping
  // pendingRestore around would let stale data clobber a fresh write once
  // Clerk settles. Also claim ownership for the currently-known identity
  // so the persisted blob never lies about who built it.
  pendingRestore = null;
  localOwnerId = currentUserId;
}

export function setRouteTrails(next: Trail[]) {
  routeTrails = next;
  noteWrite();
  persist();
  emit();
  scheduleCloudSync();
}

export function addRouteTrail(trail: Trail) {
  if (routeTrails.some((t) => t.id === trail.id)) return;
  routeTrails = [...routeTrails, trail];
  noteWrite();
  persist();
  emit();
  scheduleCloudSync();
}

export function removeRouteTrail(trailId: string) {
  routeTrails = routeTrails.filter((t) => t.id !== trailId);
  noteWrite();
  persist();
  emit();
  scheduleCloudSync();
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
