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
import * as Location from "expo-location";
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

import { geocode, type NominatimResult } from "@/lib/nominatim";
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
import { parseGeoJsonPath } from "@/lib/geo";
import { publishVisibleTrails } from "@/lib/visibleTrails";

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

// ---------------------------------------------------------------------------
// LayerPanel component
// ---------------------------------------------------------------------------

function LayerPanel({
  layers,
  onToggle,
}: {
  layers: Record<LayerId, boolean>;
  onToggle: (id: LayerId) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const anim = useRef(new Animated.Value(0)).current;

  function toggle() {
    Animated.spring(anim, {
      toValue: expanded ? 0 : 1,
      useNativeDriver: false,
      tension: 60,
      friction: 10,
    }).start();
    setExpanded(e => !e);
  }

  const panelHeight = anim.interpolate({ inputRange: [0, 1], outputRange: [0, LAYER_DEFS.length * 46 + 8] });
  const panelOpacity = anim.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 0, 1] });

  return (
    <View style={layerStyles.container} pointerEvents="box-none">
      <Animated.View style={[layerStyles.panel, { height: panelHeight, opacity: panelOpacity }]}>
        {LAYER_DEFS.map(layer => (
          <View key={layer.id} style={layerStyles.row}>
            <View style={[layerStyles.swatch, { backgroundColor: layer.color }]} />
            <Text style={layerStyles.label}>{layer.label}</Text>
            <Switch
              value={layers[layer.id]}
              onValueChange={() => onToggle(layer.id)}
              trackColor={{ false: "#333", true: layer.color }}
              thumbColor={layers[layer.id] ? "#fff" : "#666"}
              style={layerStyles.switch}
            />
          </View>
        ))}
      </Animated.View>

      <TouchableOpacity
        style={[layerStyles.btn, expanded && layerStyles.btnActive]}
        onPress={toggle}
        activeOpacity={0.8}
      >
        <Feather name="layers" size={22} color={expanded ? "#0D0D0D" : AMBER} />
      </TouchableOpacity>
    </View>
  );
}

const AMBER = "#F5A623";
const LAYER_BG = "#1A1A1A";
const LAYER_BORDER = "#2A2A2A";

const layerStyles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 24,
    left: 12,
    alignItems: "flex-start",
  },
  panel: {
    backgroundColor: LAYER_BG,
    borderColor: AMBER + "55",
    borderWidth: 1.5,
    borderRadius: 14,
    marginBottom: 10,
    overflow: "hidden",
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
    width: 240,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: 50,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: LAYER_BORDER,
  },
  swatch: { width: 12, height: 12, borderRadius: 6, marginRight: 10 },
  label: { flex: 1, color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
  switch: { transform: [{ scaleX: 0.9 }, { scaleY: 0.9 }] },
  btn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: LAYER_BG,
    borderColor: AMBER + "55",
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 6,
  },
  btnActive: {
    backgroundColor: AMBER,
    borderColor: AMBER,
  },
});

// ---------------------------------------------------------------------------
// Default region
// ---------------------------------------------------------------------------

