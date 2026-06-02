/**
 * BrandLogo — renders the TrailForge brand image (intoimage.jpeg / logo.jpeg).
 *
 * Props:
 *   size         — diameter in px (default 96). For circular variant this is
 *                  both width and height.
 *   circular     — clip to circle with amber border (default false)
 *   showWordmark — render "TrailForge" text below the image (default false)
 *   style        — additional container style
 */
import React from "react";
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

const LOGO = require("../assets/images/logo.jpeg") as number;
const AMBER = "#F5A623";

interface Props {
  size?: number;
  circular?: boolean;
  showWordmark?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function BrandLogo({ size = 96, circular = false, showWordmark = false, style }: Props) {
  return (
    <View style={[{ alignItems: "center", gap: 10 }, style]}>
      <View
        style={[
          circular && {
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 2.5,
            borderColor: AMBER,
            overflow: "hidden",
          },
          !circular && {
            width: size,
            height: size,
            borderRadius: 20,
            overflow: "hidden",
          },
        ]}
      >
        <Image
          source={LOGO}
          style={{ width: size, height: size }}
          resizeMode={circular ? "cover" : "contain"}
          accessibilityLabel="TrailForge logo"
        />
      </View>
      {showWordmark && (
        <Text style={[s.wordmark, { fontSize: size * 0.28 }]}>TrailForge</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wordmark: {
    color: "#FFFFFF",
    fontWeight: "900",
    letterSpacing: -1,
  },
});
