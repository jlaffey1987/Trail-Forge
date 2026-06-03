/**
 * TrailForge Navigation — Road Mode & Trail Mode
 *
 * Two distinct visual modes with animated transitions:
 *
 * ROAD MODE  — compact top panel (90px), turn instructions, speed-adaptive zoom
 * TRAIL MODE — same panel height, grade badge, trail name, zoomed-out camera
 *
 * Transitions are 600ms smooth and announced via expo-speech.
 * Low-pass filtered heading for smooth rotation.
 * Re-centre button appears when rider pans map, auto-snaps after 10s.
 * Glove-friendly controls (64px minimum), safe area respected throughout.
 */

import { Feather } from "@expo/vector-icons";
import * as Location from "expo-location";
import * as Speech from "expo-speech";
import { router } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  Animated,
  Dimensions,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  getNavigationCameraCenter,
  type InstructionIcon,
  type NavInstruction,
  type NavProgress,
  type NavRoute,
  type NavSection,
} from "@/lib/navigation";
import {
  canAttemptReroute,
  fetchRoadRoute,
  initialRerouteState,
  isOffRoute,
  shouldAutoReroute,
  updateRerouteStateOnAttempt,
  updateRerouteStateOnFailure,
  updateRerouteStateOnSuccess,
  type NavLatLng,
  type RerouteState,
} from "@/lib/navigationReroute";
import { getActiveNavRoute, clearActiveNavRoute } from "@/lib/activeNavRoute";
import { difficultyColor, gradeToColor } from "@/lib/trailColors";
import {
  loadNavPrefs,
  resolveNightMode,
  formatSpeed,
  type NavPrefs,
  NAV_PREFS_DEFAULT,
} from "@/lib/navPrefs";
import { haversineM } from "@/lib/navigationReroute";

// ── Constants ─────────────────────────────────────────────────────────────────

const AMBER         = "#F5A623";
const NAV_WHITE     = "#FFFFFF";
const NAV_ROAD_BG   = "#1A1A1A";
const NAV_BG        = "#0D0D0D";
const NAV_RED       = "#D50000";
const NAV_GREEN     = "#00C853";
const MUTED_TEXT    = "#A0A0A0";

const TOP_PANEL_H   = 90;       // fixed height both modes
const BOTTOM_BAR_H  = 70;
const CTRL_H        = 64;
const RECALC_MS     = 4000;
const ARRIVED_MS    = 8000;
const RECENTRE_AUTO_MS = 10000; // auto-snap back to following after 10s

/** Off-route threshold in metres */
const OFF_ROUTE_M   = 75;

/** Distance from start before showing handoff dialog */
const HANDOFF_DIST_M = 500;

/** Speed zoom levels (kph) — only applied when autoZoom = true */
const ZOOM_SLOW_KPH  = 32;  // < 20mph
const ZOOM_MED_KPH   = 64;  // < 40mph
const ZOOM_ROAD_SLOW = 17;
const ZOOM_ROAD_MED  = 16;
const ZOOM_ROAD_FAST = 15;
const ZOOM_TRAIL     = 14.5;

const ALTITUDE_ROAD  = 350;
const ALTITUDE_TRAIL = 550;
const NAV_PITCH      = 35;
const NAV_PITCH_OVERVIEW = 0;

const VOICE_THRESHOLDS = [400, 150, 30]; // metres before instruction

/** Low-pass filter alpha — 0 = immediate, 1 = frozen */
const HEADING_LP_ALPHA = 0.25;

// ── Main component ────────────────────────────────────────────────────────────

