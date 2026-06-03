import "react-native-gesture-handler";

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
import { BrandedLoader } from "@/components/BrandedLoader";
import colors from "@/constants/colors";
import { tokenCache } from "@/lib/clerkTokenCache";
import { setSharedBearerGetter, apiBaseUrl } from "@/lib/api";
import { subscribeToNotificationTaps } from "@/lib/notificationRouting";
import { runStartupChecks } from "@/lib/startupChecks";

// ---------------------------------------------------------------------------
// Module-level wiring (runs once per JS bundle, before React mounts).
//
// Pointing the generated React Query hooks at the remote API server. In
// development, EXPO_PUBLIC_DOMAIN is the Replit dev domain; in production
// EAS builds, it is the published `.replit.app` domain.
// ---------------------------------------------------------------------------
// Derive the base URL using the same logic as lib/api.ts so the generated
// React Query hooks and the direct apiFetch helpers always point to the
// same server — avoids the split where env var points to stale IP in dev.
let API_BASE_URL = "";
try {
  API_BASE_URL = apiBaseUrl();
} catch {
  API_BASE_URL =
    process.env.EXPO_PUBLIC_API_BASE_URL?.trim() ||
    (process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : "");
}
if (API_BASE_URL) {
  setBaseUrl(API_BASE_URL.replace(/\/+$/, ""));
  if (__DEV__) console.log("[Layout] API base URL →", API_BASE_URL);
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
/**
 * Returns the Clerk session token, retrying with back-off when it's null.
 *
 * `getToken()` can briefly return null right after Clerk loads from
 * SecureStore (the session object exists but the JWT hasn't been decoded
 * yet). Without retrying, the first API call fires with no Bearer header
 * and the server responds with 401.
 */
async function getTokenWithRetry(
  getToken: () => Promise<string | null>,
): Promise<string | null> {
  const DELAYS = [0, 150, 400, 800]; // ms between attempts
  for (const delay of DELAYS) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    try {
      const t = await getToken();
      if (t) return t;
    } catch {
      // continue to next attempt
    }
  }
  return null;
}

function ApiAuthBridge({ children }: { children: React.ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  useEffect(() => {
    // Wrap in a retry-aware closure so transient null returns during Clerk's
    // initialization window don't send an un-authenticated request.
    const fn = () => getTokenWithRetry(getToken);
    setAuthTokenGetter(fn);
    setSharedBearerGetter(fn);
    return () => {
      setAuthTokenGetter(null);
      setSharedBearerGetter(null);
    };
  }, [getToken, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    if (__DEV__) {
      console.log(
        `[ApiAuthBridge] isLoaded=${isLoaded} isSignedIn=${isSignedIn} API=${API_BASE_URL || "(none)"}`,
      );
      if (isSignedIn) {
        getTokenWithRetry(getToken)
          .then(async (t) => {
            console.log(`[ApiAuthBridge] token present=${Boolean(t)} prefix="${t?.slice(0, 20) ?? "null"}"`);
            if (t) {
              // Ping /api/auth-test to confirm full round-trip auth
              try {
                const r = await fetch(`${API_BASE_URL}/api/auth-test`, {
                  headers: { Authorization: `Bearer ${t}` },
                });
                const body = await r.json() as Record<string, unknown>;
                if (r.ok) {
                  console.log(`[ApiAuthBridge] ✅ auth-test OK → userId=${body.userId as string}`);
                } else {
                  console.warn(`[ApiAuthBridge] ❌ auth-test ${r.status} →`, JSON.stringify(body));
                  console.warn(`[ApiAuthBridge] Server URL used: ${API_BASE_URL}`);
                }
              } catch (e) {
                console.warn("[ApiAuthBridge] auth-test fetch error:", e);
              }
            }
          })
          .catch((e) => console.warn("[ApiAuthBridge] getToken error:", e));
      }
    }
  }, [isLoaded, isSignedIn, getToken]);

  return <>{children}</>;
}

function RootLayoutNav() {
  // Notification taps — mounted inside the Stack tree so expo-router's
  // navigation context is live when the listener fires.
  useEffect(() => subscribeToNotificationTaps(), []);

  // Startup diagnostics — logs API URL, Clerk env, and service reachability.
  // Runs once on app mount, dev only. Output visible in Expo terminal / Metro.
  useEffect(() => {
    void runStartupChecks();
  }, []);

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
      <Stack.Screen
        name="onboarding"
        options={{ headerShown: false, animation: "fade" }}
      />
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
      <Stack.Screen name="linesman" options={{ headerShown: false, animation: "slide_from_right" }} />
      <Stack.Screen name="intro"    options={{ headerShown: false, animation: "fade" }} />
      <Stack.Screen name="rate"         options={{ title: "Rate Trail", presentation: "modal" }} />
      <Stack.Screen name="nav-settings" options={{ title: "Navigation", presentation: "modal" }} />
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

  if (!fontsLoaded && !fontError) return <BrandedLoader />;

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
