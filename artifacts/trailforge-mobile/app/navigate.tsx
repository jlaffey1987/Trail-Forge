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

// Navigation-specific colour constants
const NAV_WHITE = "#FFFFFF";
const NAV_AMBER = "#F5A623";
const NAV_ARRIVAL_GREEN = "#00C853";
const NAV_ROAD_BLUE = "#FFFFFF";          // road sections: white dashed
const NAV_COMPLETED_TRAIL = "#444444";
const NAV_COMPLETED_ROAD = "#666666";
const NAV_CARD = "#1A1A1A";
const NAV_BG = "#0D0D0D";
const NAV_RED = "#D50000";
const NAV_OVERLAY_DARK = "rgba(13,13,13,0.96)";
const NAV_OVERLAY_MID = "rgba(26,26,26,0.96)";
const NAV_OVERLAY_CONTROL = "rgba(26,26,26,0.85)";

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
        <ActivityIndicator color={NAV_AMBER} size="large" />
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
          width: sec.kind === "trail" ? 7 : 2,
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
      <StatusBar barStyle="light-content" backgroundColor={NAV_BG} />

      {/* ── Map (full screen behind everything) ──────────────────────── */}
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        rotateEnabled={false}
        userInterfaceStyle="dark"
        initialCamera={{
          center: navRoute.from,
          heading: 0,
          pitch: NAV_PITCH,
          zoom: NAV_ZOOM,
          altitude: NAV_ALTITUDE,
        }}
      >
        {/* Route polylines — roads as dashed white, trails as vivid grade colour */}
        {polylines.map((p) => (
          <Polyline
            key={p.key}
            coordinates={p.coords}
            strokeColor={p.color}
            strokeWidth={p.width}
            lineCap="round"
            lineJoin="round"
            lineDashPattern={p.width <= 2 ? [6, 8] : undefined}
          />
        ))}

        {/* Upcoming trail section highlight in overview mode */}
        {overviewMode &&
          upcomingTrailSections.map((s) => (
            <Polyline
              key={`highlight-${s.id}`}
              coordinates={s.path}
              strokeColor={difficultyColor(s.grade != null ? String(s.grade) : null)}
              strokeWidth={8}
              lineDashPattern={[0]}
            />
          ))}

        {/* Start marker */}
        <Marker coordinate={navRoute.from} title="Start" anchor={{ x: 0.5, y: 0.5 }} flat>
          <View style={styles.startMarker}>
            <Feather name="flag" size={14} color={NAV_WHITE} />
          </View>
        </Marker>

        {/* Destination marker */}
        <Marker coordinate={navRoute.to} title="Destination" anchor={{ x: 0.5, y: 1 }}>
          <View style={styles.destMarker}>
            <Feather name="map-pin" size={24} color={NAV_RED} />
          </View>
        </Marker>

        {/* User position marker — pulsing amber arrow */}
        {userPos && (
          <Marker coordinate={userPos} anchor={{ x: 0.5, y: 0.5 }} flat>
            <View style={[styles.userArrow, { transform: [{ rotate: `${heading}deg` }] }]}>
              <View style={styles.userArrowTri} />
              <View style={styles.userArrowDot} />
            </View>
          </Marker>
        )}

        {/* Trail entry dots in overview mode */}
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
                <View style={[styles.trailEntryDot, { backgroundColor: difficultyColor(s.grade != null ? String(s.grade) : null) }]} />
              </Marker>
            ))}
      </MapView>

      {/* ── Instruction banner (TOP — 35% of screen) ─────────────────── */}
      {currentInstruction && (
        <InstructionBanner
          instruction={currentInstruction}
          distanceM={distToInstruction}
          currentSection={navRoute.sections[progress?.currentSectionIdx ?? 0]}
        />
      )}

      {/* ── Status overlay (recalculating / arrived) ─────────────────── */}
      {statusMsg && (
        <View style={styles.statusBanner} pointerEvents="none">
          <ActivityIndicator color={NAV_AMBER} size="small" style={{ marginRight: 10 }} />
          <Text style={styles.statusBannerText}>{statusMsg}</Text>
        </View>
      )}

      {/* ── Overview mode toggle (floating, mid-right) ───────────────── */}
      <Pressable
        onPress={handleOverviewToggle}
        style={[styles.overviewBtn, overviewMode && styles.overviewBtnActive]}
      >
        <Feather name={overviewMode ? "navigation" : "maximize-2"} size={20} color={overviewMode ? NAV_BG : NAV_WHITE} />
      </Pressable>

      {/* ── Bottom section: stats + control buttons ──────────────────── */}
      <View style={styles.bottomSection}>
        {/* Stats bar */}
        {progress && (
          <View style={styles.statsBar}>
            <BottomStat value={`${Math.round(progress.speedKmh)}`} label="km/h" />
            <View style={styles.statDivider} />
            <BottomStat
              value={progress.distanceRemainingM >= 1000
                ? `${(progress.distanceRemainingM / 1000).toFixed(1)}`
                : `${Math.round(progress.distanceRemainingM)}`}
              label={progress.distanceRemainingM >= 1000 ? "km left" : "m left"}
            />
            <View style={styles.statDivider} />
            <BottomStat value={formatArrivalTime(progress.etaMin)} label="ETA" />
          </View>
        )}

        {/* Control buttons */}
        <View style={styles.controlRow}>
          <Pressable onPress={exitNavigation} style={[styles.ctrlBtn, styles.ctrlBtnExit]}>
            <Feather name="x-circle" size={22} color={NAV_WHITE} />
            <Text style={styles.ctrlBtnText}>EXIT NAVIGATION</Text>
          </Pressable>
          <Pressable
            onPress={() => setMuted((m) => !m)}
            style={[styles.ctrlBtn, styles.ctrlBtnMute, muted && styles.ctrlBtnMuteActive]}
          >
            <Feather name={muted ? "volume-x" : "volume-2"} size={22} color={muted ? NAV_AMBER : NAV_WHITE} />
            <Text style={[styles.ctrlBtnText, muted && { color: NAV_AMBER }]}>{muted ? "UNMUTE" : "MUTE"}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// ── Instruction Banner ─────────────────────────────────────────────────────

