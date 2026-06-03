/**
 * Route Planner — 4-step wizard
 *
 * Step 1: Where + What kind of ride (2 questions only)
 * Step 2: Route result on map — summary + adjustments
 * Step 3: Section editor (tap a trail section)
 * Step 4: Save / Offline / Export / Go
 */

import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { router } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MapView, {
  Marker,
  Polyline,
  PROVIDER_DEFAULT,
  PROVIDER_GOOGLE,
} from "react-native-maps";

import colors, { gradeColour } from "@/constants/colors";
import {
  getPlannerSuggestions,
  searchTrailsByBbox,
  buildGpx,
  askAi,
  type MapTrail,
  type PlannerSuggestion,
} from "@/lib/api";
import { exportGpxFile, trailsToGpxInput, type GpxDevice } from "@/lib/gpxExport";
import {
  geocode,
  reverseGeocode,
  shortLabel,
  distKm,
  formatDistKm,
  type NominatimResult,
} from "@/lib/nominatim";
import { setActiveNavRoute } from "@/lib/activeNavRoute";
import { useProfile } from "@/components/ProfileContext";
import {
  usePlannerStore,
  plannerActions,
  styleToParams,
  type RideStyle,
  type PlannerStep,
} from "@/store/routePlannerStore";
import { difficultyColor } from "@/lib/trailColors";

const { width: SW, height: SH } = Dimensions.get("window");
const AMBER = colors.light.primary;
const BG    = colors.light.background;
const CARD  = colors.light.card;

// ─────────────────────────────────────────────────────────────────────────────
// Root component
// ─────────────────────────────────────────────────────────────────────────────

