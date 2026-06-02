import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useSyncMe } from "@workspace/api-client-react";
import { useAuth } from "@clerk/clerk-expo";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Tabs, router } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
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
import { ONBOARDING_KEY, INTRO_SEEN_KEY } from "@/lib/storageKeys";

/**
 * Mirror the Clerk user into Supabase + register for Expo push on launch.
 * Mounted inside the auth gate so we know the bearer token is available.
 */
function PostLoginBootstrap() {
  const { getToken } = useAuth();
  const sync = useSyncMe();
  const { setProfile } = useProfile();
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncAttemptRef = useRef(0);

  // Attempt the /me/sync POST. If we get a 401, wait for a fresh token
  // and retry up to MAX_ATTEMPTS times (handles Clerk initialization lag).
  const doSync = React.useCallback(
    (attempt = 0) => {
      const MAX_ATTEMPTS = 3;
      sync.mutate(undefined, {
        onSuccess(data) {
          setProfile({
            isPremium:         data.is_premium ?? false,
            preferredBikeType: (data.preferred_bike_type as BikeType | undefined) ?? "all",
            isLinesman:        !!((data as unknown as Record<string, unknown>)["linesman_access"]),
            linesmanGroupId:   ((data as unknown as Record<string, unknown>)["linesman_group_id"] as string | null) ?? null,
          });
        },
        onError(err) {
          const msg   = err instanceof Error ? err.message : String(err);
          const is401 = msg.includes("401") || msg.toLowerCase().includes("unauthorized");

          if (is401 && attempt < MAX_ATTEMPTS) {
            // Token wasn't ready yet — wait, then retry
            const delay = 500 * (attempt + 1);
            console.warn(`[PostLoginBootstrap] sync 401, retry ${attempt + 1}/${MAX_ATTEMPTS} in ${delay}ms`);
            setTimeout(() => {
              // Kick a fresh getToken() call so the Bearer getter refreshes
              void getToken().then(() => doSync(attempt + 1));
            }, delay);
            return;
          }

          console.warn("[PostLoginBootstrap] /me/sync failed:", msg);
          setSyncError(msg);
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sync, setProfile, getToken],
  );

  useEffect(() => {
    syncAttemptRef.current = 0;

    // Redirect to onboarding on first launch after sign-up.
    void (async () => {
      const [introDone, obDone] = await Promise.all([
        AsyncStorage.getItem(INTRO_SEEN_KEY),
        AsyncStorage.getItem(ONBOARDING_KEY),
      ]);
      if (!introDone) {
        router.replace("/intro" as unknown as Parameters<typeof router.replace>[0]);
        return;
      }
      if (!obDone) {
        router.replace("/onboarding" as unknown as Parameters<typeof router.replace>[0]);
        return;
      }
    })();

    // Pre-warm the token before firing the first sync, giving Clerk time to
    // fully initialise the session from SecureStore.
    void getToken().then(() => doSync(0));

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
          name="explore"
          options={{
            title: "Explore",
            tabBarIcon: ({ color }) => (
              <Feather name="compass" size={20} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="feed"
          options={{
            title: "Feed",
            tabBarIcon: ({ color }) => (
              <Feather name="activity" size={20} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="discover"
          options={{
            title: "Discover",
            href: null, // hidden — superseded by Explore tab
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
