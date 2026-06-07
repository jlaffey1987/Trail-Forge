import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

/** Per-grade colours — matches original Replit planner. */
export const GRADE_CHIP_COLORS: Record<number, string> = {
  1: "#4ade80", 2: "#86efac", 3: "#a3e635", 4: "#bef264", 5: "#fbbf24",
  6: "#fb923c", 7: "#f97316", 8: "#ef4444", 9: "#dc2626", 10: "#7f1d1d",
};

export const GRADE_CHIP_LABELS: Record<number, string> = {
  1: "Novice", 2: "Easy", 3: "Easy+", 4: "Moderate", 5: "Medium",
  6: "Hard", 7: "Expert", 8: "Extreme", 9: "Pro", 10: "Elite",
};

interface DifficultyScaleProps {
  selected: number[];
  onToggle: (level: number) => void;
}

export function DifficultyScale({ selected, onToggle }: DifficultyScaleProps) {
  return (
    <View>
      <View style={s.row}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map((level) => {
          const active = selected.includes(level);
          const color = GRADE_CHIP_COLORS[level];
          return (
            <Pressable
              key={level}
              onPress={() => onToggle(level)}
              style={[
                s.chip,
                {
                  backgroundColor: active ? color : "#292524",
                  borderColor: `${color}66`,
                  transform: [{ scale: active ? 1.08 : 1 }],
                },
              ]}
            >
              <Text style={[s.chipText, { color: active ? "#000" : color }]}>
                {level}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {selected.length > 0 && (
        <Text style={s.summary}>
          {[...selected].sort((a, b) => a - b).map((d) => GRADE_CHIP_LABELS[d]).join(" · ")}
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 4,
  },
  chip: {
    flex: 1,
    aspectRatio: 1,
    maxHeight: 36,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  chipText: {
    fontSize: 11,
    fontWeight: "800",
  },
  summary: {
    marginTop: 8,
    fontSize: 10,
    color: "#78716c",
  },
});
