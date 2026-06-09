/**
 * Header dropdown shown in tab screens. Profile info, quick links to
 * the record-a-ride screen, and sign-out. Admin lives in the bottom
 * tab bar as a role-gated tab — see app/(tabs)/_layout.tsx.
 */
import { useAuth, useUser } from "@clerk/clerk-expo";
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { fetchMyRiderProfile } from "@/lib/api";
import { ONBOARDING_KEY } from "@/lib/storageKeys";
import { useProfile } from "@/components/ProfileContext";

export function UserMenu() {
  const { user } = useUser();
  const { signOut } = useAuth();
  const { profile } = useProfile();
  const [open, setOpen] = useState(false);
  const riderQ = useQuery({
    queryKey: ["rider-profile", "me"],
    queryFn: fetchMyRiderProfile,
    staleTime: 60_000,
  });
  const riderStats = riderQ.data?.profile.stats;

  if (!user) return null;

  const initials = (user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "?")
    .slice(0, 2)
    .toUpperCase();
  const photoUrl = user.imageUrl ?? riderQ.data?.profile.avatarUrl ?? null;

  return (
    <>
      <TouchableOpacity
        accessibilityLabel="Open user menu"
        onPress={() => setOpen(true)}
        style={styles.avatar}
      >
        {photoUrl ? (
          <Image source={{ uri: photoUrl }} style={styles.avatarImage} />
        ) : (
          <Text style={styles.avatarText}>{initials}</Text>
        )}
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setOpen(false)}>
          <View style={styles.menu}>
            <View style={styles.identity}>
              <Text style={styles.name}>{user.fullName ?? "TrailForge rider"}</Text>
              {riderStats ? (
                <Text style={styles.riderTag} numberOfLines={1}>
                  {riderStats.rankTitle} · {riderStats.trailKmTotal.toFixed(0)} km ridden
                </Text>
              ) : null}
              <Text style={styles.email} numberOfLines={1}>
                {user.primaryEmailAddress?.emailAddress ?? ""}
              </Text>
            </View>

            <MenuItem
              icon="star"
              label={profile.isPremium ? "Membership" : "Free vs Premium"}
              onPress={() => {
                setOpen(false);
                router.push("/membership" as never);
              }}
            />
            <MenuItem
              icon="user"
              label="Rider profile"
              onPress={() => {
                setOpen(false);
                router.push("/profile" as never);
              }}
            />
            <MenuItem
              icon="map"
              label="My trails & routes"
              onPress={() => {
                setOpen(false);
                router.push("/(tabs)/trails");
              }}
            />
            <MenuItem
              icon="activity"
              label="Record a ride"
              onPress={() => {
                setOpen(false);
                router.push("/record");
              }}
            />
            <MenuItem
              icon="play-circle"
              label="Redo onboarding"
              onPress={async () => {
                setOpen(false);
                await AsyncStorage.removeItem(ONBOARDING_KEY);
                // Cast needed until expo-router rebuilds its type manifest
                router.replace(
                  "/onboarding" as unknown as Parameters<typeof router.replace>[0]
                );
              }}
            />
            {profile.isLinesman && (
              <MenuItem
                icon="tool"
                label="Linesman Tools"
                onPress={() => {
                  setOpen(false);
                  router.push("/linesman" as unknown as Parameters<typeof router.push>[0]);
                }}
              />
            )}
            <MenuItem
              icon="navigation"
              label="Navigation Settings"
              onPress={() => {
                setOpen(false);
                router.push("/nav-settings" as unknown as Parameters<typeof router.push>[0]);
              }}
            />
            <View style={styles.divider} />
            <MenuItem
              icon="log-out"
              label="Sign out"
              destructive
              onPress={() => {
                setOpen(false);
                void signOut();
              }}
            />
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

function MenuItem({
  icon,
  label,
  onPress,
  destructive,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.item}>
      <Feather
        name={icon}
        size={18}
        color={destructive ? colors.light.destructive : colors.light.foreground}
      />
      <Text
        style={[
          styles.itemLabel,
          destructive && { color: colors.light.destructive },
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.light.primary,
    overflow: "hidden",
  },
  avatarImage: {
    width: 34,
    height: 34,
  },
  avatarText: {
    color: colors.light.primaryForeground,
    fontWeight: "700",
    fontSize: 12,
  },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-start",
    alignItems: "flex-end",
    paddingTop: 80,
    paddingRight: 12,
  },
  menu: {
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 14,
    width: 240,
    paddingVertical: 8,
  },
  identity: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.light.border,
  },
  name: { color: colors.light.foreground, fontWeight: "700", fontSize: 14 },
  riderTag: {
    color: colors.light.primary,
    fontSize: 11,
    fontWeight: "700",
    marginTop: 3,
  },
  email: { color: colors.light.mutedForeground, fontSize: 12, marginTop: 2 },
  item: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  itemLabel: { color: colors.light.foreground, fontSize: 14 },
  divider: {
    height: 1,
    backgroundColor: colors.light.border,
    marginVertical: 4,
    marginHorizontal: 6,
  },
});
