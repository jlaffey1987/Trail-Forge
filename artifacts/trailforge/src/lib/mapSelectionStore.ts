import { useEffect, useState } from "react";
import { type Trail } from "@/lib/supabase";

const STORAGE_KEY = "trailforge_map_selection";
const SYNC_DEBOUNCE_MS = 600;

interface StoredSelection {
  ownerId: string | null;
  trails: Trail[];
}

let selectedTrails: Trail[] = [];
let localOwnerId: string | null = null;
let currentUserId: string | null = null;
let hasAuthSettled = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

type Listener = (trails: Trail[]) => void;
const listeners = new Set<Listener>();

function emit() {
  for (const fn of listeners) fn(selectedTrails);
}

function persist() {
  try {
    const payload: StoredSelection = { ownerId: localOwnerId, trails: selectedTrails };
    if (selectedTrails.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }
  } catch {
    // localStorage unavailable
  }
}

function clearStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // noop
  }
}

function loadFromStorage(): StoredSelection {
  if (typeof window === "undefined") return { ownerId: null, trails: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ownerId: null, trails: [] };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { ownerId: null, trails: parsed as Trail[] };
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const ownerId =
        typeof obj.ownerId === "string" && obj.ownerId.length > 0
          ? obj.ownerId
          : null;
      const trails = Array.isArray(obj.trails) ? (obj.trails as Trail[]) : [];
      return { ownerId, trails };
    }
  } catch {
    // corrupted
  }
  return { ownerId: null, trails: [] };
}

const initial = loadFromStorage();
let pendingRestore: StoredSelection | null =
  initial.trails.length > 0 ? initial : null;
localOwnerId = initial.ownerId;

async function pushSelectionToCloud(): Promise<void> {
  if (!currentUserId) return;
  const trailIds = selectedTrails.map((t) => t.id);
  try {
    const res = await fetch("/api/me/map-selection", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trailIds }),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn("[mapSelectionStore] cloud sync failed:", res.status);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[mapSelectionStore] cloud sync error:", err);
  }
}

function scheduleCloudSync() {
  if (typeof window === "undefined") return;
  if (!currentUserId) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void pushSelectionToCloud();
  }, SYNC_DEBOUNCE_MS);
}

interface CloudSelection {
  trailIds: string[];
  trails: Trail[];
  updatedAt: string | null;
}

async function fetchSelectionFromCloud(): Promise<CloudSelection | null> {
  try {
    const res = await fetch("/api/me/map-selection", {
      credentials: "include",
    });
    if (!res.ok) {
      if (res.status !== 401) {
        // eslint-disable-next-line no-console
        console.warn("[mapSelectionStore] cloud fetch failed:", res.status);
      }
      return null;
    }
    return (await res.json()) as CloudSelection;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[mapSelectionStore] cloud fetch error:", err);
    return null;
  }
}

export function setMapSelectionUserId(userId: string | null): void {
  if (hasAuthSettled && userId === currentUserId) return;

  const matchesLocal = localOwnerId === null || localOwnerId === userId;

  if (!matchesLocal) {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    selectedTrails = [];
    localOwnerId = null;
    pendingRestore = null;
    clearStorage();
    emit();
  } else if (pendingRestore !== null) {
    selectedTrails = pendingRestore.trails;
    pendingRestore = null;
    emit();
  }

  currentUserId = userId;
  hasAuthSettled = true;

  if (!userId) return;

  const wasAlreadyClaimedByThisUser = localOwnerId === userId;

  void (async () => {
    const remote = await fetchSelectionFromCloud();
    if (currentUserId !== userId) return;
    if (remote === null) return;

    function adoptRemote(r: CloudSelection) {
      const byId = new Map<string, Trail>();
      for (const t of r.trails) byId.set(t.id, t);
      selectedTrails = r.trailIds
        .map((id) => byId.get(id))
        .filter((t): t is Trail => t != null);
      localOwnerId = userId;
      persist();
      emit();
    }

    if (wasAlreadyClaimedByThisUser) {
      adoptRemote(remote);
      return;
    }

    if (remote.trailIds.length > 0) {
      adoptRemote(remote);
      return;
    }

    localOwnerId = userId;
    if (selectedTrails.length > 0) {
      persist();
      scheduleCloudSync();
    } else {
      persist();
    }
  })();
}

export function resetMapSelectionCloudState(): void {
  currentUserId = null;
  hasAuthSettled = false;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  pendingRestore = null;
}

export function useMapSelection(): Trail[] {
  const [trails, setTrails] = useState<Trail[]>(selectedTrails);
  useEffect(() => {
    listeners.add(setTrails);
    setTrails(selectedTrails);
    return () => { listeners.delete(setTrails); };
  }, []);
  return trails;
}

export function addSelectedTrail(trail: Trail) {
  if (selectedTrails.some((t) => t.id === trail.id)) return;
  selectedTrails = [...selectedTrails, trail];
  persist();
  scheduleCloudSync();
  emit();
}

export function removeSelectedTrail(id: string) {
  selectedTrails = selectedTrails.filter((t) => t.id !== id);
  persist();
  scheduleCloudSync();
  emit();
}

export function setSelectedTrails(next: Trail[]) {
  selectedTrails = next;
  persist();
  scheduleCloudSync();
  emit();
}

export function clearSelection() {
  selectedTrails = [];
  persist();
  scheduleCloudSync();
  emit();
}

export function getSelectedTrails(): Trail[] {
  return selectedTrails;
}
