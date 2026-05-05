/**
 * Blocked users — manage who the current rider has blocked from messaging
 * them. Web parity: the web app has a "Privacy → Blocked users" panel
 * with the same swipe-to-unblock affordance. Mobile uses a tap-confirm
 * pattern instead because RN's Swipeable adds gesture coordination
 * complexity that isn't worth it for a low-frequency surface.
 */
import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { listMyBlocks, unblockUser, type BlockedUser } from "@/lib/api";

export default function BlockedUsersScreen() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["my-blocks"],
    queryFn: listMyBlocks,
  });

  const unblockMut = useMutation({
    mutationFn: (userId: string) => unblockUser(userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["my-blocks"] });
    },
    onError: (err) =>
      Alert.alert(
        "Unblock failed",
        err instanceof Error ? err.message : "Unknown error",
      ),
  });

  function confirmUnblock(u: BlockedUser) {
    const name = u.display_name ?? "this user";
    Alert.alert(
      `Unblock ${name}?`,
      "They'll be able to send you messages again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unblock",
          style: "destructive",
          onPress: () => unblockMut.mutate(u.user_id),
        },
      ],
    );
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={{ padding: 16, paddingBottom: 80, flexGrow: 1 }}
      data={q.data?.blocks ?? []}
      keyExtractor={(u) => u.user_id}
      refreshControl={
        <RefreshControl
          refreshing={q.isFetching}
          onRefresh={() => void q.refetch()}
          tintColor={colors.light.primary}
        />
      }
      ListEmptyComponent={
        q.isLoading ? (
          <ActivityIndicator color={colors.light.primary} />
        ) : (
          <View style={styles.empty}>
            <Feather
              name="user-check"
              size={28}
              color={colors.light.mutedForeground}
            />
            <Text style={styles.emptyTitle}>No blocked users</Text>
            <Text style={styles.emptyBody}>
              When you block someone from a chat, they'll appear here.
            </Text>
          </View>
        )
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.avatar}>
            <Feather name="user-x" size={18} color={colors.light.destructive} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name} numberOfLines={1}>
              {item.display_name ?? "Unnamed rider"}
            </Text>
            <Text style={styles.sub} numberOfLines={1}>
              {item.user_id.slice(0, 12)}…
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => confirmUnblock(item)}
            disabled={unblockMut.isPending}
            style={styles.unblockBtn}
          >
            <Text style={styles.unblockText}>Unblock</Text>
          </TouchableOpacity>
        </View>
      )}
    />
  );
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
  name: { color: colors.light.foreground, fontWeight: "700" },
  sub: { color: colors.light.mutedForeground, fontSize: 12, marginTop: 2 },
  unblockBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.light.muted,
  },
  unblockText: {
    color: colors.light.foreground,
    fontSize: 12,
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