export default function NavigateScreen() {
  const insets   = useSafeAreaInsets();
  const inputRoute = getActiveNavRoute();

  // ── Core nav state (from existing implementation) ─────────────────────────
  const [navRoute, setNavRoute]         = useState<NavRoute | null>(null);
  const [progress, setProgress]         = useState<NavProgress | null>(null);
  const [rerouteState, setRerouteState] = useState<RerouteState>(initialRerouteState());
  const [overviewMode, setOverviewMode] = useState(false);
  const [statusMsg, setStatusMsg]       = useState<string | null>(null);
  const [userPos, setUserPos]           = useState<NavLatLng | null>(null);

  // ── New state ─────────────────────────────────────────────────────────────
  const [navMode, setNavMode]           = useState<"road" | "trail">("road");
  const [prefs, setPrefs]               = useState<NavPrefs>(NAV_PREFS_DEFAULT);
  const [isFollowing, setIsFollowing]   = useState(true);
  const [muted, setMuted]               = useState(false);
  const [isNight, setIsNight]           = useState(false);
  const [showHandoff, setShowHandoff]   = useState(false);
  const [handoffDistM, setHandoffDistM] = useState(0);
  const [pulseSectionId, setPulseSectionId] = useState<string | null>(null);
  const [pulsePhase, setPulsePhase]     = useState<"bright" | "dim">("bright");

  // ── Refs ──────────────────────────────────────────────────────────────────
  const mapRef                = useRef<MapView>(null);
  const locationSubRef        = useRef<Location.LocationSubscription | null>(null);
  const announcedAtRef        = useRef<Set<number>>(new Set());
  const rerouteAbortRef       = useRef<AbortController | null>(null);
  const progressRef           = useRef<NavProgress | null>(null);
  const routeRef              = useRef<NavRoute | null>(null);
  const mutedRef              = useRef(false);
  const navModeRef            = useRef<"road" | "trail">("road");
  const filteredHeadingRef    = useRef(0);
  const lastInteractionRef    = useRef(Date.now());
  const recentreTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null);

  mutedRef.current    = muted;
  navModeRef.current  = navMode;

  const { heading: rawHeading } = useHeading(true);

  // Low-pass filtered heading
  useEffect(() => {
    let diff = rawHeading - filteredHeadingRef.current;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    filteredHeadingRef.current = filteredHeadingRef.current + HEADING_LP_ALPHA * diff;
  }, [rawHeading]);

  // ── Animations ────────────────────────────────────────────────────────────
  // 0 = road mode bg, 1 = trail mode bg (drives background color interpolation)
  const modeTransAnim      = useRef(new Animated.Value(0)).current;
  // OFFROAD badge X offset: 100 = off screen right, 0 = visible
  const offRoadSlideAnim   = useRef(new Animated.Value(100)).current;
  // Re-centre button pulse
  const recentrePulseAnim  = useRef(new Animated.Value(1)).current;
  // Target grade colour for trail panel (stored as ref, read during render)
  const trailGradeColorRef = useRef(AMBER);

  // ── Load preferences ──────────────────────────────────────────────────────
  useEffect(() => {
    void loadNavPrefs().then(p => {
      setPrefs(p);
      setMuted(!p.voiceEnabled);
      mutedRef.current = !p.voiceEnabled;
      setIsNight(resolveNightMode(p.nightMode));
    });
  }, []);

  // ── Build route on mount ──────────────────────────────────────────────────
  useEffect(() => {
    if (!inputRoute) { router.back(); return; }
    const route = buildNavRoute(inputRoute);
    setNavRoute(route);
    routeRef.current = route;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handoff check — run once GPS is ready ─────────────────────────────────
  useEffect(() => {
    if (!userPos || !navRoute || showHandoff) return;
    const distToStart = haversineM(userPos, navRoute.from);
    if (distToStart > HANDOFF_DIST_M) {
      setHandoffDistM(Math.round(distToStart));
      setShowHandoff(true);
    }
  }, [userPos, navRoute]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── GPS tracking ──────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Location required", "Navigation needs location access.");
        router.back();
        return;
      }

      locationSubRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 5 },
        (loc) => {
          const pos: NavLatLng = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
          const speedMs  = Math.max(0, loc.coords.speed ?? 0);
          const speedKmh = speedMs * 3.6;
          setUserPos(pos);

          const route = routeRef.current;
          if (!route) return;

          const prev      = progressRef.current;
          const newProg   = computeProgress(pos, route, prev, speedKmh);
          progressRef.current = newProg;
          setProgress(newProg);

          // ── Mode transition detection ─────────────────────────────────────
          const nowOnTrail = newProg.isOnTrail;
          const wasOnTrail = navModeRef.current === "trail";
          if (nowOnTrail !== wasOnTrail) {
            const currentSec = route.sections[newProg.currentSectionIdx];
            if (nowOnTrail) {
              enterTrailMode(currentSec, speedMs);
            } else {
              exitTrailMode(route, newProg.currentSectionIdx, speedMs);
            }
          }

          // ── Arrival ───────────────────────────────────────────────────────
          if (newProg.arrived) {
            speak("You have arrived at your destination", mutedRef.current);
            setStatusMsg("You have arrived! 🎉");
            setTimeout(() => setStatusMsg(null), ARRIVED_MS);
            return;
          }

          // ── Voice instructions (road mode only) ───────────────────────────
          if (!nowOnTrail) {
            const instr = route.instructions[newProg.nextInstructionIdx];
            if (instr) {
              const distToInstr = instr.triggerDistanceM - newProg.distanceTravelledM;
              for (const threshold of VOICE_THRESHOLDS) {
                const key = newProg.nextInstructionIdx * 10000 + threshold;
                if (distToInstr <= threshold && !announcedAtRef.current.has(key)) {
                  announcedAtRef.current.add(key);
                  const text = threshold === VOICE_THRESHOLDS[0]
                    ? `In ${Math.round(threshold)} metres, ${instr.shortText}`
                    : threshold === VOICE_THRESHOLDS[1]
                    ? `${instr.shortText} in ${Math.round(threshold)} metres`
                    : instr.text;
                  speak(text, mutedRef.current);
                  break;
                }
              }
            }
          }

          // ── Off-route check ───────────────────────────────────────────────
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
      pulseTimerRef.current && clearTimeout(pulseTimerRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mode transition helpers ───────────────────────────────────────────────

  function enterTrailMode(section: NavSection | undefined, speedMs: number) {
    const gradeColor = section?.grade != null ? gradeToColor(section.grade) : AMBER;
    trailGradeColorRef.current = gradeColor;
    setNavMode("trail");
    navModeRef.current = "trail";

    // Animate panel background → grade colour
    Animated.timing(modeTransAnim, {
      toValue: 1, duration: 600, useNativeDriver: false,
    }).start();
    // Slide in OFFROAD badge
    Animated.timing(offRoadSlideAnim, {
      toValue: 0, duration: 600, useNativeDriver: true,
    }).start();

    // Trail pulse on the section polyline
    if (section) {
      setPulseSectionId(section.id);
      startPulseSequence(section.id);
    }

    // Voice
    const gradeNum  = section?.grade ?? null;
    const distKm    = section ? (section.distanceM / 1000).toFixed(1) : null;
    const name      = section?.name ?? "trail section";
    const gradeTxt  = gradeNum != null ? `Grade ${gradeNum}.` : "";
    const distTxt   = distKm  ? `${distKm} kilometres.` : "";
    speak(`Entering trail section. ${gradeTxt} ${distTxt} ${name}.`, mutedRef.current);

    // Camera zoom out for trail
    if (mapRef.current && userPos) {
      const h = filteredHeadingRef.current;
      const center = getNavigationCameraCenter({ latitude: userPos.latitude, longitude: userPos.longitude }, h, 360);
      mapRef.current.animateCamera({
        center, heading: h, pitch: NAV_PITCH, zoom: ZOOM_TRAIL, altitude: ALTITUDE_TRAIL,
      }, { duration: 600 });
    }
  }

  function exitTrailMode(route: NavRoute, currentIdx: number, _speedMs: number) {
    setNavMode("road");
    navModeRef.current = "road";

    Animated.timing(modeTransAnim, {
      toValue: 0, duration: 600, useNativeDriver: false,
    }).start();
    Animated.timing(offRoadSlideAnim, {
      toValue: 100, duration: 600, useNativeDriver: true,
    }).start();
    setPulseSectionId(null);

    // Voice: next trail distance
    const nextTrail = route.sections.slice(currentIdx + 1).find(s => s.kind === "trail");
    const nextTrailKm = nextTrail
      ? ` Next trail in ${((nextTrail.cumulativeDistanceM - route.sections[currentIdx].cumulativeDistanceM) / 1000).toFixed(1)} kilometres.`
      : "";
    speak(`Trail section complete. Returning to road.${nextTrailKm}`, mutedRef.current);
  }

  function startPulseSequence(sectionId: string) {
    pulseTimerRef.current && clearTimeout(pulseTimerRef.current);
    let phase = 0;
    const phases: Array<"bright" | "dim"> = ["bright", "dim", "bright", "dim"];
    function next() {
      if (phase >= phases.length) { setPulseSectionId(null); return; }
      setPulsePhase(phases[phase]);
      phase++;
      pulseTimerRef.current = setTimeout(next, 200);
    }
    setPulseSectionId(sectionId);
    next();
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!userPos || !mapRef.current || overviewMode || !isFollowing) return;

    const h = filteredHeadingRef.current;
    const speedKmh = progress?.speedKmh ?? 0;
    const onTrail  = navModeRef.current === "trail";

    let zoom: number;
    if (onTrail) {
      zoom = ZOOM_TRAIL;
    } else if (!prefs.autoZoom) {
      zoom = ZOOM_ROAD_MED;
    } else {
      zoom = speedKmh >= ZOOM_MED_KPH ? ZOOM_ROAD_FAST
           : speedKmh >= ZOOM_SLOW_KPH ? ZOOM_ROAD_MED
           : ZOOM_ROAD_SLOW;
    }

    const lookAheadM = onTrail ? 360 : 280;
    const center = getNavigationCameraCenter(userPos, h, lookAheadM);
    const cam: Camera = {
      center, heading: h, pitch: NAV_PITCH,
      zoom, altitude: onTrail ? ALTITUDE_TRAIL : ALTITUDE_ROAD,
    };
    mapRef.current.animateCamera(cam, { duration: 400 });
  }, [userPos, rawHeading, overviewMode, isFollowing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Overview mode: fit all route points
  const handleOverviewToggle = useCallback(() => {
    setOverviewMode(prev => {
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
        mapRef.current.animateCamera({
          center: { latitude: (minLat + maxLat) / 2, longitude: (minLon + maxLon) / 2 },
          heading: 0, pitch: NAV_PITCH_OVERVIEW, zoom: 10, altitude: 30000,
        }, { duration: 600 });
      } else if (!next && userPos) {
        setIsFollowing(true);
      }
      return next;
    });
  }, [navRoute, userPos]);

  // Re-centre logic
  function handleMapInteraction() {
    setIsFollowing(false);
    lastInteractionRef.current = Date.now();
    recentreTimerRef.current && clearTimeout(recentreTimerRef.current);
    recentreTimerRef.current = setTimeout(() => {
      setIsFollowing(true);
    }, RECENTRE_AUTO_MS);
    startRecentrePulse();
  }

  function handleRecentre() {
    setIsFollowing(true);
    recentreTimerRef.current && clearTimeout(recentreTimerRef.current);
  }

  function startRecentrePulse() {
    Animated.loop(
      Animated.sequence([
        Animated.timing(recentrePulseAnim, { toValue: 1.3, duration: 600, useNativeDriver: true }),
        Animated.timing(recentrePulseAnim, { toValue: 1.0, duration: 600, useNativeDriver: true }),
      ]),
      { iterations: 5 }
    ).start(() => recentrePulseAnim.setValue(1));
  }

  // ── Reroute ───────────────────────────────────────────────────────────────

  const triggerReroute = useCallback(async (pos: NavLatLng, route: NavRoute) => {
    setRerouteState(prev => updateRerouteStateOnAttempt(prev, Date.now()));
    setStatusMsg("Recalculating…");
    speak("Recalculating", false);

    rerouteAbortRef.current?.abort();
    rerouteAbortRef.current = new AbortController();

    const prog = progressRef.current;
    const nextTrailSection = route.sections
      .slice((prog?.currentSectionIdx ?? 0) + 1)
      .find(s => s.kind === "trail");
    const target: NavLatLng = nextTrailSection?.path[0] ?? route.to;

    const result = await fetchRoadRoute(pos, target, rerouteAbortRef.current.signal);
    if (!result.ok) {
      setRerouteState(prev => updateRerouteStateOnFailure(prev));
      setStatusMsg("Reroute failed — stay on route");
      setTimeout(() => setStatusMsg(null), RECALC_MS);
      return;
    }

    const currentIdx = prog?.currentSectionIdx ?? 0;
    const updatedSections = route.sections.map((sec, i) => {
      if (i !== currentIdx || sec.kind !== "road") return sec;
      return { ...sec, path: result.polyline, distanceM: result.distanceM };
    });
    let cum = 0;
    const rebuiltSections = updatedSections.map(sec => {
      cum += sec.distanceM;
      return { ...sec, cumulativeDistanceM: cum };
    });
    const newRoute: NavRoute = {
      ...route,
      sections: rebuiltSections,
      polyline: rebuiltSections.flatMap(s => s.path),
      polylineSection: rebuiltSections.flatMap((s, i) => s.path.map(() => i)),
      totalDistanceM: cum,
    };
    routeRef.current = newRoute;
    setNavRoute(newRoute);
    setRerouteState(prev => updateRerouteStateOnSuccess(prev));
    announcedAtRef.current.clear();
    setStatusMsg("Route updated");
    setTimeout(() => setStatusMsg(null), RECALC_MS);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Exit ──────────────────────────────────────────────────────────────────

  const exitNavigation = useCallback(() => {
    Alert.alert("Exit navigation?", "Your route progress will be lost.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Exit", style: "destructive",
        onPress: () => {
          clearActiveNavRoute();
          rerouteAbortRef.current?.abort();
          router.back();
        },
      },
    ]);
  }, []);

  // ── Derived display ───────────────────────────────────────────────────────

  const currentSection: NavSection | undefined = useMemo(() => {
    if (!navRoute || !progress) return undefined;
    return navRoute.sections[progress.currentSectionIdx];
  }, [navRoute, progress]);

  const currentInstruction: NavInstruction | null = useMemo(() => {
    if (!navRoute || !progress || navMode === "trail") return null;
    return navRoute.instructions[progress.nextInstructionIdx] ?? null;
  }, [navRoute, progress, navMode]);

  const distToInstruction: number = useMemo(() => {
    if (!currentInstruction || !progress) return 0;
    return Math.max(0, currentInstruction.triggerDistanceM - progress.distanceTravelledM);
  }, [currentInstruction, progress]);

  // Next-next instruction preview (road mode)
  const nextNextInstruction: NavInstruction | null = useMemo(() => {
    if (!navRoute || !progress || navMode === "trail") return null;
    return navRoute.instructions[progress.nextInstructionIdx + 1] ?? null;
  }, [navRoute, progress, navMode]);

  // Trail remaining distance (trail mode)
  const trailRemainingKm: number = useMemo(() => {
    if (!currentSection || currentSection.kind !== "trail" || !progress) return 0;
    const sectionEnd = currentSection.cumulativeDistanceM;
    const sectionStart = sectionEnd - currentSection.distanceM;
    const ridden = Math.max(0, progress.distanceTravelledM - sectionStart);
    return Math.max(0, (currentSection.distanceM - ridden) / 1000);
  }, [currentSection, progress]);

  // ── Polylines ─────────────────────────────────────────────────────────────

  const polylines = useMemo(() => {
    if (!navRoute) return [];
    return navRoute.sections.map(sec => {
      const completed = progress?.completedSectionIds.includes(sec.id) ?? false;
      const isPulsing = sec.id === pulseSectionId;
      const trailColor = difficultyColor(sec.grade != null ? String(sec.grade) : null);

      let color: string;
      let width: number;
      let dash: number[] | undefined;

      if (sec.kind === "road") {
        color = completed ? "#444" : "#FFFFFF";
        width = 2;
        dash  = [6, 8];
      } else {
        color = completed ? trailColor + "66" : trailColor;
        width = isPulsing && pulsePhase === "bright" ? 12 : 8;
        dash  = undefined;
      }

      return { key: sec.id, coords: sec.path, color, width, dash };
    });
  }, [navRoute, progress?.completedSectionIds, pulseSectionId, pulsePhase]);

  // ── Animated panel background colour ─────────────────────────────────────

  const panelBgColor = modeTransAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [NAV_ROAD_BG, trailGradeColorRef.current],
  });

  // ── Loading ───────────────────────────────────────────────────────────────

  if (!navRoute) {
    return (
      <View style={[st.loadingScreen, { paddingTop: insets.top }]}>
        <Text style={{ fontSize: 32 }}>🧭</Text>
        <Text style={st.loadingText}>Building route…</Text>
      </View>
    );
  }

  const screenH = Dimensions.get("window").height;

  return (
    <View style={st.screen}>
      <StatusBar barStyle="light-content" backgroundColor={NAV_BG} translucent />

      {/* ── TOP PANEL (90px, animated bg) ────────────────────────────────── */}
      <Animated.View
        style={[st.topPanel, {
          paddingTop: insets.top + 8,
          backgroundColor: panelBgColor,
        }]}
      >
        {navMode === "road" ? (
          <RoadModePanel
            instruction={currentInstruction}
            distanceM={distToInstruction}
            nextNext={nextNextInstruction}
          />
        ) : (
          <TrailModePanel
            section={currentSection}
            remainingKm={trailRemainingKm}
            offRoadSlideAnim={offRoadSlideAnim}
          />
        )}
      </Animated.View>

      {/* ── MAP ──────────────────────────────────────────────────────────── */}
      <MapView
        ref={mapRef}
        style={st.map}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        rotateEnabled={false}
        userInterfaceStyle={isNight ? "dark" : "dark"}
        initialCamera={{
          center: navRoute.from, heading: 0,
          pitch: NAV_PITCH, zoom: ZOOM_ROAD_MED, altitude: ALTITUDE_ROAD,
        }}
        onPanDrag={handleMapInteraction}
        onRegionChange={handleMapInteraction}
      >
        {/* Route polylines */}
        {polylines.map(p => (
          <Polyline
            key={p.key}
            coordinates={p.coords}
            strokeColor={p.color}
            strokeWidth={p.width}
            lineCap="round"
            lineJoin="round"
            lineDashPattern={p.dash}
          />
        ))}

        {/* Overview: start/end markers + grade dots */}
        {overviewMode && (
          <>
            <Marker coordinate={navRoute.from} anchor={{ x: 0.5, y: 0.5 }}>
              <View style={[st.mapMarker, { backgroundColor: NAV_GREEN }]} />
            </Marker>
            <Marker coordinate={navRoute.to} anchor={{ x: 0.5, y: 0.5 }}>
              <View style={[st.mapMarker, { backgroundColor: AMBER }]} />
            </Marker>
            {navRoute.sections.filter(s => s.kind === "trail").map(s => (
              <Marker key={`dot-${s.id}`} coordinate={s.path[0] ?? navRoute.from} anchor={{ x: 0.5, y: 0.5 }}>
                <View style={[st.gradeDot, { backgroundColor: gradeToColor(s.grade) }]}>
                  <Text style={st.gradeDotText}>G{s.grade ?? "?"}</Text>
                </View>
              </Marker>
            ))}
          </>
        )}

        {/* User position marker */}
        {userPos && (
          <Marker
            coordinate={userPos}
            anchor={{ x: 0.5, y: 0.5 }}
            flat
          >
            <UserMarker
              markerStyle={prefs.markerStyle}
              heading={filteredHeadingRef.current}
            />
          </Marker>
        )}
      </MapView>

      {/* ── STATUS BANNER (recalculating / arrived) ──────────────────────── */}
      {statusMsg && (
        <View style={st.statusBanner} pointerEvents="none">
          <Text style={st.statusBannerText}>{statusMsg}</Text>
        </View>
      )}

      {/* ── OVERVIEW TOGGLE (top right of map area) ──────────────────────── */}
      <Pressable
        onPress={handleOverviewToggle}
        style={[st.overviewBtn, { top: insets.top + TOP_PANEL_H + 12 }, overviewMode && st.overviewBtnActive]}
        hitSlop={8}
      >
        <Feather name={overviewMode ? "navigation" : "maximize-2"} size={22} color={overviewMode ? NAV_BG : NAV_WHITE} />
      </Pressable>

      {/* ── RE-CENTRE button (appears when user pans) ────────────────────── */}
      {!isFollowing && !overviewMode && (
        <Animated.View
          style={[st.recentreBtn, { transform: [{ scale: recentrePulseAnim }] }]}
          pointerEvents="box-none"
        >
          <Pressable onPress={handleRecentre} style={st.recentreBtnInner} hitSlop={8}>
            <Feather name="navigation" size={20} color={NAV_BG} />
          </Pressable>
        </Animated.View>
      )}

      {/* ── PERSISTENT CONTROLS — always visible, never covered ──────────── */}
      <View style={[st.ctrlRow, { paddingBottom: insets.bottom + 4 }]}>
        <Pressable onPress={exitNavigation} style={st.ctrlExit} hitSlop={4}>
          <Feather name="x" size={24} color={NAV_WHITE} />
          <Text style={st.ctrlText}>EXIT</Text>
        </Pressable>
        <Pressable
          onPress={() => { setMuted(m => !m); }}
          style={[st.ctrlMute, muted && st.ctrlMuteMuted]}
          hitSlop={4}
        >
          <Feather name={muted ? "volume-x" : "volume-2"} size={24} color={muted ? AMBER : MUTED_TEXT} />
          <Text style={[st.ctrlText, muted && { color: AMBER }]}>{muted ? "UNMUTE" : "MUTE"}</Text>
        </Pressable>
      </View>

      {/* ── BOTTOM INFO BAR ──────────────────────────────────────────────── */}
      <View style={[st.bottomBar, { paddingBottom: insets.bottom + CTRL_H + 4 }]}>
        <BottomCell
          value={progress ? formatSpeed(progress.speedKmh / 3.6, prefs.speedUnit) : "0"}
          label={prefs.speedUnit}
        />
        <View style={st.barDiv} />
        <BottomCell
          value={progress ? (progress.distanceRemainingM >= 1000
            ? `${(progress.distanceRemainingM / 1000).toFixed(1)}`
            : `${Math.round(progress.distanceRemainingM)}`)
          : "—"}
          label={progress && progress.distanceRemainingM >= 1000 ? "km left" : "m left"}
        />
        <View style={st.barDiv} />
        <BottomCell
          value={progress ? formatArrivalTime(progress.etaMin) : "—"}
          label="ETA"
        />
      </View>

      {/* ── HANDOFF DIALOG ───────────────────────────────────────────────── */}
      {showHandoff && (
        <HandoffSheet
          distM={handoffDistM}
          onNavigateToStart={() => {
            setShowHandoff(false);
            // TODO: insert road section to start
            speak("Navigating to route start", false);
          }}
          onStartHere={() => setShowHandoff(false)}
        />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

// ── Road mode top panel ───────────────────────────────────────────────────────

function RoadModePanel({
  instruction, distanceM, nextNext,
}: {
  instruction: NavInstruction | null;
  distanceM: number;
  nextNext: NavInstruction | null;
}) {
  if (!instruction) {
    return (
      <View style={panel.row}>
        <Feather name="arrow-up" size={48} color={NAV_WHITE} />
        <View style={panel.centre}>
          <Text style={panel.distText}>Continue</Text>
          <Text style={panel.roadText}>Stay on route</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={panel.row}>
      {/* Direction arrow */}
      <View style={panel.arrowBox}>
        <InstructionArrow icon={instruction.icon} size={48} />
      </View>

      {/* Centre: distance + instruction + road/trail name */}
      <View style={panel.centre}>
        {distanceM > 30 ? (
          <Text style={panel.distText}>In {formatDistance(distanceM)}</Text>
        ) : null}
        <Text style={panel.instrText} numberOfLines={1}>{instruction.shortText}</Text>
        {instruction.trailName ? (
          <Text style={panel.subText} numberOfLines={1}>{instruction.trailName}</Text>
        ) : null}
      </View>

      {/* Next-next preview */}
      {nextNext ? (
        <View style={panel.nextBox}>
          <Text style={panel.nextLabel}>Then</Text>
          <InstructionArrow icon={nextNext.icon} size={18} />
        </View>
      ) : null}
    </View>
  );
}

// ── Trail mode top panel ──────────────────────────────────────────────────────

function TrailModePanel({
  section, remainingKm, offRoadSlideAnim,
}: {
  section?: NavSection;
  remainingKm: number;
  offRoadSlideAnim: Animated.Value;
}) {
  const grade = section?.grade ?? null;
  const gradeColor = gradeToColor(grade);

  return (
    <View style={panel.row}>
      {/* Grade badge */}
      <View style={[panel.gradeBadge, { backgroundColor: "#FFFFFF22" }]}>
        <Text style={panel.gradeLetter}>G</Text>
        <Text style={panel.gradeNum}>{grade ?? "?"}</Text>
      </View>

      {/* Centre: trail name + km remaining */}
      <View style={panel.centre}>
        <Text style={panel.trailName} numberOfLines={1}>{section?.name ?? "Trail"}</Text>
        <Text style={panel.trailKm}>{remainingKm.toFixed(1)}km remaining on trail</Text>
      </View>

      {/* OFFROAD badge slides in */}
      <Animated.View
        style={[panel.offroadBadge, {
          backgroundColor: gradeColor,
          transform: [{ translateX: offRoadSlideAnim }],
        }]}
      >
        <Text style={panel.offroadText}>OFFROAD</Text>
      </Animated.View>
    </View>
  );
}

// ── Instruction arrow ─────────────────────────────────────────────────────────

function InstructionArrow({ icon, size }: { icon: InstructionIcon; size: number }) {
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
  return <Feather name={iconMap[icon]} size={size} color={NAV_WHITE} />;
}

// ── User position marker ──────────────────────────────────────────────────────

function UserMarker({ markerStyle, heading }: { markerStyle: "arrow" | "motorcycle"; heading: number }) {
  if (markerStyle === "motorcycle") {
    return (
      <View style={[st.motoMarker, { transform: [{ rotate: `${heading}deg` }] }]}>
        <Text style={{ fontSize: 28 }}>🏍️</Text>
      </View>
    );
  }
  // Default: amber directional arrow
  return (
    <View style={[st.arrowMarker, { transform: [{ rotate: `${heading}deg` }] }]}>
      <View style={st.arrowTri} />
      <View style={st.arrowDot} />
    </View>
  );
}

// ── Bottom info cell ──────────────────────────────────────────────────────────

function BottomCell({ value, label }: { value: string; label: string }) {
  return (
    <View style={st.bottomCell}>
      <Text style={st.bottomValue}>{value}</Text>
      <Text style={st.bottomLabel}>{label}</Text>
    </View>
  );
}

// ── Handoff sheet ─────────────────────────────────────────────────────────────

function HandoffSheet({
  distM, onNavigateToStart, onStartHere,
}: { distM: number; onNavigateToStart: () => void; onStartHere: () => void }) {
  return (
    <View style={st.handoffSheet}>
      <View style={st.handoffHandle} />
      <Text style={st.handoffTitle}>You are {(distM / 1000).toFixed(1)}km from the start</Text>
      <Text style={st.handoffSub}>Where would you like to begin?</Text>
      <Pressable style={st.handoffPrimary} onPress={onNavigateToStart}>
        <Text style={st.handoffPrimaryText}>Navigate to start first</Text>
      </Pressable>
      <Pressable style={st.handoffSecondary} onPress={onStartHere}>
        <Text style={st.handoffSecondaryText}>Start from here anyway</Text>
      </Pressable>
    </View>
  );
}

// ── Voice helper ──────────────────────────────────────────────────────────────

let _speechBusy = false;

function speak(text: string, muted: boolean): void {
  if (muted || _speechBusy) return;
  _speechBusy = true;
  Speech.speak(text, {
    language: "en-GB",
    rate: 0.9,
    pitch: 1.0,
    onDone: () => { _speechBusy = false; },
    onError: () => { _speechBusy = false; },
    onStopped: () => { _speechBusy = false; },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: NAV_BG },

  loadingScreen: {
    flex: 1, backgroundColor: NAV_BG,
    alignItems: "center", justifyContent: "center", gap: 16,
  },
  loadingText: { color: NAV_WHITE, fontSize: 18, fontWeight: "700" },

  // ── Top panel ──────────────────────────────────────────────────────────────
  topPanel: {
    zIndex: 10,
    paddingHorizontal: 16,
    paddingBottom: 12,
    minHeight: TOP_PANEL_H,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 14,
  },

  // ── Map (fills middle) ─────────────────────────────────────────────────────
  map: { flex: 1 },

  // ── Bottom bar ─────────────────────────────────────────────────────────────
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: NAV_BG + "F0",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#2A2A2A",
    minHeight: BOTTOM_BAR_H,
    paddingTop: 6,
  },
  bottomCell: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 8 },
  bottomValue:{ color: NAV_WHITE, fontSize: 24, fontWeight: "900" },
  bottomLabel:{ color: MUTED_TEXT, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.8 },
  barDiv:     { width: StyleSheet.hairlineWidth, height: 36, backgroundColor: "#2A2A2A" },

  // ── Persistent controls ────────────────────────────────────────────────────
  ctrlRow: {
    position: "absolute",
    bottom: BOTTOM_BAR_H,
    left: 0,
    right: 0,
    flexDirection: "row",
  },
  ctrlExit: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    height: CTRL_H, gap: 8, backgroundColor: NAV_RED + "CC",
  },
  ctrlMute: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    height: CTRL_H, gap: 8, backgroundColor: "#1E1E1E",
  },
  ctrlMuteMuted: { backgroundColor: "#221A00" },
  ctrlText: { color: NAV_WHITE, fontSize: 14, fontWeight: "800", letterSpacing: 0.8 },

  // ── Overview toggle ────────────────────────────────────────────────────────
  overviewBtn: {
    position: "absolute",
    right: 16,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#1A1A1AE0",
    borderWidth: 1,
    borderColor: "#333",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 8,
  },
  overviewBtnActive: { backgroundColor: AMBER },

  // ── Re-centre ──────────────────────────────────────────────────────────────
  recentreBtn: {
    position: "absolute",
    right: 16,
    bottom: BOTTOM_BAR_H + CTRL_H + 16,
    zIndex: 20,
  },
  recentreBtnInner: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: AMBER,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 10,
  },

  // ── Status banner ──────────────────────────────────────────────────────────
  statusBanner: {
    position: "absolute",
    alignSelf: "center",
    top: "40%",
    backgroundColor: AMBER,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 14,
  },
  statusBannerText: { color: NAV_BG, fontSize: 16, fontWeight: "900" },

  // ── User position markers ──────────────────────────────────────────────────
  arrowMarker: { width: 36, height: 36, alignItems: "center", justifyContent: "flex-start" },
  arrowTri: {
    width: 0, height: 0,
    borderLeftWidth: 11, borderRightWidth: 11, borderBottomWidth: 28,
    borderLeftColor: "transparent", borderRightColor: "transparent",
    borderBottomColor: AMBER,
  },
  arrowDot: {
    width: 11, height: 11, borderRadius: 6,
    backgroundColor: AMBER, marginTop: -4,
  },
  motoMarker: {
    width: 40, height: 40,
    alignItems: "center", justifyContent: "center",
  },

  // ── Map markers ────────────────────────────────────────────────────────────
  mapMarker: {
    width: 18, height: 18, borderRadius: 9,
    borderWidth: 2, borderColor: NAV_WHITE,
  },
  gradeDot: {
    minWidth: 36, height: 26, borderRadius: 6, paddingHorizontal: 4,
    alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: NAV_WHITE,
  },
  gradeDotText: { color: NAV_WHITE, fontSize: 11, fontWeight: "900" },

  // ── Handoff sheet ──────────────────────────────────────────────────────────
  handoffSheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#1A1A1A",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
    zIndex: 50,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.6,
    shadowRadius: 16,
    elevation: 24,
  },
  handoffHandle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: AMBER, alignSelf: "center", marginBottom: 18,
  },
  handoffTitle:  { color: NAV_WHITE, fontSize: 20, fontWeight: "800", marginBottom: 6 },
  handoffSub:    { color: MUTED_TEXT, fontSize: 14, marginBottom: 20 },
  handoffPrimary:{ backgroundColor: AMBER, borderRadius: 14, height: 68, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  handoffPrimaryText: { color: NAV_BG, fontSize: 17, fontWeight: "900" },
  handoffSecondary: { borderRadius: 14, height: 56, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#333" },
  handoffSecondaryText: { color: MUTED_TEXT, fontSize: 16, fontWeight: "600" },
});

