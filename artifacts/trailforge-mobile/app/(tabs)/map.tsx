/**
 * Map tab — react-native-maps centred on the user's location, with
 * polylines for every trail in the visible region.
 *
 * Filter rows (all gated behind Premium):
 *   1. Grade difficulty  — All · Easy 1-3 · Inter 4-6 · Hard 7-9 · Extreme 10
 *   2. Bike suitability  — All bikes · Adventure · Trail · Enduro
 *   3. Trail visibility  — All trails · Public + groups · Groups only
 */
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import * as Location from "expo-location";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { geocode, shortLabel, type NominatimResult } from "@/lib/nominatim";
import { getAccuratePosition } from "@/lib/location";
import ClusterMapView from "react-native-map-clustering";
import MapView, {
  Marker,
  PROVIDER_DEFAULT,
  PROVIDER_GOOGLE,
  Polyline,
  type Region,
} from "react-native-maps";

import {
  TrailDetailSheet,
  type TrailDetailData,
} from "@/components/TrailDetailSheet";
import { AppShellHeader } from "@/components/shell/AppShellHeader";
import { PlannerMapChrome } from "@/components/planner/PlannerMapChrome";
import { UpgradePrompt } from "@/components/UpgradePrompt";
import { useProfile } from "@/components/ProfileContext";
import colors from "@/constants/colors";
import {
  listCompletions,
  patchPreferences,
  searchTrailsByBbox,
  type MapTrail as ApiTrail,
} from "@/lib/api";
import {
  difficultyColor,
  gradeFromDifficulty,
  TRAIL_ORANGE,
} from "@/lib/trailColors";
import { formatSearchBbox, formatSearchBboxFromRegion, trailMapCoordinates, trailCentroid } from "@/lib/geo";
import { publishVisibleTrails } from "@/lib/visibleTrails";
import { toggleTrailOnRoute } from "@/lib/plannerMapSession";
import { usePlannerStore } from "@/store/routePlannerStore";

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

/** Numeric grade tier filter.  Maps to grade ranges 1-10. */
type GradeFilter = "all" | "easy" | "intermediate" | "hard" | "extreme";

/** Bike suitability filter.  Derived from the maximum grade a bike can handle. */
type BikeFilter = "all" | "adventure" | "trail" | "enduro";

/**
 * Which trails to show:
 *   all            → public + group-shared + owned (default — API already does this)
 *   public_groups  → same as "all" (alias kept for label clarity)
 *   groups_only    → hide public trails (is_public !== true)
 */
type VisibilityFilter = "all" | "public_groups" | "groups_only";

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

function matchesGrade(trail: ApiTrail, filter: GradeFilter): boolean {
  if (filter === "all") return true;
  const grade =
    gradeFromDifficulty(trail.difficulty) ??
    gradeFromDifficulty(trail.ai_difficulty ?? null);
  if (grade == null) return true; // unknown grade → always visible
  if (filter === "easy") return grade <= 3;
  if (filter === "intermediate") return grade >= 4 && grade <= 6;
  if (filter === "hard") return grade >= 7 && grade <= 9;
  if (filter === "extreme") return grade >= 10;
  return true;
}

function matchesBike(trail: ApiTrail, filter: BikeFilter): boolean {
  if (filter === "all" || filter === "enduro") return true;
  const grade =
    gradeFromDifficulty(trail.difficulty) ??
    gradeFromDifficulty(trail.ai_difficulty ?? null);
  if (grade == null) return true;
  if (filter === "adventure") return grade <= 6;
  if (filter === "trail") return grade <= 9;
  return true;
}

function matchesVisibility(trail: ApiTrail, filter: VisibilityFilter): boolean {
  if (filter === "all" || filter === "public_groups") return true;
  if (filter === "groups_only") return trail.is_public !== true;
  return true;
}

// ---------------------------------------------------------------------------
// Filter chip configs
// ---------------------------------------------------------------------------

const GRADE_CHIPS: { id: GradeFilter; label: string; color?: string }[] = [
  { id: "all", label: "ALL" },
  { id: "easy", label: "EASY 1-3", color: "#00C853" },
  { id: "intermediate", label: "INTER 4-6", color: "#2979FF" },
  { id: "hard", label: "HARD 7-9", color: "#FF6D00" },
  { id: "extreme", label: "EXTREME 10", color: "#D50000" },
];

const BIKE_CHIPS: { id: BikeFilter; label: string }[] = [
  { id: "all", label: "All bikes" },
  { id: "adventure", label: "Adventure" },
  { id: "trail", label: "Trail" },
  { id: "enduro", label: "Enduro" },
];

const VISIBILITY_CHIPS: { id: VisibilityFilter; label: string }[] = [
  { id: "all", label: "All trails" },
  { id: "public_groups", label: "Public + groups" },
  { id: "groups_only", label: "Groups only" },
];

// ---------------------------------------------------------------------------
// Layer system
// ---------------------------------------------------------------------------

const LAYER_STORAGE_KEY = "@trailforge/map_layers_v1";