const FALLBACK_REGION: Region = {
  latitude: 39.7,
  longitude: -77.5,
  latitudeDelta: 1.6,
  longitudeDelta: 1.6,
};

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
  const [mapKind, setMapKind] = useState<"standard" | "satellite">("standard");
  const [searchText, setSearchText] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchHits, setSearchHits] = useState<NominatimResult[]>([]);

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

  // ── Layer visibility state ────────────────────────────────────────────────
  const [layers, setLayers] = useState<Record<LayerId, boolean>>(defaultLayerState);

  // Persist and rehydrate layer state from AsyncStorage
  useEffect(() => {
    void AsyncStorage.getItem(LAYER_STORAGE_KEY).then(stored => {
      if (!stored) return;
      try {
        const parsed = JSON.parse(stored) as Partial<Record<LayerId, boolean>>;
        setLayers(prev => ({ ...prev, ...parsed }));
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
      const results = await geocode(q);
      setSearchHits(results);
      if (results[0]) flyTo(results[0]);
    } finally {
      setSearching(false);
    }
  }

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

  const bbox = bboxFromRegion(region);
  const trailsQ = useQuery({
    queryKey: ["trails-bbox", bbox],
    queryFn: () => searchTrailsByBbox({ bbox, limit: 200 }),
    staleTime: 60_000,
  });

  // Separate road liaison connectors (terrain="road") from rideable trail sections.
  // Split trail sections by layer for colour-coded rendering.
  const { trailData, roadData, layeredTrails } = useMemo(() => {
    const all = trailsQ.data?.trails ?? [];
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
  }, [trailsQ.data, layers, gradeFilter, bikeFilter, visibilityFilter]);

  // Flat list of trail sections (for markers, completions lookup, etc.)
  const trails: ApiTrail[] = useMemo(() => layeredTrails.map(l => l.trail), [layeredTrails]);

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

  // Pre-compute polyline coordinates so extractCoords is not called per render.
  const trailPolylines = useMemo(
    () =>
      layeredTrails
        .map(({ trail: t, layerColor, isOsm }) => ({
          id: t.id,
          trail: t,
          coords: extractCoords(t.path),
          layerColor,
          isOsm,
          isSeasonal: !!((t as unknown as Record<string, unknown>)["is_seasonal"]),
        }))
        .filter((p) => p.coords.length >= 2),
    [layeredTrails],
  );

  // Road liaison connectors — always shown regardless of filters; never tappable.
  const roadPolylines = useMemo(
    () =>
      roadData
        .map((t) => ({ id: t.id, coords: extractCoords(t.path) }))
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
        const here = await Location.getLastKnownPositionAsync();
        const pos =
          here ??
          (await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          }));
        const next: Region = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          latitudeDelta: 0.08,
          longitudeDelta: 0.08,
        };
        setRegion(next);
        mapRef.current?.animateToRegion(next, 600);
      } catch {
        // keep fallback region
      }
    })();
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <View style={styles.container}>
      <ClusterMapView
        ref={mapRef}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        mapType={mapKind}
        style={StyleSheet.absoluteFill}
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
        {trails.map((t) => {
          const lat = t.centroid_lat;
          const lon = t.centroid_lon;
          if (typeof lat !== "number" || typeof lon !== "number") return null;
          return (
            <Marker
              key={`m-${t.id}`}
              coordinate={{ latitude: lat, longitude: lon }}
              tracksViewChanges={false}
              pinColor={difficultyColor(t.difficulty)}
              onPress={() => setSelected(trailDetailData(t))}
            />
          );
        })}
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
          const color = isPremium
            ? (isOsm ? difficultyColor(trail.difficulty) : layerColor)
            : "#888888";
          return (
            <Polyline
              key={id}
              coordinates={coords}
              strokeColor={color}
              strokeWidth={isPremium ? 4 : 3}
              lineDashPattern={isSeasonal ? [8, 6] : undefined}
              tappable
              onPress={() => setSelected(trailDetailData(trail))}
            />
          );
        })}
      </ClusterMapView>

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
                  {h.display_name}
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
            {trails.length} trail{trails.length === 1 ? "" : "s"} in view
          </Text>
        </View>

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
                  const pos = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.Balanced,
                  });
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

      {/* ── Filter rows ────────────────────────────────────────────────── */}
      <View style={styles.filtersContainer} pointerEvents="box-none">
        {/* Row 1 — Grade difficulty */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
          pointerEvents="box-none"
        >
          {GRADE_CHIPS.map((chip) => {
            const active = gradeFilter === chip.id;
            const locked = chip.id !== "all" && !isPremium;
            return (
              <TouchableOpacity
                key={chip.id}
                onPress={() => handleGradeFilter(chip.id)}
                style={[
                  styles.filterChip,
                  active && styles.filterChipActive,
                  active && chip.color ? { backgroundColor: chip.color, borderColor: chip.color } : null,
                ]}
              >
                {locked ? (
                  <Feather
                    name="lock"
                    size={9}
                    color={colors.light.mutedForeground}
                    style={styles.lockIcon}
                  />
                ) : null}
                {chip.color && !active ? (
                  <View
                    style={[styles.colorDot, { backgroundColor: chip.color }]}
                  />
                ) : null}
                <Text
                  style={[
                    styles.filterChipText,
                    active && styles.filterChipTextActive,
                  ]}
                >
                  {chip.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Row 2 — Bike type */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
          pointerEvents="box-none"
        >
          {BIKE_CHIPS.map((chip) => {
            const active = bikeFilter === chip.id;
            const locked = chip.id !== "all" && !isPremium;
            return (
              <TouchableOpacity
                key={chip.id}
                onPress={() => handleBikeFilter(chip.id)}
                style={[
                  styles.filterChip,
                  active && styles.filterChipActive,
                ]}
              >
                {locked ? (
                  <Feather
                    name="lock"
                    size={9}
                    color={colors.light.mutedForeground}
                    style={styles.lockIcon}
                  />
                ) : null}
                <Text
                  style={[
                    styles.filterChipText,
                    active && styles.filterChipTextActive,
                  ]}
                >
                  {chip.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Row 3 — Trail visibility */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
          pointerEvents="box-none"
        >
          {VISIBILITY_CHIPS.map((chip) => {
            const active = visibilityFilter === chip.id;
            const locked = chip.id !== "all" && !isPremium;
            return (
              <TouchableOpacity
                key={chip.id}
                onPress={() => handleVisibilityFilter(chip.id)}
                style={[
                  styles.filterChip,
                  active && styles.filterChipActive,
                ]}
              >
                {locked ? (
                  <Feather
                    name="lock"
                    size={9}
                    color={colors.light.mutedForeground}
                    style={styles.lockIcon}
                  />
                ) : null}
                <Text
                  style={[
                    styles.filterChipText,
                    active && styles.filterChipTextActive,
                  ]}
                >
                  {chip.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* ── Location denied banner ──────────────────────────────────────── */}
      {permission === "denied" ? (
        <View style={styles.permBanner}>
          <Text style={styles.permBannerText}>
            Location off — turn it on in Settings to see your position.
          </Text>
        </View>
      ) : null}

      {/* ── Trail detail sheet ──────────────────────────────────────────── */}
      <TrailDetailSheet
        visible={!!selected}
        trail={selected}
        ridden={selected ? ridden.has(selected.id) : false}
        onClose={() => setSelected(null)}
        onMarkRiddenChange={() => void completionsQ.refetch()}
      />

      {/* ── Layer panel — bottom-left floating ─────────────────────────── */}
      <LayerPanel layers={layers} onToggle={toggleLayer} />

      {/* ── Upgrade prompt ──────────────────────────────────────────────── */}
      <UpgradePrompt
        visible={upgradeVisible}
        featureName={upgradedFeature}
        onDismiss={() => setUpgradeVisible(false)}
      />
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

function bboxFromRegion(r: Region): string {
  const minLon = (r.longitude - r.longitudeDelta / 2).toFixed(4);
  const maxLon = (r.longitude + r.longitudeDelta / 2).toFixed(4);
  const minLat = (r.latitude - r.latitudeDelta / 2).toFixed(4);
  const maxLat = (r.latitude + r.latitudeDelta / 2).toFixed(4);
  return `${minLon},${minLat},${maxLon},${maxLat}`;
}

/**
 * Coerce trail.path (GeoJSON `[lon,lat]` arrays OR legacy `{lat,lon}` objects)
 * into react-native-maps `{latitude, longitude}` shape.
 *
 * The GeoJSON array case is handled by `parseGeoJsonPath` from lib/geo.
 * The object case exists for defensive backward-compatibility with any legacy
 * data that might use `{lat, lon}` or `{latitude, longitude}` objects.
 */
function extractCoords(
  path: unknown,
): Array<{ latitude: number; longitude: number }> {
  if (!Array.isArray(path)) return [];

  // Fast path: all elements are [lon, lat] arrays (standard API format).
  if (path.length > 0 && Array.isArray(path[0])) {
    return parseGeoJsonPath(path);
  }

  // Slow path: elements are objects with lat/lon fields (legacy).
  const out: Array<{ latitude: number; longitude: number }> = [];
  for (const pt of path) {
    if (pt && typeof pt === "object") {
      const o = pt as Record<string, unknown>;
      const lat =
        typeof o.lat === "number"
          ? o.lat
          : typeof o.latitude === "number"
            ? o.latitude
            : null;
      const lon =
        typeof o.lon === "number"
          ? o.lon
          : typeof o.lng === "number"
            ? o.lng
            : typeof o.longitude === "number"
              ? o.longitude
              : null;
      if (lat != null && lon != null) {
        out.push({ latitude: lat, longitude: lon });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0D0D0D" },

  // Search — premium pill
  searchRow: {
    position: "absolute",
    top: 12,
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
    top: 82,
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
