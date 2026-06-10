/**
 * Confirm before batch-adding corridor-suggested trails to a route.
 */
import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import type { MapTrail } from "@/lib/api";
import { gradeFromDifficulty } from "@/lib/trailColors";

const AMBER = colors.light.primary;

interface Props {
  visible: boolean;
  trails: MapTrail[];
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function SuggestTrailsReviewSheet({
  visible,
  trails,
  loading = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.scrim} onPress={onCancel}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>
            Add {trails.length} trail{trails.length === 1 ? "" : "s"} along your route?
          </Text>
          <Text style={styles.sub}>
            Picked to stay on the way to your destination — no doubling back for a single track.
          </Text>
          <ScrollView style={{ maxHeight: 220 }} showsVerticalScrollIndicator={false}>
            {trails.map((t) => {
              const g =
                gradeFromDifficulty(t.difficulty) ??
                gradeFromDifficulty(t.ai_difficulty ?? null);
              return (
                <View key={t.id} style={styles.row}>
                  <Feather name="check-circle" size={16} color={colors.light.trailGreen} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowName} numberOfLines={2}>
                      {t.name}
                    </Text>
                    <Text style={styles.rowMeta}>
                      {t.distance_km != null ? `${t.distance_km.toFixed(1)} km` : "—"}
                      {g != null ? ` · Grade ${g}` : ""}
                    </Text>
                  </View>
                </View>
              );
            })}
          </ScrollView>
          <TouchableOpacity
            style={[styles.primaryBtn, loading && { opacity: 0.6 }]}
            disabled={loading}
            onPress={onConfirm}
          >
            {loading ? (
              <ActivityIndicator color="#1a0e05" />
            ) : (
              <Text style={styles.primaryText}>Add to route</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
            <Text style={styles.cancelText}>Not now</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.light.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 28,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  title: {
    color: colors.light.foreground,
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 8,
  },
  sub: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 14,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.light.border,
  },
  rowName: {
    color: colors.light.foreground,
    fontSize: 14,
    fontWeight: "700",
  },
  rowMeta: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    marginTop: 2,
  },
  primaryBtn: {
    marginTop: 16,
    minHeight: 50,
    borderRadius: 12,
    backgroundColor: AMBER,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { color: "#1a0e05", fontWeight: "900", fontSize: 16 },
  cancelBtn: { alignItems: "center", paddingTop: 14 },
  cancelText: { color: colors.light.mutedForeground, fontSize: 14 },
});
