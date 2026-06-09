/**
 * Discover tab — browse public routes, my groups, and discoverable
 * (public) groups with a one-tap join-request flow. Owners get a quick
 * leave button.
 */
import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useListPublicRoutes } from "@workspace/api-client-react";
import * as Location from "expo-location";
import { router } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { PageLoadingCover } from "@/components/PageLoadingCover";
import { TabHero } from "@/components/shell/TabHero";
import { haversineKm } from "@/lib/geo";
import {
  createGroup,
  fetchCommunityTrails,
  fetchTrailCollections,
  leaveGroup,
  listDiscoverableGroups,
  listMyGroups,
  requestGroupJoin,
  type DiscoverableGroup,
  type Group,
  type MapTrail,
  type TrailCollection,
} from "@/lib/api";
import { difficultyColor, difficultyLabel } from "@/lib/trailColors";

interface PublicRoute {
  id: string;
  name: string;
  author?: string | null;
  trail_count?: number | null;
  like_count?: number | null;
  region?: string | null;
  difficulty?: string | null;
}

// Mirrors the web Discover taxonomy exactly:
// `FILTERS = ["All", "Featured", "BOATs", "Green Lanes", "Nearby"]`.
type TrailCategory = "All" | "Featured" | "BOATs" | "Green Lanes" | "Nearby";
const TRAIL_FILTERS: TrailCategory[] = [
  "All",
  "Featured",
  "BOATs",
  "Green Lanes",
  "Nearby",
];
const NEARBY_RADIUS_KM = 50;

function trailMatchesCategory(
  t: MapTrail,
  c: TrailCategory,
  near: { lat: number; lon: number } | null,
): boolean {
  // Mirrors web's DiscoverTab filter: only BOATs / Green Lanes / Nearby
  // narrow the list. "All" and "Featured" both fall through to true.
  if (c === "BOATs") return t.legal_status === "BOAT";
  if (c === "Green Lanes") return t.legal_status === "Green Lane";
  if (c === "Nearby") {
    if (!near) return false;
    if (t.centroid_lat == null || t.centroid_lon == null) return false;
    return (
      haversineKm(near, { lat: t.centroid_lat, lon: t.centroid_lon }) <=
      NEARBY_RADIUS_KM
    );
  }
  return true;
}

type RouteCategory = "all" | "popular" | "easy" | "moderate" | "hard";

function routeMatchesCategory(r: PublicRoute, c: RouteCategory): boolean {
  if (c === "all") return true;
  if (c === "popular") return (r.like_count ?? 0) >= 5;
  const d = (r.difficulty ?? "").toLowerCase();
  if (c === "easy") return d.includes("green") || d.includes("easy");
  if (c === "moderate")
    return d.includes("blue") || d.includes("intermediate") || d === "moderate";
  if (c === "hard")
    return d.includes("black") || d.includes("expert") || d.includes("hard");
  return true;
}

