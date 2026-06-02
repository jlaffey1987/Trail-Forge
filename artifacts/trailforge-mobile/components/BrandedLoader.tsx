/**
 * Shown while Inter fonts are loading on cold-start. Matches the native
 * splash-screen colours from app.json so there is no jarring flash between
 * the native splash and the first React frame.
 */
import React from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { BrandLogo } from "@/components/BrandLogo";

export function BrandedLoader() {
  return (
    <View style={styles.container}>
      <BrandLogo size={160} circular showWordmark />
      <ActivityIndicator
        color="#F5A623"
        size="small"
        style={styles.spinner}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0D0D0D",
    alignItems: "center",
    justifyContent: "center",
  },
  spinner: {
    marginTop: 36,
  },
});
