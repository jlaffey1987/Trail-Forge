/**
 * Single-trail detail screen. Fetched via `useSearchTrails` filtered by
 * id (the API doesn't yet expose a get-by-id route in the OpenAPI spec).
 * Renders the same TrailDetailSheet layout used by the map tap.
 */
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { ElevationChart } from "@/components/ElevationChart";
import colors from "@/constants/colors";
import { searchTrailsByBbox } from "@/lib/api";
import { difficultyColor, difficultyLabel } from "@/lib/trailColors";
import { useWindowDimensions } from "react-native";

export default function TrailDetailScreen() {
  const { trailId } = useLocalSearchParams<{ trailId: string }>();
  const id = String(trailId ?? "");
  const { width } = useWindowDimensions();

  // Filter the search endpoint by trail id. The backend honours `ids` as
  // a comma-separated list — that param isn't yet in the OpenAPI spec,
  // so we call the typed direct-fetch helper rather than the generated
  // hook (which would require a spec change to accept `ids`).
  const q = useQuery({
    queryKey: ["trail-by-id", id],
    queryFn: () => searchTrailsByBbox({ ids: id, limit: 1 }),
    enabled: id.length > 0,
  });
  const trail = q.data?.trails?.[0];

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.light.primary} />
      </View>
    );
  }

  if (!trail) {
    return (
      <View style={styles.center}>
        <Feather name="frown" size={36} color={colors.light.mutedForeground} />
        <Text style={styles.notFound}>Trail not found</Text>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.link}>← Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 18, paddingBottom: 80 }}
    >
      <Text style={styles.h1}>{trail.name}</Text>

      <View style={styles.badges}>
        <View
          style={[
            styles.diffBadge,
            { borderColor: difficultyColor(trail.difficulty) },
          ]}
        >
          <View
            style={[
              styles.diffDot,
              { backgroundColor: difficultyColor(trail.difficulty) },
            ]}
          />
          <Text style={styles.diffText}>{difficultyLabel(trail.difficulty)}</Text>
        </View>
        {trail.terrain ? (
          <View style={styles.terrain}>
            <Text style={styles.terrainText}>{trail.terrain}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Distance</Text>
          <Text style={styles.statValue}>
            {trail.distance_km != null
              ? `${trail.distance_km.toFixed(2)} km`
              : "—"}
          </Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Elevation</Text>
          <Text style={styles.statValue}>
            {trail.elevation_gain_m != null
              ? `${Math.round(trail.elevation_gain_m)} m`
              : "—"}
          </Text>
        </View>
      </View>

      {Array.isArray(trail.altitudes) && trail.altitudes.length > 1 ? (
        <View style={{ marginTop: 18 }}>
          <Text style={styles.sectionLabel}>Elevation profile</Text>
          <ElevationChart
            altitudes={trail.altitudes as number[]}
            width={width - 36}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
  center: {
    flex: 1,
    backgroundColor: colors.light.background,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  notFound: { color: colors.light.foreground, fontSize: 16, fontWeight: "700" },
  link: { color: colors.light.primary, marginTop: 6 },
  h1: { color: colors.light.foreground, fontSize: 22, fontWeight: "800" },
  badges: { flexDirection: "row", gap: 6, marginTop: 10, flexWrap: "wrap" },
  diffBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  diffDot: { width: 8, height: 8, borderRadius: 4 },
  diffText: { color: colors.light.foreground, fontSize: 12 },
  terrain: {
    backgroundColor: colors.light.muted,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  terrainText: { color: colors.light.mutedForeground, fontSize: 12 },
  statsRow: { flexDirection: "row", gap: 12, marginTop: 18 },
  stat: {
    flex: 1,
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  statLabel: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  statValue: {
    color: colors.light.foreground,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 2,
  },
  sectionLabel: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
});
