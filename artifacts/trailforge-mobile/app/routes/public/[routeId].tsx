/**
 * Public saved route — rider-published trips from the community.
 */
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import * as Location from "expo-location";
import { router, useLocalSearchParams } from "expo-router";
import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, { Polyline, type Region } from "react-native-maps";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { StartRideSheet, type RidePreviewStats } from "@/components/routes/StartRideSheet";
import { UpgradePrompt } from "@/components/UpgradePrompt";
import { PageLoadingCover } from "@/components/PageLoadingCover";
import { useProfile } from "@/components/ProfileContext";
import colors from "@/constants/colors";
import { setActiveNavRoute } from "@/lib/activeNavRoute";
import { fetchPublicRouteDetail, searchTrailsByBbox, type MapTrail } from "@/lib/api";
import { trailMapCoordinates } from "@/lib/geo";
import { rideLevelById, type RideLevelId } from "@/lib/rideLevels";
import { difficultyColor, gradeFromDifficulty, gradeToColor } from "@/lib/trailColors";
import {
  buildTntNavPlan,
  buildTntNavRouteAsync,
  suggestTntDirection,
  type TntDirection,
} from "@/lib/tntNavigation";

const AMBER = colors.light.primary;

function orderTrailsByIds(trails: MapTrail[], ids: string[]): MapTrail[] {
  const map = new Map(trails.map((t) => [t.id, t]));
  const ordered: MapTrail[] = [];
  for (const id of ids) {
    const t = map.get(id);
    if (t) ordered.push(t);
  }
  if (ordered.length === 0) return trails;
  return ordered;
}