function InstructionBanner({
  instruction,
  distanceM,
  currentSection,
}: {
  instruction: NavInstruction;
  distanceM: number;
  currentSection?: { kind: string; grade?: number | null; name?: string };
}) {
  const isTrailEntry = instruction.icon === "enter-trail";
  const isTrailExit  = instruction.icon === "exit-trail";
  const isArrival    = instruction.icon === "arrive";
  const isOnTrail    = currentSection?.kind === "trail";

  // Amber left border accent colour changes per state
  const accentColor = isArrival
    ? NAV_ARRIVAL_GREEN
    : isTrailEntry || isOnTrail
    ? difficultyColor(currentSection?.grade != null ? String(currentSection.grade) : null)
    : NAV_AMBER;

  return (
    <View style={[styles.instructionBanner, { borderLeftColor: accentColor }]}>
      {/* State badge */}
      {isTrailEntry && (
        <View style={[styles.stateBadge, { backgroundColor: accentColor + "22", borderColor: accentColor }]}>
          <Text style={[styles.stateBadgeText, { color: accentColor }]}>
            🟠 ENTERING TRAIL
            {instruction.grade != null ? `  ·  GRADE ${instruction.grade}` : ""}
          </Text>
        </View>
      )}
      {isTrailExit && (
        <View style={[styles.stateBadge, { backgroundColor: "#2A2A2A", borderColor: "#555" }]}>
          <Text style={[styles.stateBadgeText, { color: NAV_WHITE }]}>⬛ RETURNING TO ROAD</Text>
        </View>
      )}
      {isArrival && (
        <View style={[styles.stateBadge, { backgroundColor: NAV_ARRIVAL_GREEN + "22", borderColor: NAV_ARRIVAL_GREEN }]}>
          <Text style={[styles.stateBadgeText, { color: NAV_ARRIVAL_GREEN }]}>✅ YOU HAVE ARRIVED</Text>
        </View>
      )}
      {isOnTrail && !isTrailEntry && !isTrailExit && !isArrival && (
        <View style={[styles.stateBadge, { backgroundColor: accentColor + "22", borderColor: accentColor }]}>
          <Text style={[styles.stateBadgeText, { color: accentColor }]}>
            🟢 ON TRAIL
            {currentSection?.grade != null ? `  ·  GRADE ${currentSection.grade}` : ""}
          </Text>
        </View>
      )}

      {/* Main instruction row */}
      <View style={styles.instructionRow}>
        <View style={styles.instructionIconWrap}>
          <InstructionArrow icon={instruction.icon} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.instructionText} numberOfLines={2}>
            {instruction.shortText}
          </Text>
          {distanceM > 30 && (
            <Text style={styles.instructionDist}>In {formatDistance(distanceM)}</Text>
          )}
          {instruction.trailName && (
            <Text style={styles.instructionSub} numberOfLines={1}>{instruction.trailName}</Text>
          )}
        </View>
      </View>
    </View>
  );
}

