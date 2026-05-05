/**
 * My Trails tab — three sections:
 *   - Saved trails (`useListMySavedTrails`)
 *   - Saved routes (`useListMySavedRoutes`)
 *   - Recently ridden (direct fetch — no generated hook yet)
 *
 * Tapping a trail navigates to `/trail/<id>`. Tapping a route navigates to
 * the planner with the route preloaded (#220).
 */
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import {
  useListMySavedRoutes,
  useListMySavedTrails,
} from "@workspace/api-client-react";
import { router } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { listRecentlyRidden, type RecentlyRiddenTrail } from "@/lib/api";
import { difficultyColor, difficultyLabel } from "@/lib/trailColors";

interface SavedTrail {
  id: string;
  name: string;
  difficulty: string | null;
  distance_km: number | null;
}

interface SavedRoute {
  id: string;
  name: string;
  trail_count: number | null;
  updated_at?: string | null;
}

export default function TrailsTab() {
  const savedTrails = useListMySavedTrails();
  const savedRoutes = useListMySavedRoutes();
  const recent = useQuery({
    queryKey: ["recently-ridden"],
    queryFn: listRecentlyRidden,
    staleTime: 60_000,
  });

  const refreshing =
    savedTrails.isFetching || savedRoutes.isFetching || recent.isFetching;
  function refetchAll() {
    void savedTrails.refetch();
    void savedRoutes.refetch();
    void recent.refetch();
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refetchAll}
          tintColor={colors.light.primary}
        />
      }
    >
      <Section
        title="Saved trails"
        loading={savedTrails.isLoading}
        empty={(savedTrails.data as { trails?: SavedTrail[] } | undefined)
          ?.trails?.length === 0}
        emptyHint="Trails you save from the map appear here."
      >
        {((savedTrails.data as { trails?: SavedTrail[] } | undefined)?.trails ??
          []).map((t) => (
          <TrailRow
            key={t.id}
            id={t.id}
            name={t.name}
            difficulty={t.difficulty}
            meta={
              t.distance_km != null ? `${t.distance_km.toFixed(1)} km` : "—"
            }
          />
        ))}
      </Section>

      <Section
        title="Saved routes"
        loading={savedRoutes.isLoading}
        empty={
          (savedRoutes.data as { routes?: SavedRoute[] } | undefined)?.routes
            ?.length === 0
        }
        emptyHint="Routes you build in the Planner appear here."
      >
        {((savedRoutes.data as { routes?: SavedRoute[] } | undefined)?.routes ??
          []).map((r) => (
          <RouteRow key={r.id} route={r} />
        ))}
      </Section>

      <Section
        title="Recently ridden"
        loading={recent.isLoading}
        empty={recent.data?.trails.length === 0}
        emptyHint="Trails you mark as ridden show up here."
      >
        {(recent.data?.trails ?? []).map((t: RecentlyRiddenTrail) => (
          <TrailRow
            key={t.id}
            id={t.id}
            name={t.name}
            difficulty={t.difficulty}
            meta={`Ridden ${new Date(t.completedAt).toLocaleDateString()}`}
          />
        ))}
      </Section>
    </ScrollView>
  );
}

function Section({
  title,
  loading,
  empty,
  emptyHint,
  children,
}: {
  title: string;
  loading: boolean;
  empty?: boolean;
  emptyHint: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ marginBottom: 22 }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {loading ? (
        <ActivityIndicator
          color={colors.light.primary}
          style={{ marginTop: 10 }}
        />
      ) : empty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{emptyHint}</Text>
        </View>
      ) : (
        children
      )}
    </View>
  );
}

function TrailRow({
  id,
  name,
  difficulty,
  meta,
}: {
  id: string;
  name: string;
  difficulty: string | null;
  meta: string;
}) {
  return (
    <Pressable
      style={styles.row}
      onPress={() => router.push(`/trail/${encodeURIComponent(id)}`)}
    >
      <View style={[styles.diffDot, { backgroundColor: difficultyColor(difficulty) }]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.rowMeta}>
          {meta} • {difficultyLabel(difficulty)}
        </Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.light.mutedForeground} />
    </Pressable>
  );
}

function RouteRow({ route }: { route: SavedRoute }) {
  return (
    <Pressable style={styles.row}>
      <Feather name="git-merge" size={18} color={colors.light.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {route.name}
        </Text>
        <Text style={styles.rowMeta}>
          {route.trail_count ?? 0} trail{route.trail_count === 1 ? "" : "s"}
        </Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.light.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
  sectionTitle: {
    color: colors.light.foreground,
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: colors.light.card,
    borderRadius: 12,
    borderColor: colors.light.border,
    borderWidth: 1,
    marginBottom: 8,
  },
  diffDot: { width: 12, height: 12, borderRadius: 6 },
  rowTitle: { color: colors.light.foreground, fontWeight: "600" },
  rowMeta: { color: colors.light.mutedForeground, fontSize: 12, marginTop: 2 },
  empty: {
    paddingVertical: 18,
    paddingHorizontal: 12,
    backgroundColor: colors.light.card,
    borderRadius: 12,
    borderColor: colors.light.border,
    borderWidth: 1,
  },
  emptyText: { color: colors.light.mutedForeground, fontSize: 13 },
});
