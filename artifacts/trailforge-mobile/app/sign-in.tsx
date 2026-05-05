import { useAuth, useSignIn, useSignUp, useSSO } from "@clerk/clerk-expo";
import { Feather } from "@expo/vector-icons";
import { Redirect } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";

// Required so the OAuth in-app browser closes itself after the redirect
// instead of dangling open.
WebBrowser.maybeCompleteAuthSession();

type Mode = "sign-in" | "sign-up" | "verify";

export default function SignInScreen() {
  const { isLoaded, isSignedIn } = useAuth();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);

  const signIn = useSignIn();
  const signUp = useSignUp();
  const sso = useSSO();

  if (isLoaded && isSignedIn) {
    return <Redirect href="/(tabs)" />;
  }

  async function onEmailContinue() {
    setPending(true);
    try {
      if (mode === "sign-up") {
        if (!signUp.isLoaded) return;
        await signUp.signUp.create({ emailAddress: email, password });
        await signUp.signUp.prepareEmailAddressVerification({
          strategy: "email_code",
        });
        setMode("verify");
        return;
      }
      if (!signIn.isLoaded) return;
      const attempt = await signIn.signIn.create({
        identifier: email,
        password,
      });
      if (attempt.status === "complete" && attempt.createdSessionId) {
        await signIn.setActive({ session: attempt.createdSessionId });
      } else {
        Alert.alert("Almost there", "Check your inbox to finish signing in.");
      }
    } catch (err) {
      Alert.alert("Sign-in failed", errMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function onVerify() {
    if (!signUp.isLoaded) return;
    setPending(true);
    try {
      const attempt = await signUp.signUp.attemptEmailAddressVerification({
        code,
      });
      if (attempt.status === "complete" && attempt.createdSessionId) {
        await signUp.setActive({ session: attempt.createdSessionId });
      }
    } catch (err) {
      Alert.alert("Verification failed", errMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function onOAuth(strategy: "oauth_google" | "oauth_apple") {
    setPending(true);
    try {
      // `useSSO().startSSOFlow` opens an in-app browser; on success it
      // returns the new session id which we activate.
      const result = await sso.startSSOFlow({
        strategy,
        redirectUrl: "trailforge://sso-callback",
      });
      if (result.createdSessionId && result.setActive) {
        await result.setActive({ session: result.createdSessionId });
      }
    } catch (err) {
      Alert.alert("OAuth failed", errMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.light.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <View style={styles.brandBadge}>
            <Feather name="map" size={26} color={colors.light.primary} />
          </View>
          <Text style={styles.brandTitle}>TrailForge</Text>
          <Text style={styles.brandSubtitle}>
            Plan, ride, and share singletrack with confidence.
          </Text>
        </View>

        <View style={styles.card}>
          {mode === "verify" ? (
            <>
              <Text style={styles.cardTitle}>Verify your email</Text>
              <Text style={styles.cardHint}>
                We sent a 6-digit code to {email}.
              </Text>
              <TextInput
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                placeholder="123456"
                placeholderTextColor={colors.light.mutedForeground}
                style={styles.input}
                autoFocus
              />
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={onVerify}
                disabled={pending}
              >
                {pending ? (
                  <ActivityIndicator color={colors.light.primaryForeground} />
                ) : (
                  <Text style={styles.primaryBtnText}>Verify</Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.cardTitle}>
                {mode === "sign-in"
                  ? "Welcome back"
                  : "Create your TrailForge account"}
              </Text>

              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="Email"
                autoCapitalize="none"
                keyboardType="email-address"
                placeholderTextColor={colors.light.mutedForeground}
                style={styles.input}
              />
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                secureTextEntry
                placeholderTextColor={colors.light.mutedForeground}
                style={styles.input}
              />

              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={onEmailContinue}
                disabled={pending || !email || !password}
              >
                {pending ? (
                  <ActivityIndicator color={colors.light.primaryForeground} />
                ) : (
                  <Text style={styles.primaryBtnText}>
                    {mode === "sign-in" ? "Sign in" : "Sign up"}
                  </Text>
                )}
              </TouchableOpacity>

              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>or continue with</Text>
                <View style={styles.dividerLine} />
              </View>

              <View style={styles.oauthRow}>
                <OauthButton
                  icon="chrome"
                  label="Google"
                  onPress={() => void onOAuth("oauth_google")}
                  disabled={pending}
                />
                {Platform.OS === "ios" ? (
                  <OauthButton
                    icon="smartphone"
                    label="Apple"
                    onPress={() => void onOAuth("oauth_apple")}
                    disabled={pending}
                  />
                ) : null}
              </View>

              <Pressable
                onPress={() =>
                  setMode((m) => (m === "sign-in" ? "sign-up" : "sign-in"))
                }
                style={styles.toggleRow}
              >
                <Text style={styles.toggleText}>
                  {mode === "sign-in"
                    ? "New here? Create an account"
                    : "Already have an account? Sign in"}
                </Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function OauthButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={styles.oauthBtn}
    >
      <Feather name={icon} size={16} color={colors.light.foreground} />
      <Text style={styles.oauthBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

function errMessage(err: unknown): string {
  if (typeof err === "object" && err && "errors" in err) {
    const errs = (err as { errors?: Array<{ message?: string }> }).errors;
    if (Array.isArray(errs) && errs[0]?.message) return errs[0].message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    padding: 24,
    justifyContent: "center",
    backgroundColor: colors.light.background,
  },
  brand: { alignItems: "center", marginBottom: 28 },
  brandBadge: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: colors.light.card,
    borderColor: colors.light.primary,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  brandTitle: {
    color: colors.light.foreground,
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  brandSubtitle: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    marginTop: 4,
    textAlign: "center",
  },
  card: {
    backgroundColor: colors.light.card,
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  cardTitle: {
    color: colors.light.foreground,
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 14,
  },
  cardHint: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    marginBottom: 12,
  },
  input: {
    backgroundColor: colors.light.input,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: colors.light.foreground,
    marginBottom: 10,
    fontSize: 14,
  },
  primaryBtn: {
    backgroundColor: colors.light.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  primaryBtnText: {
    color: colors.light.primaryForeground,
    fontWeight: "700",
    fontSize: 14,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 14,
    gap: 8,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.light.border },
  dividerText: { color: colors.light.mutedForeground, fontSize: 11 },
  oauthRow: { flexDirection: "row", gap: 10 },
  oauthBtn: {
    flex: 1,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: colors.light.border,
    borderRadius: 12,
    backgroundColor: colors.light.muted,
  },
  oauthBtnText: { color: colors.light.foreground, fontWeight: "600" },
  toggleRow: { marginTop: 14, alignItems: "center" },
  toggleText: { color: colors.light.primary, fontSize: 13 },
});
