/**
 * Record-a-ride screen.
 *
 * Phases:
 *  1. Idle        — "Start recording" button + resume banner if a prior
 *                   interrupted ride is found in storage.
 *  2. Live        — HUD (distance/duration/speed/elevation) + live track map.
 *  3. Review      — Trim editor, name, grade, visibility picker, save.
 */
import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, {
  Polyline,
  PROVIDER_DEFAULT,
  PROVIDER_GOOGLE,
  type Region,
} from "react-native-maps";

import colors from "@/constants/colors";
import {
  createTrailFromRide,
  listMyGroups,
  type Group,
} from "@/lib/api";
import { haversineMeters } from "@/lib/geo";
import {
  isRecording,
  rehydrate,
  startRecording,
  stopRecording,
  subscribe,
  type RidePoint,
  type RideStats,
} from "@/lib/recording";

type Visibility = "private" | "public" | "group";

const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: "Personal only",
  public: "Public",
  group: "Private group",
};

// Grade options for the save panel.
const GRADE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export default function RecordScreen() {
  const [points, setPoints] = useState<RidePoint[]>([]);
  const [stats, setStats] = useState<RideStats>({
    distanceMeters: 0,
    durationSeconds: 0,
    elevationGainMeters: 0,
    pointCount: 0,
  });
  const [active, setActive] = useState(isRecording());
  const [hasResumable, setHasResumable] = useState(false);

  // Saved ride buffer (set when the user stops). Drives the trim+save UI.
  const [savedRide, setSavedRide] = useState<{
    points: RidePoint[];
    stats: RideStats;
  } | null>(null);

  const mapRef = useRef<MapView | null>(null);

  // On mount, rehydrate in case there's a ride that survived a process kill.
  useEffect(() => {
    void rehydrate().then(() => {
      // After rehydrate, check if storage has data but we're not "active"
      // (background task collected points while app was dead/backgrounded).
      // The subscribe callback will fire immediately with any buffered points.
    });
  }, []);

  useEffect(() => {
    return subscribe((p, s) => {
      setPoints(p);
      setStats(s);
      // Show resume banner if there are stored points but recording isn't active.
      if (p.length > 0 && !isRecording()) {
        setHasResumable(true);
      }
    });
  }, []);

  // Pan the live map to the latest GPS point.
  useEffect(() => {
    if (!active || points.length === 0) return;
    const last = points[points.length - 1];
    const region: Region = {
      latitude: last.lat,
      longitude: last.lon,
      latitudeDelta: 0.008,
      longitudeDelta: 0.008,
    };
    mapRef.current?.animateToRegion(region, 300);
  }, [active, points]);

  async function onStart() {
    setSavedRide(null);
    setHasResumable(false);
    const r = await startRecording();
    if (!r.ok) {
      Alert.alert(
        "Cannot start",
        r.reason === "fg-denied"
          ? "Location permission was declined. Enable it in Settings."
          : "Recording failed to start.",
      );
      return;
    }
    setActive(true);
  }

  async function onStop() {
    const result = await stopRecording();
    setActive(false);
    setHasResumable(false);
    setSavedRide({ points: result.points, stats: result.stats });
  }

  function onDiscardResumable() {
    Alert.alert(
      "Discard ride?",
      "This will delete the interrupted ride permanently.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            // stopRecording clears storage even if nothing is "active".
            void stopRecording().then(() => {
              setHasResumable(false);
              setPoints([]);
              setStats({ distanceMeters: 0, durationSeconds: 0, elevationGainMeters: 0, pointCount: 0 });
            });
          },
        },
      ],
    );
  }

  function onResumeFromStorage() {
    // Mark as active so the HUD/map show the buffered data; user can then
    // stop whenever they're ready to save.
    setHasResumable(false);
    setActive(true);
    // Re-start a new foreground watcher to continue collecting.
    void startRecording();
  }

  const speedKmh =
    points.length > 0
      ? Math.max(0, (points[points.length - 1].speed ?? 0) * 3.6)
      : 0;

  // Build live polyline from GPS points.
  const liveCoords = useMemo(
    () => points.map((p) => ({ latitude: p.lat, longitude: p.lon })),
    [points],
  );

  // Stable starting region — computed once from the first batch of points
  // (either rehydrated from a previous session or the device default).
  // Intentionally NOT re-computed on every GPS update; the map pans live.
  const [initialRegion] = useState<Region>(() => {
    if (points.length > 0) {
      const last = points[points.length - 1];
      return { latitude: last.lat, longitude: last.lon, latitudeDelta: 0.01, longitudeDelta: 0.01 };
    }
    return { latitude: 51.5, longitude: -0.1, latitudeDelta: 0.1, longitudeDelta: 0.1 };
  });

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 20, paddingBottom: 80, gap: 14 }}
    >
      {/* ── Resume banner ────────────────────────────────────────────── */}
      {hasResumable && !active ? (
        <View style={styles.resumeBanner}>
          <View style={{ flex: 1 }}>
            <Text style={styles.resumeTitle}>Interrupted ride found</Text>
            <Text style={styles.resumeMeta}>
              {stats.pointCount} GPS points · {(stats.distanceMeters / 1000).toFixed(2)} km
            </Text>
          </View>
          <TouchableOpacity onPress={onResumeFromStorage} style={styles.resumeBtn}>
            <Text style={styles.resumeBtnText}>Continue</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onDiscardResumable} style={styles.discardBtn}>
            <Feather name="trash-2" size={16} color={colors.light.destructive} />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* ── Stats HUD ───────────────────────────────────────────────── */}
      <View style={styles.hud}>
        <Stat
          label="Distance"
          value={`${(stats.distanceMeters / 1000).toFixed(2)} km`}
        />
        <Stat label="Duration" value={formatDuration(stats.durationSeconds)} />
        <Stat label="Speed" value={`${speedKmh.toFixed(1)} km/h`} />
        <Stat
          label="Elevation gain"
          value={`${Math.round(stats.elevationGainMeters)} m`}
        />
      </View>

      {/* ── Live map ─────────────────────────────────────────────────── */}
      {(active || (hasResumable && points.length > 0)) ? (
        <View style={styles.mapWrap}>
          <MapView
            ref={mapRef}
            style={{ flex: 1 }}
            provider={
              Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT
            }
            initialRegion={initialRegion}
            showsUserLocation={active}
            followsUserLocation={active}
            scrollEnabled={!active}
          >
            {liveCoords.length >= 2 ? (
              <Polyline
                coordinates={liveCoords}
                strokeColor={colors.light.primary}
                strokeWidth={4}
              />
            ) : null}
          </MapView>
          {active ? (
            <View style={styles.mapLiveDot} pointerEvents="none">
              <View style={styles.liveDotPulse} />
            </View>
          ) : null}
        </View>
      ) : null}

      {/* ── Helper text ──────────────────────────────────────────────── */}
      <Text style={styles.helper}>
        {active
          ? "Recording — the screen can lock; tracking continues in the background."
          : savedRide
            ? "Trim wrong turns, choose a grade and visibility, then save."
            : hasResumable
              ? "You have an interrupted ride. Continue recording or discard it."
              : "Press Start to begin recording your ride."}
      </Text>

      {/* ── Start / Stop button ──────────────────────────────────────── */}
      {!savedRide ? (
        <TouchableOpacity
          style={[
            styles.recordBtn,
            { backgroundColor: active ? colors.light.destructive : colors.light.primary },
          ]}
          onPress={active ? onStop : onStart}
        >
          <Feather
            name={active ? "square" : "play"}
            size={26}
            color={colors.light.primaryForeground}
          />
          <Text style={styles.recordBtnText}>
            {active ? "Stop recording" : "Start recording"}
          </Text>
        </TouchableOpacity>
      ) : null}

      {/* ── Save panel ───────────────────────────────────────────────── */}
      {savedRide && savedRide.points.length >= 2 ? (
        <SaveRidePanel ride={savedRide} onDone={() => setSavedRide(null)} />
      ) : null}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Save ride panel