export default function PlannerTab() {
  const state = usePlannerStore();
  const { profile } = useProfile();

  // If coming back from navigate, reset to step 1
  useEffect(() => {
    if (state.step === 4) plannerActions.setStep(1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  switch (state.step) {
    case 1: return <Step1StyleSelector profile={profile} />;
    case 2: return <Step2RouteResult />;
    case 3: return <Step2RouteResult showSectionEditor />;
    case 4: return <Step4SaveAndGo />;
    default: return <Step1StyleSelector profile={profile} />;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Two questions
// ─────────────────────────────────────────────────────────────────────────────

function Step1StyleSelector({ profile }: { profile: ReturnType<typeof useProfile>["profile"] }) {
  const state = usePlannerStore();
  const [gpsLoading, setGpsLoading] = useState(!state.from);
  const [gpsDenied, setGpsDenied] = useState(false);
  const [nlMode, setNlMode] = useState(false);
  const [nlText, setNlText] = useState(state.naturalLanguageInput);
  const [nlLoading, setNlLoading] = useState(false);
  const [fromSearch, setFromSearch] = useState(false);
  const [fromQuery, setFromQuery] = useState("");
  const [fromResults, setFromResults] = useState<NominatimResult[]>([]);
  const [fromSearching, setFromSearching] = useState(false);
  const [gpsPos, setGpsPos] = useState<{ lat: number; lon: number } | null>(null);
  // TO destination state
  const [toQuery, setToQuery] = useState(state.to?.address ?? "");
  const [toResults, setToResults] = useState<NominatimResult[]>([]);
  const [toSearching, setToSearching] = useState(false);
  const [toFocused, setToFocused] = useState(false);
  const isLoop = state.to === null;

  // Auto-GPS on mount
  useEffect(() => {
    if (state.from) { setGpsLoading(false); return; }
    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") {
          setGpsDenied(true);
          setGpsLoading(false);
          return;
        }
        const pos = await Location.getLastKnownPositionAsync()
          ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const { latitude: lat, longitude: lon } = pos.coords;
        setGpsPos({ lat, lon });
        setGpsDenied(false);
        const rev = await reverseGeocode(lat, lon);
        const address = rev?.display_name
          ? `Near ${shortLabel(rev.display_name)}`
          : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        plannerActions.setFrom({ lat, lon, address });
      } catch { /* ignore */ }
      finally { setGpsLoading(false); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced FROM search
  useEffect(() => {
    if (!fromSearch || !fromQuery) { setFromResults([]); return; }
    setFromSearching(true);
    const h = setTimeout(async () => {
      const r = await geocode(fromQuery, gpsPos ?? undefined);
      setFromResults(r);
      setFromSearching(false);
    }, 300);
    return () => clearTimeout(h);
  }, [fromQuery, fromSearch, gpsPos]);

  // Debounced TO search
  useEffect(() => {
    if (!toFocused || !toQuery.trim()) { setToResults([]); return; }
    setToSearching(true);
    const h = setTimeout(async () => {
      const r = await geocode(toQuery, gpsPos ?? undefined);
      setToResults(r);
      setToSearching(false);
    }, 300);
    return () => clearTimeout(h);
  }, [toQuery, toFocused, gpsPos]);

  async function useGpsFallback() {
    setGpsLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setGpsDenied(true);
        return;
      }
      const pos = await Location.getLastKnownPositionAsync()
        ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude: lat, longitude: lon } = pos.coords;
      setGpsPos({ lat, lon });
      setGpsDenied(false);
      const rev = await reverseGeocode(lat, lon);
      const address = rev?.display_name ? `Near ${shortLabel(rev.display_name)}` : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      plannerActions.setFrom({ lat, lon, address });
    } catch { Alert.alert("GPS unavailable", "Could not get your position."); }
    finally { setGpsLoading(false); }
  }

  async function handleNlSubmit() {
    if (!nlText.trim() || !state.from) return;
    setNlLoading(true);
    plannerActions.setNaturalLanguage(nlText);
    try {
      const resp = await askAi(
        [{ role: "user", content: `Parse this ride request and return JSON only with keys: rideStyle ("easy"|"moderate"|"challenge"), corridorKm (number). Request: "${nlText}"` }],
        {},
      );
      try {
        const parsed = JSON.parse(resp.reply.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as { rideStyle?: string; corridorKm?: number };
        const style = (["easy","moderate","challenge"].includes(parsed.rideStyle ?? "") ? parsed.rideStyle : "moderate") as RideStyle;
        plannerActions.setRideStyle(style);
      } catch { plannerActions.setRideStyle("moderate"); }
    } catch { plannerActions.setRideStyle("moderate"); }
    setNlLoading(false);
    await doCalculate(state.from, state.rideStyle ?? "moderate");
  }

  async function doCalculate(from: typeof state.from, style: RideStyle) {
    if (!from) return;
    const params = styleToParams(style);
    const dest = state.to ?? from; // null to = loop back to start
    plannerActions.setCalculating(true);
    plannerActions.setStep(2);
    try {
      const res = await getPlannerSuggestions({
        fromLat: from.lat,
        fromLon: from.lon,
        toLat:   dest.lat,
        toLon:   dest.lon,
        corridorKm: params.corridorKm,
      });
      const ids = res.suggestions.map(s => s.trailId).join(",");
      const details = ids
        ? await searchTrailsByBbox({ ids, limit: 50 })
        : { trails: [] };
      plannerActions.setSuggestions(res.suggestions, details.trails);
    } catch (e) {
      Alert.alert("Route error", e instanceof Error ? e.message : "Could not find trails");
      plannerActions.setCalculating(false);
      plannerActions.setStep(1);
    }
  }

  function handleStylePick(style: RideStyle) {
    plannerActions.setRideStyle(style);
    if (state.from) void doCalculate(state.from, style);
  }

  const canGo = !!state.from && !!state.rideStyle;
  const bikeLabel = profile.preferredBikeType === "all" ? "All bikes"
    : profile.preferredBikeType.charAt(0).toUpperCase() + profile.preferredBikeType.slice(1);

  return (
    <SafeAreaView style={s1.safe}>
      <ScrollView contentContainerStyle={s1.scroll} keyboardShouldPersistTaps="handled">
        {/* Header */}
        <Text style={s1.header}>PLAN YOUR RIDE</Text>
        <View style={s1.headerAccent} />

        {/* Q1: Where are you starting? */}
        <Text style={s1.qLabel}>WHERE ARE YOU STARTING?</Text>

        {fromSearch ? (
          <View style={s1.searchBox}>
            <Feather name="search" size={16} color={AMBER} style={{ marginLeft: 14 }} />
            <TextInput
              value={fromQuery}
              onChangeText={setFromQuery}
              placeholder="Search start location…"
              placeholderTextColor={colors.light.mutedForeground}
              style={s1.searchInput}
              autoFocus
            />
            {fromSearching
              ? <ActivityIndicator size="small" color={AMBER} style={{ marginRight: 12 }} />
              : <Pressable onPress={() => { setFromSearch(false); setFromQuery(""); setFromResults([]); }} style={{ marginRight: 12 }}>
                  <Feather name="x" size={16} color={colors.light.mutedForeground} />
                </Pressable>
            }
          </View>
        ) : (
          <TouchableOpacity
            style={[s1.locPill, gpsLoading && { opacity: 0.7 }]}
            onPress={() => setFromSearch(true)}
            activeOpacity={0.8}
          >
            <Feather name="navigation" size={16} color={gpsDenied ? colors.light.mutedForeground : AMBER} />
            {gpsLoading
              ? <>
                  <ActivityIndicator size="small" color={AMBER} style={{ marginLeft: 8 }} />
                  <Text style={s1.locHint}> Getting your location…</Text>
                </>
              : gpsDenied
                ? <>
                    <Text style={[s1.locHint, { color: colors.light.mutedForeground, flex: 1 }]}>📍 Location access needed</Text>
                    <TouchableOpacity
                      onPress={() => void Linking.openSettings()}
                      style={s1.openSettingsBtn}
                    >
                      <Text style={s1.openSettingsText}>Enable in Settings</Text>
                    </TouchableOpacity>
                  </>
              : state.from
                ? <Text style={s1.locText} numberOfLines={1}>{state.from.address}</Text>
                : <TouchableOpacity onPress={() => void useGpsFallback()} style={s1.gpsFallBtn}>
                    <Text style={s1.gpsFallText}>📍 Use Current Location</Text>
                  </TouchableOpacity>
            }
            {state.from && !gpsLoading && !gpsDenied && (
              <Feather name="edit-2" size={13} color={colors.light.mutedForeground} style={{ marginLeft: "auto" }} />
            )}
          </TouchableOpacity>
        )}

        {/* Search results dropdown */}
        {fromResults.length > 0 && (
          <View style={s1.dropdown}>
            {fromResults.map(r => (
              <TouchableOpacity
                key={r.place_id}
                style={s1.dropItem}
                onPress={() => {
                  plannerActions.setFrom({ lat: parseFloat(r.lat), lon: parseFloat(r.lon), address: shortLabel(r.display_name) });
                  setFromSearch(false);
                  setFromQuery("");
                  setFromResults([]);
                }}
              >
                <Feather name="map-pin" size={14} color={AMBER} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={s1.dropName} numberOfLines={1}>{shortLabel(r.display_name)}</Text>
                  {gpsPos && <Text style={s1.dropDist}>{formatDistKm(distKm(gpsPos.lat, gpsPos.lon, parseFloat(r.lat), parseFloat(r.lon)))}</Text>}
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Q1b: Destination (TO) */}
        <Text style={[s1.qLabel, { marginTop: 24 }]}>WHERE TO?</Text>

        {/* Loop option */}
        <TouchableOpacity
          style={[s1.loopPill, isLoop && s1.loopPillActive]}
          onPress={() => { plannerActions.setTo(null); setToQuery(""); setToFocused(false); setToResults([]); }}
          activeOpacity={0.8}
        >
          <Text style={s1.loopIcon}>🔄</Text>
          <View style={{ flex: 1 }}>
            <Text style={[s1.loopText, isLoop && { color: "#000" }]}>Anywhere — create a loop</Text>
            <Text style={[s1.loopSub, isLoop && { color: "#000" }]}>Find trails near your start and loop back</Text>
          </View>
          {isLoop && <Feather name="check" size={16} color="#000" />}
        </TouchableOpacity>

        {/* Or search a specific destination */}
        <View style={s1.searchBox}>
          <Feather name="map-pin" size={16} color={state.to ? AMBER : colors.light.mutedForeground} style={{ marginLeft: 14 }} />
          <TextInput
            value={toQuery}
            onChangeText={t => { setToQuery(t); if (!t) plannerActions.setTo(null); }}
            onFocus={() => setToFocused(true)}
            onBlur={() => setTimeout(() => setToFocused(false), 200)}
            placeholder="Or search a destination…"
            placeholderTextColor={colors.light.mutedForeground}
            style={s1.searchInput}
            returnKeyType="search"
          />
          {toSearching
            ? <ActivityIndicator size="small" color={AMBER} style={{ marginRight: 12 }} />
            : toQuery
              ? <Pressable onPress={() => { setToQuery(""); plannerActions.setTo(null); setToResults([]); }} style={{ marginRight: 12 }}>
                  <Feather name="x" size={16} color={colors.light.mutedForeground} />
                </Pressable>
              : null
          }
        </View>

        {/* TO search results */}
        {toResults.length > 0 && toFocused && (
          <View style={s1.dropdown}>
            {toResults.map(r => (
              <TouchableOpacity
                key={r.place_id}
                style={s1.dropItem}
                onPress={() => {
                  const addr = shortLabel(r.display_name);
                  plannerActions.setTo({ lat: parseFloat(r.lat), lon: parseFloat(r.lon), address: addr });
                  setToQuery(addr);
                  setToFocused(false);
                  setToResults([]);
                }}
              >
                <Feather name="map-pin" size={14} color={AMBER} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={s1.dropName} numberOfLines={1}>{shortLabel(r.display_name)}</Text>
                  {gpsPos && <Text style={s1.dropDist}>{formatDistKm(distKm(gpsPos.lat, gpsPos.lon, parseFloat(r.lat), parseFloat(r.lon)))}</Text>}
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Q2: What kind of ride? */}
        <Text style={[s1.qLabel, { marginTop: 28 }]}>WHAT KIND OF RIDE?</Text>

        {!nlMode ? (
          <>
            {RIDE_STYLES.map(rs => (
              <TouchableOpacity
                key={rs.id}
                style={[s1.styleCard, state.rideStyle === rs.id && s1.styleCardActive]}
                onPress={() => handleStylePick(rs.id)}
                activeOpacity={0.85}
              >
                <Text style={s1.styleEmoji}>{rs.emoji}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s1.styleName}>{rs.name}</Text>
                  <Text style={s1.styleDesc}>{rs.desc}</Text>
                  <Text style={s1.styleGrade}>{rs.gradeRange}</Text>
                </View>
                {state.rideStyle === rs.id && (
                  <View style={s1.checkCircle}>
                    <Feather name="check" size={16} color="#000" />
                  </View>
                )}
              </TouchableOpacity>
            ))}

            <TouchableOpacity onPress={() => setNlMode(true)} style={s1.nlLink}>
              <Feather name="message-square" size={14} color={AMBER} />
              <Text style={s1.nlLinkText}>Describe your ideal ride instead →</Text>
            </TouchableOpacity>
          </>
        ) : (
          <View style={s1.nlBox}>
            <TextInput
              value={nlText}
              onChangeText={setNlText}
              placeholder="e.g. half day loop, not too hard, great scenery…"
              placeholderTextColor={colors.light.mutedForeground}
              style={s1.nlInput}
              multiline
              maxLength={200}
              autoFocus
            />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <TouchableOpacity onPress={() => setNlMode(false)} style={s1.nlCancel}>
                <Text style={s1.nlCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void handleNlSubmit()}
                style={[s1.nlSubmit, (!nlText.trim() || !state.from) && { opacity: 0.4 }]}
                disabled={!nlText.trim() || !state.from || nlLoading}
              >
                {nlLoading
                  ? <ActivityIndicator color="#000" />
                  : <Text style={s1.nlSubmitText}>🤖 Interpret & Find</Text>
                }
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Bike type note */}
        <Text style={s1.bikeNote}>Using your {bikeLabel} profile — change in Settings</Text>

        {/* Generate button (only if style already chosen via NL or re-calculate) */}
        {canGo && !nlMode && (
          <TouchableOpacity
            style={s1.generateBtn}
            onPress={() => state.from && state.rideStyle && void doCalculate(state.from, state.rideStyle)}
          >
            <Text style={s1.generateText}>🗺️  FIND MY RIDE</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const RIDE_STYLES: { id: RideStyle; emoji: string; name: string; desc: string; gradeRange: string }[] = [
  { id: "easy",     emoji: "🌅", name: "EASY RIDE",    desc: "Relaxed trails, scenic routes",          gradeRange: "Grade 1-4" },
  { id: "moderate", emoji: "☀️",  name: "GOOD DAY OUT", desc: "Mixed terrain, some challenge",          gradeRange: "Grade 3-6" },
  { id: "challenge",emoji: "⚡", name: "CHALLENGE ME",  desc: "Technical trails, serious riding",       gradeRange: "Grade 5-8" },
];

const s1 = StyleSheet.create({
  safe:          { flex: 1, backgroundColor: BG },
  scroll:        { padding: 20, paddingBottom: 100 },
  header:        { fontSize: 28, fontWeight: "900", color: "#fff", letterSpacing: -1 },
  headerAccent:  { width: 48, height: 3, backgroundColor: AMBER, borderRadius: 2, marginTop: 6, marginBottom: 28 },
  qLabel:        { color: colors.light.mutedForeground, fontSize: 11, fontWeight: "800", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 },

  locPill: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: CARD, borderRadius: 14, borderWidth: 1.5,
    borderColor: AMBER + "66", minHeight: 58, paddingHorizontal: 16,
  },
  locText:    { flex: 1, color: "#fff", fontSize: 16, fontWeight: "600" },
  locHint:    { color: colors.light.mutedForeground, fontSize: 14 },
  gpsFallBtn: { flex: 1 },
  gpsFallText:{ color: AMBER, fontSize: 15, fontWeight: "700" },
  openSettingsBtn: { backgroundColor: AMBER, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  openSettingsText: { color: "#000", fontSize: 12, fontWeight: "800" },

  loopPill: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: CARD, borderRadius: 14, borderWidth: 1.5,
    borderColor: colors.light.border, padding: 14, marginBottom: 10,
  },
  loopPillActive: { backgroundColor: AMBER, borderColor: AMBER },
  loopIcon: { fontSize: 22 },
  loopText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  loopSub:  { color: colors.light.mutedForeground, fontSize: 12, marginTop: 1 },

  searchBox: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: CARD, borderRadius: 14, borderWidth: 1.5,
    borderColor: AMBER, height: 58,
  },
  searchInput: { flex: 1, color: "#fff", fontSize: 15, paddingHorizontal: 10 },
  dropdown: {
    backgroundColor: CARD, borderRadius: 12, borderWidth: 1,
    borderColor: colors.light.border, marginTop: 4, overflow: "hidden",
  },
  dropItem: { flexDirection: "row", alignItems: "center", padding: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.light.border },
  dropName: { color: "#fff", fontSize: 14, fontWeight: "600" },
  dropDist: { color: AMBER, fontSize: 11, marginTop: 1 },

  styleCard: {
    flexDirection: "row", alignItems: "center", gap: 16,
    backgroundColor: CARD, borderRadius: 16, borderWidth: 2,
    borderColor: colors.light.border, minHeight: 100, padding: 18,
    marginBottom: 12,
  },
  styleCardActive: { borderColor: AMBER, backgroundColor: AMBER + "18" },
  styleEmoji: { fontSize: 36 },
  styleName:  { color: "#fff", fontSize: 20, fontWeight: "800", letterSpacing: -0.5 },
  styleDesc:  { color: colors.light.mutedForeground, fontSize: 13, marginTop: 2 },
  styleGrade: { color: AMBER, fontSize: 13, fontWeight: "700", marginTop: 4 },
  checkCircle:{ width: 28, height: 28, borderRadius: 14, backgroundColor: AMBER, alignItems: "center", justifyContent: "center" },

  nlLink:      { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4, marginBottom: 8 },
  nlLinkText:  { color: AMBER, fontSize: 13, fontWeight: "600" },
  nlBox:       { backgroundColor: CARD, borderRadius: 14, padding: 16, gap: 12, marginBottom: 12 },
  nlInput:     { color: "#fff", fontSize: 15, minHeight: 80, textAlignVertical: "top" },
  nlCancel:    { flex: 1, height: 52, borderRadius: 10, borderWidth: 1, borderColor: colors.light.border, alignItems: "center", justifyContent: "center" },
  nlCancelText:{ color: colors.light.mutedForeground, fontSize: 15 },
  nlSubmit:    { flex: 2, height: 52, borderRadius: 10, backgroundColor: AMBER, alignItems: "center", justifyContent: "center" },
  nlSubmitText:{ color: "#000", fontSize: 15, fontWeight: "800" },

  bikeNote:    { color: colors.light.mutedForeground, fontSize: 12, textAlign: "center", marginTop: 8, marginBottom: 20 },
  generateBtn: { backgroundColor: AMBER, borderRadius: 16, height: 72, alignItems: "center", justifyContent: "center", marginTop: 8 },
  generateText:{ color: "#000", fontSize: 18, fontWeight: "900", letterSpacing: 0.5 },
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 + STEP 3 — Route result + section editor
// ─────────────────────────────────────────────────────────────────────────────

function Step2RouteResult({ showSectionEditor = false }: { showSectionEditor?: boolean }) {
  const state = usePlannerStore();
  const mapRef = useRef<MapView>(null);
  const sheetAnim = useRef(new Animated.Value(0)).current;
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [showQuality, setShowQuality] = useState(false);

  // Visible trails = suggestions minus skipped
  const skippedSet = useMemo(() => new Set(state.skippedIds), [state.skippedIds]);
  const visibleTrails = useMemo(
    () => state.trailDetails.filter(t => !skippedSet.has(t.id)),
    [state.trailDetails, skippedSet],
  );
  const skippedTrails = useMemo(
    () => state.trailDetails.filter(t => skippedSet.has(t.id)),
    [state.trailDetails, skippedSet],
  );

  // Selected section
  const selectedTrail = useMemo(
    () => state.trailDetails.find(t => t.id === state.selectedSectionId) ?? null,
    [state.trailDetails, state.selectedSectionId],
  );

  // Bottom sheet animation
  useEffect(() => {
    Animated.spring(sheetAnim, {
      toValue: 1,
      useNativeDriver: true,
      tension: 60,
      friction: 10,
    }).start();
  }, []);

  // Route stats
  const { totalKm, minGrade, maxGrade, avgStars } = useMemo(() => {
    let km = 0, mn = 10, mx = 0, starSum = 0, starCount = 0;
    for (const t of visibleTrails) {
      km += t.distance_km ?? 0;
      const g = parseInt(String(t.difficulty ?? "5"), 10);
      if (!isNaN(g)) { mn = Math.min(mn, g); mx = Math.max(mx, g); }
      const avg = (t as unknown as { avg_stars?: number }).avg_stars;
      if (avg) { starSum += avg; starCount++; }
    }
    return {
      totalKm: km,
      minGrade: mn === 10 ? 5 : mn,
      maxGrade: mx,
      avgStars: starCount > 0 ? Math.round(starSum / starCount * 10) / 10 : null,
    };
  }, [visibleTrails]);

  const estimatedMin = Math.round((totalKm / 20) * 60);

  // Initial map region
  const region = useMemo(() => {
    if (!state.from) return undefined;
    return {
      latitude: state.from.lat,
      longitude: state.from.lon,
      latitudeDelta: 0.5,
      longitudeDelta: 0.5,
    };
  }, [state.from]);

  async function handleAdjust(mode: "more_trails" | "less_trails" | "harder" | "easier") {
    if (!state.from) return;
    setAdjusting(mode);
    plannerActions.setAdjustmentMode(mode);

    const base = styleToParams(state.rideStyle ?? "moderate");
    const corridorKm = mode === "more_trails" ? base.corridorKm * 1.4
      : mode === "less_trails" ? base.corridorKm * 0.6
      : base.corridorKm;

    try {
      const res = await getPlannerSuggestions({
        fromLat: state.from.lat, fromLon: state.from.lon,
        toLat: state.from.lat,   toLon: state.from.lon,
        corridorKm,
      });
      const filteredSuggestions = res.suggestions.filter(s => {
        const g = parseInt(String(s.difficulty ?? "5"), 10);
        if (mode === "harder")  return g >= (base.maxGrade - 2);
        if (mode === "easier")  return g <= (base.maxGrade - 1);
        return true;
      });
      const ids = filteredSuggestions.map(s => s.trailId).join(",");
      const details = ids ? await searchTrailsByBbox({ ids, limit: 50 }) : { trails: [] };
      plannerActions.setSuggestions(filteredSuggestions, details.trails);
    } catch (e) {
      Alert.alert("Adjust failed", e instanceof Error ? e.message : "Try again");
    } finally {
      setAdjusting(null);
      plannerActions.setAdjustmentMode(null);
    }
  }

  if (state.isCalculating) {
    return (
      <View style={{ flex: 1, backgroundColor: BG, alignItems: "center", justifyContent: "center", gap: 20 }}>
        <ActivityIndicator size="large" color={AMBER} />
        <Text style={{ color: "#fff", fontSize: 20, fontWeight: "700" }}>Finding your perfect ride…</Text>
        <Text style={{ color: colors.light.mutedForeground, fontSize: 14 }}>Searching {styleToParams(state.rideStyle ?? "moderate").corridorKm}km around your location</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: BG }}>
      {/* Back */}
      <TouchableOpacity
        style={s2.backBtn}
        onPress={() => { plannerActions.selectSection(null); plannerActions.setStep(1); }}
      >
        <Feather name="arrow-left" size={22} color="#fff" />
      </TouchableOpacity>

      {/* Map */}
      <MapView
        ref={mapRef}
        style={{ flex: 1 }}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        initialRegion={region}
        showsUserLocation
        showsCompass={false}
      >
        {/* Visible trail polylines */}
        {visibleTrails.map(t => {
          const pts = polylineFromPath(t.path);
          if (!pts.length) return null;
          const grade = parseInt(String(t.difficulty ?? "5"), 10);
          const isRoad = t.terrain === "road";
          const isSelected = t.id === state.selectedSectionId;
          return (
            <Polyline
              key={t.id}
              coordinates={pts}
              strokeColor={isSelected ? AMBER : (isRoad ? "#888" : gradeColour(grade))}
              strokeWidth={isSelected ? 8 : (isRoad ? 2 : 6)}
              lineDashPattern={isRoad ? [8, 6] : undefined}
              tappable
              onPress={() => {
                plannerActions.selectSection(t.id);
                plannerActions.setStep(3);
              }}
            />
          );
        })}
        {/* Skipped (grey dashed) */}
        {skippedTrails.map(t => {
          const pts = polylineFromPath(t.path);
          if (!pts.length) return null;
          return (
            <Polyline
              key={t.id + "-skipped"}
              coordinates={pts}
              strokeColor="#555"
              strokeWidth={3}
              lineDashPattern={[4, 8]}
              tappable
              onPress={() => { plannerActions.selectSection(t.id); plannerActions.setStep(3); }}
            />
          );
        })}
        {/* Start pin */}
        {state.from && (
          <Marker coordinate={{ latitude: state.from.lat, longitude: state.from.lon }} pinColor={colors.light.success} />
        )}
      </MapView>

      {/* Section editor sheet */}
      {(state.step === 3 && selectedTrail) && (
        <SectionEditorSheet
          trail={selectedTrail}
          isSkipped={skippedSet.has(selectedTrail.id)}
          onClose={() => { plannerActions.selectSection(null); plannerActions.setStep(2); }}
        />
      )}

      {/* Summary + controls */}
      {state.step === 2 && (
        <Animated.View
          style={[s2.summarySheet, {
            transform: [{ translateY: sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [200, 0] }) }],
          }]}
        >
          {/* Summary bar */}
          <View style={s2.summaryBar}>
            <SumStat value={`${totalKm.toFixed(1)}km`} label="Distance" />
            <View style={s2.divider} />
            <SumStat value={estimatedMin >= 60 ? `${Math.floor(estimatedMin/60)}h${estimatedMin%60}m` : `${estimatedMin}m`} label="Time" />
            <View style={s2.divider} />
            <SumStat value={`${minGrade}-${maxGrade}`} label="Grades" />
            <View style={s2.divider} />
            <SumStat value={avgStars ? `★${avgStars}` : "—"} label="Rating" amber />
          </View>

          {/* Adjustment toolbar */}
          <View style={s2.adjRow}>
            {ADJUSTMENTS.map(a => (
              <TouchableOpacity
                key={a.mode}
                style={s2.adjBtn}
                onPress={() => void handleAdjust(a.mode)}
                disabled={adjusting !== null}
              >
                {adjusting === a.mode
                  ? <ActivityIndicator size="small" color={AMBER} />
                  : <Text style={s2.adjIcon}>{a.icon}</Text>
                }
                <Text style={s2.adjLabel}>{a.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Edit link */}
          <View style={s2.bottomLinks}>
            <TouchableOpacity onPress={() => { plannerActions.selectSection(null); plannerActions.setStep(3); }}>
              <Text style={s2.link}>Edit sections →</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => plannerActions.setStep(4)} style={s2.goBtn}>
              <Text style={s2.goBtnText}>SAVE & GO ›</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

function SumStat({ value, label, amber }: { value: string; label: string; amber?: boolean }) {
  return (
    <View style={{ alignItems: "center", flex: 1 }}>
      <Text style={{ color: amber ? AMBER : "#fff", fontSize: 20, fontWeight: "800" }}>{value}</Text>
      <Text style={{ color: colors.light.mutedForeground, fontSize: 11 }}>{label}</Text>
    </View>
  );
}

function SectionEditorSheet({
  trail, isSkipped, onClose,
}: { trail: MapTrail; isSkipped: boolean; onClose: () => void }) {
  const grade = parseInt(String(trail.difficulty ?? "5"), 10);
  const avgStars = (trail as unknown as { avg_stars?: number }).avg_stars;
  const slideAnim = useRef(new Animated.Value(300)).current;

  useEffect(() => {
    Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 60, friction: 10 }).start();
  }, []);

  return (
    <Animated.View style={[s2.sectionSheet, { transform: [{ translateY: slideAnim }] }]}>
      {/* Handle */}
      <View style={{ width: 40, height: 4, backgroundColor: AMBER, borderRadius: 2, alignSelf: "center", marginBottom: 16 }} />

      {/* Trail info */}
      <Text style={s2.sectionName}>{trail.name}</Text>
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 20 }}>
        <View style={[s2.gradePill, { backgroundColor: gradeColour(grade) }]}>
          <Text style={{ color: "#fff", fontWeight: "800", fontSize: 13 }}>Grade {isNaN(grade) ? "?" : grade}</Text>
        </View>
        {trail.distance_km && (
          <View style={s2.statPill}><Text style={s2.statPillText}>{trail.distance_km.toFixed(1)}km</Text></View>
        )}
        {avgStars && (
          <View style={s2.statPill}><Text style={[s2.statPillText, { color: AMBER }]}>★ {avgStars}</Text></View>
        )}
      </View>

      {/* Actions */}
      {isSkipped ? (
        <TouchableOpacity
          style={[s2.sectionBtn, { backgroundColor: colors.light.success }]}
          onPress={() => { plannerActions.restoreSection(trail.id); onClose(); }}
        >
          <Feather name="plus" size={22} color="#fff" />
          <Text style={s2.sectionBtnText}>ADD BACK TO ROUTE</Text>
        </TouchableOpacity>
      ) : (
        <>
          <TouchableOpacity
            style={[s2.sectionBtn, { backgroundColor: colors.light.success }]}
            onPress={onClose}
          >
            <Feather name="check" size={22} color="#fff" />
            <Text style={s2.sectionBtnText}>KEEP THIS SECTION</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s2.sectionBtn, { backgroundColor: colors.light.destructive, marginTop: 12 }]}
            onPress={() => { plannerActions.skipSection(trail.id); onClose(); }}
          >
            <Feather name="x" size={22} color="#fff" />
            <Text style={s2.sectionBtnText}>SKIP THIS SECTION</Text>
          </TouchableOpacity>
        </>
      )}

      <TouchableOpacity onPress={onClose} style={{ alignSelf: "center", marginTop: 16 }}>
        <Text style={{ color: colors.light.mutedForeground, fontSize: 14 }}>Cancel</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const ADJUSTMENTS = [
  { mode: "more_trails" as const, icon: "🏍️", label: "More trails" },
  { mode: "less_trails" as const, icon: "🛣️",  label: "Less trails" },
  { mode: "harder"      as const, icon: "⬆️",  label: "Harder" },
  { mode: "easier"      as const, icon: "⬇️",  label: "Easier" },
];

function polylineFromPath(path: unknown): Array<{ latitude: number; longitude: number }> {
  if (!Array.isArray(path)) return [];
  const pts: Array<{ latitude: number; longitude: number }> = [];
  for (const p of path) {
    if (Array.isArray(p) && p.length >= 2) {
      const [lon, lat] = p as [unknown, unknown];
      if (typeof lon === "number" && typeof lat === "number") {
        pts.push({ latitude: lat, longitude: lon });
      }
    }
  }
  return pts;
}

const s2 = StyleSheet.create({
  backBtn: {
    position: "absolute", top: 52, left: 16, zIndex: 50,
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: CARD + "E0", alignItems: "center", justifyContent: "center",
  },
  summarySheet: {
    backgroundColor: CARD, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 20, paddingHorizontal: 16, paddingBottom: 28,
    shadowColor: "#000", shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.4, shadowRadius: 12, elevation: 20,
  },
  summaryBar: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 6, marginBottom: 16,
  },
  divider: { width: 1, height: 32, backgroundColor: colors.light.border },
  adjRow:  { flexDirection: "row", gap: 8, marginBottom: 14 },
  adjBtn:  {
    flex: 1, alignItems: "center", justifyContent: "center",
    backgroundColor: colors.light.cardElevated, borderRadius: 12,
    height: 64, gap: 4,
  },
  adjIcon:   { fontSize: 22 },
  adjLabel:  { color: colors.light.mutedForeground, fontSize: 11, fontWeight: "600" },
  bottomLinks: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  link:        { color: AMBER, fontSize: 14, fontWeight: "600" },
  goBtn:       { backgroundColor: AMBER, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12 },
  goBtnText:   { color: "#000", fontWeight: "900", fontSize: 15 },

  sectionSheet: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    backgroundColor: CARD, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 40,
    shadowColor: "#000", shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.5, shadowRadius: 16, elevation: 30,
  },
  sectionName: { color: "#fff", fontSize: 22, fontWeight: "800", marginBottom: 12 },
  gradePill:   { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5 },
  statPill:    { backgroundColor: colors.light.cardElevated, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5 },
  statPillText:{ color: "#fff", fontWeight: "700", fontSize: 13 },
  sectionBtn:  {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    height: 72, borderRadius: 14, gap: 12,
  },
  sectionBtnText: { color: "#fff", fontSize: 18, fontWeight: "900" },
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Save and Go
// ─────────────────────────────────────────────────────────────────────────────

function Step4SaveAndGo() {
  const state = usePlannerStore();
  const [routeName, setRouteName] = useState(() => {
    if (state.savedRouteName) return state.savedRouteName;
    if (state.from) {
      const total = state.trailDetails.reduce((s, t) => s + (t.distance_km ?? 0), 0);
      return `${state.from.address.split(",")[0].trim()} Loop — ${Math.round(total)}km`;
    }
    return "My Route";
  });
  const [privacy, setPrivacy] = useState<"private" | "groups" | "public">("private");
  const [deviceModal, setDeviceModal] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [saving, setSaving] = useState(false);

  const visibleTrails = state.trailDetails.filter(t => !state.skippedIds.includes(t.id));

  async function handleSave() {
    setSaving(true);
    try {
      // Use existing saved route API
      const { useCreateMySavedRoute } = await import("@workspace/api-client-react");
      // Direct API call since we're not in a component that has the hook
      const { apiJson } = await import("@/lib/api");
      await apiJson("/api/me/saved-routes", {
        method: "POST",
        body: JSON.stringify({
          name: routeName,
          trailIds: visibleTrails.map(t => t.id),
          waypoints: state.from
            ? [{ id: "from", lat: state.from.lat, lon: state.from.lon, label: state.from.address }]
            : [],
        }),
      });
      plannerActions.setSavedRouteName(routeName);
      Alert.alert("Saved! ✓", `"${routeName}" saved to your routes.`);
    } catch (e) {
      Alert.alert("Save failed", e instanceof Error ? e.message : "Unknown error");
    } finally { setSaving(false); }
  }

  async function handleExportGpx(device: GpxDevice) {
    setDeviceModal(false);
    setExporting(true);
    try {
      const gpxInput = trailsToGpxInput(routeName, visibleTrails);
      await exportGpxFile(gpxInput, device);
    } catch (e) {
      Alert.alert("Export failed", e instanceof Error ? e.message : "Unknown error");
    } finally { setExporting(false); }
  }

  async function handleOfflineDownload() {
    if (!state.from) return;
    setDownloading(true);
    try {
      const { cacheTiles } = await import("@/lib/offlineStore");
      const { apiJson } = await import("@/lib/api");
      const ids = visibleTrails.map(t => t.id).join(",");
      if (ids) await apiJson(`/api/trails/search?ids=${ids}&limit=50`);
      // Download tile cache around route bbox
      const lats = visibleTrails.flatMap(t => {
        const r = t as unknown as { bbox_min_lat?: number; bbox_max_lat?: number };
        return [r.bbox_min_lat ?? state.from!.lat, r.bbox_max_lat ?? state.from!.lat];
      });
      const lons = visibleTrails.flatMap(t => {
        const r = t as unknown as { bbox_min_lng?: number; bbox_max_lng?: number };
        return [r.bbox_min_lng ?? state.from!.lon, r.bbox_max_lng ?? state.from!.lon];
      });
      const bbox = {
        minLat: Math.min(...lats) - 0.05,
        maxLat: Math.max(...lats) + 0.05,
        minLon: Math.min(...lons) - 0.05,
        maxLon: Math.max(...lons) + 0.05,
      };
      await cacheTiles(bbox, p => {
        const pct = p.total > 0 ? Math.round((p.downloaded / p.total) * 100) : 0;
        setDownloadProgress(pct);
      });
      Alert.alert("Downloaded ✓", "Route ready for offline use.");
    } catch (e) {
      Alert.alert("Download failed", e instanceof Error ? e.message : "Unknown error");
    } finally { setDownloading(false); setDownloadProgress(0); }
  }

  function handleGo() {
    if (!state.from) return;
    setActiveNavRoute({
      trails: visibleTrails.map(t => ({
        id: t.id,
        name: t.name,
        difficulty: String(t.difficulty ?? "5"),
        distance_km: t.distance_km ?? null,
        path: t.path,
      })),
      from: { latitude: state.from.lat, longitude: state.from.lon, label: state.from.address },
      to: state.to
        ? { latitude: state.to.lat, longitude: state.to.lon, label: state.to.address }
        : { latitude: state.from.lat, longitude: state.from.lon, label: state.from.address },
    });
    router.push("/navigate");
  }

  const totalKm = visibleTrails.reduce((s, t) => s + (t.distance_km ?? 0), 0);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: BG }}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 100 }}>
        {/* Back */}
        <TouchableOpacity onPress={() => plannerActions.setStep(2)} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 24 }}>
          <Feather name="arrow-left" size={20} color={AMBER} />
          <Text style={{ color: AMBER, fontSize: 15, fontWeight: "600" }}>Back to route</Text>
        </TouchableOpacity>

        <Text style={{ color: "#fff", fontSize: 26, fontWeight: "900", letterSpacing: -1, marginBottom: 6 }}>SAVE & GO</Text>
        <View style={{ width: 48, height: 3, backgroundColor: AMBER, borderRadius: 2, marginBottom: 28 }} />

        {/* Route name */}
        <Text style={s4.label}>ROUTE NAME</Text>
        <TextInput
          value={routeName}
          onChangeText={v => { setRouteName(v); plannerActions.setSavedRouteName(v); }}
          style={s4.nameInput}
          placeholderTextColor={colors.light.mutedForeground}
        />

        {/* Stats */}
        <View style={s4.statsRow}>
          <View style={s4.statCard}><Text style={s4.statValue}>{totalKm.toFixed(1)}</Text><Text style={s4.statLabel}>km</Text></View>
          <View style={s4.statCard}><Text style={s4.statValue}>{visibleTrails.length}</Text><Text style={s4.statLabel}>sections</Text></View>
          <View style={s4.statCard}><Text style={s4.statValue}>{state.skippedIds.length}</Text><Text style={s4.statLabel}>skipped</Text></View>
        </View>

        {/* Privacy */}
        <Text style={[s4.label, { marginTop: 20 }]}>VISIBILITY</Text>
        <View style={s4.privacyRow}>
          {PRIVACY_OPTS.map(p => (
            <TouchableOpacity
              key={p.id}
              onPress={() => setPrivacy(p.id)}
              style={[s4.privChip, privacy === p.id && s4.privChipActive]}
            >
              <Text style={s4.privIcon}>{p.icon}</Text>
              <Text style={[s4.privLabel, privacy === p.id && { color: "#000" }]}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Action buttons */}
        <TouchableOpacity style={s4.goBtn} onPress={handleGo}>
          <Feather name="navigation" size={22} color="#000" />
          <Text style={s4.goBtnText}>🧭  START NAVIGATING</Text>
        </TouchableOpacity>

        <View style={s4.actionsRow}>
          <ActionCard icon="💾" label="Save" loading={saving} onPress={() => void handleSave()} />
          <ActionCard
            icon="📥"
            label="Offline"
            loading={downloading}
            progress={downloadProgress}
            onPress={() => void handleOfflineDownload()}
          />
          <ActionCard icon="📤" label="Export" loading={exporting} onPress={() => setDeviceModal(true)} />
        </View>

        {/* New route */}
        <TouchableOpacity
          style={{ alignSelf: "center", marginTop: 24 }}
          onPress={() => { plannerActions.reset(); plannerActions.setStep(1); }}
        >
          <Text style={{ color: colors.light.mutedForeground, fontSize: 14 }}>+ Plan a new route</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Device selector modal */}
      <Modal visible={deviceModal} transparent animationType="slide" onRequestClose={() => setDeviceModal(false)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: "#000A" }} onPress={() => setDeviceModal(false)} />
        <View style={s4.deviceSheet}>
          <Text style={s4.deviceTitle}>EXPORT TO DEVICE</Text>
          {GPX_DEVICES.map(d => (
            <TouchableOpacity key={d.id} style={s4.deviceRow} onPress={() => void handleExportGpx(d.id)}>
              <Text style={s4.deviceIcon}>{d.icon}</Text>
              <View>
                <Text style={s4.deviceName}>{d.label}</Text>
                <Text style={s4.deviceDesc}>{d.desc}</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const PRIVACY_OPTS = [
  { id: "private" as const, icon: "🔒", label: "Just me" },
  { id: "groups"  as const, icon: "👥", label: "My groups" },
  { id: "public"  as const, icon: "🌍", label: "Community" },
];

const GPX_DEVICES = [
  { id: "garminEdge"   as GpxDevice, icon: "🟣", label: "Garmin Edge",    desc: "Full elevation + course points" },
  { id: "garminInreach"as GpxDevice, icon: "🛰️",  label: "Garmin inReach", desc: "Simplified, max 500 pts/track" },
  { id: "wahoo"        as GpxDevice, icon: "🔵", label: "Wahoo",          desc: "Named segments, compatible" },
  { id: "generic"      as GpxDevice, icon: "📄", label: "Generic GPX",    desc: "Standard GPX 1.1, all data" },
];

function ActionCard({ icon, label, loading, progress, onPress }: {
  icon: string; label: string; loading?: boolean;
  progress?: number; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={s4.actionCard} onPress={onPress} disabled={loading}>
      {loading
        ? progress != null && progress > 0
          ? <Text style={s4.actionProgress}>{Math.round(progress)}%</Text>
          : <ActivityIndicator color={AMBER} />
        : <Text style={s4.actionIcon}>{icon}</Text>
      }
      <Text style={s4.actionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const s4 = StyleSheet.create({
  label:     { color: colors.light.mutedForeground, fontSize: 11, fontWeight: "800", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 },
  nameInput: { backgroundColor: CARD, borderRadius: 12, borderWidth: 1.5, borderColor: AMBER + "55", color: "#fff", fontSize: 18, fontWeight: "700", padding: 16, marginBottom: 16 },
  statsRow:  { flexDirection: "row", gap: 10 },
  statCard:  { flex: 1, backgroundColor: CARD, borderRadius: 12, padding: 14, alignItems: "center" },
  statValue: { color: AMBER, fontSize: 22, fontWeight: "800" },
  statLabel: { color: colors.light.mutedForeground, fontSize: 11, marginTop: 2 },
  privacyRow:{ flexDirection: "row", gap: 8, marginBottom: 24 },
  privChip:  { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: CARD, borderRadius: 12, borderWidth: 1.5, borderColor: colors.light.border, height: 52 },
  privChipActive: { backgroundColor: AMBER, borderColor: AMBER },
  privIcon:  { fontSize: 16 },
  privLabel: { color: "#fff", fontSize: 13, fontWeight: "700" },
  goBtn:     { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: AMBER, borderRadius: 16, height: 76, marginBottom: 16 },
  goBtnText: { color: "#000", fontSize: 20, fontWeight: "900", letterSpacing: 0.5 },
  actionsRow:{ flexDirection: "row", gap: 10 },
  actionCard:{ flex: 1, backgroundColor: CARD, borderRadius: 12, height: 72, alignItems: "center", justifyContent: "center", gap: 4, borderWidth: 1, borderColor: colors.light.border },
  actionIcon:{ fontSize: 22 },
  actionLabel:{ color: colors.light.mutedForeground, fontSize: 11, fontWeight: "700" },
  actionProgress: { color: AMBER, fontSize: 16, fontWeight: "800" },
  deviceSheet: { backgroundColor: CARD, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  deviceTitle: { color: "#fff", fontSize: 16, fontWeight: "900", letterSpacing: 1, marginBottom: 20 },
  deviceRow:   { flexDirection: "row", alignItems: "center", gap: 16, minHeight: 64, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.light.border },
  deviceIcon:  { fontSize: 28, width: 40 },
  deviceName:  { color: "#fff", fontSize: 16, fontWeight: "700" },
  deviceDesc:  { color: colors.light.mutedForeground, fontSize: 12 },
});
