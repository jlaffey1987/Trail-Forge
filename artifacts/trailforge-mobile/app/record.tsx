/**
 * Record-a-ride screen.
 *
 * Live phase: HUD with distance/duration/speed/elevation, start/stop button.
 * Stopped phase: trim editor (drop wrong turns at start/end via two index
 * sliders) + visibility picker (private / public / group), then save the
 * ride as a trail via /api/trails.
 */
import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import {
  createTrailFromRide,
  listMyGroups,
  type Group,
} from "@/lib/api";
import {
  isRecording,
  startRecording,
  stopRecording,
  subscribe,
  type RidePoint,
  type RideStats,
} from "@/lib/recording";

type Visibility = "private" | "public" | "group";

export default function RecordScreen() {
  const [points, setPoints] = useState<RidePoint[]>([]);
  const [stats, setStats] = useState<RideStats>({
    distanceMeters: 0,
    durationSeconds: 0,
    elevationGainMeters: 0,
    pointCount: 0,
  });
  const [active, setActive] = useState(isRecording());

  // Saved ride buffer (set when the user stops). Drives the trim+save UI.
  const [savedRide, setSavedRide] = useState<{
    points: RidePoint[];
    stats: RideStats;
  } | null>(null);

  useEffect(() => {
    return subscribe((p, s) => {
      setPoints(p);
      setStats(s);
    });
  }, []);

  async function onStart() {
    setSavedRide(null);
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
    setSavedRide(result);
  }

  const speedKmh =
    points.length > 0
      ? Math.max(0, (points[points.length - 1].speed ?? 0) * 3.6)
      : 0;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 20, paddingBottom: 80, gap: 14 }}
    >
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

      <Text style={styles.helper}>
        {active
          ? "Recording — keep TrailForge open for best accuracy. The screen can lock; we'll keep tracking."
          : savedRide
            ? "Trim wrong turns from the start or end of your ride, then save it as a trail."
            : "Press Start to begin recording your ride. Background location is requested separately and is optional."}
      </Text>

      <TouchableOpacity
        style={[
          styles.recordBtn,
          {
            backgroundColor: active
              ? colors.light.destructive
              : colors.light.primary,
          },
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

      {savedRide && savedRide.points.length >= 2 ? (
        <SaveRidePanel
          ride={savedRide}
          onDone={() => setSavedRide(null)}
        />
      ) : null}
    </ScrollView>
  );
}

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
      m += haversine(trimmed[i - 1], trimmed[i]);
    }
    return m / 1000;
  }, [trimmed]);

  const saveMut = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error("Give your ride a name first.");
      if (visibility === "group" && !groupId) {
        throw new Error("Pick a group to publish to.");
      }
      const path: Array<[number, number]> = trimmed.map((p) => [
        p.lon,
        p.lat,
      ]);
      const altitudes = trimmed
        .map((p) => p.altitude)
        .filter((a): a is number => typeof a === "number" && a !== null);
      return createTrailFromRide({
        name: name.trim(),
        path,
        altitudes,
        visibility,
        groupId: visibility === "group" ? groupId ?? undefined : undefined,
      });
    },
    onSuccess: () => {
      Alert.alert("Saved", `Trail "${name.trim()}" published.`);
      onDone();
    },
    onError: (err) =>
      Alert.alert(
        "Save failed",
        err instanceof Error ? err.message : "Unknown error",
      ),
  });

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Trim &amp; save</Text>
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

      <Text style={styles.fieldLabel}>Visibility</Text>
      <View style={styles.row}>
        {(["private", "public", "group"] as Visibility[]).map((v) => (
          <Pressable
            key={v}
            onPress={() => setVisibility(v)}
            style={[
              styles.chip,
              visibility === v && styles.chipActive,
            ]}
          >
            <Text
              style={[
                styles.chipText,
                visibility === v && styles.chipTextActive,
              ]}
            >
              {v}
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
                  groupId === g.id && {
                    borderColor: colors.light.primary,
                  },
                ]}
              >
                <Feather
                  name={groupId === g.id ? "check-circle" : "circle"}
                  size={16}
                  color={
                    groupId === g.id
                      ? colors.light.primary
                      : colors.light.mutedForeground
                  }
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
        style={[
          styles.saveBtn,
          (saveMut.isPending || !name.trim()) && { opacity: 0.5 },
        ]}
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

function DiscreteSlider({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  // Lightweight ± stepper that doesn't pull in extra slider deps. Tap and
  // hold isn't supported — short presses move 1 step, the long buttons
  // jump 5%.
  const step = Math.max(1, Math.round((max - min) / 20));
  const clamped = Math.max(min, Math.min(max, value));
  return (
    <View style={styles.sliderRow}>
      <SliderBtn
        label="−5%"
        onPress={() => onChange(Math.max(min, clamped - step))}
      />
      <SliderBtn
        label="−1"
        onPress={() => onChange(Math.max(min, clamped - 1))}
      />
      <View style={styles.sliderTrack}>
        <View
          style={[
            styles.sliderFill,
            {
              width: `${((clamped - min) / Math.max(1, max - min)) * 100}%`,
            },
          ]}
        />
      </View>
      <SliderBtn
        label="+1"
        onPress={() => onChange(Math.min(max, clamped + 1))}
      />
      <SliderBtn
        label="+5%"
        onPress={() => onChange(Math.min(max, clamped + step))}
      />
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

function haversine(a: RidePoint, b: RidePoint): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
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
  statValue: {
    color: colors.light.foreground,
    fontSize: 22,
    fontWeight: "800",
    marginTop: 4,
  },
  helper: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    marginTop: 4,
  },
  recordBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 18,
    borderRadius: 16,
  },
  recordBtnText: {
    color: colors.light.primaryForeground,
    fontWeight: "800",
    fontSize: 16,
  },
  panel: {
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginTop: 8,
  },
  panelTitle: {
    color: colors.light.foreground,
    fontSize: 16,
    fontWeight: "800",
  },
  panelMeta: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    marginTop: 2,
    marginBottom: 12,
  },
  fieldLabel: {
    color: colors.light.foreground,
    fontWeight: "700",
    fontSize: 13,
    marginTop: 12,
  },
  input: {
    backgroundColor: colors.light.input,
    color: colors.light.foreground,
    borderRadius: 10,
    padding: 12,
    marginTop: 6,
    fontSize: 14,
  },
  row: { flexDirection: "row", gap: 8, marginTop: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.light.muted,
  },
  chipActive: { backgroundColor: colors.light.primary },
  chipText: {
    color: colors.light.foreground,
    fontSize: 13,
    fontWeight: "600",
    textTransform: "capitalize",
  },
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
  saveBtnText: {
    color: colors.light.primaryForeground,
    fontWeight: "800",
    fontSize: 14,
  },
  sliderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
  },
  sliderBtn: {
    backgroundColor: colors.light.muted,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sliderBtnText: {
    color: colors.light.foreground,
    fontWeight: "700",
    fontSize: 12,
  },
  sliderTrack: {
    flex: 1,
    height: 8,
    backgroundColor: colors.light.muted,
    borderRadius: 4,
    overflow: "hidden",
    marginHorizontal: 4,
  },
  sliderFill: {
    height: "100%",
    backgroundColor: colors.light.primary,
  },
});
