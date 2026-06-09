/**
 * Route Planner Store
 *
 * Lightweight module-level store with AsyncStorage persistence.
 * No external state library needed — uses a simple pub/sub model
 * with React hooks for component subscription.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import type { PlannerSuggestion, MapTrail } from "@/lib/api";

const STORAGE_KEY = "@trailforge/route-planner-v1";

// ── Types ────────────────────────────────────────────────────────────────────

export type RideStyle = "easy" | "moderate" | "challenge";
export type PlannerStep = 1 | 2 | 3 | 4;
export type AdjustmentMode = "more_trails" | "less_trails" | "harder" | "easier" | null;
export type PlannerMapMode = "idle" | "planning";
export type PlanningSource = "suggest" | "browse";

export interface RoadPoint {
  latitude: number;
  longitude: number;
}

export interface LocationPoint {
  lat: number;
  lon: number;
  address: string;
}

export interface PlannerState {
  step: PlannerStep;
  from: LocationPoint | null;
  to: LocationPoint | null;
  rideStyle: RideStyle | null;
  naturalLanguageInput: string;
  suggestions: PlannerSuggestion[];
  trailDetails: MapTrail[];
  /** IDs the user has explicitly skipped */
  skippedIds: string[];
  isCalculating: boolean;
  adjustmentMode: AdjustmentMode;
  selectedSectionId: string | null;
  savedRouteName: string;
  /** Map-tab planning session (planner → map flow). */
  mapMode: PlannerMapMode;
  planningSource: PlanningSource | null;
  difficultyGrades: number[];
  /** Ordered trail ids in the active route. */
  activeTrailIds: string[];
  /** Subset of activeTrailIds that came from AI suggestion. */
  suggestedTrailIds: string[];
  roadPolyline: RoadPoint[] | null;
  roadDistanceKm: number | null;
  routeReady: boolean;
  isRebuildingRoute: boolean;
  /** Open the route actions sheet once route geometry is ready (saved draft reload). */
  pendingRouteActionsOpen: boolean;
}

const DEFAULT_STATE: PlannerState = {
  step: 1,
  from: null,
  to: null,
  rideStyle: null,
  naturalLanguageInput: "",
  suggestions: [],
  trailDetails: [],
  skippedIds: [],
  isCalculating: false,
  adjustmentMode: null,
  selectedSectionId: null,
  savedRouteName: "",
  mapMode: "idle",
  planningSource: null,
  difficultyGrades: [],
  activeTrailIds: [],
  suggestedTrailIds: [],
  roadPolyline: null,
  roadDistanceKm: null,
  routeReady: false,
  isRebuildingRoute: false,
  pendingRouteActionsOpen: false,
};

// ── Module-level state + listeners ───────────────────────────────────────────

let _state: PlannerState = { ...DEFAULT_STATE };
const _listeners = new Set<() => void>();

function _notify() {
  _listeners.forEach(fn => fn());
}

function _setState(patch: Partial<PlannerState>) {
  _state = { ..._state, ...patch };
  _notify();
  // Persist non-transient parts (skip calculating flag)
  const toSave: Partial<PlannerState> = {
    from: _state.from,
    to: _state.to,
    rideStyle: _state.rideStyle,
    naturalLanguageInput: _state.naturalLanguageInput,
    skippedIds: _state.skippedIds,
    savedRouteName: _state.savedRouteName,
  };
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(toSave)).catch(() => undefined);
}

/** Load persisted state on app start — call once from _layout.tsx */
export async function hydratePlannerStore(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<PlannerState>;
      _state = { ...DEFAULT_STATE, ...saved, step: 1 };
      _notify();
    }
  } catch {
    // ignore
  }
}

export function getPlannerState(): PlannerState {
  return _state;
}

// ── Actions ───────────────────────────────────────────────────────────────────

