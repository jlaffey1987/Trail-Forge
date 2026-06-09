/**
 * One-time hint when planning a route on the map — tap trails to build a route.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { MAP_PLANNER_COACH_KEY } from "@/lib/storageKeys";

const AMBER = colors.light.primary;

interface Props {
  /** Show while the user is in an active map planning session. */
  active: boolean;
}

export function MapPlannerCoachMark({ active }: Props) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!active) {
      setShow(false);
      return;
    }
    void AsyncStorage.getItem(MAP_PLANNER_COACH_KEY).then((v) => {
      if (v !== "seen") setShow(true);
    });
  }, [active]);

  async function dismiss() {
    await AsyncStorage.setItem(MAP_PLANNER_COACH_KEY, "seen");
    setShow(false);
  }

  if (!show) return null;

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.card}>
        <View style={styles.iconRow}>
          <Feather name="info" size={18} color={AMBER} />
          <Text style={styles.title}>Build your route</Text>
          <Pressable onPress={() => void dismiss()} hitSlop={12}>
            <Feather name="x" size={18} color={colors.light.mutedForeground} />
          </Pressable>
        </View>
        <Text style={styles.body}>
          Tap orange trails on the map to add them to your trip. Tap again to remove.
          When you&apos;re happy, tap Review route at the bottom.
        </Text>
        <TouchableOpacity style={styles.btn} onPress={() => void dismiss()}>
          <Text style={styles.btnText}>Got it</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: 72,
    left: 16,
    right: 16,
    zIndex: 50,
  },
  card: {
    backgroundColor: colors.light.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: AMBER,
    padding: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  iconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  title: {
    flex: 1,
    color: colors.light.foreground,
    fontWeight: "800",
    fontSize: 15,
  },
  body: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  btn: {
    alignSelf: "flex-start",
    backgroundColor: AMBER,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  btnText: {
    color: "#1a0e05",
    fontWeight: "800",
    fontSize: 13,
  },
});
