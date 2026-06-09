/**
 * Trans Euro Trail — informational landing page, official link-out, personal GPX import.
 * No community trail listing; the official file lives on the rider's device after import.
 */
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { Image } from "expo-image";
import * as Location from "expo-location";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { useProfile } from "@/components/ProfileContext";
import colors from "@/constants/colors";
import { RIDE_POV_BANNER } from "@/constants/brandImages";
import { setActiveNavRoute } from "@/lib/activeNavRoute";
import { validateGpxString } from "@/lib/gpxImport";
import {
  buildPersonalGpxNavRouteAsync,
  loadPersonalGpxRoute,
  personalGpxMapCoords,
  previewPersonalGpxNav,
  savePersonalGpxRoute,
  clearPersonalGpxRoute,
  suggestPersonalGpxDirection,
  type PersonalGpxRoute,
} from "@/lib/personalGpxRoute";
import {
  TRANS_EURO_TRAIL,
  TRANS_EURO_TRAIL_ABOUT,
  TRANS_EURO_TRAIL_IMPORT_STEPS,
} from "@/lib/transEuroTrail";
import type { TntDirection } from "@/lib/tntNavigation";

const AMBER = colors.light.primary;

export function TransEuroTrailScreen() {
  const insets = useSafeAreaInsets();
  const { profile } = useProfile();
  const isPremium = profile.isPremium;
  const mapRef = useRef<MapView | null>(null);

  const [personalRoute, setPersonalRoute] = useState<PersonalGpxRoute | null>(null);
  const [importing, setImporting] = useState(false);
  const [rideSheetOpen, setRideSheetOpen] = useState(false);
  const [navLoading, setNavLoading] = useState(false);
  const [navDirection, setNavDirection] = useState<TntDirection>("forward");
  const [navUserPos, setNavUserPos] = useState<{ latitude: number; longitude: number } | null>(null);
  const [upgradeVisible, setUpgradeVisible] = useState(false);

  useEffect(() => {
    void (async () => {
      let route = await loadPersonalGpxRoute(TRANS_EURO_TRAIL.personalGpxStorageKey);
      if (!route) {
        route = await loadPersonalGpxRoute("@trailforge/personal-gpx/euro-trail-associated-v1");
        if (route) {
          await savePersonalGpxRoute(TRANS_EURO_TRAIL.personalGpxStorageKey, route);
        }
      }
      setPersonalRoute(route);
    })();
  }, []);

  const mapCoords = useMemo(
    () => (personalRoute ? personalGpxMapCoords(personalRoute) : []),
    [personalRoute],
  );

  const mapRegion = useMemo((): Region => {
    if (!mapCoords.length) {
      return { latitude: 54.5, longitude: -2.5, latitudeDelta: 4, longitudeDelta: 4 };
    }
    const lats = mapCoords.map((c) => c.latitude);
    const lons = mapCoords.map((c) => c.longitude);
    return {
      latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
      longitude: (Math.min(...lons) + Math.max(...lons)) / 2,
      latitudeDelta: Math.max(0.4, (Math.max(...lats) - Math.min(...lats)) * 1.35),
      longitudeDelta: Math.max(0.4, (Math.max(...lons) - Math.min(...lons)) * 1.35),
    };
  }, [mapCoords]);

  const ridePreview = useMemo((): RidePreviewStats | null => {
    if (!navUserPos || !rideSheetOpen || !personalRoute) return null;
    const preview = previewPersonalGpxNav(personalRoute, navUserPos, navDirection);
    if (!preview) return null;
    return {
      joinName: personalRoute.name,
      joinDistanceKm: preview.joinDistanceKm,
      trailSectionCount: 1,
      skippedSections: 0,
      estimatedRoadBypassKm: 0,
      totalDistanceKm: preview.remainingKm,
    };
  }, [navUserPos, rideSheetOpen, personalRoute, navDirection]);

  async function openWebsite() {
    await WebBrowser.openBrowserAsync(TRANS_EURO_TRAIL.websiteUrl);
  }

  async function openDownload() {
    await WebBrowser.openBrowserAsync(TRANS_EURO_TRAIL.downloadUrl);
  }

  async function pickAndImport() {
    setImporting(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["application/gpx+xml", "application/xml", "text/xml", "*/*"],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      const name = asset.name ?? "route.gpx";
      if (!/\.gpx$/i.test(name)) {
        Alert.alert("Wrong file type", "Please choose the .gpx file you downloaded from transeurotrail.org.");
        return;
      }

      const text = await FileSystem.readAsStringAsync(asset.uri);
      const validation = validateGpxString(text, asset.size ?? text.length);
      if (!validation.ok) {
        Alert.alert("Could not read GPX", validation.error ?? "Invalid GPX file.");
        return;
      }

      const route: PersonalGpxRoute = {
        name: validation.name ?? name.replace(/\.gpx$/i, ""),
        waypoints: validation.waypoints,
        distanceKm: validation.distanceKm,
        importedAt: Date.now(),
        sourceUrl: TRANS_EURO_TRAIL.downloadUrl,
      };

      await savePersonalGpxRoute(TRANS_EURO_TRAIL.personalGpxStorageKey, route);
      setPersonalRoute(route);
      Alert.alert(
        "Route imported",
        `"${route.name}" is on this device. With Premium you can navigate it turn-by-turn.`,
      );
    } catch (e) {
      Alert.alert(
        "Import failed",
        e instanceof Error ? e.message : "Could not read the GPX file.",
      );
    } finally {
      setImporting(false);
    }
  }

  function confirmRemove() {
    Alert.alert(
      "Remove imported route?",
      "This deletes the file from this device only. You can download and import again anytime.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void clearPersonalGpxRoute(TRANS_EURO_TRAIL.personalGpxStorageKey).then(() =>
              setPersonalRoute(null),
            );
          },
        },
      ],
    );
  }

  async function openRideSheet() {
    if (!personalRoute) {
      Alert.alert("Import first", "Download the GPX from the Trans Euro Trail website, then import it below.");
      return;
    }
    setNavLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Location needed", "Turn on location so we can join the route where you are.");
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const userPos = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      setNavUserPos(userPos);
      setNavDirection(suggestPersonalGpxDirection(mapCoords, userPos));
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
    if (!navUserPos || !personalRoute) return;
    setNavLoading(true);
    try {
      const built = await buildPersonalGpxNavRouteAsync(
        personalRoute,
        navUserPos,
        navDirection,
      );
      if (!built) {
        Alert.alert("No route found", "Try changing direction or move closer to the track.");
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

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 28 }}>
        <View style={styles.heroWrap}>
          <Image source={RIDE_POV_BANNER} style={StyleSheet.absoluteFill} contentFit="cover" />
          <View style={styles.heroScrim} />
          <TouchableOpacity
            style={[styles.backBtn, { top: insets.top + 8 }]}
            onPress={() => router.back()}
          >
            <Feather name="arrow-left" size={20} color="#fff" />
          </TouchableOpacity>
          <View style={[styles.heroText, { paddingTop: insets.top + 48 }]}>
            <Text style={styles.heroTitle}>TRANS EURO TRAIL</Text>
            <View style={styles.heroUnderline} />
            <Text style={styles.heroSub}>
              Official GPX from transeurotrail.org · import for personal navigation
            </Text>
          </View>
        </View>

        <View style={styles.body}>
          <Text style={styles.sectionTitle}>About the Trans Euro Trail</Text>
          {TRANS_EURO_TRAIL_ABOUT.map((para) => (
            <Text key={para.slice(0, 24)} style={styles.paragraph}>
              {para}
            </Text>
          ))}

          <TouchableOpacity style={styles.linkBtn} onPress={() => void openWebsite()}>
            <Feather name="globe" size={18} color={AMBER} />
            <View style={{ flex: 1 }}>
              <Text style={styles.linkTitle}>Visit transeurotrail.org</Text>
              <Text style={styles.linkSub}>Learn about the project and routes across Europe</Text>
            </View>
            <Feather name="external-link" size={16} color="#78716c" />
          </TouchableOpacity>

          <TouchableOpacity style={styles.linkBtn} onPress={() => void openDownload()}>
            <Feather name="download" size={18} color={AMBER} />
            <View style={{ flex: 1 }}>
              <Text style={styles.linkTitle}>Download UK GPX</Text>
              <Text style={styles.linkSub}>Get the official route file for United Kingdom</Text>
            </View>
            <Feather name="external-link" size={16} color="#78716c" />
          </TouchableOpacity>

          <Text style={[styles.sectionTitle, { marginTop: 24 }]}>
            Use it in TrailForge
          </Text>
          {TRANS_EURO_TRAIL_IMPORT_STEPS.map((s) => (
            <View key={s.step} style={styles.stepRow}>
              <View style={styles.stepBadge}>
                <Text style={styles.stepNum}>{s.step}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.stepTitle}>{s.title}</Text>
                <Text style={styles.stepBody}>{s.body}</Text>
              </View>
            </View>
          ))}

          {personalRoute ? (
            <View style={styles.loadedBox}>
              <View style={{ flex: 1 }}>
                <Text style={styles.loadedLabel}>Your imported route</Text>
                <Text style={styles.loadedName} numberOfLines={2}>
                  {personalRoute.name}
                </Text>
                <Text style={styles.loadedMeta}>
                  {personalRoute.distanceKm.toFixed(0)} km · imported{" "}
                  {new Date(personalRoute.importedAt).toLocaleDateString()} · this device only
                </Text>
              </View>
              <TouchableOpacity onPress={confirmRemove} hitSlop={8}>
                <Text style={styles.removeText}>Remove</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.importBtn, importing && { opacity: 0.6 }]}
            disabled={importing}
            onPress={() => void pickAndImport()}
          >
            {importing ? (
              <ActivityIndicator color="#1a0e05" size="small" />
            ) : (
              <>
                <Feather name="upload" size={20} color="#1a0e05" />
                <Text style={styles.importText}>
                  {personalRoute ? "REPLACE GPX FILE" : "IMPORT GPX FILE"}
                </Text>
              </>
            )}
          </TouchableOpacity>

          {personalRoute && mapCoords.length >= 2 ? (
            <>
              <Text style={[styles.sectionTitle, { marginTop: 20 }]}>Your route</Text>
              <View style={styles.mapBox}>
                <MapView
                  ref={mapRef}
                  style={styles.map}
                  initialRegion={mapRegion}
                  scrollEnabled
                  zoomEnabled
                >
                  <Polyline
                    coordinates={mapCoords}
                    strokeColor={AMBER}
                    strokeWidth={4}
                  />
                </MapView>
              </View>

              <TouchableOpacity
                style={styles.startBtn}
                disabled={navLoading}
                onPress={() => void openRideSheet()}
              >
                {navLoading && !rideSheetOpen ? (
                  <ActivityIndicator color="#1a0e05" size="small" />
                ) : (
                  <>
                    <Feather name="navigation" size={22} color="#1a0e05" />
                    <Text style={styles.startText}>START RIDING</Text>
                  </>
                )}
              </TouchableOpacity>
              {!isPremium ? (
                <Text style={styles.premiumHint}>
                  Turn-by-turn navigation on your imported route is included with Premium
                </Text>
              ) : null}

              <TouchableOpacity
                style={styles.mapLink}
                onPress={() => router.push("/(tabs)/map" as never)}
              >
                <Text style={styles.mapLinkText}>Open map to filter trails along your route</Text>
              </TouchableOpacity>
            </>
          ) : null}

          <View style={styles.premiumBox}>
            <Feather name="star" size={16} color={AMBER} />
            <Text style={styles.premiumBoxText}>
              Premium adds turn-by-turn navigation on your imported GPX and difficulty filters on
              the map — so you can plan each day to match how you want to ride.
            </Text>
          </View>
        </View>
      </ScrollView>

      <StartRideSheet
        visible={rideSheetOpen}
        routeName={personalRoute?.name ?? "Trans Euro Trail"}
        isPremium={isPremium}
        loading={navLoading}
        direction={navDirection}
        rideLevelId="full"
        preview={ridePreview}
        showRideLevels={false}
        onClose={() => setRideSheetOpen(false)}
        onSetDirection={setNavDirection}
        onSelectLevel={() => undefined}
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
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#1c1917" },
  heroWrap: { height: 220, position: "relative" },
  heroScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  backBtn: {
    position: "absolute",
    left: 16,
    zIndex: 2,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroText: { paddingHorizontal: 20, paddingBottom: 20 },
  heroTitle: { color: "#fff", fontSize: 26, fontWeight: "900", letterSpacing: 1 },
  heroUnderline: {
    width: 48,
    height: 3,
    backgroundColor: AMBER,
    marginVertical: 10,
    borderRadius: 2,
  },
  heroSub: { color: "#d6d3d1", fontSize: 14, lineHeight: 20 },
  body: { paddingHorizontal: 16, paddingTop: 20 },
  sectionTitle: {
    color: AMBER,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.2,
    marginBottom: 12,
  },
  paragraph: {
    color: "#d6d3d1",
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 12,
  },
  linkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#292524",
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#44403c",
  },
  linkTitle: { color: "#fff", fontWeight: "800", fontSize: 15 },
  linkSub: { color: "#78716c", fontSize: 12, marginTop: 3, lineHeight: 17 },
  stepRow: { flexDirection: "row", gap: 12, marginBottom: 16 },
  stepBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: AMBER,
    alignItems: "center",
    justifyContent: "center",
  },
  stepNum: { color: "#1a0e05", fontWeight: "900", fontSize: 13 },
  stepTitle: { color: "#fff", fontWeight: "800", fontSize: 15, marginBottom: 4 },
  stepBody: { color: "#a8a29e", fontSize: 13, lineHeight: 19 },
  loadedBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(245,166,35,0.08)",
    borderRadius: 12,
    padding: 14,
    marginTop: 8,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: AMBER,
  },
  loadedLabel: {
    color: AMBER,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  loadedName: { color: "#fff", fontWeight: "800", fontSize: 16 },
  loadedMeta: { color: "#78716c", fontSize: 12, marginTop: 4 },
  removeText: { color: "#f87171", fontWeight: "700", fontSize: 13 },
  importBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: AMBER,
    borderRadius: 12,
    paddingVertical: 16,
    marginTop: 4,
  },
  importText: { color: "#1a0e05", fontWeight: "900", fontSize: 15 },
  mapBox: {
    height: 200,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#44403c",
    marginBottom: 12,
  },
  map: { flex: 1 },
  startBtn: {
    minHeight: 56,
    borderRadius: 14,
    backgroundColor: AMBER,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  startText: { color: "#1a0e05", fontWeight: "900", fontSize: 17 },
  premiumHint: {
    textAlign: "center",
    color: "#78716c",
    fontSize: 12,
    marginTop: 8,
    lineHeight: 17,
  },
  mapLink: { alignItems: "center", paddingTop: 14 },
  mapLinkText: { color: AMBER, fontWeight: "700", fontSize: 14 },
  premiumBox: {
    flexDirection: "row",
    gap: 10,
    marginTop: 24,
    padding: 14,
    borderRadius: 10,
    backgroundColor: "#292524",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  premiumBoxText: { flex: 1, color: "#a8a29e", fontSize: 12, lineHeight: 18 },
});
