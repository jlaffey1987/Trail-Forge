/**
 * Celebrate newly earned achievements after marking a trail ridden.
 */
import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import type { RiderAchievement } from "@/lib/api";

const AMBER = colors.light.primary;

interface Props {
  achievements: Array<Pick<RiderAchievement, "name" | "description" | "icon" | "colour">>;
  statsLine?: string | null;
  visible: boolean;
  onDismiss: () => void;
  onViewProfile?: () => void;
}

export function AchievementCelebration({
  achievements,
  statsLine,
  visible,
  onDismiss,
  onViewProfile,
}: Props) {
  if (!visible) return null;
  const first = achievements[0];
  const statsOnly = achievements.length === 0 && statsLine;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss}>
      <Pressable style={s.backdrop} onPress={onDismiss}>
        <Pressable style={s.card} onPress={(e) => e.stopPropagation()}>
          {statsOnly ? (
            <>
              <View style={[s.iconWrap, { backgroundColor: `${AMBER}22` }]}>
                <Feather name="check-circle" size={32} color="#22c55e" />
              </View>
              <Text style={s.title}>Trail logged!</Text>
              <Text style={s.statsLine}>{statsLine}</Text>
            </>
          ) : (
            <>
              <View
                style={[
                  s.iconWrap,
                  { backgroundColor: `${first?.colour ?? AMBER}22` },
                ]}
              >
                <Feather
                  name={(first?.icon as keyof typeof Feather.glyphMap) ?? "award"}
                  size={32}
                  color={first?.colour ?? AMBER}
                />
              </View>
              <Text style={s.title}>
                {achievements.length === 1
                  ? "Achievement unlocked!"
                  : `${achievements.length} achievements unlocked!`}
              </Text>
              {achievements.map((a) => (
                <View key={a.name} style={s.achievementBlock}>
                  <Text style={s.achievementName}>{a.name}</Text>
                  {a.description ? (
                    <Text style={s.achievementDesc}>{a.description}</Text>
                  ) : null}
                </View>
              ))}
              {statsLine ? <Text style={s.statsLine}>{statsLine}</Text> : null}
            </>
          )}
          {onViewProfile ? (
            <TouchableOpacity style={s.primaryBtn} onPress={onViewProfile}>
              <Text style={s.primaryBtnText}>View my profile</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={s.secondaryBtn} onPress={onDismiss}>
            <Text style={s.secondaryBtnText}>Keep exploring</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    backgroundColor: colors.light.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: AMBER,
    padding: 22,
    alignItems: "center",
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  title: {
    color: colors.light.foreground,
    fontSize: 20,
    fontWeight: "900",
    textAlign: "center",
    marginBottom: 12,
  },
  achievementBlock: {
    alignItems: "center",
    marginBottom: 8,
  },
  achievementName: {
    color: AMBER,
    fontWeight: "800",
    fontSize: 16,
  },
  achievementDesc: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    textAlign: "center",
    marginTop: 4,
  },
  statsLine: {
    color: colors.light.foreground,
    fontSize: 13,
    fontWeight: "600",
    marginTop: 10,
    textAlign: "center",
  },
  primaryBtn: {
    backgroundColor: AMBER,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginTop: 16,
    width: "100%",
    alignItems: "center",
  },
  primaryBtnText: {
    color: "#1a0e05",
    fontWeight: "900",
    fontSize: 14,
  },
  secondaryBtn: {
    marginTop: 10,
    padding: 8,
  },
  secondaryBtnText: {
    color: colors.light.mutedForeground,
    fontWeight: "600",
    fontSize: 13,
  },
});