function InstructionArrow({ icon }: { icon: InstructionIcon }) {
  const iconMap: Record<InstructionIcon, keyof typeof Feather.glyphMap> = {
    straight:      "arrow-up",
    "turn-left":   "corner-up-left",
    "turn-right":  "corner-up-right",
    "u-turn":      "rotate-ccw",
    "enter-trail": "trending-up",
    "exit-trail":  "trending-down",
    arrive:        "flag",
    start:         "navigation",
  };
  return <Feather name={iconMap[icon]} size={64} color={NAV_WHITE} />;
}

// ── Bottom stat cell ───────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Styles — premium dark navigation
// ─────────────────────────────────────────────────────────────────────────────

const BOTTOM_STATS_H = 80;
const CONTROL_ROW_H  = 72;
const SAFE_TOP       = Platform.OS === "ios" ? 52 : 28;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: NAV_BG },

  loadingScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: NAV_BG,
    gap: 16,
  },
  loadingText: { color: NAV_WHITE, fontSize: 16, fontWeight: "600" },

  // ── Instruction banner — sits at top, ~35% of screen ─────────────────────
  instructionBanner: {
    position: "absolute",
    top: SAFE_TOP,
    left: 0,
    right: 0,
    backgroundColor: NAV_CARD,
    borderLeftWidth: 6,
    borderLeftColor: NAV_AMBER,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.6,
    shadowRadius: 16,
    elevation: 16,
  },
  stateBadge: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignSelf: "flex-start",
  },
  stateBadgeText: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  instructionRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  instructionIconWrap: {
    width: 80,
    height: 80,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 12,
  },
  instructionText: {
    color: NAV_WHITE,
    fontSize: 28,
    fontWeight: "900",
    lineHeight: 34,
    letterSpacing: -0.5,
  },
  instructionDist: {
    color: NAV_AMBER,
    fontSize: 20,
    fontWeight: "700",
    marginTop: 6,
  },
  instructionSub: {
    color: "#A0A0A0",
    fontSize: 14,
    marginTop: 4,
  },

  // ── Status banner (recalculating) ─────────────────────────────────────────
  statusBanner: {
    position: "absolute",
    alignSelf: "center",
    top: "42%",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: NAV_AMBER,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 12,
  },
  statusBannerText: { color: NAV_BG, fontSize: 16, fontWeight: "800" },

  // ── Overview toggle (floating right) ─────────────────────────────────────
  overviewBtn: {
    position: "absolute",
    right: 16,
    top: "50%",
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: NAV_OVERLAY_CONTROL,
    borderColor: "#333",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 6,
  },
  overviewBtnActive: { backgroundColor: NAV_AMBER },

  // ── Bottom section ────────────────────────────────────────────────────────
  bottomSection: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: NAV_OVERLAY_DARK,
    borderTopWidth: 1,
    borderTopColor: "#2A2A2A",
  },
  statsBar: {
    flexDirection: "row",
    alignItems: "center",
    height: BOTTOM_STATS_H,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#2A2A2A",
  },
  statDivider: { width: 1, height: 40, backgroundColor: "#2A2A2A" },
  bottomStat: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 8 },
  bottomStatValue: { color: NAV_WHITE, fontSize: 24, fontWeight: "900" },
  bottomStatLabel: { color: "#A0A0A0", fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.8, marginTop: 2 },

  // ── Control buttons ───────────────────────────────────────────────────────
  controlRow: {
    flexDirection: "row",
    height: CONTROL_ROW_H + (Platform.OS === "ios" ? 24 : 0),
    paddingBottom: Platform.OS === "ios" ? 24 : 0,
  },
  ctrlBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  ctrlBtnExit: { backgroundColor: NAV_RED + "CC" },
  ctrlBtnMute: { backgroundColor: "#2A2A2A" },
  ctrlBtnMuteActive: { backgroundColor: "#1A1A00" },
  ctrlBtnText: { fontSize: 13, fontWeight: "800", color: NAV_WHITE, letterSpacing: 0.8 },

  // ── User position marker ──────────────────────────────────────────────────
  userArrow: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "flex-start",
  },
  userArrowTri: {
    width: 0,
    height: 0,
    borderLeftWidth: 10,
    borderRightWidth: 10,
    borderBottomWidth: 26,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: NAV_AMBER,
  },
  userArrowDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: NAV_AMBER,
    marginTop: -4,
  },

  // ── Map markers ───────────────────────────────────────────────────────────
  startMarker: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: NAV_ARRIVAL_GREEN,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: NAV_WHITE,
  },
  destMarker: { alignItems: "center" },
  trailEntryDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: NAV_WHITE,
  },
});