export type LayerId = "osm" | "tet" | "trf" | "my_trails" | "my_groups";

interface LayerDef {
  id: LayerId;
  label: string;
  /** Source tag or null for ownership-based layers */
  source?: string;
  color: string;
  defaultOn: boolean;
}

export const LAYER_DEFS: LayerDef[] = [
  { id: "osm",       label: "Public Trails",    source: "OSM-UK",  color: "#00C853", defaultOn: true },
  { id: "tet",       label: "Trans Euro Trail",  source: "TET-UK",  color: "#F5A623", defaultOn: true },
  { id: "trf",       label: "TRF Routes",        source: "TRF",     color: "#2979FF", defaultOn: true },
  { id: "my_trails", label: "My Trails",                            color: "#CE93D8", defaultOn: true },
  { id: "my_groups", label: "My Groups",                            color: "#FF6D00", defaultOn: true },
];

function defaultLayerState(): Record<LayerId, boolean> {
  return Object.fromEntries(LAYER_DEFS.map(l => [l.id, l.defaultOn])) as Record<LayerId, boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// FiltersSheet — floating FILTERS button + slide-up bottom sheet
// ─────────────────────────────────────────────────────────────────────────────

const AMBER = "#F5A623";
const SHEET_BG = "#1A1A1A";
const SHEET_BORDER = "#2A2A2A";

interface FiltersSheetProps {
  open: boolean;
  onClose: () => void;
  gradeFilter: GradeFilter;
  bikeFilter: BikeFilter;
  visibilityFilter: VisibilityFilter;
  layers: Record<LayerId, boolean>;
  isPremium: boolean;
  onApply: (g: GradeFilter, b: BikeFilter, v: VisibilityFilter, l: Record<LayerId, boolean>) => void;
  onShowUpgrade: (feature: string) => void;
}

function FiltersSheet({
  open,
  onClose,
  gradeFilter,
  bikeFilter,
  visibilityFilter,
  layers,
  isPremium,
  onApply,
  onShowUpgrade,
}: FiltersSheetProps) {
  const slideAnim = useRef(new Animated.Value(0)).current;

  // Draft state — only committed on APPLY
  const [draftGrade, setDraftGrade] = useState<GradeFilter>(gradeFilter);
  const [draftBike,  setDraftBike]  = useState<BikeFilter>(bikeFilter);
  const [draftVis,   setDraftVis]   = useState<VisibilityFilter>(visibilityFilter);
  const [draftLayers, setDraftLayers] = useState<Record<LayerId, boolean>>(layers);

  // Grade numeric (1–10) derived from GradeFilter
  const gradeNumFromFilter = (f: GradeFilter) => {
    if (f === "easy") return 3;
    if (f === "intermediate") return 5;
    if (f === "hard") return 8;
    if (f === "extreme") return 10;
    return 0; // "all"
  };
  const gradeFilterFromNum = (n: number): GradeFilter => {
    if (n === 0) return "all";
    if (n <= 3) return "easy";
    if (n <= 6) return "intermediate";
    if (n <= 9) return "hard";
    return "extreme";
  };
  const [gradeNum, setGradeNum] = useState(() => gradeNumFromFilter(gradeFilter));

  useEffect(() => {
    if (!open) {
      slideAnim.setValue(0);
      return;
    }
    setDraftGrade(gradeFilter);
    setGradeNum(gradeNumFromFilter(gradeFilter));
    setDraftBike(bikeFilter);
    setDraftVis(visibilityFilter);
    setDraftLayers({ ...layers });
    Animated.spring(slideAnim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 11 }).start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function closeSheet() {
    Animated.timing(slideAnim, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => onClose());
  }

  function apply() {
    const g = gradeFilterFromNum(gradeNum);
    onApply(g, draftBike, draftVis, draftLayers);
    closeSheet();
  }

  function reset() {
    setGradeNum(0); setDraftBike("all"); setDraftVis("all");
    setDraftLayers(defaultLayerState());
    onApply("all", "all", "all", defaultLayerState());
    closeSheet();
  }

  function handleBike(b: BikeFilter) {
    if (b !== "all" && !isPremium) { onShowUpgrade("Bike type filtering"); return; }
    setDraftBike(b);
  }

  const sheetTranslate = slideAnim.interpolate({ inputRange: [0, 1], outputRange: [600, 0] });

  const GRADE_LABELS: Record<number, string> = {
    0: "All grades", 1: "Grade 1 — Easy", 2: "Grade 2 — Easy", 3: "Grade 3 — Easy",
    4: "Grade 4 — Intermediate", 5: "Grade 5 — Intermediate", 6: "Grade 6 — Intermediate",
    7: "Grade 7 — Hard", 8: "Grade 8 — Hard", 9: "Grade 9 — Hard", 10: "Grade 10 — Extreme",
  };
  const gradeColor = (n: number) => {
    if (n === 0) return "#A0A0A0";
    if (n <= 3) return "#00C853";
    if (n <= 6) return "#2979FF";
    if (n <= 9) return "#FF6D00";
    return "#D50000";
  };

  return (
    <>
      {open && (
        <>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={closeSheet}
          />
          <Animated.View style={[fs.sheet, { transform: [{ translateY: sheetTranslate }] }]}>
            <View style={fs.handle} />
            <Text style={fs.sheetTitle}>FILTERS</Text>

            <ScrollView
              style={fs.sheetScroll}
              contentContainerStyle={fs.sheetScrollContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={fs.sectionLabel}>DIFFICULTY</Text>
              <View style={[fs.gradeDisplay, { borderColor: gradeColor(gradeNum) }]}>
                <Text style={[fs.gradeNum, { color: gradeColor(gradeNum) }]}>
                  {gradeNum === 0 ? "All" : gradeNum}
                </Text>
                <Text style={[fs.gradeDesc, { color: gradeColor(gradeNum) }]}>
                  {GRADE_LABELS[gradeNum]}
                </Text>
              </View>
              <View style={fs.trackWrap}>
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                  <TouchableOpacity
                    key={n}
                    style={[
                      fs.trackCell,
                      n > 0 && n <= gradeNum && { backgroundColor: gradeColor(n), borderColor: gradeColor(n) },
                      n === gradeNum && { borderColor: gradeColor(n), borderWidth: 2 },
                    ]}
                    onPress={() => setGradeNum(n)}
                  >
                    <Text style={[fs.trackCellTxt, n > 0 && n <= gradeNum && { color: "#000" }]}>
                      {n === 0 ? "★" : n}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={fs.sectionLabel}>BIKE TYPE</Text>
              <View style={fs.bikeRow}>
                {(["all", "adventure", "trail", "enduro"] as BikeFilter[]).map(b => (
                  <TouchableOpacity
                    key={b}
                    style={[fs.bikeChip, draftBike === b && fs.bikeChipActive]}
                    onPress={() => handleBike(b)}
                  >
                    <Text style={[fs.bikeChipTxt, draftBike === b && fs.bikeChipTxtActive]}>
                      {b === "all" ? "Any" : b.charAt(0).toUpperCase() + b.slice(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={fs.sectionLabel}>MAP LAYERS</Text>
              {LAYER_DEFS.map(layer => (
                <View key={layer.id} style={fs.layerRow}>
                  <View style={[fs.layerDot, { backgroundColor: layer.color }]} />
                  <Text style={fs.layerLabel}>{layer.label}</Text>
                  <Switch
                    value={draftLayers[layer.id]}
                    onValueChange={() => setDraftLayers(prev => ({ ...prev, [layer.id]: !prev[layer.id] }))}
                    trackColor={{ false: "#333", true: layer.color }}
                    thumbColor={draftLayers[layer.id] ? "#fff" : "#666"}
                  />
                </View>
              ))}
            </ScrollView>

            <TouchableOpacity style={fs.applyBtn} onPress={apply}>
              <Text style={fs.applyBtnTxt}>APPLY FILTERS</Text>
            </TouchableOpacity>
            <TouchableOpacity style={fs.resetBtn} onPress={reset}>
              <Text style={fs.resetBtnTxt}>Reset to defaults</Text>
            </TouchableOpacity>
          </Animated.View>
        </>
      )}
    </>
  );
}

const fs = StyleSheet.create({
  topBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: AMBER,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 6,
  },
  topBtnTxt: { color: "#000", fontSize: 11, fontWeight: "900", letterSpacing: 0.8 },
  topBtnOutline: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#1A1A1A",
    borderColor: AMBER,
    borderWidth: 1.5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  topBtnOutlineTxt: { color: AMBER, fontSize: 11, fontWeight: "900", letterSpacing: 0.8 },
  activeDot: {
    width: 7, height: 7, borderRadius: 4,
    backgroundColor: "#D50000",
    position: "absolute", top: -2, right: -2,
    borderWidth: 1.5, borderColor: AMBER,
  },

  // Sheet
  sheet: {
    position: "absolute",
    bottom: 0, left: 0, right: 0,
    backgroundColor: SHEET_BG,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingBottom: 28,
    paddingTop: 8,
    maxHeight: "85%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 24,
  },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  sheetScrollContent: { paddingBottom: 8 },
  handle: { alignSelf: "center", width: 44, height: 5, borderRadius: 3, backgroundColor: AMBER, marginBottom: 16 },
  sheetTitle: { fontSize: 15, fontWeight: "900", color: "#FFF", letterSpacing: 1.5, marginBottom: 20 },

  sectionLabel: { fontSize: 11, fontWeight: "800", color: AMBER, letterSpacing: 1.5, marginBottom: 10, marginTop: 4 },

  // Grade
  gradeDisplay: {
    flexDirection: "row", alignItems: "baseline", gap: 10,
    borderWidth: 1.5, borderRadius: 10,
    paddingVertical: 8, paddingHorizontal: 14, marginBottom: 12,
    alignSelf: "flex-start",
  },
  gradeNum: { fontSize: 32, fontWeight: "900", lineHeight: 36 },
  gradeDesc: { fontSize: 14, fontWeight: "700" },
  trackWrap: { flexDirection: "row", gap: 5, marginBottom: 20 },
  trackCell: {
    flex: 1, height: 44, borderRadius: 8,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "#0D0D0D", borderColor: SHEET_BORDER, borderWidth: 1,
  },
  trackCellTxt: { fontSize: 11, fontWeight: "800", color: "#A0A0A0" },

  // Bike chips
  bikeRow: { flexDirection: "row", gap: 8, marginBottom: 20 },
  bikeChip: {
    flex: 1, height: 52, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "#0D0D0D", borderColor: SHEET_BORDER, borderWidth: 1.5,
  },
  bikeChipActive: { backgroundColor: AMBER + "22", borderColor: AMBER },
  bikeChipTxt: { fontSize: 12, fontWeight: "800", color: "#A0A0A0" },
  bikeChipTxtActive: { color: AMBER },

  // Layer toggles
  layerRow: {
    flexDirection: "row", alignItems: "center", height: 56,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: SHEET_BORDER,
  },
  layerDot: { width: 12, height: 12, borderRadius: 6, marginRight: 12 },
  layerLabel: { flex: 1, color: "#FFF", fontSize: 15, fontWeight: "600" },

  // Buttons
  applyBtn: {
    height: 56, borderRadius: 14, backgroundColor: AMBER,
    alignItems: "center", justifyContent: "center", marginTop: 12,
  },
  applyBtnTxt: { color: "#000", fontSize: 16, fontWeight: "900", letterSpacing: 1 },
  resetBtn: { alignItems: "center", marginTop: 14 },
  resetBtnTxt: { color: "#A0A0A0", fontSize: 14, fontWeight: "600" },
});

// ---------------------------------------------------------------------------
// Default region
// ---------------------------------------------------------------------------

const FALLBACK_REGION: Region = {
  latitude: 54.5,
  longitude: -2.5,
  latitudeDelta: 4.5,
  longitudeDelta: 4.5,
};

/** UK + Ireland bbox for browsing all public trails without a planned route. */
const UK_IE_BBOX = formatSearchBbox(49.5, -11.0, 61.0, 2.0);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MapTab() {
  const mapRef = useRef<MapView | null>(null);
  const [region, setRegion] = useState<Region>(FALLBACK_REGION);
  const [permission, setPermission] = useState<
    "unknown" | "granted" | "denied"
  >("unknown");
  const [selected, setSelected] = useState<TrailDetailData | null>(null);
  const [mapKind, setMapKind] = useState<"standard" | "satellite">("satellite");
  const [searchText, setSearchText] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchHits, setSearchHits] = useState<NominatimResult[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [userCoords, setUserCoords] = useState<{ lat: number; lon: number } | null>(null);

  // Active filters
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [bikeFilter, setBikeFilter] = useState<BikeFilter>("all");
  const [visibilityFilter, setVisibilityFilter] =
    useState<VisibilityFilter>("all");

  // Upgrade prompt
  const [upgradeVisible, setUpgradeVisible] = useState(false);
  const [upgradedFeature, setUpgradedFeature] = useState("");
  const { profile } = useProfile();
  const isPremium = profile.isPremium;
  const planner = usePlannerStore();
  const isPlanning = planner.mapMode === "planning";
  const activeTrailSet = useMemo(
    () => new Set(planner.activeTrailIds),
    [planner.activeTrailIds],
  );

  // ── Layer visibility state ────────────────────────────────────────────────
  const [layers, setLayers] = useState<Record<LayerId, boolean>>(defaultLayerState);
  const hasFiltersActive =
    gradeFilter !== "all"
    || bikeFilter !== "all"
    || visibilityFilter !== "all"
    || Object.values(layers).some(v => !v);

  // Persist and rehydrate layer state from AsyncStorage
  useEffect(() => {
    void AsyncStorage.getItem(LAYER_STORAGE_KEY).then(stored => {
      if (!stored) return;
      try {
        const parsed = JSON.parse(stored) as Partial<Record<LayerId, boolean>>;
        setLayers({ ...defaultLayerState(), ...parsed });
      } catch { /* ignore */ }
    });
  }, []);

  const toggleLayer = useCallback((id: LayerId) => {
    setLayers(prev => {
      const next = { ...prev, [id]: !prev[id] };
      void AsyncStorage.setItem(LAYER_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Seed the bike filter from the profile on mount
  useEffect(() => {
    if (profile.preferredBikeType && profile.preferredBikeType !== "all") {
      setBikeFilter(profile.preferredBikeType);
    }
  // Only run once after the profile first populates
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function showUpgrade(feature: string) {
    setUpgradedFeature(feature);
    setUpgradeVisible(true);
  }

  function handleGradeFilter(f: GradeFilter) {
    if (f !== "all" && !isPremium) {
      showUpgrade("Trail difficulty filtering");
      return;
    }
    setGradeFilter(f);
  }

  function handleBikeFilter(f: BikeFilter) {
    if (f !== "all" && !isPremium) {
      showUpgrade("Bike type filtering");
      return;
    }
    setBikeFilter(f);
    // Best-effort persist — don't block the UI on a network round-trip.
    void patchPreferences({ preferred_bike_type: f }).catch(() => undefined);
  }

  function handleVisibilityFilter(f: VisibilityFilter) {
    if (f !== "all" && !isPremium) {
      showUpgrade("Groups-only map view");
      return;
    }
    setVisibilityFilter(f);
  }

  // -------------------------------------------------------------------------
  // Geocode search
  // -------------------------------------------------------------------------

  async function runSearch(): Promise<void> {
    const q = searchText.trim();
    if (!q) return;
    Keyboard.dismiss();
    setSearching(true);
    try {
      const bias = userCoords ?? { lat: region.latitude, lon: region.longitude };
      const results = await geocode(q, bias);
      setSearchHits(results);
      if (results[0]) flyTo(results[0]);
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    const q = searchText.trim();
    if (q.length < 2) {
      setSearchHits([]);
      return;
    }
    const t = setTimeout(() => {
      setSearching(true);
      const bias = userCoords ?? { lat: region.latitude, lon: region.longitude };
      void geocode(q, bias)
        .then(setSearchHits)
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [searchText, userCoords, region.latitude, region.longitude]);

  function flyTo(hit: NominatimResult): void {
    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const next: Region = {
      latitude: lat,
      longitude: lon,
      latitudeDelta: 0.4,
      longitudeDelta: 0.4,
    };
    setRegion(next);
    mapRef.current?.animateToRegion(next, 600);
    setSearchHits([]);
  }

  // -------------------------------------------------------------------------
  // Trail data
  // -------------------------------------------------------------------------

  const useWideFetch = !isPlanning;
  const bbox = useMemo(() => {
    if (useWideFetch) return UK_IE_BBOX;
    const lats = [region.latitude - region.latitudeDelta / 2, region.latitude + region.latitudeDelta / 2];
    const lngs = [region.longitude - region.longitudeDelta / 2, region.longitude + region.longitudeDelta / 2];
    if (planner.from) {
      lats.push(planner.from.lat);
      lngs.push(planner.from.lon);
    }
    if (planner.to) {
      lats.push(planner.to.lat);
      lngs.push(planner.to.lon);
    }
    for (const p of planner.roadPolyline ?? []) {
      lats.push(p.latitude);
      lngs.push(p.longitude);
    }
    const pad = 0.15;
    const latSpan = Math.max(0.08, Math.max(...lats) - Math.min(...lats));
    const lngSpan = Math.max(0.08, Math.max(...lngs) - Math.min(...lngs));
    return formatSearchBbox(
      Math.min(...lats) - latSpan * pad,
      Math.min(...lngs) - lngSpan * pad,
      Math.max(...lats) + latSpan * pad,
      Math.max(...lngs) + lngSpan * pad,
    );
  }, [useWideFetch, region, planner.from, planner.to, planner.roadPolyline]);
  const trailLimit = useWideFetch ? 500 : 300;
  const trailsQ = useQuery({
    queryKey: ["trails-bbox", bbox, trailLimit],
    queryFn: () => searchTrailsByBbox({ bbox, limit: trailLimit }),
    staleTime: 60_000,
    retry: 2,
  });

  useFocusEffect(
    useCallback(() => {
      void trailsQ.refetch();
    }, [trailsQ.refetch]),
  );

  // Separate road liaison connectors (terrain="road") from rideable trail sections.
  // Split trail sections by layer for colour-coded rendering.
  const { trailData, roadData, layeredTrails } = useMemo(() => {
    const byId = new Map<string, ApiTrail>();
    for (const t of trailsQ.data?.trails ?? []) byId.set(t.id, t);
    for (const t of isPlanning ? planner.trailDetails : []) byId.set(t.id, t);
    const all = [...byId.values()];
    const trailData: ApiTrail[] = [];
    const roadData: ApiTrail[] = [];
    const layerMap: Record<LayerId, ApiTrail[]> = {
      osm: [], tet: [], trf: [], my_trails: [], my_groups: [],
    };

    for (const t of all) {
      if (t.terrain === "road") {
        roadData.push(t);
        continue;
      }
      trailData.push(t);

      // Assign to layer bucket by source tag
      const tAny = t as unknown as Record<string, unknown>;
      const src = tAny["source"] as string | undefined;
      if (src === "TET-UK") layerMap.tet.push(t);
      else if (src === "TRF") layerMap.trf.push(t);
      else if (src === "OSM-UK") layerMap.osm.push(t);
      else if (tAny["owner_user_id"]) layerMap.my_trails.push(t);
      else layerMap.osm.push(t); // default bucket
    }

    // Apply active-layer filter and difficulty/bike filters
    const layeredTrails: Array<{ trail: ApiTrail; layerColor: string; isOsm: boolean }> = [];
    for (const def of LAYER_DEFS) {
      if (!layers[def.id]) continue;
      for (const t of layerMap[def.id]) {
        if (!matchesGrade(t, gradeFilter)) continue;
        if (!matchesBike(t, bikeFilter)) continue;
        if (!matchesVisibility(t, visibilityFilter)) continue;
        layeredTrails.push({ trail: t, layerColor: def.color, isOsm: def.id === "osm" });
      }
    }

    return { trailData, roadData, layeredTrails };
  }, [trailsQ.data, isPlanning, planner.trailDetails, layers, gradeFilter, bikeFilter, visibilityFilter]);

  // Flat list of trail sections (for markers, completions lookup, etc.)
  const trails: ApiTrail[] = useMemo(() => layeredTrails.map(l => l.trail), [layeredTrails]);
  const showTrailMarkers = region.latitudeDelta < 0.75 && trails.length <= 120;
  const rawTrailCount = trailsQ.data?.trails?.length ?? 0;

  const completionsQ = useQuery({
    queryKey: ["my-completions"],
    queryFn: listCompletions,
    staleTime: 60_000,
  });
  const ridden = useMemo(() => {
    const set = new Set<string>();
    for (const c of completionsQ.data?.completions ?? []) {
      set.add(c.trailId);
    }
    return set;
  }, [completionsQ.data]);

  // Pre-compute polyline coordinates for rendering.
  const trailPolylines = useMemo(
    () =>
      layeredTrails
        .map(({ trail: t, layerColor, isOsm }) => ({
          id: t.id,
          trail: t,
          coords: trailMapCoordinates(t),
          layerColor,
          isOsm,
          isSeasonal: !!((t as unknown as Record<string, unknown>)["is_seasonal"]),
        }))
        .filter((p) => p.coords.length >= 2),
    [layeredTrails],
  );

  useEffect(() => {
    if (!__DEV__) return;
    if (trailsQ.isError) {
      console.warn("[Map] trails fetch failed:", trailsQ.error);
    } else if (trailsQ.data) {
      console.log(
        `[Map] API trails=${rawTrailCount} rendered=${trailPolylines.length} polylines`,
      );
    }
  }, [trailsQ.isError, trailsQ.error, trailsQ.data, rawTrailCount, trailPolylines.length]);

  // Road liaison connectors — always shown regardless of filters; never tappable.
  const roadPolylines = useMemo(
    () =>
      roadData
        .map((t) => ({ id: t.id, coords: trailMapCoordinates(t) }))
        .filter((p) => p.coords.length >= 2),
    [roadData],
  );

  useEffect(() => {
    publishVisibleTrails({
      bbox: {
        minLng: region.longitude - region.longitudeDelta / 2,
        maxLng: region.longitude + region.longitudeDelta / 2,
        minLat: region.latitude - region.latitudeDelta / 2,
        maxLat: region.latitude + region.latitudeDelta / 2,
      },
      trailIds: trails.slice(0, 20).map((t) => t.id),
    });
  }, [region, trails]);

  useEffect(() => {
    void (async () => {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== "granted") {
        setPermission("denied");
        return;
      }
      setPermission("granted");
      try {
        const pos = await getAccuratePosition();
        setUserCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      } catch {
        // keep fallback region
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isPlanning || !planner.from || !planner.to) return;
    const lats = [planner.from.lat, planner.to.lat];
    const lons = [planner.from.lon, planner.to.lon];
    for (const p of planner.roadPolyline ?? []) {
      lats.push(p.latitude);
      lons.push(p.longitude);
    }
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const next: Region = {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLon + maxLon) / 2,
      latitudeDelta: Math.max(0.08, (maxLat - minLat) * 1.5),
      longitudeDelta: Math.max(0.08, (maxLon - minLon) * 1.5),
    };
    setRegion(next);
    mapRef.current?.animateToRegion(next, 800);
  }, [isPlanning, planner.from, planner.to, planner.roadPolyline]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <View style={styles.container}>
      <AppShellHeader />
      <View style={styles.mapArea}>
      <ClusterMapView
        ref={mapRef}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        mapType={mapKind}
        style={{ flex: 1 }}
        initialRegion={FALLBACK_REGION}
        showsUserLocation={permission === "granted"}
        showsMyLocationButton={false}
        onRegionChangeComplete={setRegion}
        radius={48}
        minZoom={1}
        maxZoom={12}
        clusterColor={colors.light.primary}
        clusterTextColor={colors.light.primaryForeground}
      >
        {planner.from && isPlanning ? (
          <Marker
            coordinate={{ latitude: planner.from.lat, longitude: planner.from.lon }}
            pinColor="#22c55e"
            title="Start"
          />
        ) : null}
        {planner.to && isPlanning ? (
          <Marker
            coordinate={{ latitude: planner.to.lat, longitude: planner.to.lon }}
            pinColor={colors.light.primary}
            title="Destination"
          />
        ) : null}
        {planner.roadPolyline && planner.roadPolyline.length >= 2 && isPlanning ? (
          <Polyline
            coordinates={planner.roadPolyline}
            strokeColor="#3b82f6"
            strokeWidth={5}
            zIndex={2}
          />
        ) : null}
        {showTrailMarkers ? trails.map((t) => {
          const center = trailCentroid(t);
          if (!center) return null;
          return (
            <Marker
              key={`m-${t.id}`}
              coordinate={center}
              tracksViewChanges={false}
              pinColor={difficultyColor(t.difficulty)}
              onPress={() => setSelected(trailDetailData(t))}
            />
          );
        }) : null}
        {/* Road liaison connectors — thin grey dashed lines, never interactive */}
        {roadPolylines.map(({ id, coords }) => (
          <Polyline
            key={`road-${id}`}
            coordinates={coords}
            strokeColor="#999999"
            strokeWidth={1.5}
            lineDashPattern={[4, 8]}
            tappable={false}
          />
        ))}

        {/* Trail sections — coloured by layer (premium) or grey (free).
            OSM trails use difficulty colour; other layers use their layer colour.
            Seasonal trails render as dashed lines. */}
        {trailPolylines.map(({ id, trail, coords, layerColor, isOsm, isSeasonal }) => {
          const isActive = activeTrailSet.has(id);
          const color = isActive
            ? colors.light.primary
            : isPremium
              ? (isOsm ? difficultyColor(trail.difficulty) : layerColor)
              : "#888888";
          return (
            <Polyline
              key={id}
              coordinates={coords}
              strokeColor={color}
              strokeWidth={isActive ? 7 : isPremium ? 4 : 3}
              lineDashPattern={isSeasonal ? [8, 6] : undefined}
              tappable
              onPress={() => {
                if (isPlanning) {
                  void toggleTrailOnRoute(trail);
                } else {
                  setSelected(trailDetailData(trail));
                }
              }}
            />
          );
        })}
      </ClusterMapView>

      {/* ── Top actions: Filters + Add trail ───────────────────────────── */}
      <View style={styles.topActions} pointerEvents="box-none">
        <TouchableOpacity
          style={fs.topBtnOutline}
          onPress={() => setFiltersOpen(true)}
          activeOpacity={0.85}
        >
          <Feather name="sliders" size={14} color={AMBER} />
          <Text style={fs.topBtnOutlineTxt}>FILTERS</Text>
          {hasFiltersActive ? <View style={fs.activeDot} /> : null}
        </TouchableOpacity>
        {!isPlanning ? (
          <TouchableOpacity
            style={fs.topBtn}
            onPress={() => router.push("/add-trail")}
            activeOpacity={0.85}
          >
            <Feather name="plus" size={14} color="#000" />
            <Text style={fs.topBtnTxt}>ADD TRAIL</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* ── Search bar ─────────────────────────────────────────────────── */}
      <View style={styles.searchRow} pointerEvents="box-none">
        <View style={styles.searchBar}>
          <Feather name="search" size={16} color={colors.light.mutedForeground} />
          <TextInput
            value={searchText}
            onChangeText={setSearchText}
            onSubmitEditing={runSearch}
            placeholder="Search a place…"
            placeholderTextColor={colors.light.mutedForeground}
            style={styles.searchInput}
            returnKeyType="search"
          />
          {searchText ? (
            <TouchableOpacity
              onPress={() => {
                setSearchText("");
                setSearchHits([]);
              }}
            >
              <Feather name="x" size={16} color={colors.light.mutedForeground} />
            </TouchableOpacity>
          ) : null}
          {searching ? (
            <ActivityIndicator size="small" color={colors.light.primary} />
          ) : null}
        </View>
        {searchHits.length > 0 ? (
          <View style={styles.searchHits}>
            {searchHits.slice(0, 5).map((h) => (
              <TouchableOpacity
                key={`${h.lat},${h.lon},${h.place_id}`}
                style={styles.searchHit}
                onPress={() => flyTo(h)}
              >
                <Feather
                  name="map-pin"
                  size={14}
                  color={colors.light.mutedForeground}
                />
                <Text numberOfLines={2} style={styles.searchHitText}>
                  {shortLabel(h.display_name)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </View>

      {/* ── Status pill + map controls ─────────────────────────────────── */}
      <View style={styles.headerCard} pointerEvents="box-none">
        <View style={styles.statusPill} pointerEvents="none">
          {trailsQ.isFetching ? (
            <ActivityIndicator color={colors.light.primary} size="small" />
          ) : (
            <Feather name="map" size={14} color={colors.light.primary} />
          )}
          <Text style={styles.statusText}>
            {trailsQ.isError
              ? "Couldn't load trails"
              : `${trails.length} trail${trails.length === 1 ? "" : "s"} in view`}
          </Text>
        </View>

        {trailsQ.isError ? (
          <TouchableOpacity
            style={styles.retryPill}
            onPress={() => void trailsQ.refetch()}
          >
            <Feather name="refresh-cw" size={13} color="#fff" />
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        ) : null}

        <View style={{ flexDirection: "row", gap: 6 }}>
          <TouchableOpacity
            style={styles.mapBtn}
            onPress={() =>
              setMapKind((k) => (k === "standard" ? "satellite" : "standard"))
            }
          >
            <Feather
              name={mapKind === "standard" ? "image" : "map"}
              size={18}
              color={colors.light.primary}
            />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.mapBtn}
            onPress={() => {
              void (async () => {
                try {
                  const pos = await getAccuratePosition();
                  const next: Region = {
                    latitude: pos.coords.latitude,
                    longitude: pos.coords.longitude,
                    latitudeDelta: 0.08,
                    longitudeDelta: 0.08,
                  };
                  mapRef.current?.animateToRegion(next, 600);
                } catch {
                  // ignore
                }
              })();
            }}
          >
            <Feather name="navigation" size={18} color={colors.light.primary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Location denied banner ──────────────────────────────────────── */}
      {permission === "denied" ? (
        <View style={styles.permBanner}>
          <Text style={styles.permBannerText}>
            Location off — turn it on in Settings to see your position.
          </Text>
        </View>
      ) : null}

      <PlannerMapChrome />

      {/* ── Trail detail sheet ──────────────────────────────────────────── */}
      <TrailDetailSheet
        visible={!!selected}
        trail={selected}
        ridden={selected ? ridden.has(selected.id) : false}
        onClose={() => setSelected(null)}
        onMarkRiddenChange={() => void completionsQ.refetch()}
      />


      <FiltersSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        gradeFilter={gradeFilter}
        bikeFilter={bikeFilter}
        visibilityFilter={visibilityFilter}
        layers={layers}
        isPremium={isPremium}
        onApply={(g, b, v, l) => {
          setGradeFilter(g);
          setBikeFilter(b);
          setVisibilityFilter(v);
          setLayers(l);
          void AsyncStorage.setItem(LAYER_STORAGE_KEY, JSON.stringify(l));
          if (b !== "all") void patchPreferences({ preferred_bike_type: b }).catch(() => undefined);
        }}
        onShowUpgrade={showUpgrade}
      />

      {/* ── Upgrade prompt ──────────────────────────────────────────────── */}
      <UpgradePrompt
        visible={upgradeVisible}
        featureName={upgradedFeature}
        onDismiss={() => setUpgradeVisible(false)}
      />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trailDetailData(t: ApiTrail): TrailDetailData {
  return {
    id: t.id,
    name: t.name,
    difficulty: t.difficulty,
    ai_difficulty: t.ai_difficulty ?? null,
    terrain: t.terrain ?? null,
    distance_km: t.distance_km ?? null,
    elevation_gain_m: t.elevation_gain_m ?? null,
    altitudes: t.altitudes ?? [],
    photo_urls: t.photo_urls ?? [],
    legal_status: t.legal_status ?? null,
  };
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0D0D0D" },
  mapArea: { flex: 1, position: "relative" },

  topActions: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
    zIndex: 20,
  },

  // Search — premium pill
  searchRow: {
    position: "absolute",
    top: 56,
    left: 12,
    right: 12,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#1A1A1A",
    borderColor: "#F5A623" + "55",
    borderWidth: 1.5,
    paddingHorizontal: 16,
    height: 56,
    borderRadius: 999,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  searchInput: {
    flex: 1,
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
    paddingVertical: 0,
  },
  searchHits: {
    marginTop: 8,
    backgroundColor: "#1A1A1A",
    borderColor: "#2A2A2A",
    borderWidth: 1,
    borderRadius: 14,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 10,
  },
  searchHit: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 72,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2A2A2A",
  },
  searchHitText: { flex: 1, color: "#FFFFFF", fontSize: 15, fontWeight: "600" },

  // Header (status + controls)
  headerCard: {
    position: "absolute",
    top: 126,
    left: 12,
    right: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#1A1A1A",
    borderColor: "#2A2A2A",
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  statusText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
  },
  retryPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#7f1d1d",
    borderColor: "#ef4444",
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  retryText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
  },
  mapBtn: {
    backgroundColor: "#1A1A1A",
    borderColor: "#2A2A2A",
    borderWidth: 1,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },

  // Filter rows — vivid, high-contrast, glove-friendly
  filtersContainer: {
    position: "absolute",
    top: 130,
    left: 0,
    right: 0,
    gap: 6,
  },
  filterRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 2,
  },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    height: 48,
    borderRadius: 999,
    backgroundColor: "#1A1A1A",
    borderWidth: 1.5,
    borderColor: "#2A2A2A",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 3,
  },
  filterChipActive: {
    borderColor: "#F5A623",
    backgroundColor: "#1A1A00",
  },
  filterChipText: {
    color: "#A0A0A0",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  filterChipTextActive: { color: "#FFFFFF" },
  colorDot: { width: 10, height: 10, borderRadius: 5 },
  lockIcon: { marginRight: 1 },

  // Location permission banner
  permBanner: {
    position: "absolute",
    bottom: 12,
    left: 12,
    right: 12,
    backgroundColor: "#1A1A1A",
    borderColor: "#D50000",
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  permBannerText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
});
