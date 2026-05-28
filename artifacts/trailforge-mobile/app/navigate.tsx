/**
 * Full-screen turn-by-turn navigation screen.
 *
 * Layout (portrait):
 * ┌────────────────────────────────────────────────┐
 * │  [×]  TRAILFORGE NAV            [🔇]  [⊕]     │  ← Control strip
 * ├────────────────────────────────────────────────┤
 * │  ┌──────────────────────────────────────────┐  │
 * │  │  [↑] Entering trail: Midland Way         │  │  ← Instruction banner
 * │  │      In 350 m  ·  Grade 4 (Intermediate) │  │
 * │  └──────────────────────────────────────────┘  │
 * │                                                │
 * │              MapView                           │  ← Heading-up map,
 * │         (rotates with compass)                 │    user at bottom-third
 * │                                                │
 * │         [●] User marker                        │
 * │                                                │
 * ├────────────────────────────────────────────────┤
 * │  45.2 km  │  2h 15m  │  38 km/h  │  Arr 16:30 │  ← Bottom info bar
 * └────────────────────────────────────────────────┘
 *
 * Features:
 *   - Heading-up map via react-native-maps `camera.heading`
 *   - User at bottom-third via camera center offset (`getNavigationCameraCenter`)
 *   - Live GPS via expo-location
 *   - Compass heading via useHeading hook (expo-location.watchHeadingAsync)
 *   - Voice prompts via expo-speech (mutable)
 *   - Off-route detection + OSRM reroute
 *   - Overview mode toggle
 *   - Route progress (completed sections grey out)
 */

import { Feather } from "@expo/vector-icons";
import * as Location from "expo-location";
import * as Speech from "expo-speech";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import MapView, {
  type Camera,
  Marker,
  Polyline,
  PROVIDER_DEFAULT,
  PROVIDER_GOOGLE,
} from "react-native-maps";

import colors from "@/constants/colors";
import { useHeading } from "@/lib/useHeading";
import {
  buildNavRoute,
  computeProgress,
  formatArrivalTime,
  formatDistance,
  formatEta,
  getNavigationCameraCenter,
  type InstructionIcon,
  type NavInstruction,
  type NavProgress,
  type NavRoute,
} from "@/lib/navigation";
import {
  canAttemptReroute,
  fetchRoadRoute,
  initialRerouteState,
  isOffRoute,
  resetRerouteState,
  shouldAutoReroute,
  updateRerouteStateOnAttempt,
  updateRerouteStateOnFailure,
  updateRerouteStateOnSuccess,
  type NavLatLng,
  type RerouteState,
} from "@/lib/navigationReroute";
import { getActiveNavRoute, clearActiveNavRoute } from "@/lib/activeNavRoute";
import { difficultyColor, gradeShortLabel, TRAIL_ORANGE } from "@/lib/trailColors";

