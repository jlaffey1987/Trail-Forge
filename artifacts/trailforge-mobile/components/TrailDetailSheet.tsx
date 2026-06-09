/**
 * Bottom sheet shown when a trail polyline is tapped. Renders distance,
 * difficulty, AI difficulty, terrain, photos and "ridden" / "save" CTAs.
 * Implementation uses a plain modal so we don't need a third-party sheet
 * library — task #220 may upgrade to `@gorhom/bottom-sheet` later.
 */
import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSaveTrail } from "@workspace/api-client-react";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";

import { AchievementCelebration } from "@/components/profile/AchievementCelebration";
import { ElevationChart } from "@/components/ElevationChart";
import colors from "@/constants/colors";
import {
  listTrailAmendments,
  listTrailNotes,
  markTrailRidden,
  unmarkTrailRidden,
  type MarkTrailRiddenResult,
  type RiderAchievement,
} from "@/lib/api";
import { difficultyColor, difficultyLabel, type TrailDifficulty } from "@/lib/trailColors";

export interface TrailDetailData {
  id: string;
  name: string;
  difficulty: TrailDifficulty;
  ai_difficulty?: TrailDifficulty;
  terrain?: string | null;
  distance_km?: number | null;
  elevation_gain_m?: number | null;
  altitudes?: number[];
  photo_urls?: string[];
  legal_status?: string | null;
}

interface TrailDetailSheetProps {
  visible: boolean;
  trail: TrailDetailData | null;
  ridden: boolean;
  onClose: () => void;
  onMarkRiddenChange?: (next: boolean) => void;
}

