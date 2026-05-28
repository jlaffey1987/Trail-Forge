/**
 * Renders `children` only when Clerk has finished loading and the user is
 * signed in. Otherwise shows a loading splash or redirects to /sign-in.
 * Mirrors the wouter `<Switch>` layout in the web App.tsx.
 */
import { useAuth } from "@clerk/clerk-expo";
import { Redirect } from "expo-router";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import colors from "@/constants/colors";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (isLoaded) return;
    const t = setTimeout(() => setTimedOut(true), 10_000);
    return () => clearTimeout(t);
  }, [isLoaded]);

  if (!isLoaded) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.light.background,
          gap: 12,
          padding: 24,
        }}
      >
        <ActivityIndicator color={colors.light.primary} />
        {timedOut && __DEV__ ? (
          <Text
            style={{
              color: colors.light.mutedForeground,
              fontSize: 12,
              textAlign: "center",
            }}
          >
            {"Clerk is taking a while to load.\nCheck your network and API URL."}
          </Text>
        ) : null}
      </View>
    );
  }

  if (!isSignedIn) {
    return <Redirect href="/sign-in" />;
  }

  return <>{children}</>;
}