// Navigation-specific colour constants (map overlays, not part of the main theme).
const NAV_WHITE = "#ffffff";
const NAV_ARRIVAL_GREEN = "#27AE60";
const NAV_ROAD_BLUE = "#4A90D9";
const NAV_COMPLETED_TRAIL = "#666666";
const NAV_COMPLETED_ROAD = "#aaaaaa";
const NAV_OVERLAY_DARK = "rgba(0,0,0,0.78)";
const NAV_OVERLAY_MID = "rgba(0,0,0,0.72)";
const NAV_OVERLAY_CONTROL = "rgba(0,0,0,0.55)";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAV_ZOOM = 16.5;         // Google Maps zoom level for street-level nav
const NAV_ALTITUDE = 400;      // iOS MapKit altitude (metres)
const NAV_PITCH = 35;          // Tilt for 3D perspective
const OVERVIEW_PITCH = 0;
const VOICE_ANNOUNCE_DISTANCES = [400, 150, 30]; // metres before instruction
const RECALC_BANNER_MS = 4000;
const ARRIVED_BANNER_MS = 8000;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function NavigateScreen() {
  const inputRoute = getActiveNavRoute();

  // Route is built once from the input and never mutated (reroutes patch sections).
  const [navRoute, setNavRoute] = useState<NavRoute | null>(null);
  const [progress, setProgress] = useState<NavProgress | null>(null);
  const [rerouteState, setRerouteState] = useState<RerouteState>(initialRerouteState());
  const [muted, setMuted] = useState(false);
  const [overviewMode, setOverviewMode] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [userPos, setUserPos] = useState<NavLatLng | null>(null);

  const mapRef = useRef<MapView>(null);
  const locationSubRef = useRef<Location.LocationSubscription | null>(null);
  const announcedAtRef = useRef<Set<number>>(new Set());
  const rerouteAbortRef = useRef<AbortController | null>(null);
  const progressRef = useRef<NavProgress | null>(null);
  const routeRef = useRef<NavRoute | null>(null);
  const mutedRef = useRef(false);

  const { heading } = useHeading(true);
  const headingRef = useRef(heading);
  headingRef.current = heading;
  mutedRef.current = muted;

  // ---------------------------------------------------------------------------
  // Build route on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!inputRoute) {
      // No route loaded — go back.
      router.back();
      return;
    }
    const route = buildNavRoute(inputRoute);
    setNavRoute(route);
    routeRef.current = route;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // GPS tracking
  // ---------------------------------------------------------------------------
  useEffect(() => {
    void (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Location required", "Navigation needs location permission.");
        router.back();
        return;
      }

      locationSubRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: 5,
        },
        (loc) => {
          const pos: NavLatLng = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
          };
          const speedKmh = Math.max(0, (loc.coords.speed ?? 0) * 3.6);

          setUserPos(pos);

          const route = routeRef.current;
          if (!route) return;

          const prev = progressRef.current;
          const newProgress = computeProgress(pos, route, prev, speedKmh);
          progressRef.current = newProgress;
          setProgress(newProgress);

          if (newProgress.arrived) {
            speak("You have arrived at your destination", mutedRef.current);
            setStatusMsg("You have arrived!");
            setTimeout(() => setStatusMsg(null), ARRIVED_BANNER_MS);
            return;
          }

          // Voice prompts for upcoming instructions.
          const instr = route.instructions[newProgress.nextInstructionIdx];
          if (instr) {
            const distToInstr = instr.triggerDistanceM - newProgress.distanceTravelledM;
            for (const threshold of VOICE_ANNOUNCE_DISTANCES) {
              const key = newProgress.nextInstructionIdx * 10000 + threshold;
              if (distToInstr <= threshold && !announcedAtRef.current.has(key)) {
                announcedAtRef.current.add(key);
                const ttsText =
                  threshold === VOICE_ANNOUNCE_DISTANCES[0]
                    ? `In ${Math.round(threshold)} metres, ${instr.shortText}`
                    : threshold === VOICE_ANNOUNCE_DISTANCES[1]
                    ? `${instr.shortText} in ${Math.round(threshold)} metres`
                    : instr.text;
                speak(ttsText, mutedRef.current);
                break;
              }
            }
          }

          // Off-route check + auto-reroute.
          const offResult = isOffRoute(pos, route.sections);
          if (
            offResult.offRoute &&
            shouldAutoReroute(offResult) &&
            canAttemptReroute(rerouteState, Date.now())
          ) {
            void triggerReroute(pos, route);
          }
        },
      );
    })();

    return () => {
      locationSubRef.current?.remove();
      locationSubRef.current = null;
      rerouteAbortRef.current?.abort();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Camera animation
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!userPos || !mapRef.current || overviewMode) return;

    const center = getNavigationCameraCenter(userPos, heading, 280);
    const camera: Camera = {
      center,
      heading,
      pitch: NAV_PITCH,
      zoom: NAV_ZOOM,
      altitude: NAV_ALTITUDE,
    };
    mapRef.current.animateCamera(camera, { duration: 400 });
  }, [userPos, heading, overviewMode]);

  // Overview mode: zoom to show entire route.
  const handleOverviewToggle = useCallback(() => {
    setOverviewMode((prev) => {
      const next = !prev;
      if (next && navRoute && mapRef.current) {
        const pts = navRoute.polyline;
        if (pts.length < 2) return next;
        let minLat = pts[0].latitude, maxLat = pts[0].latitude;
        let minLon = pts[0].longitude, maxLon = pts[0].longitude;
        for (const p of pts) {
          if (p.latitude < minLat) minLat = p.latitude;
          if (p.latitude > maxLat) maxLat = p.latitude;
          if (p.longitude < minLon) minLon = p.longitude;
          if (p.longitude > maxLon) maxLon = p.longitude;
        }
        const camera: Camera = {
          center: { latitude: (minLat + maxLat) / 2, longitude: (minLon + maxLon) / 2 },
          heading: 0,
          pitch: OVERVIEW_PITCH,
          zoom: 10,
          altitude: 30000,
        };
        mapRef.current.animateCamera(camera, { duration: 600 });
      }
      return next;
    });
  }, [navRoute]);

  // ---------------------------------------------------------------------------
  // Reroute
  // ---------------------------------------------------------------------------
  const triggerReroute = useCallback(
    async (pos: NavLatLng, route: NavRoute) => {
      setRerouteState((prev) => updateRerouteStateOnAttempt(prev, Date.now()));
      setStatusMsg("Recalculating…");
      speak("Recalculating", false);

      rerouteAbortRef.current?.abort();
      rerouteAbortRef.current = new AbortController();

      // Target: entry of next trail section, or destination.
      const prog = progressRef.current;
      const nextTrailSection = route.sections
        .slice((prog?.currentSectionIdx ?? 0) + 1)
        .find((s) => s.kind === "trail");
      const target: NavLatLng = nextTrailSection?.path[0] ?? route.to;

      const result = await fetchRoadRoute(pos, target, rerouteAbortRef.current.signal);
      if (!result.ok) {
        setRerouteState((prev) => updateRerouteStateOnFailure(prev));
        setStatusMsg("Reroute failed — stay on route");
        setTimeout(() => setStatusMsg(null), RECALC_BANNER_MS);
        return;
      }

      // Splice the new road polyline into the current road section.
      const currentIdx = prog?.currentSectionIdx ?? 0;
      const updatedSections = route.sections.map((sec, i) => {
        if (i !== currentIdx || sec.kind !== "road") return sec;
        return { ...sec, path: result.polyline, distanceM: result.distanceM };
      });

      // Recompute cumulative distances.
      let cum = 0;
      const rebuiltSections = updatedSections.map((sec) => {
        cum += sec.distanceM;
        return { ...sec, cumulativeDistanceM: cum };
      });

      const newRoute: NavRoute = {
        ...route,
        sections: rebuiltSections,
        polyline: rebuiltSections.flatMap((s) => s.path),
        polylineSection: rebuiltSections.flatMap((s, i) => s.path.map(() => i)),
        totalDistanceM: cum,
      };

      routeRef.current = newRoute;
      setNavRoute(newRoute);
      setRerouteState((prev) => updateRerouteStateOnSuccess(prev));
      announcedAtRef.current.clear();
      setStatusMsg("Route updated");
      setTimeout(() => setStatusMsg(null), RECALC_BANNER_MS);
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Exit navigation
  // ---------------------------------------------------------------------------
  const exitNavigation = useCallback(() => {
    Alert.alert("Exit navigation?", "Your route progress will be lost.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Exit",
        style: "destructive",
        onPress: () => {
          clearActiveNavRoute();
          rerouteAbortRef.current?.abort();
          router.back();
        },
      },
    ]);
  }, []);

  // ---------------------------------------------------------------------------
  // Derived display values
  // ---------------------------------------------------------------------------
  const currentInstruction: NavInstruction | null = useMemo(() => {
    if (!navRoute || !progress) return null;
    return navRoute.instructions[progress.nextInstructionIdx] ?? null;
  }, [navRoute, progress]);

  const distToInstruction: number = useMemo(() => {
    if (!currentInstruction || !progress) return 0;
    return Math.max(0, currentInstruction.triggerDistanceM - progress.distanceTravelledM);
  }, [currentInstruction, progress]);

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------
  if (!navRoute) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator color={colors.light.primary} size="large" />
        <Text style={styles.loadingText}>Building route…</Text>
      </View>
    );
  }

  // ---------------------------------------------------------------------------
  // Memoised polylines — only recomputed when sections or completed IDs change
  // ---------------------------------------------------------------------------
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const polylines = useMemo(
    () =>
      navRoute.sections.map((sec) => {
        const completed = progress?.completedSectionIds.includes(sec.id) ?? false;
        return {
          key: sec.id,
          coords: sec.path,
          color:
            sec.kind === "trail"
              ? completed
                ? NAV_COMPLETED_TRAIL
                : difficultyColor(sec.grade != null ? String(sec.grade) : null)
              : completed
              ? NAV_COMPLETED_ROAD
              : NAV_ROAD_BLUE,
          width: sec.kind === "trail" ? 5 : 3,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navRoute.sections, progress?.completedSectionIds],
  );

  // Upcoming trail sections for special highlight.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const upcomingTrailSections = useMemo(
    () =>
      progress
        ? navRoute.sections
            .slice(progress.currentSectionIdx + 1)
            .filter((s) => s.kind === "trail")
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navRoute.sections, progress?.currentSectionIdx],
  );

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />

      {/* ── Map ──────────────────────────────────────────────────────── */}
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        rotateEnabled={false}
        initialCamera={{
          center: navRoute.from,
          heading: 0,
          pitch: NAV_PITCH,
          zoom: NAV_ZOOM,
          altitude: NAV_ALTITUDE,
        }}
      >
        {/* Route polylines */}
        {polylines.map((p) => (
          <Polyline
            key={p.key}
            coordinates={p.coords}
            strokeColor={p.color}
            strokeWidth={p.width}
            lineCap="round"
            lineJoin="round"
          />
        ))}

        {/* Upcoming trail section highlight */}
        {overviewMode &&
          upcomingTrailSections.map((s) => (
            <Polyline
              key={`highlight-${s.id}`}
              coordinates={s.path}
              strokeColor={difficultyColor(s.grade != null ? String(s.grade) : null)}
              strokeWidth={7}
              lineDashPattern={[0]}
            />
          ))}

        {/* Start marker */}
        <Marker
          coordinate={navRoute.from}
          title="Start"
          anchor={{ x: 0.5, y: 0.5 }}
          flat
        >
          <View style={styles.startMarker}>
            <Feather name="flag" size={14} color={NAV_WHITE} />
          </View>
        </Marker>

        {/* Destination marker */}
        <Marker coordinate={navRoute.to} title="Destination" anchor={{ x: 0.5, y: 1 }}>
          <View style={styles.destMarker}>
            <Feather name="map-pin" size={20} color={colors.light.destructive} />
          </View>
        </Marker>

        {/* User position marker — custom heading arrow */}
        {userPos ? (
          <Marker coordinate={userPos} anchor={{ x: 0.5, y: 0.5 }} flat>
            <View
              style={[
                styles.userArrow,
                { transform: [{ rotate: `${heading}deg` }] },
              ]}
            >
              <View style={styles.userArrowInner} />
            </View>
          </Marker>
        ) : null}

        {/* Trail section entry markers (overview mode) */}
        {overviewMode &&
          navRoute.sections
            .filter((s) => s.kind === "trail" && s.path.length > 0)
            .map((s) => (
              <Marker
                key={`marker-${s.id}`}
                coordinate={s.path[0]}
                title={`${s.name}${s.grade ? ` — Grade ${s.grade}` : ""}`}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <View
                  style={[
                    styles.trailEntryDot,
                    { backgroundColor: difficultyColor(s.grade != null ? String(s.grade) : null) },
                  ]}
                />
              </Marker>
            ))}
      </MapView>

      {/* ── Status overlay (recalculating / arrived) ─────────────────── */}
      {statusMsg ? (
        <View style={styles.statusBanner} pointerEvents="none">
          <Text style={styles.statusBannerText}>{statusMsg}</Text>
        </View>
      ) : null}

      {/* ── Control strip ────────────────────────────────────────────── */}
      <View style={styles.controlStrip}>
        <Pressable onPress={exitNavigation} style={styles.controlBtn} hitSlop={8}>
          <Feather name="x" size={22} color={NAV_WHITE} />
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => setMuted((m) => !m)}
          style={[styles.controlBtn, muted && styles.controlBtnActive]}
          hitSlop={8}
        >
          <Feather name={muted ? "volume-x" : "volume-2"} size={20} color={NAV_WHITE} />
        </Pressable>
        <Pressable
          onPress={handleOverviewToggle}
          style={[styles.controlBtn, overviewMode && styles.controlBtnActive]}
          hitSlop={8}
        >
          <Feather name={overviewMode ? "navigation" : "maximize-2"} size={20} color={NAV_WHITE} />
        </Pressable>
      </View>

      {/* ── Instruction banner ───────────────────────────────────────── */}
      {currentInstruction ? (
        <InstructionBanner
          instruction={currentInstruction}
          distanceM={distToInstruction}
        />
      ) : null}

      {/* ── Bottom info bar ──────────────────────────────────────────── */}
      {progress ? (
        <BottomBar
          distanceRemainingM={progress.distanceRemainingM}
          etaMin={progress.etaMin}
          speedKmh={progress.speedKmh}
        />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function InstructionBanner({
  instruction,
  distanceM,
}: {
  instruction: NavInstruction;
  distanceM: number;
}) {
  const isTrailEntry = instruction.icon === "enter-trail";
  const isTrailExit = instruction.icon === "exit-trail";
  const isArrival = instruction.icon === "arrive";

  const bannerColor = isArrival
    ? NAV_ARRIVAL_GREEN
    : isTrailEntry
    ? TRAIL_ORANGE
    : isTrailExit
    ? NAV_ROAD_BLUE
    : colors.light.primary;

  return (
    <View style={[styles.instructionBanner, { backgroundColor: bannerColor }]}>
      <View style={styles.instructionIconWrap}>
        <InstructionArrow icon={instruction.icon} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.instructionText} numberOfLines={2}>
          {instruction.shortText}
          {instruction.grade != null && isTrailEntry
            ? `  —  Grade ${instruction.grade} ${gradeShortLabel(instruction.grade)}`
            : ""}
        </Text>
        {distanceM > 30 ? (
          <Text style={styles.instructionDistance}>{formatDistance(distanceM)}</Text>
        ) : null}
        {instruction.trailName && isTrailEntry ? (
          <Text style={styles.instructionSub} numberOfLines={1}>
            {instruction.trailName}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function InstructionArrow({ icon }: { icon: InstructionIcon }) {
  const iconMap: Record<InstructionIcon, string> = {
    straight: "arrow-up",
    "turn-left": "corner-up-left",
    "turn-right": "corner-up-right",
    "u-turn": "rotate-ccw",
    "enter-trail": "trending-up",
    "exit-trail": "trending-down",
    arrive: "flag",
    start: "navigation",
  };
  return <Feather name={iconMap[icon] as keyof typeof Feather.glyphMap} size={36} color={NAV_WHITE} />;
}

function BottomBar({
  distanceRemainingM,
  etaMin,
  speedKmh,
}: {
  distanceRemainingM: number;
  etaMin: number;
  speedKmh: number;
}) {
  const distLabel =
    distanceRemainingM >= 1000
      ? `${(distanceRemainingM / 1000).toFixed(1)} km`
      : `${Math.round(distanceRemainingM)} m`;

  return (
    <View style={styles.bottomBar}>
      <BottomStat value={distLabel} label="Remaining" />
      <View style={styles.bottomDivider} />
      <BottomStat value={formatEta(etaMin)} label="ETA" />
      <View style={styles.bottomDivider} />
      <BottomStat value={`${Math.round(speedKmh)}`} label="km/h" />
      <View style={styles.bottomDivider} />
      <BottomStat value={formatArrivalTime(etaMin)} label="Arrives" />
    </View>
  );
}

function BottomStat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.bottomStat}>
      <Text style={styles.bottomStatValue}>{value}</Text>
      <Text style={styles.bottomStatLabel}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Voice helper (avoids speech queue pile-up)
// ---------------------------------------------------------------------------

let _speechBusy = false;

function speak(text: string, muted: boolean): void {
  if (muted || _speechBusy) return;
  _speechBusy = true;
  Speech.speak(text, {
    language: "en",
    rate: 0.95,
    onDone: () => { _speechBusy = false; },
    onError: () => { _speechBusy = false; },
    onStopped: () => { _speechBusy = false; },
  });
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const CONTROL_HEIGHT = 52;
const BANNER_HEIGHT = 90;
const BOTTOM_HEIGHT = 72;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.light.background },

  loadingScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.light.background,
    gap: 16,
  },
  loadingText: { color: colors.light.foreground, fontSize: 15 },

  map: { ...StyleSheet.absoluteFillObject },

  // Control strip (sits on top of the map at the very top)
  controlStrip: {
    position: "absolute",
    top: Platform.OS === "ios" ? 52 : 28,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    gap: 8,
    height: CONTROL_HEIGHT,
  },
  controlBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: NAV_OVERLAY_CONTROL,
    alignItems: "center",
    justifyContent: "center",
  },
  controlBtnActive: { backgroundColor: "rgba(240,168,50,0.85)" },

  // Instruction banner (below control strip)
  instructionBanner: {
    position: "absolute",
    top: (Platform.OS === "ios" ? 52 : 28) + CONTROL_HEIGHT + 8,
    left: 14,
    right: 14,
    minHeight: BANNER_HEIGHT,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 14,
    // Subtle shadow so it reads over the map
    shadowColor: colors.light.background,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  instructionIconWrap: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  instructionText: {
    color: NAV_WHITE,
    fontSize: 17,
    fontWeight: "800",
    lineHeight: 22,
  },
  instructionDistance: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 13,
    marginTop: 3,
    fontWeight: "600",
  },
  instructionSub: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 12,
    marginTop: 2,
  },

  // Status overlay (recalculating / arrived)
  statusBanner: {
    position: "absolute",
    alignSelf: "center",
    top: "45%",
    backgroundColor: NAV_OVERLAY_MID,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  statusBannerText: { color: NAV_WHITE, fontSize: 17, fontWeight: "700" },

  // Bottom info bar
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: BOTTOM_HEIGHT + (Platform.OS === "ios" ? 20 : 0),
    paddingBottom: Platform.OS === "ios" ? 20 : 0,
    backgroundColor: NAV_OVERLAY_DARK,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  bottomDivider: {
    width: 1,
    height: 36,
    backgroundColor: "rgba(255,255,255,0.20)",
  },
  bottomStat: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
  },
  bottomStatValue: {
    color: NAV_WHITE,
    fontSize: 18,
    fontWeight: "800",
  },
  bottomStatLabel: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 10,
    marginTop: 2,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  // User position arrow marker
  userArrow: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  userArrowInner: {
    width: 0,
    height: 0,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderBottomWidth: 22,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: colors.light.primary,
  },

  // Start / destination markers
  startMarker: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: NAV_ARRIVAL_GREEN,
    alignItems: "center",
    justifyContent: "center",
  },
  destMarker: {
    alignItems: "center",
  },

  // Trail entry dots (overview mode)
  trailEntryDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: NAV_WHITE,
  },
});
