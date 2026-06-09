/**
 * Full-bleed ride POV image with amber spinner — used while pages load.
 */
import { Image } from "expo-image";
import React from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { RIDE_POV_BANNER } from "@/constants/brandImages";
import colors from "@/constants/colors";

interface RidePovLoadingViewProps {
  message?: string;
  style?: StyleProp<ViewStyle>;
}

export function RidePovLoadingView({ message, style }: RidePovLoadingViewProps) {
  return (
    <View style={[styles.root, style]}>
      <Image source={RIDE_POV_BANNER} style={StyleSheet.absoluteFill} contentFit="cover" />
      <View style={styles.scrim} />
      <View style={styles.center}>
        <ActivityIndicator color={colors.light.primary} size="large" />
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0D0D0D",
    overflow: "hidden",
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(10,8,6,0.55)",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingHorizontal: 24,
  },
  message: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
});
