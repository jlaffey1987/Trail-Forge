import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useSyncMe } from "@workspace/api-client-react";
import { Tabs } from "expo-router";
import React, { useEffect, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";

import { AuthGate } from "@/components/AuthGate";
import { NotificationsBell } from "@/components/NotificationsBell";
import {
  ProfileProvider,
  useProfile,
  type BikeType,
} from "@/components/ProfileContext";
import { UserMenu } from "@/components/UserMenu";
import colors from "@/constants/colors";
import { adminWhoami } from "@/lib/api";
import { registerForPushAndSubscribe } from "@/lib/pushSetup";
import { rehydrate as rehydrateRecording } from "@/lib/recording";

/**
 * Mirror the Clerk user into Supabase + register for Expo push on launch.
 * Mounted inside the auth gate so we know the bearer token is available.
 */
function PostLoginBootstrap() {
  const sync = useSyncMe();
  const { setProfile } = useProfile();
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    sync.mutate(undefined, {
      onSuccess(data) {
        setProfile({
          isPremium: data.is_premium ?? false,
          preferredBikeType: (data.preferred_bike_type as BikeType | undefined) ?? "all",
        });
      },
      onError(err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[PostLoginBootstrap] /me/sync failed:", msg);
        setSyncError(msg);
      },
    });
    void registerForPushAndSubscribe();
    void rehydrateRecording();
    // We deliberately want this to run exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (syncError) {
    if (__DEV__) {
      return (
        <View
          style={{
            position: "absolute",
            bottom: 100,
            left: 16,
            right: 16,
            backgroundColor: "#7f1d1d",
            borderRadius: 8,
            padding: 12,
            zIndex: 9999,
          }}
          pointerEvents="none"
        >
          <Text style={{ color: "#fca5a5", fontSize: 11, fontFamily: "monospace" }}>
            API sync failed: {syncError}
          </Text>
        </View>
      );
    }
  }

  return null;
}

export default function TabLayout() {
  // Whoami doubles as a tab-visibility check. We only render the
  // role-gated Admin tab when the API confirms the user is a moderator.
  const adminQ = useQuery({
    queryKey: ["admin-whoami"],
    queryFn: adminWhoami,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  const isAdmin = adminQ.data?.isModerator === true;

  return (
    <ProfileProvider>
    <AuthGate>
      <PostLoginBootstrap />
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: colors.light.primary,
          tabBarInactiveTintColor: colors.light.mutedForeground,
          tabBarStyle: {
            backgroundColor: colors.light.background,
            borderTopColor: colors.light.border,
            borderTopWidth: StyleSheet.hairlineWidth,
            height: Platform.OS === "ios" ? 88 : 64,
            paddingTop: 6,
          },
          tabBarLabelStyle: {
            fontSize: 10,
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          },
          headerStyle: { backgroundColor: colors.light.background },
          headerTitleStyle: {
            color: colors.light.foreground,
            fontWeight: "700",
          },
          headerTintColor: colors.light.foreground,
          headerRight: () => (
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <NotificationsBell />
              <UserMenu />
            </View>
          ),
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Planner",
            tabBarIcon: ({ color }) => (
              <Feather name="map-pin" size={20} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="map"
          options={{
            title: "Map",
            tabBarIcon: ({ color }) => (
              <Feather name="map" size={20} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="trails"
          options={{
            title: "Trails",
            tabBarIcon: ({ color }) => (
              <Feather name="bookmark" size={20} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="discover"
          options={{
            title: "Discover",
            tabBarIcon: ({ color }) => (
              <Feather name="search" size={20} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="ai"
          options={{
            title: "AI",
            tabBarIcon: ({ color }) => (
              <Feather name="message-circle" size={20} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="messages"
          options={{
            title: "Messages",
            tabBarIcon: ({ color }) => (
              <Feather name="mail" size={20} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="admin"
          options={{
            title: "Admin",
            // Hide the tab entirely until whoami confirms moderator
            // status. We can't actually unmount the screen file (Expo
            // Router would 404), so we set href:null which removes it
            // from the tab bar without unregistering it.
            href: isAdmin ? "/admin" : null,
            tabBarIcon: ({ color }) => (
              <Feather name="shield" size={20} color={color} />
            ),
          }}
        />
      </Tabs>
    </AuthGate>
    </ProfileProvider>
  );
}
