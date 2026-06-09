/**
 * My Trails tab — three sections (saved trails, saved routes, recently
 * ridden). Saved trails are sortable + difficulty-filterable; tapping
 * one navigates to the detail screen with the surrounding ids passed
 * along so the detail view can offer prev/next navigation. Tapping a
 * saved route opens the planner with that route preloaded.
 */
import { Feather } from "@expo/vector-icons";

import { useQuery } from "@tanstack/react-query";
import {
  useListMySavedRoutes,
  useListMySavedTrails,
} from "@workspace/api-client-react";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { PageLoadingCover } from "@/components/PageLoadingCover";
import { useProfile } from "@/components/ProfileContext";
import { AppShellHeader } from "@/components/shell/AppShellHeader";
import { TabHero } from "@/components/shell/TabHero";
import { listRecentlyRidden, type RecentlyRiddenTrail } from "@/lib/api";
import {
  clearAllOffline,
  getOfflineStorageStats,
  listOfflineTrails,
  removeOfflineTrail,
  type OfflineTrail,
} from "@/lib/offlineStore";
import { difficultyColor, difficultyLabel, gradeFromDifficulty } from "@/lib/trailColors";

interface SavedTrail {
  id: string;
  name: string;
  difficulty: string | number | null;
  distance_km: number | null;
  elevation_gain_m?: number | null;
}

interface SavedRoute {
  id: string;
  name: string;
  trail_count?: number | null;
  trailIds?: string[];
  isPublic?: boolean;
  updated_at?: string | null;
  updatedAt?: string | null;
}

type SortKey = "name" | "distance" | "climb";
type DiffFilter = "all" | "green" | "blue" | "black" | "double-black";

function difficultyMatches(t: SavedTrail, f: DiffFilter): boolean {
  if (f === "all") return true;
  const grade = gradeFromDifficulty(t.difficulty);
  if (grade != null) {
    if (f === "green") return grade <= 3;
    if (f === "blue") return grade >= 4 && grade <= 6;
    if (f === "black") return grade >= 7 && grade <= 9;
    if (f === "double-black") return grade >= 10;
  }
  const raw = String(t.difficulty ?? "").toLowerCase();
  if (f === "green") return raw.includes("green") || raw.includes("easy");
  if (f === "blue")
    return (
      raw.includes("blue") || raw.includes("intermediate") || raw === "moderate"
    );
  if (f === "black") return raw.includes("black") && !raw.includes("double");
  if (f === "double-black")
    return raw.includes("double") || raw.includes("expert");
  return true;
}

