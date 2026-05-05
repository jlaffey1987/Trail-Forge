/**
 * Activity feed — group notifications surface (mirrors the web
 * NotificationsBell + flyout). Lists trail shares, member joins/leaves,
 * trail unshares, photo posts, and declined invites across every group
 * the user belongs to. Pull-to-refresh and "Mark all as read" mirror
 * the web behaviour.
 */
import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import {
  listMyNotifications,
  markAllNotificationsRead,
  type GroupNotification,
} from "@/lib/api";

export default function ActivityScreen() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["my-notifications"],
    queryFn: () => listMyNotifications({ limit: 50 }),
    refetchInterval: 60_000,
  });

  const markReadMut = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["my-notifications"] });
    },
  });

  const items = q.data?.items ?? [];
  const unread = q.data?.unreadCount ?? 0;

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={{ padding: 16, paddingBottom: 80, flexGrow: 1 }}
      data={items}
      keyExtractor={(n) => n.id}
      refreshControl={
        <RefreshControl
          refreshing={q.isFetching}
          onRefresh={() => void q.refetch()}
          tintColor={colors.light.primary}
        />
      }
      ListHeaderComponent={
        unread > 0 ? (
          <TouchableOpacity
            style={styles.markReadBtn}
            onPress={() => markReadMut.mutate()}
            disabled={markReadMut.isPending}
          >
            <Feather name="check" size={14} color={colors.light.primary} />
            <Text style={styles.markReadText}>
              Mark {unread} as read
            </Text>
          </TouchableOpacity>
        ) : null
      }
      ListEmptyComponent={
        q.isLoading ? (
          <ActivityIndicator color={colors.light.primary} />
        ) : (
          <View style={styles.empty}>
            <Feather name="bell-off" size={28} color={colors.light.mutedForeground} />
            <Text style={styles.emptyTitle}>No activity yet</Text>
            <Text style={styles.emptyBody}>
              When members of your groups share trails or join up, you'll
              see it here.
            </Text>
          </View>
        )
      }
      renderItem={({ item }) => <NotifRow notif={item} />}
    />
  );
}

function NotifRow({ notif }: { notif: GroupNotification }) {
  const actor =
    notif.actor.display_name ??
    (notif.actor.email ? notif.actor.email.split("@")[0] : null) ??
    "A rider";

  let icon: React.ComponentProps<typeof Feather>["name"] = "bell";
  let body = "";
  let onPress: (() => void) | null = null;

  if (notif.type === "trail_shared") {
    icon = "share-2";
    body = `${actor} shared "${notif.trail.name}" in ${notif.group.name}`;
    if (notif.trail.id) {
      const trailId = notif.trail.id;
      onPress = () =>
        router.push({
          pathname: "/trail/[trailId]",
          params: { trailId },
        });
    }
  } else if (notif.type === "member_joined") {
    icon = "user-plus";
    body = `${actor} joined ${notif.group.name}`;
  } else if (notif.type === "member_left") {
    icon = "user-minus";
    const subject =
      notif.subject.display_name ??
      (notif.subject.email ? notif.subject.email.split("@")[0] : null) ??
      "A rider";
    body = notif.removed_by_admin
      ? `${actor} removed ${subject} from ${notif.group.name}`
      : `${subject} left ${notif.group.name}`;
  } else if (notif.type === "trail_unshared") {
    icon = "x-circle";
    body = `${actor} unshared "${notif.trail.name}" from ${notif.group.name}`;
  } else if (notif.type === "photo_shared") {
    icon = "image";
    body = `${actor} shared a photo in ${notif.group.name}`;
  } else if (notif.type === "invite_declined") {
    icon = "user-x";
    body = `${notif.decliner_label} declined an invite to ${notif.group.name}`;
  }

  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper
      onPress={onPress ?? undefined}
      style={[styles.row, notif.unread && styles.rowUnread]}
    >
      <View style={styles.iconWrap}>
        <Feather name={icon} size={16} color={colors.light.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.body}>{body}</Text>
        <Text style={styles.timestamp}>{formatRelative(notif.occurred_at)}</Text>
      </View>
      {notif.unread ? <View style={styles.unreadDot} /> : null}
    </Wrapper>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
  row: {
    flexDirection: "row",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 12,
    marginBottom: 8,
    alignItems: "flex-start",
  },
  rowUnread: {
    backgroundColor: colors.light.muted,
    borderColor: colors.light.primary,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.light.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { color: colors.light.foreground, fontSize: 14, lineHeight: 18 },
  timestamp: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    marginTop: 2,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.light.primary,
    marginTop: 12,
  },
  markReadBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.light.muted,
    borderRadius: 10,
    alignSelf: "flex-start",
    marginBottom: 12,
  },
  markReadText: {
    color: colors.light.primary,
    fontSize: 13,
    fontWeight: "700",
  },
  empty: { alignItems: "center", paddingVertical: 60, gap: 8 },
  emptyTitle: {
    color: colors.light.foreground,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 6,
  },
  emptyBody: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    textAlign: "center",
    paddingHorizontal: 32,
  },
});
