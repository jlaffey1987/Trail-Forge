/**
 * Shown while Inter fonts are loading on cold-start (before the JS splash
 * hides and the real UI mounts). Matches the native splash-screen colours
 * from app.json so there is no jarring flash of white between the native
 * splash and the first React frame.
 */
import React from "react";
import { ActivityIndicator, Image, StyleSheet, View } from "react-native";

const icon = require("../assets/images/icon.png") as number;

export function BrandedLoader() {
  return (
    <View style={styles.container}>
      <Image source={icon} style={styles.icon} resizeMode="contain" />
      <ActivityIndicator
        color="#f0a832"
        size="small"
        style={styles.spinner}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1208",
    alignItems: "center",
    justifyContent: "center",
  },
  icon: {
    width: 200,
    height: 200,
  },
  spinner: {
    marginTop: 32,
  },
});
