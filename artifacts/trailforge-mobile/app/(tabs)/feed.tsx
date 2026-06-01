/**
 * Feed tab — community activity stream + leaderboards.
 * Shows achievements, completed trails, condition reports, and new trails
 * from the community.  Leaderboards toggle weekly/monthly/all-time.
 */
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useUser } from "@clerk/clerk-expo";
import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { apiFetch } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FeedEventType = "achievement" | "trail_completed" | "condition_report" | "trail_added" | "route_published";

interface FeedEvent {
  id: string;
  type: FeedEventType;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  title: string;
  subtitle: string | null;
  created_at: string;
  icon: string;
  icon_color: string;
}

type LeaderboardPeriod = "weekly" | "monthly" | "all_time";
type LeaderboardType = "trail_miles" | "trails_completed" | "elevation" | "most_helpful";

interface LeaderboardEntry {
  rank: number;
  display_name: string;
  avatar_url: string | null;
  score: number;
  user_id: string;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchFeed(page = 0): Promise<FeedEvent[]> {
  const res = await apiFetch(`/api/feed?limit=30&offset=${page * 30}`);
  if (!res.ok) return [];
  return (res.json() as Promise<{ events: FeedEvent[] }>).then(d => d.events ?? []);
}

async function fetchLeaderboard(type: LeaderboardType, period: LeaderboardPeriod): Promise<LeaderboardEntry[]> {
  const res = await apiFetch(`/api/leaderboard?type=${type}&period=${period}`);
  if (!res.ok) return [];
  return (res.json() as Promise<{ entries: LeaderboardEntry[] }>).then(d => d.entries ?? []);
}

// ---------------------------------------------------------------------------
// Feed event card
// ---------------------------------------------------------------------------

const EVENT_ICONS: Record<FeedEventType, string> = {
  achievement:      "award",
  trail_completed:  "check-circle",
  condition_report: "alert-circle",
  trail_added:      "plus-circle",
  route_published:  "map",
};

const EVENT_COLORS: Record<FeedEventType, string> = {
  achievement:      "#D97706",
  trail_completed:  "#22c55e",
  condition_report: "#3b82f6",
  trail_added:      "#8b5cf6",
  route_published:  colors.light.primary,
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function FeedCard({ event }: { event: FeedEvent }) {
  const color = EVENT_COLORS[event.type] ?? colors.light.primary;
  const iconName = EVENT_ICONS[event.type] ?? "activity";

  return (
    <View style={feedStyles.card}>
      <View style={[feedStyles.iconWrap, { backgroundColor: color + "22" }]}>
        <Feather name={iconName as keyof typeof Feather.glyphMap} size={18} color={color} />
      </View>
      <View style={feedStyles.body}>
        <Text style={feedStyles.title}>{event.title}</Text>
        {event.subtitle ? <Text style={feedStyles.sub}>{event.subtitle}</Text> : null}
        <View style={feedStyles.meta}>
          <Text style={feedStyles.metaText}>{event.display_name}</Text>
          <Text style={feedStyles.dot}> · </Text>
          <Text style={feedStyles.metaText}>{timeAgo(event.created_at)}</Text>
        </View>
      </View>
    </View>
  );
}

const feedStyles = StyleSheet.create({
  card: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, gap: 2 },
  title: { fontSize: 13, fontWeight: "600", color: colors.light.foreground },
  sub: { fontSize: 12, color: colors.light.mutedForeground },
  meta: { flexDirection: "row", alignItems: "center" },
  metaText: { fontSize: 11, color: colors.light.mutedForeground },
  dot: { color: colors.light.mutedForeground },
});

// ---------------------------------------------------------------------------
// Leaderboard row
// ---------------------------------------------------------------------------

const LEADERBOARD_TYPES: { id: LeaderboardType; label: string }[] = [
  { id: "trail_miles",      label: "Trail Miles" },
  { id: "trails_completed", label: "Completed" },
  { id: "most_helpful",     label: "Helpful" },
];

const PERIOD_LABELS: Record<LeaderboardPeriod, string> = {
  weekly: "Week",
  monthly: "Month",
  all_time: "All Time",
};

function LeaderboardRow({ entry, currentUserId }: { entry: LeaderboardEntry; currentUserId?: string }) {
  const isMe = entry.user_id === currentUserId;
  return (
    <View style={[lbStyles.row, isMe && lbStyles.rowMe]}>
      <Text style={[lbStyles.rank, isMe && lbStyles.textMe]}>#{entry.rank}</Text>
      <View style={lbStyles.nameWrap}>
        <Text style={[lbStyles.name, isMe && lbStyles.textMe]} numberOfLines={1}>
          {entry.display_name}{isMe ? " (you)" : ""}
        </Text>
      </View>
      <Text style={[lbStyles.score, isMe && lbStyles.textMe]}>
        {Math.round(entry.score).toLocaleString()}
      </Text>
    </View>
  );
}

const lbStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.light.border,
    gap: 10,
  },
  rowMe: { backgroundColor: colors.light.primary + "18" },
  rank: { width: 32, fontSize: 13, fontWeight: "700", color: colors.light.mutedForeground },
  nameWrap: { flex: 1 },
  name: { fontSize: 13, color: colors.light.foreground },
  score: { fontSize: 13, fontWeight: "600", color: colors.light.foreground },
  textMe: { color: colors.light.primary },
});

