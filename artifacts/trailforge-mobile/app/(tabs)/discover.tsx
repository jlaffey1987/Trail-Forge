/**
 * Discover tab — browse public routes (`useListPublicRoutes`) and groups.
 * Tap a route to see its details (#220 will deep-link into the route
 * comments thread).
 */
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useListPublicRoutes } from "@workspace/api-client-react";
import React, { useState } from "react";
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
import { createGroup, listMyGroups, type Group } from "@/lib/api";

interface PublicRoute {
  id: string;
  name: string;
  author?: string | null;
  trail_count?: number | null;
  like_count?: number | null;
}

export default function DiscoverTab() {
  const routesQ = useListPublicRoutes();
  const groupsQ = useQuery({ queryKey: ["my-groups"], queryFn: listMyGroups });
  const [groupName, setGroupName] = useState("");
  const [creating, setCreating] = useState(false);

  const routes =
    (routesQ.data as { routes?: PublicRoute[] } | undefined)?.routes ?? [];
  const groups = groupsQ.data?.groups ?? [];

  async function onCreateGroup() {
    if (!groupName.trim()) return;
    setCreating(true);
    try {
      await createGroup(groupName.trim());
      setGroupName("");
      void groupsQ.refetch();
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
          }}
          tintColor={colors.light.primary}
        />
      }
      ListHeaderComponent={
        <View style={{ marginBottom: 22 }}>
          <Text style={styles.h1}>Discover</Text>

          <Text style={styles.sectionTitle}>My groups</Text>
          {groupsQ.isLoading ? (
            <ActivityIndicator color={colors.light.primary} />
          ) : groups.length === 0 ? (
            <Text style={styles.emptyText}>You're not in any group yet.</Text>
          ) : (
            groups.map((g: Group) => <GroupRow key={g.id} group={g} />)
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
            Public routes
          </Text>
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
  );
}

function GroupRow({ group }: { group: Group }) {
  return (
    <Pressable style={styles.groupRow}>
      <Feather name="users" size={18} color={colors.light.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{group.name}</Text>
        <Text style={styles.rowMeta}>
          {group.member_count} member{group.member_count === 1 ? "" : "s"}
          {group.is_owner ? " • owner" : ""}
        </Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.light.mutedForeground} />
    </Pressable>
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
});
