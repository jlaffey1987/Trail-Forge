/**
 * Linesman Tools — trail maintenance interface.
 *
 * Premium dark #0D0D0D theme with amber #F5A623 accents.
 * Glove-friendly: all touch targets ≥ 60 × 60 px.
 * Maximum 3 taps to complete any action.
 *
 * FLOWS:
 *   edit   — tap trail → edit sheet → save
 *   flag   — tap trail → flag type → note → confirm
 *   add    — method → record/draw → name + grade → save
 *   admin  — grant/revoke linesman access
 */

import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
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
  Easing,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, {
  Marker,
  PROVIDER_DEFAULT,
  PROVIDER_GOOGLE,
  Polyline,
  type Region,
} from "react-native-maps";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import colors, { gradeColour, GRADE_LABEL } from "@/constants/colors";
import {
  fetchLinesmanRecentEdits,
  linesmanAddTrail,
  linesmanFlagTrail,
  linesmanPatchTrail,
  searchTrailsByBbox,
  undoLinesmanEdit,
  type FlagType,
  type LinesmanEdit,
  type MapTrail,
} from "@/lib/api";
import { haversineKm, parseGeoJsonPath } from "@/lib/geo";
import {
  startRecording,
  stopRecording,
  subscribe,
  type RidePoint,
} from "@/lib/recording";
import { useProfile } from "@/components/ProfileContext";

const { width: W, height: H } = Dimensions.get("window");

// ── Design tokens ─────────────────────────────────────────────────────────────
const BG = "#0D0D0D";
const CARD = "#1A1A1A";
const AMBER = "#F5A623";
const RED = "#D50000";
const GREEN = "#00C853";
const TEXT = "#FFFFFF";
const MUTED = "#A0A0A0";
const BORDER = "#2A2A2A";

// ── Flows ─────────────────────────────────────────────────────────────────────
type Flow = "home" | "edit" | "flag" | "add";
type EditStep = "map" | "form" | "success";
type FlagStep = "map" | "type" | "note" | "success";
type AddStep = "method" | "record" | "draw" | "details" | "success";

// ── Flag config ───────────────────────────────────────────────────────────────
const FLAG_TYPES: Array<{
  id: FlagType;
  label: string;
  sub: string;
  icon: keyof typeof Feather.glyphMap;
  color: string;
}> = [
  { id: "closed",       label: "TRAIL CLOSED",   sub: "Trail is impassable",           icon: "slash",            color: RED },
  { id: "legal_issue",  label: "LEGAL ISSUE",    sub: "Access rights changed",          icon: "alert-triangle",   color: "#FF6D00" },
  { id: "flood_damage", label: "FLOOD / DAMAGE", sub: "Weather or physical damage",     icon: "droplet",          color: "#2979FF" },
  { id: "overgrown",    label: "OVERGROWN",      sub: "Vegetation blocking passage",    icon: "wind",             color: GREEN },
  { id: "temp_closure", label: "TEMP CLOSURE",   sub: "Temporary works",                icon: "tool",             color: "#FFD600" },
  { id: "rerouted",     label: "REROUTED",       sub: "Trail route has changed",        icon: "corner-up-right",  color: "#CE93D8" },
];

// ── Animated tick ─────────────────────────────────────────────────────────────
function SuccessTick({ color = GREEN }: { color?: string }) {
  const scale = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, tension: 60, friction: 5 }),
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <Animated.View style={{ transform: [{ scale }], opacity, alignItems: "center" }}>
      <View style={[tickSt.circle, { borderColor: color }]}>
        <Feather name="check" size={56} color={color} />
      </View>
    </Animated.View>
  );
}
const tickSt = StyleSheet.create({
  circle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
  },
});

// ── Pulsing amber dot ─────────────────────────────────────────────────────────
function AmberPulse() {
  const anim = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.3, duration: 700, useNativeDriver: true }),
      ]),
    ).start();
  }, []);
  return (
    <Animated.View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: AMBER, opacity: anim }} />
  );
}

