/**
 * Admin landing screen. Visible to anyone the API tells us is a moderator
 * (`/api/admin/whoami` returns `isModerator: true`). Non-moderators see a
 * 403 placeholder. Detailed admin tools (review queue, user list) are a
 * port for task #220.
 */
import { useQuery } from "@tanstack/react-query";
import { Stack, router } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { adminWhoami } from "@/lib/api";

export default function AdminScreen() {
  const q = useQuery({ queryKey: ["admin-whoami"], queryFn: adminWhoami });

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.light.primary} />
      </View>
    );
  }

  if (!q.data?.isModerator) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Admin" }} />
        <Text style={styles.h1}>403</Text>
        <Text style={styles.body}>You don't have admin access.</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.btn}>
          <Text style={styles.btnText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.h1}>Welcome, moderator.</Text>
      <Text style={styles.body}>
        Detailed admin tools — AI discovery review, user management, and the
        admin activity log — are available on the web app. Mobile parity is
        tracked in task #220.
      </Text>
      <Text style={styles.note}>
        Signed in as{" "}
        <Text style={{ color: colors.light.foreground, fontWeight: "700" }}>
          {q.data.email ?? "unknown"}
        </Text>
        .
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.light.background,
    padding: 20,
  },
  center: {
    flex: 1,
    backgroundColor: colors.light.background,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 8,
  },
  h1: { color: colors.light.foreground, fontSize: 22, fontWeight: "800" },
  body: { color: colors.light.mutedForeground, fontSize: 14, marginTop: 8 },
  note: { color: colors.light.mutedForeground, fontSize: 13, marginTop: 16 },
  btn: {
    marginTop: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.light.primary,
    borderRadius: 12,
  },
  btnText: { color: colors.light.primaryForeground, fontWeight: "700" },
});
