import { Feather } from "@expo/vector-icons";

import { useQuery } from "@tanstack/react-query";

import { useSyncMe } from "@workspace/api-client-react";

import { useAuth } from "@clerk/clerk-expo";

import AsyncStorage from "@react-native-async-storage/async-storage";

import { Tabs, router } from "expo-router";

import React, { useEffect, useRef } from "react";

import { Platform, StyleSheet } from "react-native";



import { AuthGate } from "@/components/AuthGate";

import {

  ProfileProvider,

  useProfile,

  type BikeType,

} from "@/components/ProfileContext";

import colors from "@/constants/colors";

import { adminWhoami } from "@/lib/api";

import { registerForPushAndSubscribe } from "@/lib/pushSetup";

import { rehydrate as rehydrateRecording } from "@/lib/recording";

import { ONBOARDING_KEY } from "@/lib/storageKeys";



function PostLoginBootstrap() {

  const { getToken } = useAuth();

  const sync = useSyncMe();

  const { setProfile } = useProfile();

  const syncAttemptRef = useRef(0);



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

            const delay = 500 * (attempt + 1);

            if (__DEV__) {

              console.warn(`[PostLoginBootstrap] sync 401, retry ${attempt + 1}/${MAX_ATTEMPTS} in ${delay}ms`);

            }

            setTimeout(() => {

              void getToken().then(() => doSync(attempt + 1));

            }, delay);

          } else if (__DEV__) {

            console.warn("[PostLoginBootstrap] /me/sync failed:", msg);

          }

        },

      });

    },

    // eslint-disable-next-line react-hooks/exhaustive-deps

    [sync, setProfile, getToken],

  );



  useEffect(() => {

    syncAttemptRef.current = 0;



    void (async () => {

      const obDone = await AsyncStorage.getItem(ONBOARDING_KEY);

      if (!obDone) {

        router.replace("/onboarding" as unknown as Parameters<typeof router.replace>[0]);

        return;

      }

    })();



    void getToken().then(() => doSync(0));

    void registerForPushAndSubscribe();

    void rehydrateRecording();

    // eslint-disable-next-line react-hooks/exhaustive-deps

  }, []);



  return null;

}



export default function TabLayout() {

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

          headerShown: false,

          tabBarActiveTintColor: colors.light.primary,

          tabBarInactiveTintColor: colors.light.mutedForeground,

          tabBarStyle: {

            backgroundColor: colors.light.background,

            borderTopColor: "#2a2520",

            borderTopWidth: StyleSheet.hairlineWidth,

            height: Platform.OS === "ios" ? 88 : 68,

            paddingTop: 6,

          },

          tabBarLabelStyle: {

            fontSize: 10,

            fontWeight: "700",

            textTransform: "uppercase",

            letterSpacing: 0.6,

          },

        }}

      >

        <Tabs.Screen

          name="index"

          options={{

            title: "Planner",

            tabBarIcon: ({ color }) => (

              <Feather name="home" size={20} color={color} />

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

            title: "My Trails",

            tabBarIcon: ({ color }) => (

              <Feather name="save" size={20} color={color} />

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

        {/* Hidden — kept for deep links / future use */}

        <Tabs.Screen name="explore" options={{ href: null }} />

        <Tabs.Screen name="feed" options={{ href: null }} />

        <Tabs.Screen name="messages" options={{ href: null }} />

        <Tabs.Screen

          name="admin"

          options={{

            title: "Admin",

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