// ---------------------------------------------------------------------------
// Tab toggle component
// ---------------------------------------------------------------------------

function TabToggle<T extends string>({
  options,
  value,
  onSelect,
}: {
  options: { id: T; label: string }[];
  value: T;
  onSelect: (v: T) => void;
}) {
  return (
    <View style={tabStyles.row}>
      {options.map(o => (
        <TouchableOpacity
          key={o.id}
          onPress={() => onSelect(o.id)}
          style={[tabStyles.tab, o.id === value && tabStyles.tabActive]}
        >
          <Text style={[tabStyles.label, o.id === value && tabStyles.labelActive]}>{o.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const tabStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    backgroundColor: colors.light.muted,
    borderRadius: 10,
    padding: 3,
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 8 },
  tabActive: { backgroundColor: colors.light.card },
  label: { fontSize: 12, fontWeight: "600", color: colors.light.mutedForeground },
  labelActive: { color: colors.light.foreground },
});

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

type MainTab = "feed" | "leaderboard";

export default function FeedTab() {
  const { user } = useUser();
  const [mainTab, setMainTab] = useState<MainTab>("feed");
  const [lbType, setLbType] = useState<LeaderboardType>("trail_miles");
  const [lbPeriod, setLbPeriod] = useState<LeaderboardPeriod>("weekly");

  const feedQ = useQuery({
    queryKey: ["feed"],
    queryFn: () => fetchFeed(0),
    staleTime: 60_000,
  });

  const lbQ = useQuery({
    queryKey: ["leaderboard", lbType, lbPeriod],
    queryFn: () => fetchLeaderboard(lbType, lbPeriod),
    staleTime: 5 * 60_000,
  });

  return (
    <View style={styles.root}>
      {/* Main tab bar */}
      <View style={styles.mainTabBar}>
        <TabToggle
          options={[{ id: "feed", label: "Activity" }, { id: "leaderboard", label: "Leaderboard" }]}
          value={mainTab}
          onSelect={setMainTab}
        />
      </View>

      {mainTab === "feed" ? (
        <FlatList
          data={feedQ.data ?? []}
          keyExtractor={e => e.id}
          renderItem={({ item }) => <FeedCard event={item} />}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={feedQ.isFetching}
              onRefresh={() => void feedQ.refetch()}
              tintColor={colors.light.primary}
            />
          }
          ListEmptyComponent={
            feedQ.isLoading
              ? <ActivityIndicator color={colors.light.primary} style={{ marginTop: 40 }} />
              : (
                <View style={styles.empty}>
                  <Feather name="activity" size={40} color={colors.light.mutedForeground} />
                  <Text style={styles.emptyText}>No activity yet</Text>
                  <Text style={styles.emptySub}>Ride trails and share your rides to see activity here.</Text>
                </View>
              )
          }
        />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>
          {/* Leaderboard type selector */}
          <TabToggle options={LEADERBOARD_TYPES} value={lbType} onSelect={setLbType} />

          {/* Period selector */}
          <View style={{ marginTop: 10 }}>
            <TabToggle
              options={(["weekly", "monthly", "all_time"] as LeaderboardPeriod[]).map(p => ({
                id: p,
                label: PERIOD_LABELS[p],
              }))}
              value={lbPeriod}
              onSelect={setLbPeriod}
            />
          </View>

          {/* Leaderboard list */}
          <View style={styles.lbCard}>
            {lbQ.isLoading ? (
              <ActivityIndicator color={colors.light.primary} style={{ padding: 20 }} />
            ) : lbQ.data?.length === 0 ? (
              <Text style={[styles.emptySub, { textAlign: "center", padding: 20 }]}>
                No data yet for this period
              </Text>
            ) : (
              lbQ.data?.map(entry => (
                <LeaderboardRow
                  key={entry.user_id}
                  entry={entry}
                  currentUserId={user?.id}
                />
              ))
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.light.background },
  mainTabBar: { padding: 12, paddingBottom: 4 },
  list: { padding: 12, paddingBottom: 32 },
  empty: { alignItems: "center", marginTop: 60, gap: 8 },
  emptyText: { fontSize: 16, fontWeight: "600", color: colors.light.foreground },
  emptySub: { fontSize: 13, color: colors.light.mutedForeground, textAlign: "center" },
  lbCard: {
    marginTop: 12,
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
});
