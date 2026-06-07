/**
 * Trans Northern Trail — dedicated community route page.
 * Wording avoids "official" / "partnership"; credits community mapping.
 */
import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router } from "expo-router";
import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, { Polyline, type Region } from "react-native-maps";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  TrailDetailSheet,
  type TrailDetailData,
} from "@/components/TrailDetailSheet";
import colors from "@/constants/colors";
import {
  fetchCollectionSections,
  fetchTntTrails,
  fetchTrailCollections,
  type MapTrail,
} from "@/lib/api";
import { exportGpxFile, trailsToGpxInput, type GpxDevice } from "@/lib/gpxExport";
import { trailMapCoordinates, trailCentroid } from "@/lib/geo";
import {
  difficultyColor,
  gradeFromDifficulty,
  gradeToColor,
} from "@/lib/trailColors";

const AMBER = colors.light.primary;
const HERO = require("@/assets/videos/intoimage.jpeg");
const OFFLINE_KEY = "@trailforge/tnt-offline-v1";
const { width: W } = Dimensions.get("window");

function trailDetailData(t: MapTrail): TrailDetailData {
  return {
    id: t.id,
    name: t.name,
    difficulty: t.difficulty,
    distance_km: t.distance_km ?? null,
    elevation_gain_m: t.elevation_gain_m ?? null,
    legal_status: t.legal_status ?? null,
  };
}

