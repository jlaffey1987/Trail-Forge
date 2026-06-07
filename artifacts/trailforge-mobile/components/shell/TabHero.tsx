import React from "react";
import {
  ImageBackground,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";

import colors from "@/constants/colors";

const HERO_IMAGE = require("@/assets/videos/intoimage.jpeg");

interface TabHeroProps {
  title: string;
  titleAccent?: string;
  subtitle?: string;
  height?: number;
  rightAction?: React.ReactNode;
  style?: ViewStyle;
}

export function TabHero({
  title,
  titleAccent,
  subtitle,
  height = 210,
  rightAction,
  style,
}: TabHeroProps) {
  return (
    <View style={[{ height }, style]}>
      <ImageBackground
        source={HERO_IMAGE}
        style={StyleSheet.absoluteFill}
        imageStyle={{ resizeMode: "cover" }}
      />
      <View style={s.overlayTop} />
      <View style={s.overlayBottom} />
      <View style={s.content}>
        <View style={s.titleRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>
              {title}
              {titleAccent ? (
                <Text style={s.accent}> {titleAccent}</Text>
              ) : null}
            </Text>
            {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
          </View>
          {rightAction}
        </View>
      </View>
      <View style={s.hairline} />
    </View>
  );
}

const s = StyleSheet.create({
  overlayTop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(15,10,5,0.45)",
  },
  overlayBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "70%",
    backgroundColor: "rgba(23,17,10,0.55)",
  },
  content: {
    flex: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    paddingBottom: 16,
    backgroundColor: "rgba(15,10,5,0.35)",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: "900",
    color: "#fff",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  accent: {
    color: colors.light.primary,
  },
  subtitle: {
    marginTop: 6,
    fontSize: 11,
    color: "rgba(245,245,244,0.95)",
    maxWidth: 280,
  },
  hairline: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
    backgroundColor: "rgba(240,168,50,0.5)",
    opacity: 0.6,
  },
});
