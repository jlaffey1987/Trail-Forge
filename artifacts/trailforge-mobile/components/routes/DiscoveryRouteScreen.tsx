/**
 * Shared discovery route page — TNT and collection-backed community routes.
 */
import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import * as Location from "expo-location";
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

import { StartRideSheet, type RidePreviewStats } from "@/components/routes/StartRideSheet";
import {
  TrailDetailSheet,
  type TrailDetailData,
} from "@/components/TrailDetailSheet";
import { UpgradePrompt } from "@/components/UpgradePrompt";
import { PageLoadingCover } from "@/components/PageLoadingCover";
import { useProfile } from "@/components/ProfileContext";
import colors from "@/constants/colors";
import { RIDE_POV_BANNER } from "@/constants/brandImages";
import { setActiveNavRoute } from "@/lib/activeNavRoute";
import {
  fetchCollectionSections,
  fetchTrailCollections,
  fetchTrailsBySource,
  type MapTrail,
} from "@/lib/api";
import type { DiscoveryRouteConfig } from "@/lib/discoveryRouteConfig";
import { resolveCollection } from "@/lib/discoveryRouteConfig";
import { exportGpxFile, trailsToGpxInput, type GpxDevice } from "@/lib/gpxExport";
import { trailMapCoordinates, trailCentroid } from "@/lib/geo";
import { gradeRangeLabel } from "@/lib/rideLevels";
import { rideLevelById, type RideLevelId } from "@/lib/rideLevels";
import {
  difficultyColor,
  gradeFromDifficulty,
  gradeToColor,
} from "@/lib/trailColors";
import {
  buildTntNavPlan,
  buildTntNavRouteAsync,
  orderedTntTrails,
  suggestTntDirection,
  type TntDirection,
} from "@/lib/tntNavigation";

const AMBER = colors.light.primary;
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