export default function TransNorthernTrailScreen() {
  const insets = useSafeAreaInsets();
  const mapRef = useRef<MapView | null>(null);
  const [selected, setSelected] = useState<TrailDetailData | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);

  const collectionsQ = useQuery({
    queryKey: ["trail-collections"],
    queryFn: fetchTrailCollections,
    staleTime: 60_000,
  });

  const collection = useMemo(
    () => collectionsQ.data?.find((c) => c.name === "Trans Northern Trail") ?? null,
    [collectionsQ.data],
  );

  const sectionsQ = useQuery({
    queryKey: ["tnt-sections", collection?.id],
    queryFn: () => fetchCollectionSections(collection!.id),
    enabled: !!collection?.id,
    staleTime: 60_000,
  });

  const fallbackTrailsQ = useQuery({
    queryKey: ["tnt-trails-fallback"],
    queryFn: () => fetchTntTrails(500),
    enabled: !collection?.id,
    staleTime: 60_000,
  });

  const trails: MapTrail[] = useMemo(() => {
    if (sectionsQ.data?.length) {
      return sectionsQ.data.map((s) => s.trail).filter(Boolean);
    }
    return fallbackTrailsQ.data ?? [];
  }, [sectionsQ.data, fallbackTrailsQ.data]);

  const overviewCoords = useMemo(() => {
    const geo = collection?.overview_path_geojson;
    if (!geo?.coordinates?.length) return [];
    return geo.coordinates.map(([lon, lat]) => ({
      latitude: lat,
      longitude: lon,
    }));
  }, [collection?.overview_path_geojson]);

  const polylines = useMemo(
    () =>
      trails
        .map((t) => ({
          id: t.id,
          trail: t,
          coords: trailMapCoordinates(t),
          isRoad: t.terrain === "road",
        }))
        .filter((p) => p.coords.length >= 2),
    [trails],
  );

  const stats = useMemo(() => {
    let trailKm = 0;
    let roadKm = 0;
    const grades: number[] = [];
    for (const t of trails) {
      const d = t.distance_km ?? 0;
      if (t.terrain === "road") roadKm += d;
      else trailKm += d;
      const g = gradeFromDifficulty(t.difficulty ?? t.ai_difficulty);
      if (g != null) grades.push(g);
    }
    return {
      trailKm: Math.round(trailKm),
      roadKm: Math.round(roadKm),
      totalKm: Math.round(trailKm + roadKm),
      sections: trails.length,
      gradeMin: grades.length ? Math.min(...grades) : null,
      gradeMax: grades.length ? Math.max(...grades) : null,
    };
  }, [trails]);

  const mapRegion = useMemo((): Region => {
    const lats: number[] = [];
    const lons: number[] = [];
    for (const p of polylines) {
      for (const c of p.coords) {
        lats.push(c.latitude);
        lons.push(c.longitude);
      }
    }
    for (const c of overviewCoords) {
      lats.push(c.latitude);
      lons.push(c.longitude);
    }
    if (!lats.length) {
      return { latitude: 54.5, longitude: -2.5, latitudeDelta: 4, longitudeDelta: 4 };
    }
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLon + maxLon) / 2,
      latitudeDelta: Math.max(0.4, (maxLat - minLat) * 1.35),
      longitudeDelta: Math.max(0.4, (maxLon - minLon) * 1.35),
    };
  }, [polylines, overviewCoords]);

  const loading =
    collectionsQ.isLoading
    || (collection?.id ? sectionsQ.isLoading : fallbackTrailsQ.isLoading);

  async function saveOffline() {
    setSaving(true);
    try {
      await AsyncStorage.setItem(
        OFFLINE_KEY,
        JSON.stringify({ trailIds: trails.map((t) => t.id), savedAt: Date.now() }),
      );
      Alert.alert(
        "Saved for offline",
        "Trail section IDs cached locally. Full offline maps coming soon.",
      );
    } catch {
      Alert.alert("Save failed", "Could not cache route data.");
    } finally {
      setSaving(false);
    }
  }

  async function exportGpx() {
    if (!trails.length) return;
    setExporting(true);
    try {
      const device: GpxDevice = "generic";
      await exportGpxFile(
        trailsToGpxInput("Trans Northern Trail (community route)", trails),
        device,
      );
    } catch (e) {
      Alert.alert("Export failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setExporting(false);
    }
  }

  function navigateFullRoute() {
    if (!polylines.length) {
      Alert.alert("Route not loaded", "Import the TNT data or check your connection.");
      return;
    }
    mapRef.current?.animateToRegion(mapRegion, 800);
    router.push("/(tabs)/map" as never);
  }

  function focusTrail(t: MapTrail) {
    setHighlightId(t.id);
    const center = trailCentroid(t);
    if (center) {
      mapRef.current?.animateToRegion(
        {
          latitude: center.latitude,
          longitude: center.longitude,
          latitudeDelta: 0.12,
          longitudeDelta: 0.12,
        },
        500,
      );
    }
    setSelected(trailDetailData(t));
  }

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        {/* Hero */}
        <View style={styles.heroWrap}>
          <Image source={HERO} style={StyleSheet.absoluteFill} contentFit="cover" />
          <View style={styles.heroScrim} />
          <TouchableOpacity
            style={[styles.backBtn, { top: insets.top + 8 }]}
            onPress={() => router.back()}
          >
            <Feather name="arrow-left" size={20} color="#fff" />
          </TouchableOpacity>
          <View style={[styles.heroText, { paddingTop: insets.top + 48 }]}>
            <Text style={styles.heroTitle}>TRANS NORTHERN TRAIL</Text>
            <View style={styles.heroUnderline} />
            <Text style={styles.heroSub}>
              Trails associated with the Trans Northern Trail
            </Text>
          </View>
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          <Stat label="Total" value={`${stats.totalKm} km`} />
          <Stat label="Trail" value={`${stats.trailKm} km`} />
          <Stat label="Road" value={`${stats.roadKm} km`} />
          <Stat label="Sections" value={String(stats.sections)} />
        </View>

        <Text style={styles.credit}>Route data from community mapping</Text>

        {loading ? (
          <ActivityIndicator color={AMBER} style={{ marginVertical: 24 }} />
        ) : null}

        {/* Map overview */}
        <Text style={styles.sectionLabel}>Route overview</Text>
        <View style={styles.mapBox}>
          <MapView
            ref={mapRef}
            style={styles.map}
            initialRegion={mapRegion}
            scrollEnabled
            zoomEnabled
          >
            {overviewCoords.length >= 2 ? (
              <Polyline
                coordinates={overviewCoords}
                strokeColor="rgba(255,255,255,0.35)"
                strokeWidth={3}
                lineDashPattern={[0]}
                zIndex={0}
              />
            ) : null}
            {polylines.map(({ id, trail, coords, isRoad }) => (
              <Polyline
                key={id}
                coordinates={coords}
                strokeColor={
                  highlightId === id
                    ? AMBER
                    : isRoad
                      ? "#888888"
                      : difficultyColor(trail.difficulty)
                }
                strokeWidth={highlightId === id ? 6 : isRoad ? 2 : 4}
                lineDashPattern={isRoad ? [6, 8] : undefined}
                tappable
                onPress={() => focusTrail(trail)}
              />
            ))}
          </MapView>
        </View>

        {/* Actions */}
        <TouchableOpacity style={styles.navBtn} onPress={navigateFullRoute}>
          <Feather name="navigation" size={20} color="#1a0e05" />
          <Text style={styles.navBtnText}>NAVIGATE FULL ROUTE</Text>
        </TouchableOpacity>
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.secondaryBtn}
            disabled={saving || !trails.length}
            onPress={() => void saveOffline()}
          >
            {saving ? (
              <ActivityIndicator size="small" color={AMBER} />
            ) : (
              <>
                <Feather name="download" size={16} color={AMBER} />
                <Text style={styles.secondaryText}>SAVE OFFLINE</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryBtn}
            disabled={exporting || !trails.length}
            onPress={() => void exportGpx()}
          >
            {exporting ? (
              <ActivityIndicator size="small" color={AMBER} />
            ) : (
              <>
                <Feather name="share" size={16} color={AMBER} />
                <Text style={styles.secondaryText}>EXPORT GPX</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Section list */}
        <Text style={styles.sectionLabel}>Trail sections</Text>
        {trails.length === 0 && !loading ? (
          <Text style={styles.empty}>
            No TNT sections in the database yet. Run the import script after confirming the dry run.
          </Text>
        ) : null}
        {trails.map((t) => {
          const grade = gradeFromDifficulty(t.difficulty ?? t.ai_difficulty);
          const gColor = gradeToColor(grade);
          return (
            <TouchableOpacity
              key={t.id}
              style={[styles.sectionCard, highlightId === t.id && styles.sectionCardActive]}
              onPress={() => focusTrail(t)}
            >
              <View style={[styles.gradeBadge, { backgroundColor: gColor + "33", borderColor: gColor }]}>
                <Text style={[styles.gradeText, { color: gColor }]}>
                  {grade ?? "?"}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionName} numberOfLines={2}>{t.name}</Text>
                <Text style={styles.sectionMeta}>
                  {t.distance_km != null ? `${t.distance_km.toFixed(1)} km` : "—"}
                  {t.terrain === "road" ? " · road link" : " · trail"}
                </Text>
              </View>
              <Feather name="chevron-right" size={18} color="#78716c" />
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <TrailDetailSheet
        visible={!!selected}
        trail={selected}
        ridden={false}
        onClose={() => setSelected(null)}
        onMarkRiddenChange={() => undefined}
      />
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.light.background },
  heroWrap: { width: W, height: 220, backgroundColor: "#111" },
  heroScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  backBtn: {
    position: "absolute",
    left: 12,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroText: { paddingHorizontal: 20, paddingBottom: 20 },
  heroTitle: {
    color: "#fff",
    fontSize: 32,
    fontWeight: "900",
    letterSpacing: 1.2,
  },
  heroUnderline: {
    width: 120,
    height: 3,
    backgroundColor: AMBER,
    borderRadius: 2,
    marginTop: 8,
    marginBottom: 10,
  },
  heroSub: { color: "rgba(255,255,255,0.85)", fontSize: 14, lineHeight: 20 },
  statsRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 8,
  },
  stat: {
    flex: 1,
    backgroundColor: "#1c1917",
    borderRadius: 10,
    padding: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#292524",
  },
  statValue: { color: "#fff", fontWeight: "800", fontSize: 15 },
  statLabel: { color: "#78716c", fontSize: 10, marginTop: 2, fontWeight: "700" },
  credit: {
    textAlign: "center",
    color: "#78716c",
    fontSize: 11,
    marginTop: 8,
    fontStyle: "italic",
  },
  sectionLabel: {
    color: AMBER,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.2,
    marginHorizontal: 16,
    marginTop: 20,
    marginBottom: 8,
  },
  mapBox: {
    marginHorizontal: 16,
    height: 220,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#292524",
  },
  map: { flex: 1 },
  navBtn: {
    marginHorizontal: 16,
    marginTop: 16,
    height: 72,
    borderRadius: 14,
    backgroundColor: AMBER,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  navBtnText: { color: "#1a0e05", fontWeight: "900", fontSize: 16, letterSpacing: 0.8 },
  actionRow: { flexDirection: "row", gap: 10, marginHorizontal: 16, marginTop: 10 },
  secondaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#44403c",
    backgroundColor: "#1c1917",
  },
  secondaryText: { color: AMBER, fontWeight: "800", fontSize: 12 },
  sectionCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
  },
  sectionCardActive: { borderColor: AMBER },
  gradeBadge: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  gradeText: { fontWeight: "900", fontSize: 14 },
  sectionName: { color: "#fff", fontWeight: "700", fontSize: 14 },
  sectionMeta: { color: "#78716c", fontSize: 12, marginTop: 2 },
  empty: { color: "#78716c", marginHorizontal: 16, fontSize: 13, lineHeight: 20 },
});
