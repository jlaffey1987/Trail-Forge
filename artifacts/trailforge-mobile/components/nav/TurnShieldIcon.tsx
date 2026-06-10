/**
 * Google Maps–style turn icons: shield badges for step lists, bold arrows on banners.
 */
import React from "react";
import { View, StyleSheet } from "react-native";
import Svg, { Path, G, Circle } from "react-native-svg";

import { GM } from "@/lib/navGoogleTheme";
import type { InstructionIcon } from "@/lib/navigation";

export type TurnShieldVariant = "banner" | "list" | "mini" | "onGreen";

interface Props {
  icon: InstructionIcon;
  size?: number;
  variant?: TurnShieldVariant;
}

/** Degrees to rotate the arrow glyph (0 = straight ahead). */
function iconRotation(icon: InstructionIcon): number {
  switch (icon) {
    case "turn-left":
      return -90;
    case "turn-right":
      return 90;
    case "u-turn":
      return 180;
    case "exit-trail":
      return 135;
    case "enter-trail":
      return 0;
    case "arrive":
      return 0;
    case "start":
      return 0;
    default:
      return 0;
  }
}

function arrowColor(variant: TurnShieldVariant): string {
  if (variant === "banner" || variant === "onGreen") return GM.card;
  if (variant === "mini") return GM.blue;
  return GM.greenDark;
}

function ArrowGlyph({
  icon,
  color,
  scale = 1,
}: {
  icon: InstructionIcon;
  color: string;
  scale?: number;
}) {
  const s = scale;
  const rot = iconRotation(icon);

  if (icon === "enter-trail") {
    return (
      <G rotation={0} origin="12, 12">
        <Path
          d={`M${12 * s} ${4 * s} L${18 * s} ${16 * s} H${6 * s} Z`}
          fill={color}
        />
        <Path
          d={`M${8 * s} ${18 * s} H${16 * s}`}
          stroke={color}
          strokeWidth={1.8 * s}
          strokeLinecap="round"
        />
      </G>
    );
  }

  if (icon === "arrive") {
    return (
      <G origin="12, 12">
        <Path
          d={`M${12 * s} ${4 * s} C${9 * s} ${4 * s} ${7 * s} ${6 * s} ${7 * s} ${9 * s} C${7 * s} ${13 * s} ${12 * s} ${19 * s} ${12 * s} ${19 * s} C${12 * s} ${19 * s} ${17 * s} ${13 * s} ${17 * s} ${9 * s} C${17 * s} ${6 * s} ${15 * s} ${4 * s} ${12 * s} ${4 * s} Z`}
          fill={color}
        />
        <Circle cx={12 * s} cy={9 * s} r={2 * s} fill="#FFFFFF" />
      </G>
    );
  }

  if (icon === "start") {
    return (
      <G origin="12, 12">
        <Circle cx={12 * s} cy={12 * s} r={4 * s} fill={color} />
      </G>
    );
  }

  return (
    <G rotation={rot} origin={`${12 * s}, ${12 * s}`}>
      <Path
        d={`M${12 * s} ${5 * s} L${12 * s} ${17 * s} M${12 * s} ${5 * s} L${7 * s} ${10 * s} M${12 * s} ${5 * s} L${17 * s} ${10 * s}`}
        stroke={color}
        strokeWidth={2.2 * s}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </G>
  );
}


export function TurnShieldIcon({ icon, size = 32, variant = "list" }: Props) {
  const color = arrowColor(variant);

  if (variant === "banner") {
    const dim = size;
    return (
      <View style={[styles.bannerCircle, { width: dim, height: dim, borderRadius: dim / 2 }]}>
        <Svg width={dim * 0.55} height={dim * 0.55} viewBox="0 0 24 24">
          <ArrowGlyph icon={icon} color={color} scale={1} />
        </Svg>
      </View>
    );
  }

  if (variant === "mini" || variant === "onGreen") {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <ArrowGlyph icon={icon} color={color} scale={0.85} />
      </Svg>
    );
  }

  const w = size;
  const h = size * 1.12;
  return (
    <Svg width={w} height={h} viewBox="0 0 24 28">
      <Path
        d="M12 1.5 L21.5 5.2 V12.2 C21.5 17.8 12 26 12 26 C12 26 2.5 17.8 2.5 12.2 V5.2 Z"
        fill={GM.card}
        stroke={GM.divider}
        strokeWidth={1}
      />
      <ArrowGlyph icon={icon} color={color} scale={0.9} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  bannerCircle: {
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
});