export function DiscoveryRouteScreen({ config }: { config: DiscoveryRouteConfig }) {
  const insets = useSafeAreaInsets();
  const { profile } = useProfile();
  const isPremium = profile.isPremium;
  const mapRef = useRef<MapView | null>(null);
  const [selected, setSelected] = useState<TrailDetailData | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [rideSheetOpen, setRideSheetOpen] = useState(false);
  const [navLoading, setNavLoading] = useState(false);
  const [navDirection, setNavDirection] = useState<TntDirection>("forward");
  const [rideLevelId, setRideLevelId] = useState<RideLevelId>("moderate");
  const [navUserPos, setNavUserPos] = useState<{ latitude: number; longitude: number } | null>(null);
  const [upgradeVisible, setUpgradeVisible] = useState(false);

  const collectionsQ = useQuery({
    queryKey: ["trail-collections"],
    queryFn: fetchTrailCollections,
    staleTime: 60_000,
  });

  const collection = useMemo(
    () => resolveCollection(collectionsQ.data ?? [], config.collectionNames),
    [collectionsQ.data, config.collectionNames],
  );

  const sectionsQ = useQuery({
    queryKey: ["collection-sections", config.slug, collection?.id],
    queryFn: () => fetchCollectionSections(collection!.id),
    enabled: !!collection?.id,
    staleTime: 60_000,
  });

  const fallbackTrailsQ = useQuery({
    queryKey: ["discovery-trails-fallback", config.slug, config.trailSourceFallback],
    queryFn: () => fetchTrailsBySource(config.trailSourceFallback!, 500),
    enabled: !collection?.id && !!config.trailSourceFallback,
    staleTime: 60_000,
  });

  const collectionMeta = useMemo(
    () => collectionsQ.data?.find((c) => c.id === collection?.id) ?? null,
    [collectionsQ.data, collection?.id],
  );

  const trails: MapTrail[] = useMemo(
    () => orderedTntTrails(sectionsQ.data ?? [], fallbackTrailsQ.data ?? []),
    [sectionsQ.data, fallbackTrailsQ.data],
  );

  const overviewCoords = useMemo(() => {
    const geo = collectionMeta?.overview_path_geojson;
    if (!geo?.coordinates?.length) return [];
    return geo.coordinates.map(([lon, lat]) => ({
      latitude: lat,
      longitude: lon,
    }));
  }, [collectionMeta?.overview_path_geojson]);

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

  const ridePreview = useMemo((): RidePreviewStats | null => {
    if (!navUserPos || !rideSheetOpen) return null;
    const level = rideLevelById(rideLevelId);
    const built = buildTntNavPlan({
      allTrails: trails,
      userPos: navUserPos,
      direction: navDirection,
      maxGrade: level.maxGrade,
    });
    if (!built) return null;
    const joinTrail = trails[built.plan.join.sectionIndex];
    return {
      joinName: joinTrail?.name ?? config.title,
      joinDistanceKm: built.plan.join.snap.distanceM / 1000,
      trailSectionCount: built.plan.legs.filter((l) => l.kind === "trail").length,
      skippedSections: built.plan.skippedHardSections,
      estimatedRoadBypassKm: built.plan.bypassRoadKm,
      totalDistanceKm: stats.totalKm,
    };
  }, [navUserPos, rideSheetOpen, trails, rideLevelId, navDirection, stats.totalKm, config.title]);

  async function saveOffline() {
    if (!isPremium) {
      setUpgradeVisible(true);
      return;
    }
    setSaving(true);
    try {
      await AsyncStorage.setItem(
        config.offlineStorageKey,
        JSON.stringify({ trailIds: trails.map((t) => t.id), savedAt: Date.now() }),
      );
      Alert.alert("Saved", "Route bookmarked on this device. Open a trail from the route to save it for offline riding.");
    } catch {
      Alert.alert("Save failed", "Could not save route on this device.");
    } finally {
      setSaving(false);
    }
  }

  async function exportGpx() {
    if (!isPremium) {
      setUpgradeVisible(true);
      return;
    }
    if (!trails.length) return;
    setExporting(true);
    try {
      await exportGpxFile(
        trailsToGpxInput(config.gpxExportLabel, trails),
        "generic" as GpxDevice,
      );
    } catch (e) {
      Alert.alert("Export failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setExporting(false);
    }
  }

  async function openRideSheet() {
    if (!trails.length) {
      Alert.alert("Route not ready", "Check your connection or try again later.");
      return;
    }
    setNavLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Location needed", "Turn on location so we can join the route where you are.");
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const userPos = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      };
      setNavUserPos(userPos);
      setNavDirection(suggestTntDirection(trails, userPos));
      setRideLevelId("moderate");
      setRideSheetOpen(true);
    } catch {
      Alert.alert("GPS unavailable", "Try again when you have a clear view of the sky.");
    } finally {
      setNavLoading(false);
    }
  }

  async function startNavigation() {
    if (!isPremium) {
      setUpgradeVisible(true);
      return;
    }
    if (!navUserPos) return;
    setNavLoading(true);
    try {
      const level = rideLevelById(rideLevelId);
      const built = await buildTntNavRouteAsync({
        allTrails: trails,
        userPos: navUserPos,
        direction: navDirection,
        maxGrade: level.maxGrade,
      });
      if (!built) {
        Alert.alert(
          "No route found",
          "Try a less challenging ride level or change direction.",
        );
        return;
      }
      setRideSheetOpen(false);
      setActiveNavRoute(built.routeInput, built.route);
      router.push("/navigate");
    } catch (e) {
      Alert.alert("Could not start", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setNavLoading(false);
    }
  }

  function viewOnMap() {
    setRideSheetOpen(false);
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

  const difficultyText = gradeRangeLabel(stats.gradeMin, stats.gradeMax);
  const heroImage = config.heroImage ?? RIDE_POV_BANNER;

  return (
    <PageLoadingCover loading={loading} message="Loading route…">
      <View style={styles.root}>
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
          <View style={styles.heroWrap}>
            <Image source={heroImage} style={StyleSheet.absoluteFill} contentFit="cover" />
            <View style={styles.heroScrim} />
            <TouchableOpacity
              style={[styles.backBtn, { top: insets.top + 8 }]}
              onPress={() => router.back()}
            >
              <Feather name="arrow-left" size={20} color="#fff" />
            </TouchableOpacity>
            <View style={[styles.heroText, { paddingTop: insets.top + 48 }]}>
              <Text style={styles.heroTitle}>{config.title}</Text>
              <View style={styles.heroUnderline} />
              <Text style={styles.heroSub}>{config.subtitle}</Text>
            </View>
          </View>

          <View style={styles.statsRow}>
            <Stat label="Total" value={`${stats.totalKm} km`} />
            <Stat label="Trail" value={`${stats.trailKm} km`} />
            <Stat label="Road" value={`${stats.roadKm} km`} />
            <Stat label="Sections" value={String(stats.sections)} />
          </View>
          <Text style={styles.credit}>{difficultyText} · Community mapping</Text>

          <Text style={styles.sectionLabel}>Route overview</Text>
          <View style={styles.mapBox}>
            <MapView ref={mapRef} style={styles.map} initialRegion={mapRegion} scrollEnabled zoomEnabled>
              {overviewCoords.length >= 2 ? (
                <Polyline
                  coordinates={overviewCoords}
                  strokeColor="rgba(255,255,255,0.35)"
                  strokeWidth={3}
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

          <TouchableOpacity
            style={styles.primaryBtn}
            disabled={navLoading || !trails.length}
            onPress={() => void openRideSheet()}
          >
            {navLoading && !rideSheetOpen ? (
              <ActivityIndicator size="small" color="#1a0e05" />
            ) : (
              <>
                <Feather name="navigation" size={22} color="#1a0e05" />
                <Text style={styles.primaryBtnText}>START RIDE</Text>
              </>
            )}
          </TouchableOpacity>
          {!isPremium ? (
            <Text style={styles.premiumHint}>
              Turn-by-turn navigation is included with Premium
            </Text>
          ) : null}

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
                  {!isPremium ? <Feather name="lock" size={12} color="#78716c" style={{ marginLeft: 4 }} /> : null}
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
                  {!isPremium ? <Feather name="lock" size={12} color="#78716c" style={{ marginLeft: 4 }} /> : null}
                </>
              )}
            </TouchableOpacity>
          </View>

          <Text style={styles.sectionLabel}>Trail sections</Text>
          {trails.length === 0 && !loading ? (
            <Text style={styles.empty}>{config.emptyHint}</Text>
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
                  <Text style={[styles.gradeText, { color: gColor }]}>{grade ?? "?"}</Text>
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

        <StartRideSheet
          visible={rideSheetOpen}
          routeName={config.title.replace(/\s+/g, " ").trim()}
          isPremium={isPremium}
          loading={navLoading}
          direction={navDirection}
          rideLevelId={rideLevelId}
          preview={ridePreview}
          onClose={() => setRideSheetOpen(false)}
          onSetDirection={setNavDirection}
          onSelectLevel={setRideLevelId}
          onStart={() => void startNavigation()}
          onUpgrade={() => setUpgradeVisible(true)}
          onViewMap={viewOnMap}
        />

        <UpgradePrompt
          visible={upgradeVisible}
          featureName="Turn-by-turn navigation"
          onDismiss={() => setUpgradeVisible(false)}
        />
      </View>
    </PageLoadingCover>
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
  heroScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
  backBtn: {
    position: "absolute",
    left: 12,
    zIndex: 10,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroText: { paddingHorizontal: 20, paddingBottom: 20 },
  heroTitle: { color: "#fff", fontSize: 28, fontWeight: "900", letterSpacing: 1 },
  heroUnderline: { width: 100, height: 3, backgroundColor: AMBER, borderRadius: 2, marginTop: 8, marginBottom: 10 },
  heroSub: { color: "rgba(255,255,255,0.85)", fontSize: 14, lineHeight: 20 },
  statsRow: { flexDirection: "row", paddingHorizontal: 16, paddingTop: 16, gap: 8 },
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
  credit: { textAlign: "center", color: "#78716c", fontSize: 11, marginTop: 8, fontStyle: "italic" },
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
  primaryBtn: {
    marginHorizontal: 16,
    marginTop: 16,
    minHeight: 56,
    borderRadius: 14,
    backgroundColor: AMBER,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 14,
  },
  primaryBtnText: { color: "#1a0e05", fontWeight: "900", fontSize: 17, letterSpacing: 0.6 },
  premiumHint: {
    textAlign: "center",
    color: "#78716c",
    fontSize: 12,
    marginTop: 8,
    marginHorizontal: 24,
  },
  actionRow: { flexDirection: "row", gap: 10, marginHorizontal: 16, marginTop: 10 },
  secondaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#44403c",
    backgroundColor: "#1c1917",
  },
  secondaryText: { color: AMBER, fontWeight: "800", fontSize: 11 },
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
    width: 40,
    height: 40,
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