export default function DiscoverTab() {
  const qc = useQueryClient();
  const routesQ = useListPublicRoutes();
  const groupsQ = useQuery({ queryKey: ["my-groups"], queryFn: listMyGroups });
  const [groupName, setGroupName] = useState("");
  const [creating, setCreating] = useState(false);
  const [discoverQuery, setDiscoverQuery] = useState("");
  const discoverQ = useQuery({
    queryKey: ["discoverable-groups", discoverQuery],
    queryFn: () => listDiscoverableGroups(discoverQuery),
  });

  const joinMut = useMutation({
    mutationFn: (groupId: string) => requestGroupJoin(groupId),
    onSuccess: () => {
      Alert.alert(
        "Request sent",
        "The group's owners will see your request shortly.",
      );
      void qc.invalidateQueries({ queryKey: ["discoverable-groups"] });
    },
    onError: (err) =>
      Alert.alert(
        "Couldn't request to join",
        err instanceof Error ? err.message : "Unknown error",
      ),
  });

  const leaveMut = useMutation({
    mutationFn: (groupId: string) => leaveGroup(groupId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["my-groups"] });
      void qc.invalidateQueries({ queryKey: ["discoverable-groups"] });
    },
    onError: (err) =>
      Alert.alert(
        "Leave failed",
        err instanceof Error ? err.message : "Unknown error",
      ),
  });

  // Community trails — single page (limit=120), filtered locally.
  const trailsQ = useQuery({
    queryKey: ["community-trails"],
    queryFn: fetchCommunityTrails,
    staleTime: 60_000,
  });
  const collectionsQ = useQuery({
    queryKey: ["trail-collections"],
    queryFn: fetchTrailCollections,
    staleTime: 60_000,
  });
  const [trailCategory, setTrailCategory] = useState<TrailCategory>("All");

  // Lightweight one-shot location fetch for "Nearby". We don't hold a
  // watcher open — Discover doesn't need live updates.
  const [near, setNear] = useState<{ lat: number; lon: number } | null>(null);
  useEffect(() => {
    void (async () => {
      const fg = await Location.getForegroundPermissionsAsync();
      if (fg.status !== "granted") return;
      const last = await Location.getLastKnownPositionAsync();
      if (last) {
        setNear({
          lat: last.coords.latitude,
          lon: last.coords.longitude,
        });
      }
    })();
  }, []);

  const allTrails = trailsQ.data?.trails ?? [];
  const trails = useMemo(
    () => allTrails.filter((t) => trailMatchesCategory(t, trailCategory, near)),
    [allTrails, trailCategory, near],
  );

  const [routeCategory, setRouteCategory] = useState<RouteCategory>("all");
  const allRoutes =
    (routesQ.data as { routes?: PublicRoute[] } | undefined)?.routes ?? [];
  const routes = allRoutes.filter((r) => routeMatchesCategory(r, routeCategory));
  const groups = groupsQ.data?.groups ?? [];
  const discoverable = (discoverQ.data?.items ?? []).filter(
    (g) => !g.is_member,
  );

  const initialLoading =
    (routesQ.isLoading || groupsQ.isLoading || trailsQ.isLoading)
    && !routesQ.data
    && !groupsQ.data
    && !trailsQ.data;

  const tntCollection = useMemo(
    () => collectionsQ.data?.find((c) => c.name === "Trans Northern Trail") ?? null,
    [collectionsQ.data],
  );
  const otherFeatured = useMemo(
    () =>
      (collectionsQ.data ?? []).filter(
        (c) => c.is_featured && c.name !== "Trans Northern Trail",
      ),
    [collectionsQ.data],
  );

  function confirmLeave(g: Group) {
    Alert.alert("Leave group?", `Leave "${g.name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave",
        style: "destructive",
        onPress: () => leaveMut.mutate(g.id),
      },
    ]);
  }

  async function onCreateGroup() {
    if (!groupName.trim()) return;
    setCreating(true);
    try {
      await createGroup(groupName.trim());
      setGroupName("");
      void groupsQ.refetch();
      void qc.invalidateQueries({ queryKey: ["discoverable-groups"] });
    } catch (err) {
      Alert.alert(
        "Could not create group",
        err instanceof Error ? err.message : "Unknown error",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <PageLoadingCover loading={initialLoading} message="Loading discover…">
    <FlatList
      style={styles.container}
      contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
      data={routes}
      keyExtractor={(r) => r.id}
      refreshControl={
        <RefreshControl
          refreshing={routesQ.isFetching || groupsQ.isFetching}
          onRefresh={() => {
            void routesQ.refetch();
            void groupsQ.refetch();
            void collectionsQ.refetch();
          }}
          tintColor={colors.light.primary}
        />
      }
      ListHeaderComponent={
        <View style={{ marginBottom: 22 }}>
          <TabHero
            title="Discover"
            subtitle="Featured routes, community trails, and groups"
            height={200}
          />

          <Text style={styles.sectionTitle}>Featured routes</Text>
          <FeaturedRouteCard
            collection={tntCollection}
            fallback={{
              name: "Trans Northern Trail",
              region: "England North / Scotland",
              total_distance_km: null,
              difficulty_min: 3,
              difficulty_max: 8,
            }}
            onPress={() => router.push("/routes/tnt" as never)}
          />
          {otherFeatured.map((c) => (
            <FeaturedRouteCard
              key={c.id}
              collection={c}
              onPress={() => router.push("/(tabs)/map" as never)}
            />
          ))}

          <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Community trails</Text>
          <View style={styles.categoryRibbon}>
            {TRAIL_FILTERS.map((f) => {
              const active = f === trailCategory;
              const disabled = f === "Nearby" && !near;
              return (
                <TouchableOpacity
                  key={f}
                  onPress={() => !disabled && setTrailCategory(f)}
                  disabled={disabled}
                  style={[
                    styles.catChip,
                    active && styles.catChipActive,
                    disabled && { opacity: 0.4 },
                  ]}
                >
                  <Text
                    style={[
                      styles.catChipText,
                      active && styles.catChipTextActive,
                    ]}
                  >
                    {f}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {trailCategory === "Nearby" && !near ? (
            <Text style={styles.helper}>
              Enable location on the Map tab to use Nearby.
            </Text>
          ) : null}
          {trailsQ.isLoading ? (
            <ActivityIndicator
              color={colors.light.primary}
              style={{ marginTop: 6 }}
            />
          ) : trails.length === 0 ? (
            <Text style={styles.emptyText}>
              No trails match this filter yet.
            </Text>
          ) : (
            trails.slice(0, 30).map((t) => (
              <Pressable
                key={t.id}
                style={styles.trailRow}
                onPress={() =>
                  router.push(`/trail/${encodeURIComponent(t.id)}`)
                }
              >
                <View
                  style={[
                    styles.diffDot,
                    { backgroundColor: difficultyColor(t.difficulty) },
                  ]}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.trailRowTitle} numberOfLines={1}>
                    {t.name}
                  </Text>
                  <Text style={styles.trailRowMeta}>
                    {difficultyLabel(t.difficulty)}
                    {t.distance_km != null
                      ? ` • ${t.distance_km.toFixed(1)} km`
                      : ""}
                    {t.legal_status ? ` • ${t.legal_status}` : ""}
                  </Text>
                </View>
                <Feather
                  name="chevron-right"
                  size={18}
                  color={colors.light.mutedForeground}
                />
              </Pressable>
            ))
          )}

          <Text style={[styles.sectionTitle, { marginTop: 24 }]}>My groups</Text>
          {groupsQ.isLoading ? (
            <ActivityIndicator color={colors.light.primary} />
          ) : groups.length === 0 ? (
            <Text style={styles.emptyText}>You're not in any group yet.</Text>
          ) : (
            groups.map((g: Group) => (
              <GroupRow
                key={g.id}
                group={g}
                onLeave={() => confirmLeave(g)}
              />
            ))
          )}

          <View style={styles.createGroupRow}>
            <TextInput
              value={groupName}
              onChangeText={setGroupName}
              placeholder="New group name"
              placeholderTextColor={colors.light.mutedForeground}
              style={styles.input}
            />
            <TouchableOpacity
              onPress={onCreateGroup}
              disabled={creating || !groupName.trim()}
              style={[
                styles.createBtn,
                (!groupName.trim() || creating) && { opacity: 0.5 },
              ]}
            >
              {creating ? (
                <ActivityIndicator color={colors.light.primaryForeground} />
              ) : (
                <Feather
                  name="plus"
                  size={18}
                  color={colors.light.primaryForeground}
                />
              )}
            </TouchableOpacity>
          </View>

          <Text style={[styles.sectionTitle, { marginTop: 24 }]}>
            Discover groups
          </Text>
          <TextInput
            value={discoverQuery}
            onChangeText={setDiscoverQuery}
            placeholder="Search public groups"
            placeholderTextColor={colors.light.mutedForeground}
            style={[styles.input, { marginBottom: 8 }]}
          />
          {discoverQ.isLoading ? (
            <ActivityIndicator color={colors.light.primary} />
          ) : discoverable.length === 0 ? (
            <Text style={styles.emptyText}>
              No matching public groups.
            </Text>
          ) : (
            discoverable.slice(0, 10).map((g) => (
              <DiscoverableGroupRow
                key={g.id}
                group={g}
                onJoin={() => joinMut.mutate(g.id)}
                pending={
                  joinMut.isPending ||
                  Boolean(g.has_pending_request)
                }
              />
            ))
          )}

          <Text style={[styles.sectionTitle, { marginTop: 24 }]}>
            Public routes
          </Text>
          <View style={styles.categoryRibbon}>
            {(
              [
                { value: "all", label: "All", icon: "list" },
                { value: "popular", label: "Popular", icon: "trending-up" },
                { value: "easy", label: "Easy", icon: "smile" },
                { value: "moderate", label: "Moderate", icon: "wind" },
                { value: "hard", label: "Hard", icon: "zap" },
              ] as Array<{
                value: RouteCategory;
                label: string;
                icon: keyof typeof Feather.glyphMap;
              }>
            ).map((c) => {
              const active = c.value === routeCategory;
              return (
                <TouchableOpacity
                  key={c.value}
                  onPress={() => setRouteCategory(c.value)}
                  style={[styles.catChip, active && styles.catChipActive]}
                >
                  <Feather
                    name={c.icon}
                    size={12}
                    color={
                      active
                        ? colors.light.primaryForeground
                        : colors.light.foreground
                    }
                  />
                  <Text
                    style={[
                      styles.catChipText,
                      active && styles.catChipTextActive,
                    ]}
                  >
                    {c.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      }
      renderItem={({ item }) => <RouteCard route={item} />}
      ListEmptyComponent={
        routesQ.isLoading ? (
          <ActivityIndicator color={colors.light.primary} />
        ) : (
          <Text style={styles.emptyText}>
            No public routes yet — be the first to share one!
          </Text>
        )
      }
    />
    </PageLoadingCover>
  );
}

function FeaturedRouteCard({
  collection,
  fallback,
  onPress,
}: {
  collection: TrailCollection | null;
  fallback?: {
    name: string;
    region: string;
    total_distance_km: number | null;
    difficulty_min: number;
    difficulty_max: number;
  };
  onPress: () => void;
}) {
  const name = collection?.name ?? fallback?.name ?? "Community route";
  const region = collection?.region ?? fallback?.region;
  const km = collection?.total_distance_km ?? fallback?.total_distance_km;
  const dMin = collection?.difficulty_min ?? fallback?.difficulty_min;
  const dMax = collection?.difficulty_max ?? fallback?.difficulty_max;

  return (
    <TouchableOpacity style={styles.featuredCard} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.featuredTop}>
        <Text style={styles.featuredTitle} numberOfLines={1}>{name}</Text>
        <View style={styles.communityBadge}>
          <Text style={styles.communityBadgeText}>Community Route</Text>
        </View>
      </View>
      {region ? <Text style={styles.featuredRegion}>{region}</Text> : null}
      <View style={styles.featuredMeta}>
        {km != null ? (
          <Text style={styles.featuredMetaText}>{Math.round(km)} km total</Text>
        ) : (
          <Text style={styles.featuredMetaText}>Distance after import</Text>
        )}
        {dMin != null && dMax != null ? (
          <Text style={styles.featuredMetaText}>Grade {dMin}–{dMax}</Text>
        ) : null}
      </View>
      <Text style={styles.featuredHint}>
        Trails associated with the {name}
      </Text>
    </TouchableOpacity>
  );
}

function GroupRow({ group, onLeave }: { group: Group; onLeave: () => void }) {
  return (
    <Pressable
      style={styles.groupRow}
      onPress={() =>
        router.push({
          pathname: "/group/[groupId]",
          params: { groupId: group.id },
        })
      }
      onLongPress={onLeave}
      delayLongPress={400}
    >
      <Feather name="users" size={18} color={colors.light.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{group.name}</Text>
        <Text style={styles.rowMeta}>
          {group.member_count} member{group.member_count === 1 ? "" : "s"}
          {group.is_owner ? " • owner" : ""}
        </Text>
      </View>
      {!group.is_owner ? (
        <TouchableOpacity onPress={onLeave} hitSlop={8}>
          <Feather name="log-out" size={16} color={colors.light.mutedForeground} />
        </TouchableOpacity>
      ) : (
        <Feather name="chevron-right" size={18} color={colors.light.mutedForeground} />
      )}
    </Pressable>
  );
}

function DiscoverableGroupRow({
  group,
  onJoin,
  pending,
}: {
  group: DiscoverableGroup;
  onJoin: () => void;
  pending: boolean;
}) {
  return (
    <View style={styles.groupRow}>
      <Feather name="globe" size={18} color={colors.light.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{group.name}</Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {group.member_count} member{group.member_count === 1 ? "" : "s"}
          {group.description ? ` • ${group.description}` : ""}
        </Text>
      </View>
      <TouchableOpacity
        onPress={onJoin}
        disabled={pending}
        style={[styles.joinBtn, pending && { opacity: 0.5 }]}
      >
        <Text style={styles.joinBtnText}>
          {group.has_pending_request ? "Pending" : "Join"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function RouteCard({ route }: { route: PublicRoute }) {
  return (
    <Pressable style={styles.routeCard}>
      <Text style={styles.routeName} numberOfLines={1}>
        {route.name}
      </Text>
      <Text style={styles.rowMeta}>
        {route.trail_count ?? 0} trails • ♥ {route.like_count ?? 0}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
  h1: { color: colors.light.foreground, fontSize: 22, fontWeight: "800", marginBottom: 14 },
  sectionTitle: {
    color: colors.light.foreground,
    fontWeight: "700",
    fontSize: 14,
    marginBottom: 8,
  },
  featuredCard: {
    backgroundColor: colors.light.card,
    borderRadius: 14,
    borderColor: colors.light.border,
    borderWidth: 1,
    padding: 16,
    marginBottom: 10,
  },
  featuredTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 6,
  },
  featuredTitle: {
    flex: 1,
    color: colors.light.foreground,
    fontWeight: "800",
    fontSize: 16,
  },
  communityBadge: {
    backgroundColor: colors.light.primary,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  communityBadgeText: {
    color: colors.light.primaryForeground,
    fontWeight: "700",
    fontSize: 10,
  },
  featuredRegion: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    marginBottom: 6,
  },
  featuredMeta: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 6,
  },
  featuredMetaText: {
    color: colors.light.foreground,
    fontSize: 12,
    fontWeight: "600",
  },
  featuredHint: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    fontStyle: "italic",
  },
  groupRow: {
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
  rowTitle: { color: colors.light.foreground, fontWeight: "600" },
  rowMeta: { color: colors.light.mutedForeground, fontSize: 12, marginTop: 2 },
  emptyText: { color: colors.light.mutedForeground, fontSize: 13 },
  createGroupRow: { flexDirection: "row", gap: 8, marginTop: 6 },
  input: {
    flex: 1,
    backgroundColor: colors.light.input,
    color: colors.light.foreground,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    fontSize: 14,
  },
  createBtn: {
    backgroundColor: colors.light.primary,
    width: 42,
    height: 42,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  routeCard: {
    backgroundColor: colors.light.card,
    borderRadius: 12,
    borderColor: colors.light.border,
    borderWidth: 1,
    padding: 14,
    marginBottom: 8,
  },
  routeName: { color: colors.light.foreground, fontWeight: "700", fontSize: 14 },
  joinBtn: {
    backgroundColor: colors.light.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  joinBtnText: {
    color: colors.light.primaryForeground,
    fontWeight: "700",
    fontSize: 12,
  },
  categoryRibbon: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 8,
    marginBottom: 8,
  },
  catChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.light.card,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  catChipActive: {
    backgroundColor: colors.light.primary,
    borderColor: colors.light.primary,
  },
  catChipText: {
    color: colors.light.foreground,
    fontSize: 11,
    fontWeight: "600",
  },
  catChipTextActive: { color: colors.light.primaryForeground },
  trailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: colors.light.card,
    borderRadius: 10,
    borderColor: colors.light.border,
    borderWidth: 1,
    marginBottom: 6,
  },
  diffDot: { width: 12, height: 12, borderRadius: 6 },
  trailRowTitle: { color: colors.light.foreground, fontWeight: "600" },
  trailRowMeta: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    marginTop: 2,
  },
  helper: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    marginBottom: 8,
  },
});
