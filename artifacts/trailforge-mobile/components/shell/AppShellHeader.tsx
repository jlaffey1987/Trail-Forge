/**
 * Global app header — matches the original Replit TrailForge shell:
 * brand thumbnail · GPS status pill · notifications · sign-in / profile.
 */
import { useAuth } from "@clerk/clerk-expo";
import * as Location from "expo-location";
import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NotificationsBell } from "@/components/NotificationsBell";
import { UserMenu } from "@/components/UserMenu";
import colors from "@/constants/colors";

const AMBER = colors.light.primary;

export function AppShellHeader() {
  const insets = useSafeAreaInsets();
  const { isSignedIn, isLoaded } = useAuth();
  const [gpsActive, setGpsActive] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== "granted") {
          setGpsActive(false);
          return;
        }
        const pos = await Location.getLastKnownPositionAsync();
        setGpsActive(Boolean(pos));
      } catch {
        setGpsActive(false);
      }
    })();
  }, []);

  return (
    <View style={[s.wrap, { paddingTop: insets.top + 8 }]}>
      <Image
        source={require("@/assets/images/logo.jpeg")}
        style={s.brand}
        resizeMode="cover"
      />

      <View style={s.right}>
        <View style={s.gpsPill}>
          <View style={[s.gpsDot, { backgroundColor: gpsActive ? "#4ade80" : "#78716c" }]} />
          <Text style={s.gpsText}>{gpsActive ? "GPS Active" : "GPS"}</Text>
        </View>

        {isLoaded && isSignedIn ? (
          <>
            <NotificationsBell />
            <UserMenu />
          </>
        ) : (
          <TouchableOpacity
            style={s.signInBtn}
            onPress={() => router.push("/sign-in")}
            activeOpacity={0.85}
          >
            <Text style={s.signInText}>Sign In</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 14,
    backgroundColor: colors.light.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2a2520",
  },
  brand: {
    width: 72,
    height: 36,
    borderRadius: 6,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  gpsPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#292524",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  gpsDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  gpsText: {
    color: "#a8a29e",
    fontSize: 10,
    fontWeight: "600",
  },
  signInBtn: {
    backgroundColor: AMBER,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  signInText: {
    color: "#1a0e05",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
});
