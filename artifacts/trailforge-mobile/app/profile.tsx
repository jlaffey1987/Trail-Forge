/**
 * Rider profile — gamertag card with mileage, rank, badges, and recent rides.
 */
import { useUser } from "@clerk/clerk-expo";
import { Feather } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PageLoadingCover } from "@/components/PageLoadingCover";
import colors from "@/constants/colors";
import {
  fetchLeaderboard,
  fetchMyRiderProfile,
  fetchRiderProfile,
  patchPreferences,
  type RiderAchievement,
} from "@/lib/api";
import { HOME_REGIONS } from "@/lib/homeRegions";
import { rankProgress } from "@/lib/rankTiers";

const AMBER = colors.light.primary;
const BIKE_OPTIONS = [
  { id: "adventure", label: "Adventure bike" },
  { id: "trail", label: "Trail / dual sport" },
  { id: "enduro", label: "Enduro bike" },
] as const;

function formatKm(km: number): string {
  if (km >= 1000) return `${(km / 1000).toFixed(1)}k km`;
  if (km >= 100) return `${Math.round(km)} km`;
  return `${km.toFixed(1)} km`;
}

export function RiderProfileContent({ userId }: { userId?: string }) {
  const isMe = !userId;
  const insets = useSafeAreaInsets();
  const { user } = useUser();
  const qc = useQueryClient();
  const [bikePickerOpen, setBikePickerOpen] = useState(false);
  const [regionPickerOpen, setRegionPickerOpen] = useState(false);
  const [savingBike, setSavingBike] = useState(false);
  const [savingRegion, setSavingRegion] = useState(false);

  const profileQ = useQuery({
    queryKey: ["rider-profile", userId ?? "me"],
    queryFn: () =>
      userId ? fetchRiderProfile(userId).then((r) => r) : fetchMyRiderProfile(),
  });
  const leaderboardQ = useQuery({
    queryKey: ["leaderboard", "trail_miles"],
    queryFn: () => fetchLeaderboard("trail_miles", "all_time"),
    staleTime: 120_000,
  });

  const profile = profileQ.data?.profile;
  const stats = profile?.stats;
  const progress = stats ? rankProgress(stats.rankPoints) : null;

  async function refreshAll() {
    await Promise.all([profileQ.refetch(), leaderboardQ.refetch()]);
  }

  async function setBike(bikeId: (typeof BIKE_OPTIONS)[number]["id"]) {
    setSavingBike(true);
    try {
      await patchPreferences({ preferred_bike_type: bikeId });
      await qc.invalidateQueries({ queryKey: ["rider-profile", "me"] });
      setBikePickerOpen(false);
    } finally {
      setSavingBike(false);
    }
  }

  async function setRegion(region: string) {
    setSavingRegion(true);
    try {
      await patchPreferences({ home_region: region });
      await qc.invalidateQueries({ queryKey: ["rider-profile", "me"] });
      setRegionPickerOpen(false);
    } finally {
      setSavingRegion(false);
    }
  }

  async function shareProfile() {
    if (!profile || !stats) return;
    const msg = [
      `${displayName} on TrailForge`,
      `${stats.rankTitle} · ${formatKm(stats.trailKmTotal)} ridden · ${stats.trailsCompleted} trails`,
      profile.bikeLabel ? `Rides a ${profile.bikeLabel}` : null,
      profile.homeRegion ? `Mostly in ${profile.homeRegion}` : null,
      "",
      "Explore UK & Ireland adventure trails with TrailForge.",
    ]
      .filter(Boolean)
      .join("\n");
    await Share.share({ message: msg });
  }

  const avatarUrl =
    profile?.avatarUrl ?? (isMe ? user?.imageUrl : null) ?? null;
  const displayName =
    profile?.displayName ?? (isMe ? user?.fullName : null) ?? "TrailForge rider";

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Feather name="arrow-left" size={22} color={colors.light.foreground} />
        </TouchableOpacity>
        <Text style={s.topTitle}>{isMe ? "Rider profile" : displayName}</Text>
        {isMe ? (
          <TouchableOpacity onPress={() => void shareProfile()} hitSlop={12}>
            <Feather name="share-2" size={20} color={colors.light.foreground} />
          </TouchableOpacity>
        ) : (
          <View style={{ width: 22 }} />
        )}
      </View>

      <PageLoadingCover loading={profileQ.isLoading && !profile} message="Loading profile…">
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
          refreshControl={
            <RefreshControl
              refreshing={profileQ.isFetching && !!profile}
              onRefresh={() => void refreshAll()}
              tintColor={AMBER}
            />
          }
        >
          {profile && stats ? (
            <>
              <View style={s.hero}>
                <View style={s.avatarRing}>
                  {avatarUrl ? (
                    <Image source={{ uri: avatarUrl }} style={s.avatar} />
                  ) : (
                    <View style={[s.avatar, s.avatarFallback]}>
                      <Text style={s.avatarInitials}>
                        {displayName.slice(0, 2).toUpperCase()}
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={s.displayName}>{displayName}</Text>
                <View style={s.rankBadge}>
                  <Feather name="award" size={14} color="#1a0e05" />
                  <Text style={s.rankText}>
                    {stats.rankTitle} · Lv {stats.rankLevel}
                  </Text>
                </View>
                {stats.globalRank != null ? (
                  <Text style={s.globalRank}>
                    #{stats.globalRank} by trail miles ridden
                  </Text>
                ) : null}

                {profile.homeRegion ? (
                  <Text style={s.homeRegion}>
                    Rides mostly in {profile.homeRegion}
                  </Text>
                ) : isMe ? (
                  <Text style={s.homeRegionHint}>Add your home region below</Text>
                ) : null}

                {(isMe || profile.bikeLabel) && (
                <View style={s.bikeRow}>
                  <Feather name="navigation" size={14} color={AMBER} />
                  <Text style={s.bikeText}>
                    {profile.bikeLabel ?? "Set your bike"}
                  </Text>
                  {isMe ? (
                  <TouchableOpacity onPress={() => setBikePickerOpen((v) => !v)}>
                    <Text style={s.bikeEdit}>{profile.bikeLabel ? "Change" : "Add"}</Text>
                  </TouchableOpacity>
                  ) : null}
                </View>
                )}

                {isMe && bikePickerOpen ? (
                  <View style={s.bikePicker}>
                    {BIKE_OPTIONS.map((opt) => (
                      <TouchableOpacity
                        key={opt.id}
                        style={s.bikeOption}
                        disabled={savingBike}
                        onPress={() => void setBike(opt.id)}
                      >
                        <Text style={s.bikeOptionText}>{opt.label}</Text>
                        {savingBike ? (
                          <ActivityIndicator size="small" color={AMBER} />
                        ) : null}
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}

                {isMe ? (
                  <>
                    <View style={[s.bikeRow, { marginTop: 10 }]}>
                      <Feather name="map-pin" size={14} color={AMBER} />
                      <Text style={s.bikeText}>
                        {profile.homeRegion ?? "Home region"}
                      </Text>
                      <TouchableOpacity onPress={() => setRegionPickerOpen((v) => !v)}>
                        <Text style={s.bikeEdit}>
                          {profile.homeRegion ? "Change" : "Add"}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    {regionPickerOpen ? (
                      <View style={s.bikePicker}>
                        {HOME_REGIONS.map((region) => (
                          <TouchableOpacity
                            key={region}
                            style={s.bikeOption}
                            disabled={savingRegion}
                            onPress={() => void setRegion(region)}
                          >
                            <Text style={s.bikeOptionText}>{region}</Text>
                            {savingRegion ? (
                              <ActivityIndicator size="small" color={AMBER} />
                            ) : null}
                          </TouchableOpacity>
                        ))}
                      </View>
                    ) : null}
                  </>
                ) : null}
              </View>

              <View style={s.statsGrid}>
                <StatCard label="Trail miles" value={formatKm(stats.trailKmTotal)} />
                <StatCard label="Trails ridden" value={String(stats.trailsCompleted)} />
                <StatCard label="Rank points" value={String(stats.rankPoints)} />
              </View>

              {progress?.next ? (
                <View style={s.progressCard}>
                  <View style={s.progressHeader}>
                    <Text style={s.progressLabel}>Next rank: {progress.next.title}</Text>
                    <Text style={s.progressMeta}>
                      {progress.pointsToNext} pts to go
                    </Text>
                  </View>
                  <View style={s.progressTrack}>
                    <View
                      style={[s.progressFill, { width: `${Math.round(progress.progress * 100)}%` }]}
                    />
                  </View>
                </View>
              ) : null}

              <Section title="Achievements" count={profile.achievements.length}>
                {profile.achievements.length === 0 ? (
                  <Text style={s.emptyHint}>
                    Mark trails as ridden on the map to earn your first badges.
                  </Text>
                ) : (
                  <View style={s.badgeGrid}>
                    {profile.achievements.map((a) => (
                      <AchievementBadge key={a.key} achievement={a} />
                    ))}
                  </View>
                )}
              </Section>

              <Section title="Recently ridden" count={profile.recentTrails.length}>
                {profile.recentTrails.length === 0 ? (
                  <Text style={s.emptyHint}>
                    Tap a trail on the map and choose &quot;Mark as ridden&quot; after your ride.
                  </Text>
                ) : (
                  profile.recentTrails.map((t) => (
                    <Pressable
                      key={`${t.trailId}-${t.completedAt}`}
                      style={s.trailRow}
                      onPress={() =>
                        router.push(`/trail/${encodeURIComponent(t.trailId)}`)
                      }
                    >
                      <Feather name="check-circle" size={16} color="#22c55e" />
                      <View style={{ flex: 1 }}>
                        <Text style={s.trailName} numberOfLines={1}>
                          {t.name}
                        </Text>
                        <Text style={s.trailMeta}>
                          {t.distanceKm != null ? `${t.distanceKm.toFixed(1)} km · ` : ""}
                          {String(t.difficulty ?? "—")}
                          {" · "}
                          {new Date(t.completedAt).toLocaleDateString()}
                        </Text>
                      </View>
                      <Feather name="chevron-right" size={16} color={colors.light.mutedForeground} />
                    </Pressable>
                  ))
                )}
              </Section>

              <Section title="Leaderboard" count={leaderboardQ.data?.length ?? 0}>
                {leaderboardQ.isLoading ? (
                  <ActivityIndicator color={AMBER} style={{ marginVertical: 12 }} />
                ) : (leaderboardQ.data ?? []).length === 0 ? (
                  <Text style={s.emptyHint}>
                    Leaderboard updates as riders log miles. Keep riding to climb the ranks.
                  </Text>
                ) : (
                  (leaderboardQ.data ?? []).slice(0, 10).map((entry) => (
                    <View key={`${entry.user_id}-${entry.rank}`} style={s.lbRow}>
                      <Text style={s.lbRank}>#{entry.rank}</Text>
                      {entry.avatar_url ? (
                        <Image source={{ uri: entry.avatar_url }} style={s.lbAvatar} />
                      ) : (
                        <View style={[s.lbAvatar, s.avatarFallback]}>
                          <Text style={s.lbInitials}>
                            {(entry.display_name ?? "?").slice(0, 1).toUpperCase()}
                          </Text>
                        </View>
                      )}
                      <Text style={s.lbName} numberOfLines={1}>
                        {entry.display_name ?? "Rider"}
                      </Text>
                      <Text style={s.lbScore}>
                        {entry.score != null ? `${Math.round(entry.score)} km` : "—"}
                      </Text>
                    </View>
                  ))
                )}
              </Section>
            </>
          ) : profileQ.isError ? (
            <Text style={s.emptyHint}>Could not load your profile. Pull to refresh.</Text>
          ) : null}
        </ScrollView>
      </PageLoadingCover>
    </View>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.statCard}>
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <View style={s.section}>
      <View style={s.sectionHeader}>
        <Text style={s.sectionTitle}>{title}</Text>
        {count > 0 ? <Text style={s.sectionCount}>{count}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function AchievementBadge({ achievement }: { achievement: RiderAchievement }) {
  const colour = achievement.colour ?? AMBER;
  return (
    <View style={[s.badge, { borderColor: colour }]}>
      <View style={[s.badgeIcon, { backgroundColor: `${colour}22` }]}>
        <Feather
          name={(achievement.icon as keyof typeof Feather.glyphMap) ?? "award"}
          size={18}
          color={colour}
        />
      </View>
      <Text style={s.badgeName} numberOfLines={2}>
        {achievement.name}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.light.background },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  topTitle: {
    color: colors.light.foreground,
    fontWeight: "800",
    fontSize: 16,
  },
  hero: {
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  avatarRing: {
    borderWidth: 3,
    borderColor: AMBER,
    borderRadius: 999,
    padding: 3,
    marginBottom: 12,
  },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
  },
  avatarFallback: {
    backgroundColor: colors.light.card,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitials: {
    color: colors.light.foreground,
    fontWeight: "900",
    fontSize: 28,
  },
  displayName: {
    color: colors.light.foreground,
    fontSize: 22,
    fontWeight: "900",
    textAlign: "center",
  },
  rankBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: AMBER,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 10,
  },
  rankText: {
    color: "#1a0e05",
    fontWeight: "800",
    fontSize: 13,
  },
  globalRank: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    marginTop: 8,
  },
  homeRegion: {
    color: colors.light.foreground,
    fontSize: 13,
    fontWeight: "600",
    marginTop: 8,
  },
  homeRegionHint: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    marginTop: 8,
  },
  bikeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 14,
  },
  bikeText: {
    color: colors.light.foreground,
    fontWeight: "600",
    fontSize: 14,
  },
  bikeEdit: {
    color: AMBER,
    fontWeight: "700",
    fontSize: 13,
  },
  bikePicker: {
    marginTop: 10,
    width: "100%",
    gap: 6,
  },
  bikeOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.light.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.light.border,
    padding: 12,
  },
  bikeOptionText: {
    color: colors.light.foreground,
    fontWeight: "600",
  },
  statsGrid: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    marginTop: 16,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.light.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.light.border,
    padding: 12,
    alignItems: "center",
  },
  statValue: {
    color: colors.light.foreground,
    fontWeight: "900",
    fontSize: 18,
  },
  statLabel: {
    color: colors.light.mutedForeground,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    marginTop: 4,
    textAlign: "center",
  },
  progressCard: {
    marginHorizontal: 16,
    marginTop: 14,
    backgroundColor: colors.light.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.light.border,
    padding: 14,
  },
  progressHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  progressLabel: {
    color: colors.light.foreground,
    fontWeight: "700",
    fontSize: 13,
  },
  progressMeta: {
    color: colors.light.mutedForeground,
    fontSize: 12,
  },
  progressTrack: {
    height: 8,
    backgroundColor: colors.light.muted,
    borderRadius: 999,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: AMBER,
    borderRadius: 999,
  },
  section: {
    marginTop: 22,
    paddingHorizontal: 16,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  sectionTitle: {
    color: colors.light.foreground,
    fontSize: 16,
    fontWeight: "800",
  },
  sectionCount: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    fontWeight: "700",
  },
  emptyHint: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    lineHeight: 19,
    backgroundColor: colors.light.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.light.border,
    padding: 14,
  },
  badgeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  badge: {
    width: "30%",
    minWidth: 96,
    backgroundColor: colors.light.card,
    borderRadius: 12,
    borderWidth: 1,
    padding: 10,
    alignItems: "center",
  },
  badgeIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  badgeName: {
    color: colors.light.foreground,
    fontSize: 11,
    fontWeight: "700",
    textAlign: "center",
  },
  trailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.light.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.light.border,
    padding: 12,
    marginBottom: 8,
  },
  trailName: {
    color: colors.light.foreground,
    fontWeight: "700",
    fontSize: 14,
  },
  trailMeta: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    marginTop: 2,
  },
  lbRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.light.border,
  },
  lbRank: {
    width: 28,
    color: AMBER,
    fontWeight: "900",
    fontSize: 13,
  },
  lbAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  lbInitials: {
    color: colors.light.foreground,
    fontWeight: "800",
    fontSize: 12,
  },
  lbName: {
    flex: 1,
    color: colors.light.foreground,
    fontWeight: "600",
    fontSize: 14,
  },
  lbScore: {
    color: colors.light.mutedForeground,
    fontWeight: "700",
    fontSize: 12,
  },
});

export default function ProfileScreen() {
  return <RiderProfileContent />;
}