export default function PublicRouteScreen() {
  const { routeId } = useLocalSearchParams<{ routeId: string }>();
  const insets = useSafeAreaInsets();
  const { profile } = useProfile();
  const isPremium = profile.isPremium;
  const mapRef = useRef<MapView | null>(null);

  const [rideSheetOpen, setRideSheetOpen] = useState(false);
  const [navLoading, setNavLoading] = useState(false);
  const [navDirection, setNavDirection] = useState<TntDirection>("forward");
  const [rideLevelId, setRideLevelId] = useState<RideLevelId>("moderate");
  const [navUserPos, setNavUserPos] = useState<{ latitude: number; longitude: number } | null>(null);
  const [upgradeVisible, setUpgradeVisible] = useState(false);

  const routeQ = useQuery({
    queryKey: ["public-route", routeId],
    queryFn: () => fetchPublicRouteDetail(routeId!),
    enabled: !!routeId,
  });

  const trailsQ = useQuery({
    queryKey: ["public-route-trails", routeId, routeQ.data?.trailIds],
    queryFn: async () => {
      const ids = routeQ.data!.trailIds.join(",");
      if (!ids) return [] as MapTrail[];
      const res = await searchTrailsByBbox({ ids, limit: 200 });
      return orderTrailsByIds(res.trails ?? [], routeQ.data!.trailIds);
    },
    enabled: !!routeQ.data?.trailIds?.length,
  });

  const trails = trailsQ.data ?? routeQ.data?.trails ?? [];

  const mapRegion = useMemo((): Region => {
    const lats: number[] = [];
    const lons: number[] = [];
    for (const t of trails) {
      for (const c of trailMapCoordinates(t)) {
        lats.push(c.latitude);
        lons.push(c.longitude);
      }
    }
    if (!lats.length) {
      return { latitude: 54.5, longitude: -2.5, latitudeDelta: 2, longitudeDelta: 2 };
    }
    return {
      latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
      longitude: (Math.min(...lons) + Math.max(...lons)) / 2,
      latitudeDelta: Math.max(0.3, (Math.max(...lats) - Math.min(...lats)) * 1.4),
      longitudeDelta: Math.max(0.3, (Math.max(...lons) - Math.min(...lons)) * 1.4),
    };
  }, [trails]);

  const ridePreview = useMemo((): RidePreviewStats | null => {
    if (!navUserPos || !rideSheetOpen || !trails.length) return null;
    const level = rideLevelById(rideLevelId);
    const built = buildTntNavPlan({
      allTrails: trails,
      userPos: navUserPos,
      direction: navDirection,
      maxGrade: level.maxGrade,
    });
    if (!built) return null;
    return {
      joinName: trails[built.plan.join.sectionIndex]?.name ?? routeQ.data?.name ?? "Route",
      joinDistanceKm: built.plan.join.snap.distanceM / 1000,
      trailSectionCount: built.plan.legs.filter((l) => l.kind === "trail").length,
      skippedSections: built.plan.skippedHardSections,
      estimatedRoadBypassKm: built.plan.bypassRoadKm,
      totalDistanceKm: routeQ.data?.totalDistanceKm ?? undefined,
    };
  }, [navUserPos, rideSheetOpen, trails, rideLevelId, navDirection, routeQ.data]);

  async function openRideSheet() {
    if (!trails.length) {
      Alert.alert("Route empty", "This published route has no trail sections yet.");
      return;
    }
    setNavLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Location needed", "Turn on location to start from where you are.");
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const userPos = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      setNavUserPos(userPos);
      setNavDirection(suggestTntDirection(trails, userPos));
      setRideSheetOpen(true);
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
        Alert.alert("No route found", "Try a different ride level.");
        return;
      }
      setRideSheetOpen(false);
      setActiveNavRoute(built.routeInput, built.route);
      router.push("/navigate");
    } finally {
      setNavLoading(false);
    }
  }

  const loading = routeQ.isLoading || trailsQ.isLoading;
  const route = routeQ.data;

  return (
    <PageLoadingCover loading={loading} message="Loading route…">
      <View style={{ flex: 1 }}>
      <ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <TouchableOpacity style={[styles.back, { top: insets.top + 8 }]} onPress={() => router.back()}>
          <Feather name="arrow-left" size={20} color="#fff" />
        </TouchableOpacity>

        <View style={[styles.header, { paddingTop: insets.top + 48 }]}>
          <Text style={styles.title}>{route?.name ?? "Community route"}</Text>
          {route?.ownerName ? (
            route?.ownerId ? (
              <Pressable
                onPress={() =>
                  router.push(`/profile/${encodeURIComponent(route.ownerId!)}` as never)
                }
              >
                <Text style={styles.bylineLink}>Shared by {route.ownerName}</Text>
              </Pressable>
            ) : (
              <Text style={styles.byline}>Shared by {route.ownerName}</Text>
            )
          ) : null}
          {route?.description ? (
            <Text style={styles.desc}>{route.description}</Text>
          ) : null}
          <View style={styles.metaRow}>
            {route?.totalDistanceKm != null ? (
              <Text style={styles.meta}>{Math.round(route.totalDistanceKm)} km</Text>
            ) : null}
            <Text style={styles.meta}>{trails.length} sections</Text>
            {route?.likesCount ? (
              <Text style={styles.meta}>{route.likesCount} likes</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.mapBox}>
          <MapView ref={mapRef} style={styles.map} initialRegion={mapRegion}>
            {trails.map((t) => {
              const coords = trailMapCoordinates(t);
              if (coords.length < 2) return null;
              return (
                <Polyline
                  key={t.id}
                  coordinates={coords}
                  strokeColor={difficultyColor(t.difficulty)}
                  strokeWidth={4}
                />
              );
            })}
          </MapView>
        </View>

        <TouchableOpacity style={styles.primaryBtn} onPress={() => void openRideSheet()}>
          <Feather name="navigation" size={22} color="#1a0e05" />
          <Text style={styles.primaryBtnText}>START RIDE</Text>
        </TouchableOpacity>
        {!isPremium ? (
          <Text style={styles.premiumHint}>Turn-by-turn navigation is included with Premium</Text>
        ) : null}

        <Text style={styles.sectionLabel}>Sections on this route</Text>
        {trails.map((t) => {
          const grade = gradeFromDifficulty(t.difficulty ?? t.ai_difficulty);
          const gColor = gradeToColor(grade);
          return (
            <View key={t.id} style={styles.sectionCard}>
              <View style={[styles.badge, { borderColor: gColor, backgroundColor: gColor + "33" }]}>
                <Text style={{ color: gColor, fontWeight: "900" }}>{grade ?? "?"}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionName}>{t.name}</Text>
                <Text style={styles.sectionMeta}>
                  {t.distance_km != null ? `${t.distance_km.toFixed(1)} km` : "—"}
                </Text>
              </View>
            </View>
          );
        })}
      </ScrollView>

      <StartRideSheet
        visible={rideSheetOpen}
        routeName={route?.name ?? "Route"}
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
        onViewMap={() => {
          setRideSheetOpen(false);
          router.push("/(tabs)/map" as never);
        }}
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.light.background },
  back: {
    position: "absolute",
    left: 12,
    zIndex: 10,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  header: { paddingHorizontal: 20, paddingBottom: 16 },
  title: { color: "#fff", fontSize: 26, fontWeight: "900" },
  byline: { color: AMBER, fontSize: 13, marginTop: 6, fontWeight: "600" },
  bylineLink: { color: AMBER, fontSize: 13, marginTop: 6, fontWeight: "700", textDecorationLine: "underline" },
  desc: { color: "#a8a29e", fontSize: 14, lineHeight: 20, marginTop: 10 },
  metaRow: { flexDirection: "row", gap: 12, marginTop: 12 },
  meta: { color: "#78716c", fontSize: 12, fontWeight: "700" },
  mapBox: {
    marginHorizontal: 16,
    height: 200,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#292524",
  },
  map: { flex: 1 },
  primaryBtn: {
    margin: 16,
    minHeight: 54,
    borderRadius: 12,
    backgroundColor: AMBER,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  primaryBtnText: { color: "#1a0e05", fontWeight: "900", fontSize: 16 },
  premiumHint: { textAlign: "center", color: "#78716c", fontSize: 12, marginHorizontal: 24, marginBottom: 8 },
  sectionLabel: {
    color: AMBER,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  sectionCard: {
    flexDirection: "row",
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
  },
  badge: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionName: { color: "#fff", fontWeight: "700", fontSize: 14 },
  sectionMeta: { color: "#78716c", fontSize: 12, marginTop: 2 },
});
