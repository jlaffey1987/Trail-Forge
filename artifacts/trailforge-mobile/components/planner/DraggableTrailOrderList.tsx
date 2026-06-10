/**
 * Drag-to-reorder trail list for local ride review.
 */
import { Feather } from "@expo/vector-icons";
import React, { useCallback } from "react";
import { StyleSheet, Text, View } from "react-native";
import DraggableFlatList, {
  ScaleDecorator,
  type RenderItemParams,
} from "react-native-draggable-flatlist";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import colors from "@/constants/colors";
import type { MapTrail } from "@/lib/api";
import { gradeFromDifficulty, gradeToColor } from "@/lib/trailColors";

const AMBER = colors.light.primary;
const ROW_H = 72;

interface Props {
  trails: MapTrail[];
  onOrderChange: (trailIds: string[]) => void;
  onDragStateChange?: (dragging: boolean) => void;
}

export function DraggableTrailOrderList({
  trails,
  onOrderChange,
  onDragStateChange,
}: Props) {
  const renderItem = useCallback(
    ({ item, drag, isActive, getIndex }: RenderItemParams<MapTrail>) => {
      const idx = getIndex() ?? 0;
      const grade =
        gradeFromDifficulty(item.difficulty) ??
        gradeFromDifficulty(item.ai_difficulty ?? null);
      const accent = gradeToColor(grade);

      return (
        <ScaleDecorator>
          <View style={[styles.row, isActive && styles.rowActive]}>
            <View style={[styles.index, { backgroundColor: accent }]}>
              <Text style={styles.indexText}>{idx + 1}</Text>
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowName} numberOfLines={2}>
                {item.name}
              </Text>
              <Text style={styles.rowMeta}>
                {item.distance_km != null ? `${item.distance_km.toFixed(1)} km` : "—"}
                {grade != null ? ` · Grade ${grade}` : ""}
              </Text>
            </View>
            <View
              onTouchStart={drag}
              style={styles.grip}
              accessibilityLabel="Drag to reorder"
            >
              <Feather name="menu" size={22} color={colors.light.mutedForeground} />
            </View>
          </View>
        </ScaleDecorator>
      );
    },
    [],
  );

  return (
    <GestureHandlerRootView style={styles.root}>
      <DraggableFlatList
        data={trails}
        keyExtractor={(t) => t.id}
        renderItem={renderItem}
        onDragBegin={() => onDragStateChange?.(true)}
        onDragEnd={({ data }) => {
          onDragStateChange?.(false);
          onOrderChange(data.map((t) => t.id));
        }}
        containerStyle={styles.list}
        activationDistance={12}
      />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 0 },
  list: { maxHeight: 320 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    minHeight: ROW_H,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.light.border,
    backgroundColor: colors.light.card,
  },
  rowActive: {
    backgroundColor: colors.light.cardElevated,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
  index: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  indexText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: { color: "#fff", fontSize: 16, fontWeight: "600" },
  rowMeta: { color: colors.light.mutedForeground, fontSize: 13, marginTop: 2 },
  grip: {
    padding: 12,
    marginRight: -4,
  },
});
