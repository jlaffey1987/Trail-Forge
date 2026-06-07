import React from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";

import colors from "@/constants/colors";

interface SectionCardProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
  style?: ViewStyle;
}

export function SectionCard({ label, hint, children, style }: SectionCardProps) {
  return (
    <View style={[s.card, style]}>
      <View style={s.labelRow}>
        <Text style={s.label}>{label}</Text>
        {hint ? <Text style={s.hint}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: "#1c1917",
    borderWidth: 1,
    borderColor: "#3d3428",
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  label: {
    fontSize: 11,
    fontWeight: "700",
    color: "#d6d3d1",
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  hint: {
    fontSize: 11,
    color: colors.light.primary,
    fontWeight: "600",
  },
});
