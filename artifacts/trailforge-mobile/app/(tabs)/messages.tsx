/**
 * Messages inbox — list of chat rooms with unread counts. Tap to open
 * the thread at /messages/[roomId]. Long-press a row to archive it.
 */
import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { archiveRoom, listChatRooms, type ChatRoom } from "@/lib/api";

export default function MessagesTab() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["chat-rooms"],
    queryFn: listChatRooms,
    // Refresh every 30s while the inbox is open — SSE handles the live
    // updates inside the thread itself.
    refetchInterval: 30_000,
  });

  const archiveMut = useMutation({
    mutationFn: (roomId: string) => archiveRoom(roomId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["chat-rooms"] });
    },
    onError: (err) =>
      Alert.alert(
        "Archive failed",
        err instanceof Error ? err.message : "Unknown error",
      ),
  });

  function onLongPressRoom(room: ChatRoom) {
    Alert.alert(room.title ?? "Conversation", "What would you like to do?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Archive",
        style: "destructive",
        onPress: () => archiveMut.mutate(room.id),
      },
    ]);
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={{
        padding: 16,
        paddingBottom: 100,
        flexGrow: 1,
      }}
      data={q.data?.rooms ?? []}
      keyExtractor={(r) => r.id}
      refreshControl={
        <RefreshControl
          refreshing={q.isFetching}
          onRefresh={() => void q.refetch()}
          tintColor={colors.light.primary}
        />
      }
      ListHeaderComponent={
        <TouchableOpacity
          style={styles.blockedLink}
          onPress={() => router.push("/blocked")}
        >
          <Feather name="user-x" size={14} color={colors.light.mutedForeground} />
          <Text style={styles.blockedLinkText}>Manage blocked users</Text>
          <Feather
            name="chevron-right"
            size={16}
            color={colors.light.mutedForeground}
          />
        </TouchableOpacity>
      }
      ListEmptyComponent={
        q.isLoading ? (
          <ActivityIndicator color={colors.light.primary} />
        ) : (
          <View style={styles.empty}>
            <Feather name="mail" size={28} color={colors.light.mutedForeground} />
            <Text style={styles.emptyTitle}>No conversations yet</Text>
            <Text style={styles.emptyBody}>
              Open a rider's profile to send them a message, or join a group
              to start a thread.
            </Text>
          </View>
        )
      }
      renderItem={({ item }) => (
        <RoomRow room={item} onLongPress={() => onLongPressRoom(item)} />
      )}
    />
  );
}

function RoomRow({
  room,
  onLongPress,
}: {
  room: ChatRoom;
  onLongPress: () => void;
}) {
  const title = room.title ?? (room.kind === "dm" ? "Direct message" : "Group");
  const preview = room.last_message_preview ?? "—";
  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: "/messages/[roomId]",
          params: { roomId: room.id },
        })
      }
      onLongPress={onLongPress}
      delayLongPress={350}
      style={styles.row}
    >
      <View style={styles.avatar}>
        <Feather
          name={room.kind === "dm" ? "user" : "users"}
          size={18}
          color={colors.light.primary}
        />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {room.last_message_at ? (
            <Text style={styles.timestamp}>
              {formatTime(room.last_message_at)}
            </Text>
          ) : null}
        </View>
        <Text style={styles.preview} numberOfLines={1}>
          {preview}
        </Text>
      </View>
      {room.unread_count > 0 ? (
        <View style={styles.unread}>
          <Text style={styles.unreadText}>{room.unread_count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString();
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
    alignItems: "center",
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.light.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  title: {
    color: colors.light.foreground,
    fontWeight: "700",
    flex: 1,
  },
  timestamp: { color: colors.light.mutedForeground, fontSize: 11 },
  preview: { color: colors.light.mutedForeground, fontSize: 12, marginTop: 2 },
  unread: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    backgroundColor: colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadText: { color: colors.light.primaryForeground, fontSize: 11, fontWeight: "700" },
  empty: { alignItems: "center", paddingVertical: 60, gap: 8 },
  emptyTitle: { color: colors.light.foreground, fontSize: 16, fontWeight: "700", marginTop: 6 },
  emptyBody: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  blockedLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.light.muted,
    borderRadius: 10,
    marginBottom: 12,
  },
  blockedLinkText: {
    flex: 1,
    color: colors.light.foreground,
    fontSize: 13,
    fontWeight: "600",
  },
});
