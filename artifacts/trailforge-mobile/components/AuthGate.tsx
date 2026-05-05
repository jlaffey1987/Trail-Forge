/**
 * Renders `children` only when Clerk has finished loading and the user is
 * signed in. Otherwise shows a loading splash or redirects to /sign-in.
 * Mirrors the wouter `<Switch>` layout in the web App.tsx.
 */
import { useAuth } from "@clerk/clerk-expo";
import { Redirect } from "expo-router";
import React from "react";
import { ActivityIndicator, View } from "react-native";

import colors from "@/constants/colors";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.light.background,
        }}
      >
        <ActivityIndicator color={colors.light.primary} />
      </View>
    );
  }

  if (!isSignedIn) {
    return <Redirect href="/sign-in" />;
  }

  return <>{children}</>;
}
