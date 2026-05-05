/**
 * Record-a-ride screen. Wraps `lib/recording.ts` so the user gets a live
 * distance / duration / speed / elevation HUD, with start/stop controls.
 * Saving the resulting track as a private trail is a follow-up port for
 * task #220 (the trail-create endpoint expects a GPX-shaped payload that
 * we don't synthesise yet on mobile).
 */
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import {
  isRecording,
  startRecording,
  stopRecording,
  subscribe,
  type RidePoint,
  type RideStats,
} from "@/lib/recording";

export default function RecordScreen() {
  const [points, setPoints] = useState<RidePoint[]>([]);
  const [stats, setStats] = useState<RideStats>({
    distanceMeters: 0,
    durationSeconds: 0,
    elevationGainMeters: 0,
    pointCount: 0,
  });
  const [active, setActive] = useState(isRecording());

  useEffect(() => {
    return subscribe((p, s) => {
      setPoints(p);
      setStats(s);
    });
  }, []);

  async function onStart() {
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
    Alert.alert(
      "Ride saved locally",
      `${result.points.length} samples • ${(result.stats.distanceMeters / 1000).toFixed(2)} km`,
    );
  }

  const speedKmh =
    points.length > 0
      ? Math.max(0, (points[points.length - 1].speed ?? 0) * 3.6)
      : 0;

  return (
    <View style={styles.container}>
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
          : "Press Start to begin recording your ride. Background location is requested separately and is optional."}
      </Text>

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
    </View>
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
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.light.background,
    padding: 20,
    gap: 14,
  },
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
    marginTop: "auto",
    marginBottom: 24,
  },
  recordBtnText: {
    color: colors.light.primaryForeground,
    fontWeight: "800",
    fontSize: 16,
  },
});