export function TrailDetailSheet({
  visible,
  trail,
  ridden,
  onClose,
  onMarkRiddenChange,
}: TrailDetailSheetProps) {
  const { width } = useWindowDimensions();
  const qc = useQueryClient();
  const [celebration, setCelebration] = useState<{
    achievements: Array<Pick<RiderAchievement, "name" | "description" | "icon" | "colour">>;
    statsLine: string | null;
  } | null>(null);

  const saveMut = useSaveTrail({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ["listMySavedTrails"] });
      },
    },
  });

  const riddenMut = useMutation({
    mutationFn: async (next: boolean) => {
      if (!trail) return null;
      if (next) {
        return markTrailRidden(trail.id);
      }
      await unmarkTrailRidden(trail.id);
      return null;
    },
    onSuccess: (data, next) => {
      onMarkRiddenChange?.(next);
      void qc.invalidateQueries({ queryKey: ["recently-ridden"] });
      void qc.invalidateQueries({ queryKey: ["rider-profile", "me"] });
      if (next && data && (data as MarkTrailRiddenResult).isNew !== false) {
        const result = data as MarkTrailRiddenResult;
        const stats = result.stats;
        const statsLine = stats
          ? `${stats.trailKmTotal.toFixed(1)} km ridden · ${stats.trailsCompleted} trails · ${stats.rankTitle}`
          : null;
        if (result.newAchievements.length > 0) {
          setCelebration({
            achievements: result.newAchievements,
            statsLine,
          });
        } else if (statsLine) {
          setCelebration({ achievements: [], statsLine });
        }
      }
    },
  });

  const notesQ = useQuery({
    queryKey: ["trail-notes-count", trail?.id],
    queryFn: () => listTrailNotes(trail!.id),
    enabled: !!trail && visible,
    staleTime: 30_000,
  });
  const amendmentsQ = useQuery({
    queryKey: ["trail-amendments-count", trail?.id],
    queryFn: () => listTrailAmendments(trail!.id),
    enabled: !!trail && visible,
    staleTime: 30_000,
  });
  const notesCount = notesQ.data?.items?.length ?? 0;
  const pendingCount = (amendmentsQ.data?.items ?? []).filter(
    (a) => a.status === "pending",
  ).length;

  if (!trail) return null;

  return (
    <>
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title} numberOfLines={2}>
                {trail.name}
              </Text>
              <View style={styles.badges}>
                <DiffBadge difficulty={trail.difficulty} />
                {trail.ai_difficulty &&
                trail.ai_difficulty !== trail.difficulty ? (
                  <DiffBadge difficulty={trail.ai_difficulty} prefix="AI: " />
                ) : null}
                {trail.terrain ? (
                  <View style={styles.terrainBadge}>
                    <Text style={styles.terrainBadgeText}>{trail.terrain}</Text>
                  </View>
                ) : null}
                {trail.legal_status ? (
                  <View style={styles.legalBadge}>
                    <Feather
                      name="shield"
                      size={11}
                      color={colors.light.primaryForeground}
                    />
                    <Text style={styles.legalBadgeText}>
                      {trail.legal_status}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
            <TouchableOpacity onPress={onClose} accessibilityLabel="Close">
              <Feather name="x" size={22} color={colors.light.mutedForeground} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={styles.statsRow}>
              <Stat
                label="Distance"
                value={
                  trail.distance_km != null
                    ? `${trail.distance_km.toFixed(2)} km`
                    : "—"
                }
              />
              <Stat
                label="Elevation"
                value={
                  trail.elevation_gain_m != null
                    ? `${Math.round(trail.elevation_gain_m)} m`
                    : "—"
                }
              />
            </View>

            {trail.altitudes && trail.altitudes.length > 1 ? (
              <View style={{ marginTop: 14 }}>
                <Text style={styles.sectionLabel}>Elevation profile</Text>
                <ElevationChart
                  altitudes={trail.altitudes}
                  width={Math.min(width, 560) - 40}
                />
              </View>
            ) : null}

            <View style={styles.actions}>
              <TouchableOpacity
                onPress={() => riddenMut.mutate(!ridden)}
                disabled={riddenMut.isPending}
                style={[styles.actionBtn, ridden && styles.actionBtnActive]}
              >
                {riddenMut.isPending ? (
                  <ActivityIndicator color={colors.light.primaryForeground} />
                ) : (
                  <>
                    <Feather
                      name={ridden ? "check-circle" : "circle"}
                      size={18}
                      color={
                        ridden
                          ? colors.light.primaryForeground
                          : colors.light.primary
                      }
                    />
                    <Text
                      style={[
                        styles.actionBtnText,
                        ridden && {
                          color: colors.light.primaryForeground,
                        },
                      ]}
                    >
                      {ridden ? "Ridden" : "Mark as ridden"}
                    </Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => saveMut.mutate({ data: { trailId: trail.id } })}
                disabled={saveMut.isPending}
                style={styles.secondaryBtn}
              >
                {saveMut.isPending ? (
                  <ActivityIndicator color={colors.light.primary} />
                ) : (
                  <>
                    <Feather
                      name="bookmark"
                      size={16}
                      color={colors.light.primary}
                    />
                    <Text style={styles.secondaryBtnText}>Save</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {/* Quick-glance counts + jump-off to the full-detail screen
                where notes, photos, amendments and share-to-group live.
                Keeps the sheet itself uncluttered while preserving full
                feature parity with the web TrailDetailSheet tabs. */}
            <View style={styles.contentRow}>
              <ContentChip
                icon="message-square"
                label={`${notesCount} note${notesCount === 1 ? "" : "s"}`}
              />
              <ContentChip
                icon="image"
                label={`${trail.photo_urls?.length ?? 0} photo${
                  (trail.photo_urls?.length ?? 0) === 1 ? "" : "s"
                }`}
              />
              {pendingCount > 0 ? (
                <ContentChip
                  icon="edit-3"
                  label={`${pendingCount} pending`}
                  highlight
                />
              ) : null}
            </View>
            <TouchableOpacity
              style={styles.viewFullBtn}
              onPress={() => {
                onClose();
                router.push(`/trail/${encodeURIComponent(trail.id)}`);
              }}
            >
              <Feather
                name="external-link"
                size={14}
                color={colors.light.primary}
              />
              <Text style={styles.viewFullBtnText}>
                View full details, notes &amp; share
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
    <AchievementCelebration
      visible={celebration != null}
      achievements={celebration?.achievements ?? []}
      statsLine={celebration?.statsLine ?? null}
      onDismiss={() => setCelebration(null)}
      onViewProfile={() => {
        setCelebration(null);
        onClose();
        router.push("/profile" as never);
      }}
    />
    </>
  );
}

function DiffBadge({
  difficulty,
  prefix,
}: {
  difficulty: TrailDifficulty;
  prefix?: string;
}) {
  return (
    <View
      style={[
        styles.diffBadge,
        { borderColor: difficultyColor(difficulty) },
      ]}
    >
      <View
        style={[
          styles.diffDot,
          { backgroundColor: difficultyColor(difficulty) },
        ]}
      />
      <Text style={styles.diffBadgeText}>
        {prefix ?? ""}
        {difficultyLabel(difficulty)}
      </Text>
    </View>
  );
}

function ContentChip({
  icon,
  label,
  highlight,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  highlight?: boolean;
}) {
  return (
    <View
      style={[styles.contentChip, highlight && styles.contentChipHighlight]}
    >
      <Feather
        name={icon}
        size={12}
        color={
          highlight ? colors.light.primaryForeground : colors.light.mutedForeground
        }
      />
      <Text
        style={[
          styles.contentChipText,
          highlight && { color: colors.light.primaryForeground },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.light.card,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 28,
    maxHeight: "85%",
    borderColor: colors.light.border,
    borderWidth: 1,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.light.border,
    alignSelf: "center",
    marginBottom: 14,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 12,
  },
  title: { color: colors.light.foreground, fontSize: 18, fontWeight: "700" },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  diffBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  diffDot: { width: 8, height: 8, borderRadius: 4 },
  diffBadgeText: { color: colors.light.foreground, fontSize: 11 },
  terrainBadge: {
    backgroundColor: colors.light.muted,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  terrainBadgeText: { color: colors.light.mutedForeground, fontSize: 11 },
  legalBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.light.primary,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  legalBadgeText: {
    color: colors.light.primaryForeground,
    fontSize: 11,
    fontWeight: "600",
  },
  contentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 14,
  },
  contentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.light.muted,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  contentChipHighlight: { backgroundColor: colors.light.primary },
  contentChipText: { color: colors.light.mutedForeground, fontSize: 11 },
  viewFullBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.light.border,
    borderRadius: 10,
    paddingVertical: 10,
  },
  viewFullBtnText: { color: colors.light.primary, fontWeight: "600" },
  statsRow: { flexDirection: "row", gap: 12 },
  stat: {
    flex: 1,
    backgroundColor: colors.light.muted,
    borderRadius: 10,
    padding: 12,
  },
  statLabel: { color: colors.light.mutedForeground, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  statValue: { color: colors.light.foreground, fontSize: 16, fontWeight: "700", marginTop: 2 },
  sectionLabel: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  actions: { flexDirection: "row", gap: 10, marginTop: 18 },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1.5,
    borderColor: colors.light.primary,
    borderRadius: 12,
    paddingVertical: 12,
  },
  actionBtnActive: { backgroundColor: colors.light.primary },
  actionBtnText: { color: colors.light.primary, fontWeight: "700" },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: colors.light.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  secondaryBtnText: { color: colors.light.primary, fontWeight: "600" },
});
