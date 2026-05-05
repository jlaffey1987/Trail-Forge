/**
 * Group-invite acceptance screen. Hit when a user taps a `trailforge://invite/<token>`
 * link (or the universal-link equivalent). The mobile app forwards the
 * accept call to `/api/invites/<token>/accept`; on success we drop the
 * user back into the Trails tab where the new group will appear in the
 * list.
 */
import { Feather } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { apiJson } from "@/lib/api";

export default function InviteScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const t = String(token ?? "");
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    if (!t) {
      setState("error");
      setMessage("Missing invite token.");
      return;
    }
    void (async () => {
      try {
        await apiJson(`/api/invites/${encodeURIComponent(t)}/accept`, {
          method: "POST",
        });
        setState("ok");
        setMessage("You're in!");
      } catch (err) {
        setState("error");
        setMessage(err instanceof Error ? err.message : "Could not accept invite.");
      }
    })();
  }, [t]);

  return (
    <View style={styles.container}>
      {state === "loading" ? (
        <>
          <ActivityIndicator color={colors.light.primary} size="large" />
          <Text style={styles.body}>Accepting invite…</Text>
        </>
      ) : state === "ok" ? (
        <>
          <Feather name="check-circle" size={48} color={colors.light.primary} />
          <Text style={styles.h1}>{message}</Text>
          <TouchableOpacity
            style={styles.btn}
            onPress={() => router.replace("/(tabs)/trails")}
          >
            <Text style={styles.btnText}>See your groups</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Feather name="alert-triangle" size={48} color={colors.light.destructive} />
          <Text style={styles.h1}>Invite invalid</Text>
          <Text style={styles.body}>{message}</Text>
          <TouchableOpacity
            style={styles.btn}
            onPress={() => router.replace("/(tabs)")}
          >
            <Text style={styles.btnText}>Back to TrailForge</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.light.background,
    padding: 24,
    gap: 12,
  },
  h1: { color: colors.light.foreground, fontSize: 20, fontWeight: "800" },
  body: { color: colors.light.mutedForeground, fontSize: 14, textAlign: "center" },
  btn: {
    backgroundColor: colors.light.primary,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 12,
  },
  btnText: { color: colors.light.primaryForeground, fontWeight: "700" },
});