export default function TrailsTab() {
  const savedTrails = useListMySavedTrails();
  const savedRoutes = useListMySavedRoutes();
  const recent = useQuery({
    queryKey: ["recently-ridden"],
    queryFn: listRecentlyRidden,
    staleTime: 60_000,
  });

  // Offline maps state
  const [offlineTrails, setOfflineTrails] = useState<OfflineTrail[]>([]);
  const [offlineStats, setOfflineStats] = useState<{
    trailCount: number;
    trailSizeBytes: number;
    tileSizeBytes: number;
    totalSizeBytes: number;
  } | null>(null);

  const refreshOffline = useCallback(async () => {
    const [trails, stats] = await Promise.all([
      listOfflineTrails(),
      getOfflineStorageStats(),
    ]);
    setOfflineTrails(trails);
    setOfflineStats(stats);
  }, []);

  useEffect(() => { void refreshOffline(); }, [refreshOffline]);

  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [diffFilter, setDiffFilter] = useState<DiffFilter>("all");

  const refreshing =
    savedTrails.isFetching || savedRoutes.isFetching || recent.isFetching;
  function refetchAll() {
    void savedTrails.refetch();
    void savedRoutes.refetch();
    void recent.refetch();
  }

  const filteredSavedTrails = useMemo<SavedTrail[]>(() => {
    const all =
      (savedTrails.data as { trails?: SavedTrail[] } | undefined)?.trails ?? [];
    const filtered = all.filter((t) => difficultyMatches(t, diffFilter));
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === "distance") {
        return (b.distance_km ?? 0) - (a.distance_km ?? 0);
      }
      if (sortKey === "climb") {
        return (b.elevation_gain_m ?? 0) - (a.elevation_gain_m ?? 0);
      }
      return a.name.localeCompare(b.name);
    });
    return sorted;
  }, [savedTrails.data, sortKey, diffFilter]);

  // Pre-compute the sibling-id list once so each row can open the
  // detail screen with prev/next context (?ids=a,b,c,d).
  const savedIdsCsv = useMemo(
    () => filteredSavedTrails.map((t) => t.id).join(","),
    [filteredSavedTrails],
  );

  const allSaved =
    (savedTrails.data as { trails?: SavedTrail[] } | undefined)?.trails ?? [];
  const ownedKm = allSaved
    .reduce((sum, t) => sum + (t.distance_km ?? 0), 0)
    .toFixed(1);
  const routeCount =
    (savedRoutes.data as { routes?: SavedRoute[] } | undefined)?.routes?.length ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.light.background }}>
      <AppShellHeader />
      <PageLoadingCover
        loading={savedTrails.isLoading && savedRoutes.isLoading && !savedTrails.data}
        message="Loading your trails…"
      >
      <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 100 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refetchAll}
          tintColor={colors.light.primary}
        />
      }
    >
      <TabHero
        title="My"
        titleAccent="Trails"
        subtitle="Synced with Supabase"
        rightAction={
          <TouchableOpacity
            style={heroStyles.addBtn}
            onPress={() => router.push("/add-trail")}
          >
            <Feather name="plus" size={14} color="#1a0e05" />
            <Text style={heroStyles.addText}>Add Trail</Text>
          </TouchableOpacity>
        }
      />

      <View style={heroStyles.statsBar}>
        <StatCell label="Owned km" value={ownedKm} />
        <StatCell label="My trails" value={String(allSaved.length)} />
        <StatCell label="Saved" value={String(routeCount)} />
      </View>

      <View style={{ paddingHorizontal: 16 }}>
      <Section
        title="Saved trails"
        loading={savedTrails.isLoading}
        empty={filteredSavedTrails.length === 0}
        emptyHint="Trails you save from the map appear here."
        controls={
          <View style={{ gap: 6 }}>
            <ChipRow
              options={[
                { value: "name", label: "Name" },
                { value: "distance", label: "Distance" },
                { value: "climb", label: "Climb" },
              ]}
              value={sortKey}
              onChange={(v) => setSortKey(v as SortKey)}
              label="Sort"
            />
            <ChipRow
              options={[
                { value: "all", label: "All" },
                { value: "green", label: "Green" },
                { value: "blue", label: "Blue" },
                { value: "black", label: "Black" },
                { value: "double-black", label: "2×Black" },
              ]}
              value={diffFilter}
              onChange={(v) => setDiffFilter(v as DiffFilter)}
              label="Difficulty"
            />
          </View>
        }
      >
        {filteredSavedTrails.map((t) => (
          <TrailRow
            key={t.id}
            id={t.id}
            siblingIds={savedIdsCsv}
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
        emptyHint="Routes you build in the Planner appear here as drafts. Premium unlocks navigation and GPX export."
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

      {/* ── Offline maps ─────────────────────────────────────────────── */}
      <View style={{ marginBottom: 22 }}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>Offline maps</Text>
          {offlineStats && offlineStats.totalSizeBytes > 0 ? (
            <TouchableOpacity
              onPress={() => {
                Alert.alert(
                  "Clear offline data?",
                  "This removes all downloaded trail data and tiles.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Clear",
                      style: "destructive",
                      onPress: async () => {
                        await clearAllOffline();
                        await refreshOffline();
                      },
                    },
                  ],
                );
              }}
            >
              <Text style={styles.clearBtn}>Clear all</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {offlineStats ? (
          <View style={styles.storageCard}>
            <StorageStat label="Trails" value={String(offlineStats.trailCount)} />
            <StorageStat label="Trail data" value={formatBytes(offlineStats.trailSizeBytes)} />
            <StorageStat label="Tile cache" value={formatBytes(offlineStats.tileSizeBytes)} />
            <StorageStat label="Total" value={formatBytes(offlineStats.totalSizeBytes)} accent />
          </View>
        ) : null}

        {offlineTrails.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              No offline trails saved yet. Open a trail, then tap Save offline on its detail page.
            </Text>
          </View>
        ) : (
          offlineTrails.map((t) => (
            <View key={t.id} style={[styles.row, { gap: 8 }]}>
              <View style={[styles.diffDot, { backgroundColor: difficultyColor(t.difficulty) }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{t.name}</Text>
                <Text style={styles.rowMeta}>
                  {t.distance_km != null ? `${t.distance_km.toFixed(1)} km` : "—"}
                  {" · "}
                  Saved {new Date(t.savedAt).toLocaleDateString()}
                </Text>
              </View>
              <TouchableOpacity
                onPress={async () => {
                  await removeOfflineTrail(t.id);
                  await refreshOffline();
                }}
              >
                <Feather name="trash-2" size={16} color={colors.light.destructive} />
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>
      </View>
    </ScrollView>
      </PageLoadingCover>
    </View>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={heroStyles.statCell}>
      <Text style={heroStyles.statValue}>{value}</Text>
      <Text style={heroStyles.statLabel}>{label}</Text>
    </View>
  );
}

const heroStyles = StyleSheet.create({
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.light.primary,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  addText: {
    color: "#1a0e05",
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  statsBar: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: colors.light.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.light.border,
    paddingVertical: 14,
  },
  statCell: { flex: 1, alignItems: "center" },
  statValue: {
    color: colors.light.primary,
    fontSize: 22,
    fontWeight: "900",
  },
  statLabel: {
    color: colors.light.mutedForeground,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginTop: 2,
  },
});

function StorageStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={styles.storageStat}>
      <Text style={[styles.storageValue, accent && { color: colors.light.primary }]}>{value}</Text>
      <Text style={styles.storageLabel}>{label}</Text>
    </View>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Section({
  title,
  loading,
  empty,
  emptyHint,
  controls,
  children,
}: {
  title: string;
  loading: boolean;
  empty?: boolean;
  emptyHint: string;
  controls?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={{ marginBottom: 22 }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {controls ? <View style={{ marginBottom: 10 }}>{controls}</View> : null}
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

function ChipRow({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <View style={styles.chipRow}>
      <Text style={styles.chipRowLabel}>{label}</Text>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", flex: 1 }}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <TouchableOpacity
              key={o.value}
              onPress={() => onChange(o.value)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {o.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function TrailRow({
  id,
  name,
  difficulty,
  meta,
  siblingIds,
}: {
  id: string;
  name: string;
  difficulty: string | number | null;
  meta: string;
  siblingIds?: string;
}) {
  return (
    <Pressable
      style={styles.row}
      onPress={() => {
        const path = `/trail/${encodeURIComponent(id)}` as const;
        if (siblingIds) {
          router.push(`${path}?ids=${encodeURIComponent(siblingIds)}`);
        } else {
          router.push(path);
        }
      }}
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
  const { profile } = useProfile();
  const isPremium = profile.isPremium;
  const [loading, setLoading] = useState(false);
  const isDraft = route.isPublic !== true;
  const trailCount =
    route.trailIds?.length ?? route.trail_count ?? 0;

  async function openOnMap() {
    setLoading(true);
    try {
      const { launchSavedRouteOnMap } = await import("@/lib/plannerMapSession");
      await launchSavedRouteOnMap(route.id);
    } catch (e) {
      Alert.alert(
        "Could not open route",
        e instanceof Error ? e.message : "Try again in a moment.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Pressable
      style={styles.row}
      disabled={loading}
      onPress={() => void openOnMap()}
    >
      <Feather name="git-merge" size={18} color={colors.light.primary} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {route.name}
          </Text>
          {isDraft ? (
            <View style={styles.draftBadge}>
              <Text style={styles.draftBadgeText}>Draft</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.rowMeta}>
          {trailCount} trail{trailCount === 1 ? "" : "s"}
          {!isPremium ? " · Nav & export need Premium" : ""}
        </Text>
      </View>
      {loading ? (
        <ActivityIndicator color={colors.light.primary} size="small" />
      ) : (
        <Feather name="chevron-right" size={18} color={colors.light.mutedForeground} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  clearBtn: { color: colors.light.destructive, fontSize: 12, fontWeight: "700" },
  storageCard: {
    flexDirection: "row",
    backgroundColor: colors.light.card,
    borderRadius: 12,
    borderColor: colors.light.border,
    borderWidth: 1,
    padding: 12,
    marginBottom: 10,
    gap: 4,
  },
  storageStat: { flex: 1, alignItems: "center" },
  storageValue: { color: colors.light.foreground, fontWeight: "800", fontSize: 15 },
  storageLabel: { color: colors.light.mutedForeground, fontSize: 10, marginTop: 2 },
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
  draftBadge: {
    backgroundColor: colors.light.muted,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  draftBadgeText: {
    color: colors.light.mutedForeground,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  empty: {
    paddingVertical: 18,
    paddingHorizontal: 12,
    backgroundColor: colors.light.card,
    borderRadius: 12,
    borderColor: colors.light.border,
    borderWidth: 1,
  },
  emptyText: { color: colors.light.mutedForeground, fontSize: 13 },
  chipRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  chipRowLabel: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    width: 64,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.light.card,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  chipActive: {
    backgroundColor: colors.light.primary,
    borderColor: colors.light.primary,
  },
  chipText: { color: colors.light.foreground, fontSize: 11, fontWeight: "600" },
  chipTextActive: { color: colors.light.primaryForeground },
});