// ---------------------------------------------------------------------------

function SaveRidePanel({
  ride,
  onDone,
}: {
  ride: { points: RidePoint[]; stats: RideStats };
  onDone: () => void;
}) {
  const total = ride.points.length;
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(total - 1);
  const [name, setName] = useState("");
  const [grade, setGrade] = useState<number | null>(null);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [groupId, setGroupId] = useState<string | null>(null);

  const groupsQ = useQuery({
    queryKey: ["my-groups"],
    queryFn: listMyGroups,
    enabled: visibility === "group",
  });

  const trimmed = useMemo(
    () => ride.points.slice(trimStart, trimEnd + 1),
    [ride.points, trimStart, trimEnd],
  );

  const trimmedDistanceKm = useMemo(() => {
    let m = 0;
    for (let i = 1; i < trimmed.length; i++) {
      m += haversineMeters(trimmed[i - 1], trimmed[i]);
    }
    return m / 1000;
  }, [trimmed]);

  // Trimmed track preview on a mini-map.
  const trimCoords = useMemo(
    () => trimmed.map((p) => ({ latitude: p.lat, longitude: p.lon })),
    [trimmed],
  );

  const trimRegion = useMemo<Region>(() => {
    if (trimCoords.length === 0) {
      return { latitude: 51.5, longitude: -0.1, latitudeDelta: 0.05, longitudeDelta: 0.05 };
    }
    let minLat = trimCoords[0].latitude, maxLat = trimCoords[0].latitude;
    let minLon = trimCoords[0].longitude, maxLon = trimCoords[0].longitude;
    for (const c of trimCoords) {
      if (c.latitude < minLat) minLat = c.latitude;
      if (c.latitude > maxLat) maxLat = c.latitude;
      if (c.longitude < minLon) minLon = c.longitude;
      if (c.longitude > maxLon) maxLon = c.longitude;
    }
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLon + maxLon) / 2,
      latitudeDelta: Math.max(0.005, (maxLat - minLat) * 1.4),
      longitudeDelta: Math.max(0.005, (maxLon - minLon) * 1.4),
    };
  }, [trimCoords]);

  const saveMut = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error("Give your ride a name first.");
      if (visibility === "group" && !groupId) {
        throw new Error("Pick a group to publish to.");
      }
      const path: Array<[number, number]> = trimmed.map((p) => [p.lon, p.lat]);
      const altitudes = trimmed
        .map((p) => p.altitude)
        .filter((a): a is number => typeof a === "number");
      const difficulty = grade != null ? String(grade) : undefined;
      return createTrailFromRide({
        name: name.trim(),
        path,
        altitudes,
        difficulty,
        visibility,
        groupId: visibility === "group" ? groupId ?? undefined : undefined,
      });
    },
    onSuccess: () => {
      Alert.alert("Saved", `Trail "${name.trim()}" published.`);
      onDone();
    },
    onError: (err) =>
      Alert.alert("Save failed", err instanceof Error ? err.message : "Unknown error"),
  });

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Trim &amp; save</Text>

      {/* Mini preview map */}
      {trimCoords.length >= 2 ? (
        <View style={styles.trimMapWrap}>
          <MapView
            style={{ flex: 1 }}
            provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
            initialRegion={trimRegion}
            region={trimRegion}
            scrollEnabled={false}
            zoomEnabled={false}
          >
            <Polyline
              coordinates={trimCoords}
              strokeColor={colors.light.primary}
              strokeWidth={3}
            />
          </MapView>
        </View>
      ) : null}

      <Text style={styles.panelMeta}>
        Keeping samples {trimStart + 1}–{trimEnd + 1} of {total} •{" "}
        {trimmedDistanceKm.toFixed(2)} km
      </Text>

      <Text style={styles.fieldLabel}>Trim start ({trimStart})</Text>
      <DiscreteSlider
        value={trimStart}
        min={0}
        max={Math.max(0, trimEnd - 1)}
        onChange={setTrimStart}
      />
      <Text style={styles.fieldLabel}>Trim end ({trimEnd})</Text>
      <DiscreteSlider
        value={trimEnd}
        min={Math.min(total - 1, trimStart + 1)}
        max={total - 1}
        onChange={setTrimEnd}
      />

      <Text style={styles.fieldLabel}>Trail name</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="e.g. Sunday morning loop"
        placeholderTextColor={colors.light.mutedForeground}
        style={styles.input}
      />

      <Text style={styles.fieldLabel}>Difficulty grade (1-10)</Text>
      <View style={styles.gradeRow}>
        {GRADE_OPTIONS.map((g) => (
          <Pressable
            key={g}
            onPress={() => setGrade(grade === g ? null : g)}
            style={[
              styles.gradeChip,
              grade === g && styles.gradeChipActive,
            ]}
          >
            <Text style={[styles.gradeChipText, grade === g && styles.gradeChipTextActive]}>
              {g}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.gradeMeta}>
        {grade == null ? "No grade selected" :
          grade <= 3 ? "Easy — any adventure bike" :
          grade <= 6 ? "Intermediate — capable adventure bike" :
          grade <= 9 ? "Hard — trail/enduro" :
          "Extreme — hard enduro only"}
      </Text>

      <Text style={styles.fieldLabel}>Visibility</Text>
      <View style={styles.row}>
        {(["private", "public", "group"] as Visibility[]).map((v) => (
          <Pressable
            key={v}
            onPress={() => setVisibility(v)}
            style={[styles.chip, visibility === v && styles.chipActive]}
          >
            <Text style={[styles.chipText, visibility === v && styles.chipTextActive]}>
              {VISIBILITY_LABELS[v]}
            </Text>
          </Pressable>
        ))}
      </View>

      {visibility === "group" ? (
        <View style={{ marginTop: 8 }}>
          {groupsQ.isLoading ? (
            <ActivityIndicator color={colors.light.primary} />
          ) : (
            (groupsQ.data?.groups ?? []).map((g: Group) => (
              <Pressable
                key={g.id}
                onPress={() => setGroupId(g.id)}
                style={[
                  styles.groupOption,
                  groupId === g.id && { borderColor: colors.light.primary },
                ]}
              >
                <Feather
                  name={groupId === g.id ? "check-circle" : "circle"}
                  size={16}
                  color={groupId === g.id ? colors.light.primary : colors.light.mutedForeground}
                />
                <Text style={styles.groupOptionText}>{g.name}</Text>
              </Pressable>
            ))
          )}
          {(groupsQ.data?.groups ?? []).length === 0 && !groupsQ.isLoading ? (
            <Text style={styles.helper}>
              You're not in any groups yet. Create or join one in Discover.
            </Text>
          ) : null}
        </View>
      ) : null}

      <TouchableOpacity
        onPress={() => saveMut.mutate()}
        disabled={saveMut.isPending || !name.trim()}
        style={[styles.saveBtn, (saveMut.isPending || !name.trim()) && { opacity: 0.5 }]}
      >
        {saveMut.isPending ? (
          <ActivityIndicator color={colors.light.primaryForeground} />
        ) : (
          <>
            <Feather name="save" size={18} color={colors.light.primaryForeground} />
            <Text style={styles.saveBtnText}>Save as trail</Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers / sub-components
// ---------------------------------------------------------------------------

function DiscreteSlider({ value, min, max, onChange }: {
  value: number; min: number; max: number; onChange: (v: number) => void;
}) {
  const step = Math.max(1, Math.round((max - min) / 20));
  const clamped = Math.max(min, Math.min(max, value));
  return (
    <View style={styles.sliderRow}>
      <SliderBtn label="−5%" onPress={() => onChange(Math.max(min, clamped - step))} />
      <SliderBtn label="−1"  onPress={() => onChange(Math.max(min, clamped - 1))} />
      <View style={styles.sliderTrack}>
        <View style={[styles.sliderFill, { width: `${((clamped - min) / Math.max(1, max - min)) * 100}%` }]} />
      </View>
      <SliderBtn label="+1"  onPress={() => onChange(Math.min(max, clamped + 1))} />
      <SliderBtn label="+5%" onPress={() => onChange(Math.min(max, clamped + step))} />
    </View>
  );
}

function SliderBtn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.sliderBtn}>
      <Text style={styles.sliderBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function formatDuration(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },

  // Resume banner
  resumeBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.light.muted,
    borderColor: colors.light.primary,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
  },
  resumeTitle: { color: colors.light.foreground, fontWeight: "700", fontSize: 13 },
  resumeMeta: { color: colors.light.mutedForeground, fontSize: 12, marginTop: 2 },
  resumeBtn: {
    backgroundColor: colors.light.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  resumeBtnText: { color: colors.light.primaryForeground, fontWeight: "700", fontSize: 13 },
  discardBtn: { padding: 6 },

  // HUD
  hud: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 8 },
  stat: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
  },
  statLabel: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  statValue: { color: colors.light.foreground, fontSize: 22, fontWeight: "800", marginTop: 4 },

  // Live map
  mapWrap: {
    height: 240,
    borderRadius: 14,
    overflow: "hidden",
    borderColor: colors.light.border,
    borderWidth: 1,
    position: "relative",
  },
  mapLiveDot: {
    position: "absolute",
    bottom: 10,
    right: 10,
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  liveDotPulse: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.light.destructive,
    borderWidth: 2,
    borderColor: "#fff",
  },

  helper: { color: colors.light.mutedForeground, fontSize: 13 },
  recordBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 18,
    borderRadius: 16,
  },
  recordBtnText: { color: colors.light.primaryForeground, fontWeight: "800", fontSize: 16 },

  // Save panel
  panel: {
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginTop: 8,
  },
  panelTitle: { color: colors.light.foreground, fontSize: 16, fontWeight: "800" },
  panelMeta: { color: colors.light.mutedForeground, fontSize: 12, marginTop: 4, marginBottom: 12 },
  trimMapWrap: {
    height: 160,
    borderRadius: 12,
    overflow: "hidden",
    borderColor: colors.light.border,
    borderWidth: 1,
    marginBottom: 12,
  },
  fieldLabel: { color: colors.light.foreground, fontWeight: "700", fontSize: 13, marginTop: 12 },
  input: {
    backgroundColor: colors.light.input,
    color: colors.light.foreground,
    borderRadius: 10,
    padding: 12,
    marginTop: 6,
    fontSize: 14,
  },

  // Grade picker
  gradeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  gradeChip: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.light.muted,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  gradeChipActive: { backgroundColor: colors.light.primary, borderColor: colors.light.primary },
  gradeChipText: { color: colors.light.foreground, fontWeight: "700", fontSize: 13 },
  gradeChipTextActive: { color: colors.light.primaryForeground },
  gradeMeta: { color: colors.light.mutedForeground, fontSize: 12, marginTop: 4 },

  // Visibility / group
  row: { flexDirection: "row", gap: 8, marginTop: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.light.muted,
  },
  chipActive: { backgroundColor: colors.light.primary },
  chipText: { color: colors.light.foreground, fontSize: 13, fontWeight: "600", textTransform: "capitalize" },
  chipTextActive: { color: colors.light.primaryForeground },
  groupOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.light.border,
    marginTop: 6,
    backgroundColor: colors.light.background,
  },
  groupOptionText: { color: colors.light.foreground, fontSize: 14 },
  saveBtn: {
    marginTop: 16,
    backgroundColor: colors.light.primary,
    paddingVertical: 14,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  saveBtnText: { color: colors.light.primaryForeground, fontWeight: "800", fontSize: 14 },

  // Trim slider
  sliderRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  sliderBtn: { backgroundColor: colors.light.muted, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  sliderBtnText: { color: colors.light.foreground, fontWeight: "700", fontSize: 12 },
  sliderTrack: { flex: 1, height: 8, backgroundColor: colors.light.muted, borderRadius: 4, overflow: "hidden", marginHorizontal: 4 },
  sliderFill: { height: "100%", backgroundColor: colors.light.primary },
});
