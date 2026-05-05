/**
 * Header bell that shows the unread group-activity count and routes to
 * the activity feed. Polls /api/me/notifications every 60s; mirrors the
 * web NotificationsBell behaviour.
 */
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import colors from "@/constants/colors";
import { listMyNotifications } from "@/lib/api";

export function NotificationsBell() {
  const q = useQuery({
    queryKey: ["my-notifications"],
    queryFn: () => listMyNotifications({ limit: 20 }),
    refetchInterval: 60_000,
  });
  const unread = q.data?.unreadCount ?? 0;
  const label = unread > 99 ? "99+" : String(unread);

  return (
    <TouchableOpacity
      accessibilityLabel={
        unread > 0 ? `Activity (${unread} unread)` : "Activity"
      }
      onPress={() => router.push("/activity")}
      style={styles.btn}
      hitSlop={8}
    >
      <Feather name="bell" size={20} color={colors.light.foreground} />
      {unread > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{label}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingHorizontal: 6,
    paddingVertical: 6,
    marginRight: 4,
  },
  badge: {
    position: "absolute",
    top: 0,
    right: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.light.destructive,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "800",
  },
});
