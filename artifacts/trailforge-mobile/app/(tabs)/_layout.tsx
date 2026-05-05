import { Feather } from "@expo/vector-icons";
import { useSyncMe } from "@workspace/api-client-react";
import { Tabs } from "expo-router";
import React, { useEffect } from "react";
import { Platform, StyleSheet } from "react-native";

import { AuthGate } from "@/components/AuthGate";
import { UserMenu } from "@/components/UserMenu";
import colors from "@/constants/colors";
import { registerForPushAndSubscribe } from "@/lib/pushSetup";

/**
 * Mirror the Clerk user into Supabase + register for Expo push on launch.
 * Mounted inside the auth gate so we know the bearer token is available.
 */
function PostLoginBootstrap() {
  // `useSyncMe` is the generated React Query mutation hook for
  // `POST /me/sync`. We fire it once per mount so the server has a row
  // for this Clerk user before any other API call.
  const sync = useSyncMe();

  useEffect(() => {
    sync.mutate();
    // Registering for push is idempotent — if the user already granted
    // permission and the token hasn't changed, nothing happens server-side.
    void registerForPushAndSubscribe();
    // We deliberately want this to run exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

export default function TabLayout() {
  return (
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
          headerRight: () => <UserMenu />,
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
      </Tabs>
    </AuthGate>
  );
}