// ── Map selector ──────────────────────────────────────────────────────────────
function MapSelector({
  instruction,
  linesmanGroupId,
  onSelect,
  onCancel,
}: {
  instruction: string;
  linesmanGroupId: string | null;
  onSelect: (trail: MapTrail) => void;
  onCancel: () => void;
}) {
  const mapRef = useRef<MapView | null>(null);
  const [region, setRegion] = useState<Region>({
    latitude: 54.5, longitude: -2.5, latitudeDelta: 2, longitudeDelta: 2,
  });
  const [selected, setSelected] = useState<string | null>(null);

  const bbox = useMemo(() => {
    const { latitude: lat, longitude: lon, latitudeDelta: dLat, longitudeDelta: dLon } = region;
    return `${(lon - dLon / 2).toFixed(4)},${(lat - dLat / 2).toFixed(4)},${(lon + dLon / 2).toFixed(4)},${(lat + dLat / 2).toFixed(4)}`;
  }, [region]);

  const trailsQ = useQuery({
    queryKey: ["lm-trails-bbox", bbox],
    queryFn: () => searchTrailsByBbox({ bbox, limit: 100 }),
    staleTime: 60_000,
  });
  const trails = (trailsQ.data?.trails ?? []).filter(t => t.terrain !== "road");

  useEffect(() => {
    void Location.requestForegroundPermissionsAsync().then(async ({ status }) => {
      if (status !== "granted") return;
      const pos = await Location.getLastKnownPositionAsync().catch(() => null)
        ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
      if (pos) {
        const next: Region = {
          latitude: pos.coords.latitude, longitude: pos.coords.longitude,
          latitudeDelta: 0.12, longitudeDelta: 0.12,
        };
        setRegion(next);
        mapRef.current?.animateToRegion(next, 600);
      }
    });
  }, []);

  return (
    <View style={StyleSheet.absoluteFill}>
      <StatusBar barStyle="light-content" />
      <MapView
        ref={mapRef}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        onRegionChangeComplete={setRegion}
        showsUserLocation
        userInterfaceStyle="dark"
      >
        {trails.map(t => {
          const raw = Array.isArray(t.path) && Array.isArray((t.path as unknown[])[0])
            ? (t.path as [number, number][])
            : [];
          const coords = parseGeoJsonPath(raw);
          if (coords.length < 2) return null;
          const isSelected = selected === t.id;
          return (
            <Polyline
              key={t.id}
              coordinates={coords}
              strokeColor={isSelected ? AMBER : gradeColour(Number(t.difficulty ?? 5))}
              strokeWidth={isSelected ? 8 : 5}
              tappable
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                setSelected(t.id);
                onSelect(t);
              }}
            />
          );
        })}
      </MapView>

      {/* Instruction pill */}
      <SafeAreaView style={mapSelSt.topSafe}>
        <View style={mapSelSt.pill}>
          <AmberPulse />
          <Text style={mapSelSt.pillText}>{instruction}</Text>
        </View>
      </SafeAreaView>

      {/* Cancel */}
      <TouchableOpacity style={mapSelSt.cancelBtn} onPress={onCancel}>
        <Feather name="x" size={22} color={TEXT} />
      </TouchableOpacity>
    </View>
  );
}
const mapSelSt = StyleSheet.create({
  topSafe: { position: "absolute", top: 0, left: 0, right: 0 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: CARD,
    borderColor: AMBER,
    borderWidth: 1.5,
    borderRadius: 999,
    margin: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignSelf: "flex-start",
    maxWidth: W - 80,
  },
  pillText: { color: TEXT, fontSize: 15, fontWeight: "700", letterSpacing: 0.2 },
  cancelBtn: {
    position: "absolute",
    top: 56,
    right: 16,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: CARD,
    borderColor: BORDER,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});

// ── Draw-on-map ────────────────────────────────────────────────────────────────
function DrawMap({
  onComplete,
  onCancel,
}: {
  onComplete: (coords: [number, number][], distKm: number) => void;
  onCancel: () => void;
}) {
  const [pts, setPts] = useState<Array<{ lat: number; lon: number }>>([]);
  const mapRef = useRef<MapView | null>(null);

  const coords = pts.map(p => ({ latitude: p.lat, longitude: p.lon }));
  const distKm = useMemo(() => {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += haversineKm({ lat: pts[i - 1].lat, lon: pts[i - 1].lon }, { lat: pts[i].lat, lon: pts[i].lon });
    return d;
  }, [pts]);

  function handlePress(e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) {
    void Haptics.selectionAsync();
    setPts(prev => [...prev, { lat: e.nativeEvent.coordinate.latitude, lon: e.nativeEvent.coordinate.longitude }]);
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <StatusBar barStyle="light-content" />
      <MapView
        ref={mapRef}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={{ latitude: 54.5, longitude: -2.5, latitudeDelta: 2, longitudeDelta: 2 }}
        showsUserLocation
        userInterfaceStyle="dark"
        onPress={handlePress}
      >
        {coords.length >= 2 && <Polyline coordinates={coords} strokeColor={AMBER} strokeWidth={4} />}
        {pts.map((p, i) => (
          <Marker
            key={i}
            coordinate={{ latitude: p.lat, longitude: p.lon }}
            pinColor={i === 0 ? GREEN : i === pts.length - 1 ? RED : AMBER}
          />
        ))}
      </MapView>

      {/* Header */}
      <SafeAreaView style={drawSt.header}>
        <View style={drawSt.hud}>
          <Text style={drawSt.hudText}>
            {pts.length === 0
              ? "Tap to place route points"
              : `${pts.length} pts · ${distKm.toFixed(1)} km`}
          </Text>
        </View>
      </SafeAreaView>

      {/* Bottom controls */}
      <View style={drawSt.controls}>
        <TouchableOpacity style={drawSt.ctrlBtn} onPress={onCancel}>
          <Feather name="x" size={20} color={TEXT} />
          <Text style={drawSt.ctrlLabel}>Cancel</Text>
        </TouchableOpacity>
        {pts.length > 0 && (
          <TouchableOpacity style={drawSt.ctrlBtn} onPress={() => setPts(p => p.slice(0, -1))}>
            <Feather name="corner-up-left" size={20} color={TEXT} />
            <Text style={drawSt.ctrlLabel}>Undo</Text>
          </TouchableOpacity>
        )}
        {pts.length >= 2 && (
          <TouchableOpacity
            style={[drawSt.ctrlBtn, { backgroundColor: AMBER, borderColor: AMBER }]}
            onPress={() => {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              onComplete(pts.map(p => [p.lon, p.lat] as [number, number]), distKm);
            }}
          >
            <Feather name="check" size={20} color="#000" />
            <Text style={[drawSt.ctrlLabel, { color: "#000" }]}>Use Route</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}
const drawSt = StyleSheet.create({
  header: { position: "absolute", top: 0, left: 0, right: 0 },
  hud: {
    margin: 16,
    backgroundColor: CARD,
    borderColor: AMBER,
    borderWidth: 1.5,
    borderRadius: 12,
    padding: 14,
    alignSelf: "flex-start",
  },
  hudText: { color: TEXT, fontSize: 15, fontWeight: "700" },
  controls: {
    position: "absolute",
    bottom: 40,
    left: 16,
    right: 16,
    flexDirection: "row",
    gap: 10,
    justifyContent: "flex-end",
  },
  ctrlBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: CARD,
    borderColor: BORDER,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  ctrlLabel: { fontSize: 14, fontWeight: "700", color: TEXT },
});

// ── Recent edit row ────────────────────────────────────────────────────────────
const EDIT_LABEL: Record<string, string> = {
  update_metadata: "Edited",
  replace_gpx:     "Route replaced",
  flag:            "Flagged",
  unflag:          "Unflagged",
  delete:          "Deleted",
  restore:         "Restored",
  add:             "Added",
};

function RecentRow({ edit, onUndo }: { edit: LinesmanEdit; onUndo: (id: string) => void }) {
  const age = Date.now() - new Date(edit.created_at).getTime();
  const min = Math.floor(age / 60000);
  const time = min < 1 ? "just now" : min < 60 ? `${min}m ago` : `${Math.floor(min / 60)}h ago`;
  return (
    <View style={recentSt.row}>
      <View style={recentSt.dot} />
      <View style={recentSt.info}>
        <Text style={recentSt.type}>{EDIT_LABEL[edit.edit_type] ?? edit.edit_type}</Text>
        <Text style={recentSt.name} numberOfLines={1}>{edit.trail_name ?? "Trail"}</Text>
      </View>
      <Text style={recentSt.time}>{time}</Text>
      {edit.can_undo && (
        <TouchableOpacity style={recentSt.undoBtn} onPress={() => onUndo(edit.id)}>
          <Feather name="corner-up-left" size={14} color={AMBER} />
          <Text style={recentSt.undoText}>UNDO</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
const recentSt = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: AMBER },
  info: { flex: 1, gap: 2 },
  type: { fontSize: 11, fontWeight: "800", color: AMBER, textTransform: "uppercase", letterSpacing: 1 },
  name: { fontSize: 14, color: TEXT, fontWeight: "600" },
  time: { fontSize: 12, color: MUTED },
  undoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderColor: AMBER,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  undoText: { fontSize: 11, fontWeight: "800", color: AMBER, letterSpacing: 0.5 },
});

// ═════════════════════════════════════════════════════════════════════════════
// MAIN SCREEN
// ═════════════════════════════════════════════════════════════════════════════
export default function LinesmanScreen() {
  const { profile } = useProfile();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!profile.isLinesman) router.replace("/(tabs)/map" as never);
  }, [profile.isLinesman]);

  const [flow, setFlow] = useState<Flow>("home");
  const sheetAnim = useRef(new Animated.Value(0)).current;

  // ── Edit state
  const [editStep, setEditStep] = useState<EditStep>("map");
  const [editTrail, setEditTrail] = useState<MapTrail | null>(null);
  const [editName, setEditName] = useState("");
  const [editDiff, setEditDiff] = useState(5);
  const [editNotes, setEditNotes] = useState("");

  // ── Flag state
  const [flagStep, setFlagStep] = useState<FlagStep>("map");
  const [flagTrail, setFlagTrail] = useState<MapTrail | null>(null);
  const [flagType, setFlagType] = useState<FlagType | null>(null);
  const [flagNote, setFlagNote] = useState("");

  // ── Add state
  const [addStep, setAddStep] = useState<AddStep>("method");
  const [addCoords, setAddCoords] = useState<[number, number][]>([]);
  const [addDistKm, setAddDistKm] = useState(0);
  const [addName, setAddName] = useState("");
  const [addDiff, setAddDiff] = useState(4);
  const [addRecording, setAddRecording] = useState(false);
  const [addPoints, setAddPoints] = useState<RidePoint[]>([]);

  // Animate sheet on form show
  function showSheet() {
    Animated.spring(sheetAnim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 11 }).start();
  }

  function hideSheet(cb: () => void) {
    Animated.timing(sheetAnim, { toValue: 0, duration: 220, easing: Easing.in(Easing.ease), useNativeDriver: true }).start(cb);
  }

  // Recent edits
  const editsQ = useQuery({
    queryKey: ["lm-recent"],
    queryFn: fetchLinesmanRecentEdits,
    staleTime: 30_000,
    enabled: flow === "home",
  });

  // ── Mutations
  const patchMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof linesmanPatchTrail>[1] }) =>
      linesmanPatchTrail(id, body),
    onSuccess: () => {
      setEditStep("success");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void qc.invalidateQueries({ queryKey: ["lm-recent"] });
    },
    onError: () => Alert.alert("Error", "Failed to save. Please try again."),
  });

  const flagMut = useMutation({
    mutationFn: ({ id, type, note }: { id: string; type: FlagType; note: string }) =>
      linesmanFlagTrail(id, type, note || undefined),
    onSuccess: () => {
      setFlagStep("success");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      void qc.invalidateQueries({ queryKey: ["lm-recent"] });
    },
    onError: () => Alert.alert("Error", "Failed to flag."),
  });

  const addMut = useMutation({
    mutationFn: (body: Parameters<typeof linesmanAddTrail>[0]) => linesmanAddTrail(body),
    onSuccess: () => {
      setAddStep("success");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void qc.invalidateQueries({ queryKey: ["lm-recent"] });
    },
    onError: () => Alert.alert("Error", "Failed to add trail."),
  });

  const undoMut = useMutation({
    mutationFn: undoLinesmanEdit,
    onSuccess: () => {
      Alert.alert("Undone", "The edit has been reversed.");
      void qc.invalidateQueries({ queryKey: ["lm-recent"] });
    },
    onError: (e) => Alert.alert("Cannot undo", e instanceof Error ? e.message : "Undo failed"),
  });

  // Auto-dismiss success after 2.5 s
  useEffect(() => {
    if (editStep === "success" || flagStep === "success" || addStep === "success") {
      const t = setTimeout(() => reset(), 2500);
      return () => clearTimeout(t);
    }
  }, [editStep, flagStep, addStep]);

  function reset() {
    setFlow("home");
    setEditStep("map"); setEditTrail(null);
    setFlagStep("map"); setFlagTrail(null); setFlagType(null); setFlagNote("");
    setAddStep("method"); setAddCoords([]); setAddName(""); setAddDistKm(0);
    setAddPoints([]); setAddRecording(false);
    sheetAnim.setValue(0);
  }

  // ── Recording helpers
  async function startAdd() {
    await startRecording();
    setAddRecording(true);
    subscribe((points) => setAddPoints(points));
  }
  async function stopAdd() {
    const result = await stopRecording();
    setAddRecording(false);
    if (result && result.points.length >= 2) {
      const c: [number, number][] = result.points.map(p => [p.lon, p.lat]);
      let d = 0;
      for (let i = 1; i < result.points.length; i++)
        d += haversineKm({ lat: result.points[i - 1].lat, lon: result.points[i - 1].lon }, { lat: result.points[i].lat, lon: result.points[i].lon });
      setAddCoords(c); setAddDistKm(d); setAddStep("details");
    }
  }

  // ═══════════════════════════════════
  // HOME SCREEN
  // ═══════════════════════════════════
  if (flow === "home") {
    const CARDS = [
      { icon: "✏️", label: "EDIT TRAIL", sub: "Update name, difficulty & condition", color: "#2979FF",
        onPress: () => { setFlow("edit"); setEditStep("map"); } },
      { icon: "🚩", label: "FLAG PROBLEM", sub: "Close, legal issue, damage", color: RED,
        onPress: () => { setFlow("flag"); setFlagStep("map"); } },
      { icon: "🔄", label: "REPLACE ROUTE", sub: "Upload new GPX or draw on map", color: "#FF6D00",
        onPress: () => Alert.alert("Replace Route", "Upload a GPX file from the desktop tools or record a new ride to replace this trail's route.") },
      { icon: "➕", label: "ADD TRAIL", sub: "Record, upload or draw a trail", color: GREEN,
        onPress: () => { setFlow("add"); setAddStep("method"); } },
    ];

    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        <StatusBar barStyle="light-content" backgroundColor={BG} />
        {/* Header */}
        <View style={s.homeHeader}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityLabel="Go back">
            <Feather name="arrow-left" size={22} color={TEXT} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={s.homeTitle}>LINESMAN TOOLS</Text>
            <View style={s.amberLine} />
            {profile.linesmanGroupId && (
              <Text style={s.homeSub}>Trail group assigned</Text>
            )}
          </View>
          <Feather name="shield" size={28} color={AMBER} />
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
          {/* 2×2 grid */}
          <View style={s.grid}>
            {CARDS.map(c => (
              <TouchableOpacity
                key={c.label}
                style={[s.card, { borderLeftColor: c.color }]}
                activeOpacity={0.75}
                onPress={() => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); c.onPress(); }}
              >
                <Text style={s.cardEmoji}>{c.icon}</Text>
                <Text style={[s.cardLabel, { color: c.color }]}>{c.label}</Text>
                <Text style={s.cardSub}>{c.sub}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Recent edits */}
          <View style={s.recentHead}>
            <View style={s.amberDot} />
            <Text style={s.recentTitle}>RECENT EDITS</Text>
            {editsQ.isFetching && <ActivityIndicator size="small" color={AMBER} style={{ marginLeft: 8 }} />}
          </View>
          <View style={s.recentCard}>
            {(editsQ.data ?? []).length === 0 && !editsQ.isFetching ? (
              <Text style={s.empty}>No recent edits yet</Text>
            ) : (
              (editsQ.data ?? []).map(e => (
                <RecentRow key={e.id} edit={e} onUndo={id => undoMut.mutate(id)} />
              ))
            )}
          </View>
        </ScrollView>
      </View>
    );
  }

  // ═══════════════════════════════════
  // EDIT FLOW
  // ═══════════════════════════════════
  if (flow === "edit") {
    if (editStep === "map") {
      return (
        <MapSelector
          instruction="TAP THE TRAIL TO EDIT"
          linesmanGroupId={profile.linesmanGroupId}
          onSelect={trail => {
            setEditTrail(trail);
            setEditName(trail.name);
            setEditDiff(Number(trail.difficulty ?? 5));
            setEditStep("form");
            showSheet();
          }}
          onCancel={reset}
        />
      );
    }

    if (editStep === "form" && editTrail) {
      const sheetTranslate = sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [H, 0] });
      return (
        <View style={StyleSheet.absoluteFill}>
          <StatusBar barStyle="light-content" />
          <Animated.View style={[s.sheet, { transform: [{ translateY: sheetTranslate }], paddingBottom: insets.bottom + 16 }]}>
            {/* Drag handle */}
            <View style={s.handle} />
            <View style={s.sheetHeader}>
              <View style={{ flex: 1 }}>
                <Text style={s.sheetTitle}>EDIT TRAIL</Text>
                <Text style={s.sheetSub} numberOfLines={1}>{editTrail.name}</Text>
              </View>
              <TouchableOpacity onPress={() => hideSheet(reset)} style={s.closeBtn}>
                <Feather name="x" size={20} color={MUTED} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Name */}
              <Text style={s.fieldLabel}>TRAIL NAME</Text>
              <TextInput
                style={s.input}
                value={editName}
                onChangeText={setEditName}
                placeholderTextColor={MUTED}
                selectionColor={AMBER}
              />

              {/* Difficulty */}
              <Text style={s.fieldLabel}>DIFFICULTY</Text>
              <View style={[s.gradeDisplay, { borderColor: gradeColour(editDiff) }]}>
                <Text style={[s.gradeNum, { color: gradeColour(editDiff) }]}>{editDiff}</Text>
                <Text style={[s.gradeWord, { color: gradeColour(editDiff) }]}>{GRADE_LABEL[editDiff]}</Text>
              </View>
              <View style={s.gradeRow}>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(g => (
                  <TouchableOpacity
                    key={g}
                    style={[s.gradeBtn, editDiff === g && { backgroundColor: gradeColour(g), borderColor: gradeColour(g) }]}
                    onPress={() => { void Haptics.selectionAsync(); setEditDiff(g); }}
                  >
                    <Text style={[s.gradeBtnText, editDiff === g && { color: "#000" }]}>{g}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Notes */}
              <Text style={s.fieldLabel}>NOTES (OPTIONAL)</Text>
              <TextInput
                style={[s.input, { height: 80, textAlignVertical: "top" }]}
                value={editNotes}
                onChangeText={setEditNotes}
                placeholder="Reason for edit…"
                placeholderTextColor={MUTED}
                multiline
                selectionColor={AMBER}
              />

              <TouchableOpacity
                style={[s.bigBtn, s.greenBtn, patchMut.isPending && s.disabledBtn]}
                disabled={patchMut.isPending}
                onPress={() => patchMut.mutate({ id: editTrail.id, body: { name: editName, difficulty: editDiff, notes: editNotes || undefined } })}
              >
                {patchMut.isPending ? <ActivityIndicator color="#000" /> : (
                  <Text style={[s.bigBtnText, { color: "#000" }]}>SAVE CHANGES</Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          </Animated.View>
        </View>
      );
    }

    if (editStep === "success") {
      return (
        <View style={[s.root, s.center]}>
          <StatusBar barStyle="light-content" />
          <SuccessTick color={GREEN} />
          <Text style={s.successTitle}>Trail updated!</Text>
          <Text style={s.successSub}>Changes are live for all riders</Text>
        </View>
      );
    }
  }

  // ═══════════════════════════════════
  // FLAG FLOW
  // ═══════════════════════════════════
  if (flow === "flag") {
    if (flagStep === "map") {
      return (
        <MapSelector
          instruction="TAP THE TRAIL WITH THE PROBLEM"
          linesmanGroupId={profile.linesmanGroupId}
          onSelect={trail => { setFlagTrail(trail); setFlagStep("type"); }}
          onCancel={reset}
        />
      );
    }

    if (flagStep === "type" && flagTrail) {
      return (
        <View style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom + 16 }]}>
          <StatusBar barStyle="light-content" />
          <View style={s.sheetHeader}>
            <TouchableOpacity onPress={() => setFlagStep("map")} style={s.backBtn}>
              <Feather name="arrow-left" size={22} color={TEXT} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={s.sheetTitle}>WHAT IS THE PROBLEM?</Text>
              <Text style={s.sheetSub} numberOfLines={1}>{flagTrail.name}</Text>
            </View>
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 16, gap: 10, paddingBottom: 16 }}>
            {FLAG_TYPES.map(ft => (
              <TouchableOpacity
                key={ft.id}
                style={[s.flagBtn, { borderColor: ft.color + "55", backgroundColor: ft.color + "0D" }]}
                onPress={() => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); setFlagType(ft.id); setFlagStep("note"); }}
              >
                <View style={[s.flagIcon, { backgroundColor: ft.color + "22" }]}>
                  <Feather name={ft.icon} size={26} color={ft.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[s.flagLabel, { color: ft.color }]}>{ft.label}</Text>
                  <Text style={s.flagSub}>{ft.sub}</Text>
                </View>
                <Feather name="chevron-right" size={18} color={MUTED} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      );
    }

    if (flagStep === "note" && flagTrail && flagType) {
      const ft = FLAG_TYPES.find(f => f.id === flagType)!;
      return (
        <View style={[s.root, { paddingTop: insets.top }]}>
          <StatusBar barStyle="light-content" />
          <View style={s.sheetHeader}>
            <TouchableOpacity onPress={() => setFlagStep("type")} style={s.backBtn}>
              <Feather name="arrow-left" size={22} color={TEXT} />
            </TouchableOpacity>
            <View style={[s.flagTagPill, { backgroundColor: ft.color + "22" }]}>
              <Feather name={ft.icon} size={14} color={ft.color} />
              <Text style={[s.flagTagText, { color: ft.color }]}>{ft.label}</Text>
            </View>
          </View>

          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16, gap: 12 }}>
            <Text style={s.fieldLabel}>ADD A NOTE (OPTIONAL)</Text>
            <TextInput
              style={[s.input, { height: 100, textAlignVertical: "top" }]}
              value={flagNote}
              onChangeText={setFlagNote}
              placeholder="Describe the issue (max 200 chars)…"
              placeholderTextColor={MUTED}
              multiline
              maxLength={200}
              selectionColor={AMBER}
            />

            <TouchableOpacity
              style={[s.bigBtn, { backgroundColor: ft.color, borderColor: ft.color }]}
              disabled={flagMut.isPending}
              onPress={() => flagMut.mutate({ id: flagTrail.id, type: flagType, note: flagNote })}
            >
              {flagMut.isPending ? <ActivityIndicator color="#fff" /> : (
                <Text style={s.bigBtnText}>🚩 FLAG THIS TRAIL</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      );
    }

    if (flagStep === "success") {
      return (
        <View style={[s.root, s.center]}>
          <StatusBar barStyle="light-content" />
          <SuccessTick color={RED} />
          <Text style={s.successTitle}>Trail flagged!</Text>
          <Text style={s.successSub}>Riders will see a warning immediately</Text>
        </View>
      );
    }
  }

  // ═══════════════════════════════════
  // ADD TRAIL FLOW
  // ═══════════════════════════════════
  if (flow === "add") {
    if (addStep === "method") {
      return (
        <View style={[s.root, { paddingTop: insets.top }]}>
          <StatusBar barStyle="light-content" />
          <View style={s.sheetHeader}>
            <TouchableOpacity onPress={reset} style={s.backBtn}>
              <Feather name="arrow-left" size={22} color={TEXT} />
            </TouchableOpacity>
            <Text style={s.sheetTitle}>ADD NEW TRAIL</Text>
          </View>
          <View style={{ padding: 16, gap: 14, flex: 1, justifyContent: "center" }}>
            {[
              { icon: "🔴", label: "RECORD NOW", sub: "Start GPS recording immediately", color: RED, onPress: () => { void startAdd(); setAddStep("record"); } },
              { icon: "✏️", label: "DRAW ON MAP", sub: "Tap to plot the trail route", color: "#2979FF", onPress: () => setAddStep("draw") },
            ].map(m => (
              <TouchableOpacity
                key={m.label}
                style={[s.methodCard, { borderColor: m.color + "55" }]}
                onPress={() => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); m.onPress(); }}
              >
                <Text style={s.methodEmoji}>{m.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[s.methodLabel, { color: m.color }]}>{m.label}</Text>
                  <Text style={s.methodSub}>{m.sub}</Text>
                </View>
                <Feather name="chevron-right" size={20} color={m.color} />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      );
    }

    if (addStep === "record") {
      const recCoords = addPoints.map(p => ({ latitude: p.lat, longitude: p.lon }));
      const recDist = (() => {
        let d = 0;
        for (let i = 1; i < addPoints.length; i++) d += haversineKm({ lat: addPoints[i - 1].lat, lon: addPoints[i - 1].lon }, { lat: addPoints[i].lat, lon: addPoints[i].lon });
        return d;
      })();
      return (
        <View style={StyleSheet.absoluteFill}>
          <StatusBar barStyle="light-content" />
          <MapView
            provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
            style={StyleSheet.absoluteFill}
            showsUserLocation followsUserLocation
            userInterfaceStyle="dark"
            initialRegion={{ latitude: 54.5, longitude: -2.5, latitudeDelta: 2, longitudeDelta: 2 }}
          >
            {recCoords.length >= 2 && <Polyline coordinates={recCoords} strokeColor={AMBER} strokeWidth={5} />}
          </MapView>

          <SafeAreaView style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
            <View style={s.recHud}>
              <View style={[s.recDot, addRecording && { backgroundColor: RED }]} />
              <Text style={s.recDist}>{recDist.toFixed(2)} km</Text>
              <Text style={s.recStatus}>{addRecording ? "RECORDING" : "Stopped"}</Text>
            </View>
          </SafeAreaView>

          {addRecording ? (
            <TouchableOpacity
              style={[s.bigRecordBtn, { backgroundColor: RED }]}
              onPress={() => void stopAdd()}
            >
              <Feather name="square" size={24} color="#fff" />
              <Text style={s.bigBtnText}>STOP & SAVE ROUTE</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[s.bigRecordBtn, { backgroundColor: AMBER }]}
              onPress={() => void startAdd()}
            >
              <Feather name="circle" size={24} color="#000" />
              <Text style={[s.bigBtnText, { color: "#000" }]}>START RECORDING</Text>
            </TouchableOpacity>
          )}
        </View>
      );
    }

    if (addStep === "draw") {
      return (
        <DrawMap
          onComplete={(coords, dist) => { setAddCoords(coords); setAddDistKm(dist); setAddStep("details"); }}
          onCancel={() => setAddStep("method")}
        />
      );
    }

    if (addStep === "details") {
      const DIFFS = [
        { label: "1-3", name: "EASY",     desc: "Gravel & hardpack",         color: GREEN },
        { label: "4-6", name: "MODERATE", desc: "Green lanes & ruts",         color: "#2979FF" },
        { label: "7-9", name: "HARD",     desc: "Rocks & steep terrain",      color: "#FF6D00" },
        { label: "10",  name: "EXTREME",  desc: "Hike-a-bike / expert only",  color: RED },
      ];
      const selDiff = DIFFS.find(d => {
        const [lo, hi] = d.label.includes("-") ? d.label.split("-").map(Number) : [Number(d.label), Number(d.label)];
        return addDiff >= lo && addDiff <= (hi ?? lo);
      });
      return (
        <ScrollView style={s.root} contentContainerStyle={[{ paddingTop: insets.top, paddingBottom: insets.bottom + 24, padding: 16 }]}>
          <StatusBar barStyle="light-content" />
          <View style={s.sheetHeader}>
            <TouchableOpacity onPress={() => setAddStep("method")} style={s.backBtn}>
              <Feather name="arrow-left" size={22} color={TEXT} />
            </TouchableOpacity>
            <Text style={s.sheetTitle}>NAME YOUR TRAIL</Text>
          </View>

          <Text style={s.routeSummary}>{addDistKm.toFixed(1)} km · {addCoords.length} route points</Text>

          <Text style={s.fieldLabel}>TRAIL NAME *</Text>
          <TextInput
            style={s.input}
            value={addName}
            onChangeText={setAddName}
            placeholder="e.g. Kielder Forest East"
            placeholderTextColor={MUTED}
            autoFocus
            selectionColor={AMBER}
          />

          <Text style={s.fieldLabel}>DIFFICULTY</Text>
          <View style={{ gap: 8, marginBottom: 16 }}>
            {DIFFS.map(d => {
              const [lo, hi] = d.label.includes("-") ? d.label.split("-").map(Number) : [Number(d.label), Number(d.label)];
              const sel = addDiff >= lo && addDiff <= (hi ?? lo);
              return (
                <TouchableOpacity
                  key={d.name}
                  style={[s.diffCard, sel && { borderColor: d.color, backgroundColor: d.color + "15" }]}
                  onPress={() => { void Haptics.selectionAsync(); setAddDiff(Math.round((lo + (hi ?? lo)) / 2)); }}
                >
                  <View style={[s.diffDot, { backgroundColor: d.color }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[s.diffLabel, sel && { color: d.color }]}>{d.name}</Text>
                    <Text style={s.diffSub}>{d.desc}</Text>
                  </View>
                  <Text style={[s.diffGrade, { color: d.color }]}>{d.label}</Text>
                  {sel && <Feather name="check-circle" size={20} color={d.color} />}
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            style={[s.bigBtn, { backgroundColor: AMBER, borderColor: AMBER }, (!addName.trim() || addMut.isPending) && s.disabledBtn]}
            disabled={!addName.trim() || addMut.isPending}
            onPress={() => addMut.mutate({
              name: addName.trim(),
              difficulty: addDiff,
              terrain: "trail",
              path_geojson: { type: "LineString", coordinates: addCoords },
              distance_km: addDistKm,
            })}
          >
            {addMut.isPending ? <ActivityIndicator color="#000" /> : (
              <Text style={[s.bigBtnText, { color: "#000" }]}>ADD TRAIL</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      );
    }

    if (addStep === "success") {
      return (
        <View style={[s.root, s.center]}>
          <StatusBar barStyle="light-content" />
          <SuccessTick color={GREEN} />
          <Text style={s.successTitle}>Trail added!</Text>
          <Text style={s.successSub}>"{addName}" is now on the map</Text>
        </View>
      );
    }
  }

  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Styles
// ═════════════════════════════════════════════════════════════════════════════
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  center: { alignItems: "center", justifyContent: "center" },

  homeHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  homeTitle: { fontSize: 22, fontWeight: "900", color: TEXT, letterSpacing: 1.5 },
  amberLine: { height: 3, width: 48, backgroundColor: AMBER, borderRadius: 2, marginTop: 4 },
  homeSub: { fontSize: 12, color: AMBER, marginTop: 4, fontWeight: "600", letterSpacing: 0.5 },
  amberDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: AMBER },

  // Grid
  grid: { flexDirection: "row", flexWrap: "wrap", padding: 12, gap: 12 },
  card: {
    width: (W - 36) / 2,
    minHeight: 160,
    backgroundColor: CARD,
    borderRadius: 16,
    borderLeftWidth: 4,
    borderLeftColor: AMBER,
    borderWidth: 1,
    borderColor: BORDER,
    padding: 18,
    gap: 8,
    justifyContent: "center",
  },
  cardEmoji: { fontSize: 36 },
  cardLabel: { fontSize: 18, fontWeight: "900", color: TEXT, letterSpacing: 0.5 },
  cardSub: { fontSize: 13, color: MUTED, lineHeight: 18 },

  // Recent
  recentHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  recentTitle: { fontSize: 13, fontWeight: "800", color: MUTED, letterSpacing: 1.5, flex: 1 },
  recentCard: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: BORDER },
  empty: { textAlign: "center", color: MUTED, padding: 20, fontSize: 14 },

  // Sheet
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: CARD,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    paddingHorizontal: 16,
    maxHeight: H * 0.92,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 24,
  },
  handle: { alignSelf: "center", width: 48, height: 5, borderRadius: 3, backgroundColor: AMBER, marginBottom: 12 },
  sheetHeader: { flexDirection: "row", alignItems: "center", paddingVertical: 12, gap: 12, paddingHorizontal: 4 },
  sheetTitle: { fontSize: 18, fontWeight: "900", color: TEXT, letterSpacing: 1 },
  sheetSub: { fontSize: 13, color: MUTED, marginTop: 2 },
  closeBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: BG, alignItems: "center", justifyContent: "center" },

  // Form
  fieldLabel: { fontSize: 12, fontWeight: "800", color: AMBER, letterSpacing: 1.5, marginTop: 12, marginBottom: 6 },
  input: {
    backgroundColor: BG,
    borderColor: BORDER,
    borderWidth: 1.5,
    borderRadius: 12,
    padding: 14,
    color: TEXT,
    fontSize: 16,
    fontWeight: "600",
  },

  // Grade picker
  gradeDisplay: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
    borderWidth: 2,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginBottom: 10,
    alignSelf: "flex-start",
  },
  gradeNum: { fontSize: 40, fontWeight: "900", lineHeight: 44 },
  gradeWord: { fontSize: 18, fontWeight: "700" },
  gradeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  gradeBtn: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: "center", justifyContent: "center",
    backgroundColor: BG, borderColor: BORDER, borderWidth: 1.5,
  },
  gradeBtnText: { fontSize: 15, fontWeight: "800", color: TEXT },

  // Big buttons
  bigBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 72,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 8,
  },
  greenBtn: { backgroundColor: GREEN, borderColor: GREEN },
  bigBtnText: { fontSize: 16, fontWeight: "900", color: "#fff", letterSpacing: 1 },
  disabledBtn: { opacity: 0.35 },

  backBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: CARD, borderColor: BORDER, borderWidth: 1, alignItems: "center", justifyContent: "center" },

  // Flag
  flagBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    minHeight: 80,
  },
  flagIcon: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center" },
  flagLabel: { fontSize: 16, fontWeight: "900", letterSpacing: 0.5 },
  flagSub: { fontSize: 13, color: MUTED, marginTop: 2 },
  flagTagPill: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  flagTagText: { fontSize: 13, fontWeight: "800", letterSpacing: 0.5 },

  // Method cards
  methodCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    backgroundColor: CARD,
    borderWidth: 1.5,
    borderRadius: 16,
    padding: 20,
    minHeight: 100,
  },
  methodEmoji: { fontSize: 40 },
  methodLabel: { fontSize: 18, fontWeight: "900", letterSpacing: 0.5 },
  methodSub: { fontSize: 13, color: MUTED, marginTop: 3 },

  // Record
  recHud: {
    margin: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: CARD,
    borderRadius: 12,
    borderColor: AMBER,
    borderWidth: 1.5,
    padding: 14,
    alignSelf: "stretch",
  },
  recDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: MUTED },
  recDist: { fontSize: 22, fontWeight: "900", color: TEXT, flex: 1 },
  recStatus: { fontSize: 13, fontWeight: "700", color: AMBER },
  bigRecordBtn: {
    position: "absolute",
    bottom: 40,
    left: 24,
    right: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    height: 72,
    borderRadius: 16,
  },

  // Details / Add
  routeSummary: { fontSize: 13, color: MUTED, marginBottom: 4, marginTop: 4 },
  diffCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: CARD,
    borderWidth: 1.5,
    borderColor: BORDER,
    borderRadius: 14,
    padding: 16,
    minHeight: 72,
  },
  diffDot: { width: 16, height: 16, borderRadius: 8 },
  diffLabel: { fontSize: 15, fontWeight: "800", color: TEXT },
  diffSub: { fontSize: 12, color: MUTED, marginTop: 2 },
  diffGrade: { fontSize: 16, fontWeight: "900", marginRight: 4 },

  // Success
  successTitle: { fontSize: 28, fontWeight: "900", color: TEXT, marginTop: 20, letterSpacing: 0.5 },
  successSub: { fontSize: 16, color: MUTED, marginTop: 8 },
});
