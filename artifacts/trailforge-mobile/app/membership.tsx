/**
 * Free vs Premium — full comparison and upgrade path.
 */
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MembershipExplainer } from "@/components/membership/MembershipExplainer";
import { useProfile } from "@/components/ProfileContext";
import colors from "@/constants/colors";

export default function MembershipScreen() {
  const insets = useSafeAreaInsets();
  const { profile } = useProfile();

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={12}
        >
          <Feather name="arrow-left" size={22} color={colors.light.foreground} />
        </TouchableOpacity>
      </View>
      <MembershipExplainer isPremium={profile.isPremium} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.light.background,
  },
  topBar: {
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
});
