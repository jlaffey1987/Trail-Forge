/**
 * Swipe-up bottom sheet: ETA summary + full route / turn-by-turn steps.
 */
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useMemo, useRef } from "react";
import {
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

import { TurnShieldIcon } from "@/components/nav/TurnShieldIcon";
import { GM } from "@/lib/navGoogleTheme";
import {
  buildRouteTimeline,
  distanceToInstructionM,
  formatLegDistance,
  type RouteTimelineLeg,
} from "@/lib/navRouteTimeline";
import { formatArrivalTime, type NavProgress, type NavRoute } from "@/lib/navigation";
import type { NavPrefs } from "@/lib/navPrefs";
import { formatSpeed } from "@/lib/navPrefs";
import { gradeToColor } from "@/lib/trailColors";

const SCREEN_H = Dimensions.get("window").height;
const COLLAPSED_H = 88;
const EXPANDED_H = Math.min(SCREEN_H * 0.58, 520);
const SNAP_MID = (COLLAPSED_H + EXPANDED_H) / 2;

interface Props {
  route: NavRoute;
  progress: NavProgress | null;
  prefs: NavPrefs;
  bottomInset: number;
  onSkipSection?: (sectionId: string, sectionName: string) => void;
  onExpandedChange?: (expanded: boolean) => void;
}

export function NavRouteSheet({
  route,
  progress,
  prefs,
  bottomInset,
  onSkipSection,
  onExpandedChange,
}: Props) {
  const sheetH = useSharedValue(COLLAPSED_H);
  const dragStart = useSharedValue(COLLAPSED_H);
  const scrollRef = useRef<ScrollView>(null);
  const expandedRef = useRef(false);

  const timeline = useMemo(
    () => buildRouteTimeline(route, progress),
    [route, progress],
  );

  const currentLegIdx = timeline.findIndex((l) => l.status === "current");

  useEffect(() => {
    if (expandedRef.current && currentLegIdx >= 0) {
      scrollRef.current?.scrollTo({ y: Math.max(0, currentLegIdx * 72 - 40), animated: true });
    }
  }, [currentLegIdx, expandedRef.current]);

  function setExpanded(expanded: boolean) {
    expandedRef.current = expanded;
    onExpandedChange?.(expanded);
  }

  function snapTo(height: number) {
    "worklet";
    sheetH.value = withSpring(height, { damping: 22, stiffness: 220 });
    runOnJS(setExpanded)(height > COLLAPSED_H + 40);
  }

  const pan = Gesture.Pan()
    .onBegin(() => {
      dragStart.value = sheetH.value;
    })
    .onUpdate((e) => {
      const next = dragStart.value - e.translationY;
      sheetH.value = Math.max(COLLAPSED_H, Math.min(EXPANDED_H, next));
    })
    .onEnd(() => {
      snapTo(sheetH.value >= SNAP_MID ? EXPANDED_H : COLLAPSED_H);
    });

  const sheetStyle = useAnimatedStyle(() => ({
    height: sheetH.value + bottomInset,
  }));

  function toggleSheet() {
    const next = sheetH.value < SNAP_MID ? EXPANDED_H : COLLAPSED_H;
    sheetH.value = withSpring(next, { damping: 22, stiffness: 220 });
    setExpanded(next > COLLAPSED_H + 40);
  }

  const eta = progress ? formatArrivalTime(progress.etaMin) : "—";
  const mins = progress?.etaMin ?? 0;
  const dist =
    progress == null
      ? "—"
      : progress.distanceRemainingM >= 1000
        ? `${(progress.distanceRemainingM / 1000).toFixed(1)} km`
        : `${Math.round(progress.distanceRemainingM)} m`;
  const speed = progress
    ? formatSpeed(progress.speedKmh / 3.6, prefs.speedUnit)
    : "0";

  return (
    <Animated.View style={[styles.sheet, sheetStyle, { paddingBottom: bottomInset }]}>
      <GestureDetector gesture={pan}>
        <Pressable onPress={toggleSheet} style={styles.handleArea}>
          <View style={styles.handle} />
        </Pressable>
      </GestureDetector>

      <Pressable onPress={toggleSheet} style={styles.etaRow}>
        <View style={styles.etaPrimary}>
          <Text style={styles.etaTime}>{eta}</Text>
          <Text style={styles.etaMeta}>
            {mins > 0 ? `${mins} min` : "< 1 min"} · {dist}
          </Text>
        </View>
        <View style={styles.etaDivider} />
        <View style={styles.etaSpeed}>
          <Text style={styles.etaSpeedVal}>{speed}</Text>
          <Text style={styles.etaSpeedUnit}>{prefs.speedUnit}</Text>
        </View>
        <Feather name="chevron-up" size={20} color={GM.textMuted} style={styles.chevron} />
      </Pressable>

      <ScrollView
        ref={scrollRef}
        style={styles.stepsScroll}
        contentContainerStyle={styles.stepsContent}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
      >
        <Text style={styles.stepsTitle}>Route overview</Text>
        {timeline.map((leg) => (
          <TimelineLegRow
            key={leg.sectionId}
            leg={leg}
            progress={progress}
            canSkip={
              leg.kind === "trail" &&
              leg.status !== "done" &&
              onSkipSection != null
            }
            onSkip={
              onSkipSection
                ? () => onSkipSection(leg.sectionId, leg.name)
                : undefined
            }
          />
        ))}
        <View style={{ height: 12 }} />
      </ScrollView>
    </Animated.View>
  );
}

function TimelineLegRow({
  leg,
  progress,
  canSkip,
  onSkip,
}: {
  leg: RouteTimelineLeg;
  progress: NavProgress | null;
  canSkip: boolean;
  onSkip?: () => void;
}) {
  const isTrail = leg.kind === "trail";
  const accent = isTrail ? gradeToColor(leg.grade) : GM.blue;
  const primaryInstr = leg.instructions.find((i) => i.icon !== "start") ?? leg.instructions[0];

  return (
    <View
      style={[
        styles.legRow,
        leg.status === "current" && styles.legRowCurrent,
        leg.status === "done" && styles.legRowDone,
      ]}
    >
      <View style={styles.legIconCol}>
        {primaryInstr ? (
          <TurnShieldIcon icon={primaryInstr.icon} size={28} variant="list" />
        ) : (
          <View style={[styles.legDot, { backgroundColor: accent }]} />
        )}
      </View>
      <View style={styles.legBody}>
        <View style={styles.legHeader}>
          <View style={[styles.kindChip, { backgroundColor: isTrail ? accent : GM.blueTint }]}>
            <Text style={[styles.kindChipText, { color: isTrail ? GM.card : GM.blue }]}>
              {isTrail ? `Trail · G${leg.grade ?? "?"}` : "Road"}
            </Text>
          </View>
          <Text style={styles.legDist}>{formatLegDistance(leg.distanceM)}</Text>
        </View>
        <Text style={styles.legName} numberOfLines={2}>
          {leg.name}
        </Text>
        {leg.instructions.slice(0, 3).map((instr, i) => {
          const distAhead = distanceToInstructionM(progress, instr.triggerDistanceM);
          return (
            <View key={`${instr.triggerDistanceM}-${i}`} style={styles.subStep}>
              <TurnShieldIcon icon={instr.icon} size={14} variant="mini" />
              <Text style={styles.subStepText} numberOfLines={1}>
                {instr.shortText}
                {distAhead != null && distAhead > 30 && leg.status !== "done"
                  ? ` · ${formatLegDistance(distAhead)}`
                  : ""}
              </Text>
            </View>
          );
        })}
        {canSkip && onSkip ? (
          <Pressable onPress={onSkip} style={styles.skipBtn} hitSlop={6}>
            <Feather name="skip-forward" size={14} color={GM.trailAccent} />
            <Text style={styles.skipText}>Skip this section</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const SHADOW = {
  shadowColor: GM.shadow,
  shadowOffset: { width: 0, height: -3 },
  shadowOpacity: 0.14,
  shadowRadius: 10,
  elevation: 12,
};

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: GM.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: "hidden",
    ...SHADOW,
  },
  handleArea: {
    alignItems: "center",
    paddingTop: 10,
    paddingBottom: 4,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: GM.divider,
  },
  etaRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingBottom: 10,
  },
  etaPrimary: { flex: 1 },
  etaTime: {
    color: GM.text,
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  etaMeta: {
    color: GM.textSecondary,
    fontSize: 14,
    marginTop: 2,
    fontWeight: "500",
  },
  etaDivider: {
    width: StyleSheet.hairlineWidth,
    height: 36,
    backgroundColor: GM.divider,
    marginHorizontal: 14,
  },
  etaSpeed: { alignItems: "center", minWidth: 52 },
  etaSpeedVal: { color: GM.text, fontSize: 20, fontWeight: "700" },
  etaSpeedUnit: {
    color: GM.textMuted,
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    marginTop: 2,
  },
  chevron: { marginLeft: 8 },
  stepsScroll: { flex: 1 },
  stepsContent: { paddingHorizontal: 16, paddingBottom: 8 },
  stepsTitle: {
    color: GM.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  legRow: {
    flexDirection: "row",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: GM.divider,
  },
  legRowCurrent: {
    backgroundColor: GM.blueTint,
    marginHorizontal: -16,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderBottomWidth: 0,
    marginBottom: 4,
  },
  legRowDone: { opacity: 0.45 },
  legIconCol: { width: 32, alignItems: "center", paddingTop: 2 },
  legDot: { width: 12, height: 12, borderRadius: 6 },
  legBody: { flex: 1, minWidth: 0 },
  legHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  kindChip: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  kindChipText: { fontSize: 10, fontWeight: "800", letterSpacing: 0.4 },
  legDist: { color: GM.textMuted, fontSize: 12, fontWeight: "600" },
  legName: { color: GM.text, fontSize: 16, fontWeight: "600", marginBottom: 4 },
  subStep: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  subStepText: { flex: 1, color: GM.textSecondary, fontSize: 13 },
  skipBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  skipText: { color: GM.trailAccent, fontSize: 13, fontWeight: "600" },
});