export const plannerActions = {
  setFrom(from: LocationPoint | null) {
    _setState({ from });
  },
  setTo(to: LocationPoint | null) {
    _setState({ to });
  },
  setRideStyle(rideStyle: RideStyle) {
    _setState({ rideStyle });
  },
  setNaturalLanguage(text: string) {
    _setState({ naturalLanguageInput: text });
  },
  setStep(step: PlannerStep) {
    _setState({ step });
  },
  setCalculating(v: boolean) {
    _setState({ isCalculating: v });
  },
  setSuggestions(suggestions: PlannerSuggestion[], trailDetails: MapTrail[]) {
    _setState({ suggestions, trailDetails, isCalculating: false });
  },
  setAdjustmentMode(mode: AdjustmentMode) {
    _setState({ adjustmentMode: mode });
  },
  skipSection(id: string) {
    if (!_state.skippedIds.includes(id)) {
      _setState({ skippedIds: [..._state.skippedIds, id] });
    }
  },
  restoreSection(id: string) {
    _setState({ skippedIds: _state.skippedIds.filter(x => x !== id) });
  },
  selectSection(id: string | null) {
    _setState({ selectedSectionId: id });
  },
  setSavedRouteName(name: string) {
    _setState({ savedRouteName: name });
  },
  startMapPlanning(input: {
    from: LocationPoint;
    to: LocationPoint;
    difficultyGrades: number[];
    source: PlanningSource;
  }) {
    _setState({
      from: input.from,
      to: input.to,
      difficultyGrades: input.difficultyGrades,
      planningSource: input.source,
      mapMode: "planning",
      activeTrailIds: [],
      suggestedTrailIds: [],
      roadPolyline: null,
      roadDistanceKm: null,
      routeReady: false,
      skippedIds: [],
      suggestions: [],
    });
  },
  setMapTrails(activeTrailIds: string[], suggestedTrailIds: string[], trailDetails: MapTrail[]) {
    const merged = new Map(_state.trailDetails.map((t) => [t.id, t]));
    for (const t of trailDetails) merged.set(t.id, t);
    _setState({
      activeTrailIds,
      suggestedTrailIds,
      trailDetails: [...merged.values()],
      isCalculating: false,
    });
  },
  mergeTrailDetails(trails: MapTrail[]) {
    const merged = new Map(_state.trailDetails.map((t) => [t.id, t]));
    for (const t of trails) merged.set(t.id, t);
    _setState({ trailDetails: [...merged.values()] });
  },
  setActiveTrailIds(activeTrailIds: string[]) {
    _setState({ activeTrailIds });
  },
  setRoadRoute(polyline: RoadPoint[] | null, distanceKm: number | null) {
    _setState({ roadPolyline: polyline, roadDistanceKm: distanceKm, routeReady: polyline != null });
  },
  setRouteReady(routeReady: boolean) {
    _setState({ routeReady });
  },
  setRebuildingRoute(isRebuildingRoute: boolean) {
    _setState({ isRebuildingRoute });
  },
  requestOpenRouteActions() {
    _setState({ pendingRouteActionsOpen: true });
  },
  clearPendingRouteActionsOpen() {
    _setState({ pendingRouteActionsOpen: false });
  },
  endMapPlanning() {
    _setState({
      mapMode: "idle",
      planningSource: null,
      activeTrailIds: [],
      suggestedTrailIds: [],
      roadPolyline: null,
      roadDistanceKm: null,
      routeReady: false,
      isRebuildingRoute: false,
      pendingRouteActionsOpen: false,
    });
  },
  reset() {
    _state = { ...DEFAULT_STATE };
    _notify();
    void AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
  },
};

// ── React hook ────────────────────────────────────────────────────────────────

export function usePlannerStore(): PlannerState {
  const [snap, setSnap] = useState<PlannerState>(_state);
  useEffect(() => {
    // Sync on mount in case store updated before this mounted
    setSnap({ ..._state });
    const listener = () => setSnap({ ..._state });
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
  }, []);
  return snap;
}

// ── Style → search params ─────────────────────────────────────────────────────

export function styleToParams(style: RideStyle): {
  corridorKm: number;
  maxGrade: number;
  label: string;
} {
  switch (style) {
    case "easy":     return { corridorKm: 40,  maxGrade: 4, label: "Grade 1-4 Easy" };
    case "moderate": return { corridorKm: 70,  maxGrade: 6, label: "Grade 3-6 Mixed" };
    case "challenge":return { corridorKm: 100, maxGrade: 8, label: "Grade 5-8 Technical" };
  }
}