// ── Panel sub-styles ──────────────────────────────────────────────────────────

const panel = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    gap: 12,
  },
  arrowBox: {
    width: 56, height: 56,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 10,
  },
  centre: { flex: 1 },
  distText:  { color: AMBER, fontSize: 16, fontWeight: "700" },
  instrText: { color: NAV_WHITE, fontSize: 22, fontWeight: "900", letterSpacing: -0.5 },
  roadText:  { color: NAV_WHITE, fontSize: 18, fontWeight: "700" },
  subText:   { color: "rgba(255,255,255,0.7)", fontSize: 13, marginTop: 2 },
  nextBox:   { alignItems: "center", width: 44 },
  nextLabel: { color: "rgba(255,255,255,0.6)", fontSize: 10, fontWeight: "700", marginBottom: 2 },

  // Trail mode
  gradeBadge: {
    width: 56, height: 56, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  gradeLetter: { color: "rgba(255,255,255,0.8)", fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  gradeNum:    { color: NAV_WHITE, fontSize: 32, fontWeight: "900", lineHeight: 34 },
  trailName:   { color: NAV_WHITE, fontSize: 18, fontWeight: "800", letterSpacing: -0.3 },
  trailKm:     { color: "rgba(255,255,255,0.85)", fontSize: 13, marginTop: 2 },
  offroadBadge:{
    backgroundColor: AMBER,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  offroadText: { color: NAV_WHITE, fontSize: 10, fontWeight: "900", letterSpacing: 1.5 },
});
