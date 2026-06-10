/**
 * TrailForge Navigation — Google Maps–style turn-by-turn UI.
 *
 * Full-screen map with floating instruction banner, ETA card, and FAB controls.
 * Road mode: green turn banner. Trail mode: white off-road card with grade accent.
 */

import * as Haptics from "expo-haptics";
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

import { NavRouteSheet } from "@/components/nav/NavRouteSheet";
import { NavCompletionSheet, type NavTrailToLog } from "@/components/nav/NavCompletionSheet";
import {
  GM,
  GoogleUserMarker,
  NavCloseButton,
  NavFab,
  NavFabColumn,
  NavHandoffSheet,
  NavLoadingScreen,
  NavRecentreFab,
  NavStatusChip,
  RoadInstructionBanner,
  TrailInstructionBanner,
} from "@/components/nav/NavigateChrome";
import { useHeading } from "@/lib/useHeading";
import {
  buildNavRouteAsync,
  computeProgress,
  getNavigationCameraCenter,
  rebuildNavRouteFromSections,
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
import {
  getActiveNavRoute,
  clearActiveNavRoute,
  consumePrebuiltNavRoute,
} from "@/lib/activeNavRoute";
import {
  cacheNavRoute,
  cacheTrailsForNavRoute,
  getCachedNavRoute,
} from "@/lib/offlineNavRoute";
import { difficultyColor, gradeToColor } from "@/lib/trailColors";
import {
  loadNavPrefs,
  patchNavPrefs,
  cycleNavMapType,
  resolveNightMode,
  type NavPrefs,
  NAV_PREFS_DEFAULT,
  type NavMapType,
} from "@/lib/navPrefs";
import { haversineM } from "@/lib/navigationReroute";

// ── Constants ─────────────────────────────────────────────────────────────────

const RECALC_MS     = 4000;
const RECENTRE_AUTO_MS = 10000; // auto-snap back to following after 10s
const SHEET_COLLAPSED_H = 88;
const SHEET_EXPANDED_H = Math.min(Dimensions.get("window").height * 0.58, 520);

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
  const [routeLoading, setRouteLoading] = useState(true);
  const [routeError, setRouteError]     = useState<string | null>(null);
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
  const [sheetExpanded, setSheetExpanded]   = useState(false);
  const [completionPrompt, setCompletionPrompt] = useState<{
    title: string;
    subtitle: string;
    trails: NavTrailToLog[];
    defaultSelectedIds: string[];
  } | null>(null);

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
  const arrivalPromptShownRef = useRef(false);

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

  // Re-centre button pulse
  const recentrePulseAnim  = useRef(new Animated.Value(1)).current;

  // ── Load preferences ──────────────────────────────────────────────────────
  useEffect(() => {
    void loadNavPrefs().then(p => {
      setPrefs(p);
      setMuted(!p.voiceEnabled);
      mutedRef.current = !p.voiceEnabled;
      setIsNight(resolveNightMode(p.nightMode));
    });
  }, []);

  // ── Build route on mount (OSRM road legs) ─────────────────────────────────
  useEffect(() => {
    if (!inputRoute) {
      router.back();
      return;
    }

    const prebuilt = consumePrebuiltNavRoute();
    if (prebuilt) {
      setNavRoute(prebuilt);
      routeRef.current = prebuilt;
      setRouteLoading(false);
      if (inputRoute.cacheKey) {
        void cacheNavRoute(inputRoute.cacheKey, inputRoute, prebuilt);
        void cacheTrailsForNavRoute(prebuilt);
      }
      return;
    }

    const abort = new AbortController();
    setRouteLoading(true);
    setRouteError(null);

    void buildNavRouteAsync(inputRoute, abort.signal)
      .then((route) => {
        setNavRoute(route);
        routeRef.current = route;
        if (route.routingDegraded) {
          setStatusMsg("Road routing is limited — some sections use direct lines");
        }
        if (inputRoute.cacheKey) {
          void cacheNavRoute(inputRoute.cacheKey, inputRoute, route);
          void cacheTrailsForNavRoute(route);
        }
        setRouteLoading(false);
      })
      .catch(async (err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        if (inputRoute.cacheKey) {
          const cached = await getCachedNavRoute(inputRoute.cacheKey);
          if (cached) {
            setNavRoute(cached.route);
            routeRef.current = cached.route;
            setStatusMsg("Using offline route — road links may be dated");
            setTimeout(() => setStatusMsg(null), 6000);
            setRouteLoading(false);
            return;
          }
        }
        setRouteError(err instanceof Error ? err.message : "Could not build route");
        setRouteLoading(false);
      });

    return () => abort.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handoff check — run once GPS is ready ─────────────────────────────────
  useEffect(() => {
    if (!userPos || !navRoute || showHandoff || inputRoute?.localRide) return;
    const distToStart = haversineM(userPos, navRoute.from);
    if (distToStart > HANDOFF_DIST_M) {
      setHandoffDistM(Math.round(distToStart));
      setShowHandoff(true);
    }
  }, [userPos, navRoute]); // eslint-disable-line react-hooks/exhaustive-deps

  async function navigateToRouteStart() {
    if (!userPos || !navRoute) return;
    setShowHandoff(false);
    setStatusMsg("Finding road to start…");
    try {
      const res = await fetchRoadRoute(userPos, navRoute.from);
      if (!res.ok) {
        setStatusMsg(null);
        Alert.alert(
          "Routing unavailable",
          res.error ?? "Could not find a road route to the start. Try moving closer or start from here.",
        );
        setShowHandoff(true);
        return;
      }
      const approach: NavSection = {
        kind: "road",
        id: "road-to-start-handoff",
        name: "Head to route start",
        path: res.polyline,
        distanceM: res.distanceM,
        osrmSteps: res.steps.length > 0 ? res.steps : undefined,
        cumulativeDistanceM: 0,
      };
      const rebuilt = rebuildNavRouteFromSections(
        { ...userPos, label: "You" },
        navRoute.to,
        [approach, ...navRoute.sections],
      );
      setNavRoute(rebuilt);
      routeRef.current = rebuilt;
      announcedAtRef.current.clear();
      setProgress(null);
      setStatusMsg(null);
      speak("Navigating to route start", mutedRef.current);
    } catch {
      setStatusMsg(null);
      Alert.alert("Routing failed", "Could not plan a route to the start.");
      setShowHandoff(true);
    }
  }

  // ── Exit / completion logging ─────────────────────────────────────────────

  const finishNavigation = useCallback(() => {
    clearActiveNavRoute();
    rerouteAbortRef.current?.abort();
    setCompletionPrompt(null);
    router.back();
  }, []);

  const trailSectionsFromRoute = useCallback((route: NavRoute): NavTrailToLog[] => {
    return route.sections
      .filter((sec) => sec.kind === "trail")
      .map((sec) => ({ id: sec.id, name: sec.name }));
  }, []);

  const openCompletionPrompt = useCallback((mode: "arrived" | "exit") => {
    const route = routeRef.current;
    const prog = progressRef.current;
    if (!route) {
      if (mode === "exit") finishNavigation();
      return;
    }
    const trails = trailSectionsFromRoute(route);
    if (trails.length === 0) {
      if (mode === "exit") finishNavigation();
      return;
    }
    const completedTrailIds = (prog?.completedSectionIds ?? []).filter((id) =>
      route.sections.some((s) => s.kind === "trail" && s.id === id),
    );
    const defaultSelected =
      mode === "arrived" ? trails.map((t) => t.id) : completedTrailIds;
    if (mode === "exit" && defaultSelected.length === 0) {
      finishNavigation();
      return;
    }
    setCompletionPrompt({
      title: mode === "arrived" ? "Ride complete!" : "Log trails from this ride?",
      subtitle:
        mode === "arrived"
          ? "Add these trail sections to your ridden log for mileage, rank points, and badges."
          : "You rode part of this route. Log completed trail sections to your profile.",
      trails,
      defaultSelectedIds: defaultSelected,
    });
  }, [finishNavigation, trailSectionsFromRoute]);

  const exitNavigation = useCallback(() => {
    Alert.alert("Exit navigation?", "Your route progress will be lost.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Exit", style: "destructive",
        onPress: () => openCompletionPrompt("exit"),
      },
    ]);
  }, [openCompletionPrompt]);

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
            if (!arrivalPromptShownRef.current) {
              arrivalPromptShownRef.current = true;
              speak(
                inputRoute?.localRideLoop
                  ? "You are back at the start"
                  : "You have arrived at your destination",
                mutedRef.current,
              );
              openCompletionPrompt("arrived");
            }
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

  function enterTrailMode(section: NavSection | undefined, _speedMs: number) {
    setNavMode("trail");
    navModeRef.current = "trail";
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

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
    setPulseSectionId(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

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
    const currentIdx = prog?.currentSectionIdx ?? 0;
    const currentSec = route.sections[currentIdx];

    const nextEntry: NavLatLng = (() => {
      for (let i = currentIdx + 1; i < route.sections.length; i++) {
        const sec = route.sections[i];
        if (sec.path[0]) return sec.path[0];
      }
      return route.to;
    })();

    const target: NavLatLng =
      currentSec?.kind === "road" ? nextEntry : (nextEntry ?? route.to);

    const result = await fetchRoadRoute(pos, target, rerouteAbortRef.current.signal);
    if (!result.ok) {
      setRerouteState(prev => updateRerouteStateOnFailure(prev));
      setStatusMsg("Reroute failed — stay on route");
      setTimeout(() => setStatusMsg(null), RECALC_MS);
      return;
    }

    const updatedSections = route.sections.map((sec, i) => {
      if (i !== currentIdx || sec.kind !== "road") return sec;
      return { ...sec, path: result.polyline, distanceM: result.distanceM };
    });
    const newRoute = rebuildNavRouteFromSections(route.from, route.to, updatedSections);
    routeRef.current = newRoute;
    setNavRoute(newRoute);
    setRerouteState(prev => updateRerouteStateOnSuccess(prev));
    announcedAtRef.current.clear();
    setStatusMsg("Route updated");
    setTimeout(() => setStatusMsg(null), RECALC_MS);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const skipSection = useCallback((sectionId: string, sectionName: string) => {
    const route = routeRef.current;
    if (!route) return;
    Alert.alert(
      "Skip section?",
      `Remove "${sectionName}" from this ride and continue to the next leg?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Skip",
          style: "destructive",
          onPress: () => {
            const remaining = route.sections.filter((s) => s.id !== sectionId);
            if (remaining.length === 0) {
              Alert.alert("Cannot skip", "This is the only section left on your route.");
              return;
            }
            const newRoute = rebuildNavRouteFromSections(route.from, route.to, remaining);
            routeRef.current = newRoute;
            setNavRoute(newRoute);
            announcedAtRef.current.clear();
            setProgress(null);
            progressRef.current = null;
            setStatusMsg("Section skipped — route updated");
            setTimeout(() => setStatusMsg(null), RECALC_MS);
            speak(`Skipping ${sectionName}`, mutedRef.current);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          },
        },
      ],
    );
  }, []);

  const handleMapTypeCycle = useCallback(async () => {
    const next = cycleNavMapType(prefs.mapType);
    const updated = await patchNavPrefs({ mapType: next });
    setPrefs(updated);
    void Haptics.selectionAsync();
  }, [prefs.mapType]);

  function nativeMapType(mapType: NavMapType): "standard" | "satellite" | "hybrid" | "terrain" {
    if (mapType === "satellite") return "satellite";
    if (mapType === "terrain") {
      return Platform.OS === "ios" ? "terrain" : "hybrid";
    }
    return "standard";
  }

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

  const nextTrailHint = useMemo(() => {
    if (!navRoute || !progress || navMode === "trail") return null;
    for (let i = progress.currentSectionIdx + 1; i < navRoute.sections.length; i++) {
      const sec = navRoute.sections[i];
      if (sec.kind !== "trail") continue;
      const distM = sec.cumulativeDistanceM - progress.distanceTravelledM;
      if (distM < 100) continue;
      return { name: sec.name, grade: sec.grade ?? null, distM };
    }
    return null;
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
        color = completed ? GM.blueLight : GM.blue;
        width = completed ? 5 : 7;
        dash  = undefined;
      } else {
        color = completed ? trailColor + "88" : trailColor;
        width = isPulsing && pulsePhase === "bright" ? 10 : 7;
        dash  = undefined;
      }

      return { key: sec.id, coords: sec.path, color, width, dash };
    });
  }, [navRoute, progress?.completedSectionIds, pulseSectionId, pulsePhase]);

  // ── Loading ───────────────────────────────────────────────────────────────

  if (routeLoading || !navRoute) {
    return (
      <NavLoadingScreen
        message="Calculating road route…"
        error={routeError}
        onBack={() => router.back()}
        paddingTop={insets.top}
      />
    );
  }

  const mapBottomPad =
    (sheetExpanded ? SHEET_EXPANDED_H : SHEET_COLLAPSED_H) + insets.bottom + 16;

  return (
    <View style={st.screen}>
      <StatusBar barStyle="dark-content" backgroundColor="transparent" translucent />

      {/* ── MAP (full screen) ──────────────────────────────────────────────── */}
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        rotateEnabled={false}
        mapType={nativeMapType(prefs.mapType)}
        userInterfaceStyle={isNight ? "dark" : "light"}
        initialCamera={{
          center: navRoute.from, heading: 0,
          pitch: NAV_PITCH, zoom: ZOOM_ROAD_MED, altitude: ALTITUDE_ROAD,
        }}
        mapPadding={{
          top: insets.top + 130,
          bottom: mapBottomPad,
          left: 12,
          right: 12,
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
              <View style={[st.mapMarker, { backgroundColor: GM.green }]} />
            </Marker>
            <Marker coordinate={navRoute.to} anchor={{ x: 0.5, y: 0.5 }}>
              <View style={[st.mapMarker, { backgroundColor: "#EA4335" }]} />
            </Marker>
            {navRoute.sections.filter(s => s.kind === "trail").map(s => (
              <Marker key={`dot-${s.id}`} coordinate={s.path[0] ?? navRoute.from} anchor={{ x: 0.5, y: 0.5 }}>
                <View style={[st.gradeDot, { backgroundColor: gradeToColor(s.grade) }]}>
                  <Text style={st.gradeDotText}>{s.grade ?? "?"}</Text>
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
            <GoogleUserMarker
              markerStyle={prefs.markerStyle}
              heading={filteredHeadingRef.current}
            />
          </Marker>
        )}
      </MapView>

      {/* ── Close (top-left) ─────────────────────────────────────────────── */}
      <NavCloseButton
        onPress={exitNavigation}
        style={{ position: "absolute", top: insets.top + 10, left: 16, zIndex: 20 }}
      />

      {/* ── Instruction banner (floating, full width) ──────────────────────── */}
      <View style={[st.instrFloat, { top: insets.top + 62, left: 16, right: 72 }]}
        pointerEvents="none"
      >
        {navMode === "road" ? (
          <RoadInstructionBanner
            instruction={currentInstruction}
            distanceM={distToInstruction}
            nextNext={nextNextInstruction}
            nextTrailHint={nextTrailHint}
          />
        ) : (
          <TrailInstructionBanner
            section={currentSection}
            remainingKm={trailRemainingKm}
          />
        )}
      </View>

      {/* ── FAB column (right) ───────────────────────────────────────────── */}
      <NavFabColumn
        style={{
          position: "absolute",
          right: 16,
          bottom: mapBottomPad + 12,
          zIndex: 20,
        }}
      >
        <NavFab
          icon="layers"
          onPress={() => void handleMapTypeCycle()}
          active={prefs.mapType !== "standard"}
          accessibilityLabel={`Map layer: ${prefs.mapType}`}
        />
        <NavFab
          icon={overviewMode ? "navigation" : "maximize-2"}
          onPress={handleOverviewToggle}
          active={overviewMode}
          accessibilityLabel={overviewMode ? "Resume navigation" : "Route overview"}
        />
        <NavFab
          icon={muted ? "volume-x" : "volume-2"}
          onPress={() => setMuted((m) => !m)}
          active={muted}
          accessibilityLabel={muted ? "Unmute voice" : "Mute voice"}
        />
        {!isFollowing && !overviewMode ? (
          <NavRecentreFab
            onPress={handleRecentre}
            pulseAnim={recentrePulseAnim}
          />
        ) : null}
      </NavFabColumn>

      {/* ── Status chip (recalculating) ──────────────────────────────────── */}
      {statusMsg ? (
        <View style={[st.statusFloat, { top: insets.top + 168 }]} pointerEvents="none">
          <NavStatusChip message={statusMsg} />
        </View>
      ) : null}

      {/* ── Bottom route sheet (ETA + steps) ─────────────────────────────── */}
      <NavRouteSheet
        route={navRoute}
        progress={progress}
        prefs={prefs}
        bottomInset={insets.bottom}
        onSkipSection={skipSection}
        onExpandedChange={setSheetExpanded}
      />

      {/* ── HANDOFF DIALOG ───────────────────────────────────────────────── */}
      {showHandoff && (
        <NavHandoffSheet
          distM={handoffDistM}
          onNavigateToStart={() => void navigateToRouteStart()}
          onStartHere={() => setShowHandoff(false)}
        />
      )}

      <NavCompletionSheet
        visible={completionPrompt != null}
        title={completionPrompt?.title ?? ""}
        subtitle={completionPrompt?.subtitle ?? ""}
        trails={completionPrompt?.trails ?? []}
        defaultSelectedIds={completionPrompt?.defaultSelectedIds ?? []}
        onDismiss={finishNavigation}
        onDone={finishNavigation}
      />
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

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#E8EAED" },
  instrFloat: { position: "absolute", zIndex: 15 },
  statusFloat: { position: "absolute", alignSelf: "center", zIndex: 25 },
  mapMarker: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2.5,
    borderColor: GM.card,
  },
  gradeDot: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: GM.card,
  },
  gradeDotText: { color: GM.card, fontSize: 12, fontWeight: "800" },
});
