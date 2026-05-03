import { useEffect, useState } from "react";
import { type Trail } from "@/lib/supabase";

/**
 * Trail completions ("ridden" log) — client-side store.
 *
 * Mirrors plannerRouteStore's subscribe pattern so any UI that renders
 * a trail can show the "ridden" treatment without each component
 * re-fetching the list. The store is a Set of trail ids the signed-in
 * user has marked as ridden, plus richer rows for the My Trails
 * "Ridden" section.
 *
 * - `loadCompletions()` — fetch from the server. Called once per sign-in
 *   from `useCompletionsBootstrap` (mounted near the app root) and also
 *   by MyTrailsTab to refresh after a window-of-focus change.
 * - `markCompleted(trail)` / `unmarkCompleted(trailId)` — optimistic
 *   updates. On server failure the change is rolled back and `false` is
 *   returned so the caller can surface a toast.
 * - `subscribeCompletionIds(cb)` — get notified when the id set changes.
 * - `useCompletionState(trailId)` — convenience hook returning
 *   `{ completed, mark, unmark, busy }` for an individual trail card.
 */

export interface CompletionItem {
  id: string;
  trail_id: string;
  completed_at: string;
  note: string | null;
  trail: Trail | null;
}

interface ListResponse {
  items: CompletionItem[];
}

interface State {
  loaded: boolean;
  ids: Set<string>;
  items: CompletionItem[];
}

let state: State = { loaded: false, ids: new Set(), items: [] };
const subscribers = new Set<(s: State) => void>();

// Epoch is bumped on sign-out and after a successful load. Any in-flight
// `loadCompletions()` capture the epoch at start and ignore their own
// response if the epoch has moved on — prevents stale user-A data from
// repopulating after sign-out or a fast user-switch.
let epoch = 0;

function emit() {
  subscribers.forEach((cb) => cb(state));
}

function setState(next: State) {
  state = next;
  emit();
}

export function getCompletionIds(): Set<string> {
  return state.ids;
}

export function getCompletionItems(): CompletionItem[] {
  return state.items;
}

export function isCompletionsLoaded(): boolean {
  return state.loaded;
}

export function isCompleted(trailId: string): boolean {
  return state.ids.has(trailId);
}

