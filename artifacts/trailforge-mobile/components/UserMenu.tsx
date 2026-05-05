/**
 * Header dropdown shown in tab screens. Provides:
 *   - Display of the current user's name + email.
 *   - A link to the Admin screen (only when the user is a moderator).
 *   - Sign-out.
 */
import { useAuth, useUser } from "@clerk/clerk-expo";
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
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
import { adminWhoami } from "@/lib/api";

export function UserMenu() {
  const { user } = useUser();
  const { signOut, isSignedIn } = useAuth();
  const [open, setOpen] = useState(false);

  // The `adminWhoami` lookup also doubles as the "is the API reachable"
  // health-check on app launch. We keep its result for an hour because
  // moderator status rarely changes.
  const { data: admin } = useQuery({
    queryKey: ["admin-whoami"],
    queryFn: adminWhoami,
    staleTime: 60 * 60 * 1000,
    retry: false,
    enabled: !!isSignedIn,
  });

  if (!user) return null;

  const initials = (user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "?")
    .slice(0, 2)
    .toUpperCase();

  return (
    <>
      <TouchableOpacity
        accessibilityLabel="Open user menu"
        onPress={() => setOpen(true)}
        style={styles.avatar}
      >
        <Text style={styles.avatarText}>{initials}</Text>
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
              <Text style={styles.email} numberOfLines={1}>
                {user.primaryEmailAddress?.emailAddress ?? ""}
              </Text>
            </View>

            <MenuItem
              icon="user"
              label="My profile"
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
            {admin?.isModerator ? (
              <MenuItem
                icon="shield"
                label="Admin"
                onPress={() => {
                  setOpen(false);
                  router.push("/admin");
                }}
              />
            ) : null}
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
