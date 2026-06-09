/**
 * After navigation — log trail sections as ridden for mileage & achievements.
 */
import { Feather } from "@expo/vector-icons";
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
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

import { AchievementCelebration } from "@/components/profile/AchievementCelebration";
import colors from "@/constants/colors";
import {
  markTrailRidden,
  type MarkTrailRiddenResult,
  type RiderAchievement,
} from "@/lib/api";

const AMBER = colors.light.primary;

export interface NavTrailToLog {
  id: string;
  name: string;
}

interface Props {
  visible: boolean;
  title: string;
  subtitle: string;
  trails: NavTrailToLog[];
  /** Pre-selected trail ids (e.g. completed sections). */
  defaultSelectedIds: string[];
  onDismiss: () => void;
  onDone: () => void;
}

export function NavCompletionSheet({
  visible,
  title,
  subtitle,
  trails,
  defaultSelectedIds,
  onDismiss,
  onDone,
}: Props) {
  const defaultSet = useMemo(
    () => new Set(defaultSelectedIds),
    [defaultSelectedIds],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(defaultSelectedIds));
  const [celebration, setCelebration] = useState<{
    achievements: Array<Pick<RiderAchievement, "name" | "description" | "icon" | "colour">>;
    statsLine: string | null;
  } | null>(null);

  React.useEffect(() => {
    if (visible) setSelected(new Set(defaultSet));
  }, [visible, defaultSet]);

  const saveMut = useMutation({
    mutationFn: async (ids: string[]) => {
      let lastStats: MarkTrailRiddenResult["stats"] = null;
      const allAchievements: MarkTrailRiddenResult["newAchievements"] = [];
      for (const id of ids) {
        const res = await markTrailRidden(id);
        if (res.stats) lastStats = res.stats;
        for (const a of res.newAchievements) {
          if (!allAchievements.some((x) => x.key === a.key)) allAchievements.push(a);
        }
      }
      return { stats: lastStats, newAchievements: allAchievements };
    },
    onSuccess: (result) => {
      const statsLine = result.stats
        ? `${result.stats.trailKmTotal.toFixed(1)} km ridden · ${result.stats.trailsCompleted} trails · ${result.stats.rankTitle}`
        : null;
      if (result.newAchievements.length > 0 || statsLine) {
        setCelebration({
          achievements: result.newAchievements,
          statsLine,
        });
      } else {
        onDone();
      }
    },
  });

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedIds = [...selected];

  return (
    <>
      <Modal visible={visible && celebration == null} transparent animationType="slide">
        <Pressable style={s.backdrop} onPress={onDismiss}>
          <Pressable style={s.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={s.title}>{title}</Text>
            <Text style={s.sub}>{subtitle}</Text>
            {trails.length === 0 ? (
              <Text style={s.empty}>No trail sections on this route.</Text>
            ) : (
              <ScrollView style={{ maxHeight: 260 }}>
                {trails.map((t) => {
                  const on = selected.has(t.id);
                  return (
                    <Pressable
                      key={t.id}
                      style={[s.row, on && s.rowOn]}
                      onPress={() => toggle(t.id)}
                    >
                      <Feather
                        name={on ? "check-square" : "square"}
                        size={18}
                        color={on ? AMBER : colors.light.mutedForeground}
                      />
                      <Text style={s.rowText} numberOfLines={2}>
                        {t.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
            <TouchableOpacity
              style={[s.primaryBtn, selectedIds.length === 0 && { opacity: 0.5 }]}
              disabled={selectedIds.length === 0 || saveMut.isPending}
              onPress={() => void saveMut.mutate(selectedIds)}
            >
              {saveMut.isPending ? (
                <ActivityIndicator color="#1a0e05" />
              ) : (
                <Text style={s.primaryText}>
                  Log {selectedIds.length} trail{selectedIds.length === 1 ? "" : "s"} as ridden
                </Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={s.skipBtn} onPress={onDismiss}>
              <Text style={s.skipText}>Not now</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
      <AchievementCelebration
        visible={celebration != null}
        achievements={celebration?.achievements ?? []}
        statsLine={celebration?.statsLine ?? null}
        onDismiss={() => {
          setCelebration(null);
          onDone();
        }}
        onViewProfile={() => {
          setCelebration(null);
          onDone();
          router.push("/profile" as never);
        }}
      />
    </>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.light.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 28,
  },
  title: {
    color: colors.light.foreground,
    fontSize: 20,
    fontWeight: "900",
    marginBottom: 6,
  },
  sub: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 14,
  },
  empty: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    marginBottom: 16,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  rowOn: {
    borderColor: AMBER,
    backgroundColor: "#2a1e00",
  },
  rowText: {
    flex: 1,
    color: colors.light.foreground,
    fontWeight: "600",
    fontSize: 14,
  },
  primaryBtn: {
    backgroundColor: AMBER,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 12,
  },
  primaryText: {
    color: "#1a0e05",
    fontWeight: "900",
    fontSize: 14,
  },
  skipBtn: {
    alignItems: "center",
    paddingVertical: 12,
  },
  skipText: {
    color: colors.light.mutedForeground,
    fontWeight: "600",
  },
});