export function subscribeCompletions(cb: (s: State) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function clearCompletions(): void {
  // Bump epoch so any in-flight load's response is ignored.
  epoch += 1;
  setState({ loaded: false, ids: new Set(), items: [] });
}

export async function loadCompletions(): Promise<void> {
  const myEpoch = epoch;
  try {
    const res = await fetch("/api/me/completions", { credentials: "include" });
    // Bail if we've signed out or the user switched while this was in flight.
    if (myEpoch !== epoch) return;
    if (!res.ok) {
      setState({ loaded: true, ids: new Set(), items: [] });
      return;
    }
    const body = (await res.json()) as ListResponse;
    if (myEpoch !== epoch) return;
    const items = body.items ?? [];
    setState({
      loaded: true,
      ids: new Set(items.map((it) => it.trail_id)),
      items,
    });
  } catch {
    if (myEpoch !== epoch) return;
    if (!state.loaded) setState({ loaded: true, ids: new Set(), items: [] });
  }
}

/**
 * Per-trail rollback: only revert THIS trail's optimistic change on
 * server failure rather than snapshotting the whole state. Prevents one
 * failed mutation from clobbering a concurrent successful change on a
 * different trail (e.g. user marks Trail A and Trail B in quick
 * succession; if A fails we must not undo B).
 */
function revertMark(trailId: string): void {
  const nextIds = new Set(state.ids);
  nextIds.delete(trailId);
  setState({
    loaded: true,
    ids: nextIds,
    items: state.items.filter((it) => it.trail_id !== trailId),
  });
}

function revertUnmark(trailId: string, item: CompletionItem | null): void {
  if (state.ids.has(trailId)) return;
  const nextIds = new Set(state.ids);
  nextIds.add(trailId);
  setState({
    loaded: true,
    ids: nextIds,
    items: item ? [item, ...state.items] : state.items,
  });
}

export async function markCompleted(
  trail: Trail,
  opts?: { completedAt?: string; note?: string },
): Promise<boolean> {
  const myEpoch = epoch;
  const wasCompleted = state.ids.has(trail.id);
  const stamp = opts?.completedAt ?? new Date().toISOString();
  if (!wasCompleted) {
    const optimistic: CompletionItem = {
      id: `optimistic-${trail.id}`,
      trail_id: trail.id,
      completed_at: stamp,
      note: opts?.note ?? null,
      trail,
    };
    setState({
      loaded: true,
      ids: new Set([trail.id, ...state.ids]),
      items: [optimistic, ...state.items],
    });
  }
  try {
    const body: Record<string, unknown> = { trailId: trail.id };
    if (opts?.completedAt) body.completedAt = opts.completedAt;
    if (opts?.note != null) body.note = opts.note;
    const res = await fetch("/api/me/completions", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (myEpoch !== epoch) return res.ok;
    if (!res.ok) {
      if (!wasCompleted) revertMark(trail.id);
      return false;
    }
    void loadCompletions();
    return true;
  } catch {
    if (myEpoch !== epoch) return false;
    if (!wasCompleted) revertMark(trail.id);
    return false;
  }
}

export async function unmarkCompleted(trailId: string): Promise<boolean> {
  const myEpoch = epoch;
  const prevItem = state.items.find((it) => it.trail_id === trailId) ?? null;
  const wasCompleted = state.ids.has(trailId);
  if (wasCompleted) {
    const nextIds = new Set(state.ids);
    nextIds.delete(trailId);
    setState({
      loaded: true,
      ids: nextIds,
      items: state.items.filter((it) => it.trail_id !== trailId),
    });
  }
  try {
    const res = await fetch(
      `/api/me/completions/${encodeURIComponent(trailId)}`,
      { method: "DELETE", credentials: "include" },
    );
    if (myEpoch !== epoch) return res.ok;
    if (!res.ok) {
      if (wasCompleted) revertUnmark(trailId, prevItem);
      return false;
    }
    return true;
  } catch {
    if (myEpoch !== epoch) return false;
    if (wasCompleted) revertUnmark(trailId, prevItem);
    return false;
  }
}

/**
 * Convenience hook for any per-trail UI control. Subscribes to the
 * global store so the "Ridden" badge stays in sync across screens
 * (mark from the cluster sheet → see it lit up on the detail sheet).
 */
export function useCompletionState(trailId: string): {
  completed: boolean;
  loaded: boolean;
} {
  const [completed, setCompleted] = useState(() => state.ids.has(trailId));
  const [loaded, setLoaded] = useState(state.loaded);
  useEffect(() => {
    setCompleted(state.ids.has(trailId));
    setLoaded(state.loaded);
    return subscribeCompletions((s) => {
      setCompleted(s.ids.has(trailId));
      setLoaded(s.loaded);
    });
  }, [trailId]);
  return { completed, loaded };
}

/**
 * Subscribe to the full set of completion ids — used by list views
 * that need to filter / paint many trails at once.
 */
export function useCompletionIds(): Set<string> {
  const [ids, setIds] = useState(state.ids);
  useEffect(() => {
    setIds(state.ids);
    return subscribeCompletions((s) => setIds(s.ids));
  }, []);
  return ids;
}

export function useCompletionItems(): {
  items: CompletionItem[];
  loaded: boolean;
} {
  const [snap, setSnap] = useState({ items: state.items, loaded: state.loaded });
  useEffect(() => {
    setSnap({ items: state.items, loaded: state.loaded });
    return subscribeCompletions((s) =>
      setSnap({ items: s.items, loaded: s.loaded }),
    );
  }, []);
  return snap;
}
