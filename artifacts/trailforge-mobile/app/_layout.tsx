import { ClerkProvider, useAuth } from "@clerk/clerk-expo";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import colors from "@/constants/colors";
import { tokenCache } from "@/lib/clerkTokenCache";
import { setSharedBearerGetter } from "@/lib/api";

// ---------------------------------------------------------------------------
// Module-level wiring (runs once per JS bundle, before React mounts).
//
// Pointing the generated React Query hooks at the remote API server. In
// development, EXPO_PUBLIC_DOMAIN is the Replit dev domain; in production
// EAS builds, it is the published `.replit.app` domain.
// ---------------------------------------------------------------------------
if (process.env.EXPO_PUBLIC_DOMAIN) {
  setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`);
}

// `app.json` is the canonical place for the Clerk publishable key. We read
// it via `process.env.EXPO_PUBLIC_*` because Expo statically replaces those
// at bundle time so the value is baked into the JS bundle without leaking
// any backend secrets.
const CLERK_PUBLISHABLE_KEY =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";

if (!CLERK_PUBLISHABLE_KEY) {
  // Don't throw — let the UI render an instructive error instead of an
  // unhandled-rejection screen. AuthGate will show the SignIn page where
  // the user gets a friendlier error.
  // eslint-disable-next-line no-console
  console.warn(
    "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is not set. Auth will fail.",
  );
}

SplashScreen.preventAutoHideAsync().catch(() => {
  /* noop — already hidden */
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // React Native is more memory-conscious; keep the default low.
      staleTime: 30_000,
      retry: 1,
    },
  },
});

/**
 * Bridge component: every render, install the freshest `getToken` closure
 * into the generated client + the direct-fetch helper. We can't do this
 * at module scope because Clerk's hooks must be called inside the React
 * tree. Mounted inside `<ClerkProvider>` so `useAuth` is available.
 */
function ApiAuthBridge({ children }: { children: React.ReactNode }) {
  const { getToken, isLoaded } = useAuth();

  useEffect(() => {
    const fn = async () => {
      try {
        return await getToken();
      } catch {
        return null;
      }
    };
    setAuthTokenGetter(fn);
    setSharedBearerGetter(fn);
    return () => {
      setAuthTokenGetter(null);
      setSharedBearerGetter(null);
    };
  }, [getToken, isLoaded]);

  return <>{children}</>;
}

function RootLayoutNav() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.light.background },
        headerTintColor: colors.light.foreground,
        headerTitleStyle: { color: colors.light.foreground, fontWeight: "700" },
        headerBackTitle: "Back",
        contentStyle: { backgroundColor: colors.light.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      <Stack.Screen name="record" options={{ title: "Record ride" }} />
      <Stack.Screen
        name="trail/[trailId]"
        options={{ title: "Trail", presentation: "modal" }}
      />
      <Stack.Screen
        name="messages/[roomId]"
        options={{ title: "Conversation" }}
      />
      <Stack.Screen
        name="invite/[token]"
        options={{ title: "Group invite" }}
      />
      <Stack.Screen name="blocked" options={{ title: "Blocked users" }} />
      <Stack.Screen name="activity" options={{ title: "Activity" }} />
      <Stack.Screen name="group/[groupId]" options={{ title: "Group" }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => {
        /* noop */
      });
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <ClerkProvider
          publishableKey={CLERK_PUBLISHABLE_KEY}
          tokenCache={tokenCache}
        >
          <QueryClientProvider client={queryClient}>
            <ApiAuthBridge>
              <GestureHandlerRootView style={{ flex: 1 }}>
                <KeyboardProvider>
                  <StatusBar style="light" />
                  <RootLayoutNav />
                </KeyboardProvider>
              </GestureHandlerRootView>
            </ApiAuthBridge>
          </QueryClientProvider>
        </ClerkProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
