/**
 * Google Maps–inspired navigation chrome for TrailForge.
 * Floating cards, familiar turn banner, bottom ETA strip, circular FABs.
 */
import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  Animated,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";

import { formatArrivalTime, type NavInstruction, type NavProgress, type NavSection } from "@/lib/navigation";
import { gradeToColor } from "@/lib/trailColors";
import type { NavPrefs } from "@/lib/navPrefs";
import { formatSpeed } from "@/lib/navPrefs";

import { GM } from "@/lib/navGoogleTheme";
import { TurnShieldIcon } from "@/components/nav/TurnShieldIcon";

export { GM };

function turnDistance(m: number): string {
  if (m < 50) return "Now";
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

// ── Road instruction banner (green, GMaps-style) ────────────────────────────

export function RoadInstructionBanner({
  instruction,
  distanceM,
  nextNext,
  nextTrailHint,
  style,
}: {
  instruction: NavInstruction | null;
  distanceM: number;
  nextNext: NavInstruction | null;
  nextTrailHint?: { name: string; grade: number | null; distM: number } | null;
  style?: ViewStyle;
}) {
  if (!instruction) {
    return (
      <View style={[chrome.instrBanner, style]}>
        <TurnShieldIcon icon="straight" size={52} variant="banner" />
        <View style={chrome.instrBody}>
          <Text style={chrome.instrDistance}>Continue</Text>
          <Text style={chrome.instrStreet} numberOfLines={2}>
            Stay on route
          </Text>
        </View>
      </View>
    );
  }

  const showDistance = distanceM > 25;

  return (
    <View style={[chrome.instrBanner, style]}>
      <TurnShieldIcon icon={instruction.icon} size={52} variant="banner" />
      <View style={chrome.instrBody}>
        {showDistance ? (
          <Text style={chrome.instrDistance}>{turnDistance(distanceM)}</Text>
        ) : null}
        <Text style={chrome.instrStreet} numberOfLines={2}>
          {instruction.shortText}
        </Text>
        {instruction.trailName ? (
          <Text style={chrome.instrSub} numberOfLines={1}>
            {instruction.trailName}
          </Text>
        ) : null}
        {nextTrailHint && nextTrailHint.distM > 200 ? (
          <Text style={chrome.nextTrailHint} numberOfLines={1}>
            Next trail · {nextTrailHint.name}
            {nextTrailHint.grade != null ? ` (G${nextTrailHint.grade})` : ""}
            {" · "}
            {nextTrailHint.distM >= 1000
              ? `${(nextTrailHint.distM / 1000).toFixed(1)} km`
              : `${Math.round(nextTrailHint.distM / 50) * 50} m`}
          </Text>
        ) : null}
      </View>
      {nextNext ? (
        <View style={chrome.thenBox}>
          <Text style={chrome.thenLabel}>Then</Text>
          <View style={chrome.thenIcon}>
            <TurnShieldIcon icon={nextNext.icon} size={18} variant="onGreen" />
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ── Trail instruction banner (white card, grade accent) ───────────────────────

export function TrailInstructionBanner({
  section,
  remainingKm,
  style,
}: {
  section?: NavSection;
  remainingKm: number;
  style?: ViewStyle;
}) {
  const grade = section?.grade ?? null;
  const accent = gradeToColor(grade);

  return (
    <View style={[chrome.trailBanner, { borderLeftColor: accent }, style]}>
      <View style={[chrome.trailGradeCircle, { backgroundColor: accent }]}>
        <Text style={chrome.trailGradeNum}>{grade ?? "?"}</Text>
      </View>
      <View style={chrome.instrBody}>
        <View style={chrome.trailChipRow}>
          <View style={[chrome.offroadChip, { backgroundColor: accent }]}>
            <Text style={chrome.offroadChipText}>OFF-ROAD</Text>
          </View>
        </View>
        <Text style={chrome.trailTitle} numberOfLines={1}>
          {section?.name ?? "Trail section"}
        </Text>
        <Text style={chrome.trailSub}>
          {remainingKm.toFixed(1)} km remaining on trail
        </Text>
      </View>
    </View>
  );
}

// ── Bottom ETA card ───────────────────────────────────────────────────────────

export function NavEtaCard({
  progress,
  prefs,
  style,
}: {
  progress: NavProgress | null;
  prefs: NavPrefs;
  style?: ViewStyle;
}) {
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
    <View style={[chrome.etaCard, style]}>
      <View style={chrome.etaPrimary}>
        <Text style={chrome.etaTime}>{eta}</Text>
        <Text style={chrome.etaMeta}>
          {mins > 0 ? `${mins} min` : "< 1 min"} · {dist}
        </Text>
      </View>
      <View style={chrome.etaDivider} />
      <View style={chrome.etaSpeed}>
        <Text style={chrome.etaSpeedVal}>{speed}</Text>
        <Text style={chrome.etaSpeedUnit}>{prefs.speedUnit}</Text>
      </View>
    </View>
  );
}

// ── Floating action buttons ───────────────────────────────────────────────────

export function NavFab({
  icon,
  onPress,
  active,
  accessibilityLabel,
}: {
  icon: keyof typeof Feather.glyphMap;
  onPress: () => void;
  active?: boolean;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      style={[chrome.fab, active && chrome.fabActive]}
      hitSlop={6}
    >
      <Feather
        name={icon}
        size={22}
        color={active ? GM.card : GM.textSecondary}
      />
    </Pressable>
  );
}

export function NavFabColumn({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[chrome.fabColumn, style]}>{children}</View>;
}

export function NavCloseButton({ onPress, style }: { onPress: () => void; style?: ViewStyle }) {
  return (
    <Pressable
      onPress={onPress}
      style={[chrome.closeBtn, style]}
      accessibilityLabel="Exit navigation"
      hitSlop={8}
    >
      <Feather name="x" size={22} color={GM.text} />
    </Pressable>
  );
}

// ── Re-centre FAB (pulsing) ───────────────────────────────────────────────────

export function NavRecentreFab({
  onPress,
  pulseAnim,
  style,
}: {
  onPress: () => void;
  pulseAnim: Animated.Value;
  style?: ViewStyle;
}) {
  return (
    <Animated.View style={[style, { transform: [{ scale: pulseAnim }] }]}>
      <Pressable onPress={onPress} style={chrome.fab} hitSlop={6} accessibilityLabel="Re-centre map">
        <Feather name="navigation" size={22} color={GM.blue} />
      </Pressable>
    </Animated.View>
  );
}

// ── Status chip (recalculating) ───────────────────────────────────────────────

export function NavStatusChip({ message }: { message: string }) {
  return (
    <View style={chrome.statusChip}>
      <ActivityIndicator size="small" color={GM.blue} />
      <Text style={chrome.statusChipText}>{message}</Text>
    </View>
  );
}

// ── Google-style user location puck ───────────────────────────────────────────

export function GoogleUserMarker({
  heading,
  markerStyle,
}: {
  heading: number;
  markerStyle: "arrow" | "motorcycle";
}) {
  if (markerStyle === "motorcycle") {
    return (
      <View style={[chrome.puckWrap, { transform: [{ rotate: `${heading}deg` }] }]}>
        <View style={chrome.puckRing} />
        <Text style={{ fontSize: 22 }}>🏍️</Text>
      </View>
    );
  }

  return (
    <View style={[chrome.puckWrap, { transform: [{ rotate: `${heading}deg` }] }]}>
      <View style={chrome.puckRing} />
      <View style={chrome.puckCone} />
      <View style={chrome.puckDot} />
    </View>
  );
}

// ── Handoff bottom sheet ──────────────────────────────────────────────────────

export function NavHandoffSheet({
  distM,
  onNavigateToStart,
  onStartHere,
}: {
  distM: number;
  onNavigateToStart: () => void;
  onStartHere: () => void;
}) {
  return (
    <View style={chrome.handoffSheet}>
      <View style={chrome.handoffHandle} />
      <Text style={chrome.handoffTitle}>
        You&apos;re {(distM / 1000).toFixed(1)} km from the route start
      </Text>
      <Text style={chrome.handoffSub}>How would you like to begin?</Text>
      <Pressable style={chrome.handoffPrimary} onPress={onNavigateToStart}>
        <Feather name="navigation" size={20} color={GM.card} style={{ marginRight: 8 }} />
        <Text style={chrome.handoffPrimaryText}>Drive to start first</Text>
      </Pressable>
      <Pressable style={chrome.handoffSecondary} onPress={onStartHere}>
        <Text style={chrome.handoffSecondaryText}>Start from here</Text>
      </Pressable>
    </View>
  );
}

// ── Loading screen ────────────────────────────────────────────────────────────

export function NavLoadingScreen({
  message,
  error,
  onBack,
  paddingTop,
}: {
  message: string;
  error: string | null;
  onBack: () => void;
  paddingTop: number;
}) {
  return (
    <View style={[chrome.loadingScreen, { paddingTop }]}>
      <View style={chrome.loadingCard}>
        <Feather name="navigation" size={40} color={GM.blue} />
        <Text style={chrome.loadingText}>{error ?? message}</Text>
        {error ? (
          <Pressable style={chrome.loadingBtn} onPress={onBack}>
            <Text style={chrome.loadingBtnText}>Go back</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const SHADOW = {
  shadowColor: GM.shadow,
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.18,
  shadowRadius: 8,
  elevation: 6,
};

const chrome = StyleSheet.create({
  instrBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: GM.green,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 12,
    ...SHADOW,
  },
  instrIconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  instrBody: { flex: 1, minWidth: 0 },
  instrDistance: {
    color: GM.card,
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
    lineHeight: 32,
  },
  instrStreet: {
    color: GM.card,
    fontSize: 17,
    fontWeight: "600",
    lineHeight: 22,
    marginTop: 2,
  },
  instrSub: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 13,
    marginTop: 2,
  },
  nextTrailHint: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 4,
  },
  thenBox: { alignItems: "center", paddingLeft: 4, minWidth: 44 },
  thenLabel: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 4,
  },
  thenIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },

  trailBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: GM.card,
    borderRadius: 16,
    borderLeftWidth: 5,
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 12,
    ...SHADOW,
  },
  trailGradeCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  trailGradeNum: {
    color: GM.card,
    fontSize: 22,
    fontWeight: "800",
  },
  trailChipRow: { flexDirection: "row", marginBottom: 4 },
  offroadChip: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  offroadChipText: {
    color: GM.card,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  trailTitle: {
    color: GM.text,
    fontSize: 17,
    fontWeight: "700",
  },
  trailSub: {
    color: GM.textSecondary,
    fontSize: 14,
    marginTop: 2,
  },

  etaCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: GM.card,
    borderRadius: 20,
    paddingVertical: 14,
    paddingHorizontal: 18,
    ...SHADOW,
  },
  etaPrimary: { flex: 1 },
  etaTime: {
    color: GM.text,
    fontSize: 26,
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
    height: 40,
    backgroundColor: GM.divider,
    marginHorizontal: 16,
  },
  etaSpeed: { alignItems: "center", minWidth: 56 },
  etaSpeedVal: {
    color: GM.text,
    fontSize: 22,
    fontWeight: "700",
  },
  etaSpeedUnit: {
    color: GM.textMuted,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    marginTop: 2,
  },

  fabColumn: { gap: 10 },
  fab: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: GM.card,
    alignItems: "center",
    justifyContent: "center",
    ...SHADOW,
  },
  fabActive: { backgroundColor: GM.blue },

  closeBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: GM.card,
    alignItems: "center",
    justifyContent: "center",
    ...SHADOW,
  },

  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: GM.card,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 24,
    ...SHADOW,
  },
  statusChipText: {
    color: GM.text,
    fontSize: 15,
    fontWeight: "600",
  },

  puckWrap: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  puckRing: {
    position: "absolute",
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(66, 133, 244, 0.25)",
  },
  puckCone: {
    position: "absolute",
    top: 2,
    width: 0,
    height: 0,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderBottomWidth: 22,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: "rgba(66, 133, 244, 0.45)",
  },
  puckDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: GM.blue,
    borderWidth: 3,
    borderColor: GM.card,
  },

  handoffSheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: GM.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 36,
    ...SHADOW,
    shadowOffset: { width: 0, height: -4 },
    elevation: 16,
  },
  handoffHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: GM.divider,
    alignSelf: "center",
    marginBottom: 16,
  },
  handoffTitle: {
    color: GM.text,
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 6,
  },
  handoffSub: {
    color: GM.textSecondary,
    fontSize: 15,
    marginBottom: 20,
  },
  handoffPrimary: {
    flexDirection: "row",
    backgroundColor: GM.blue,
    borderRadius: 12,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  handoffPrimaryText: {
    color: GM.card,
    fontSize: 16,
    fontWeight: "700",
  },
  handoffSecondary: {
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  handoffSecondaryText: {
    color: GM.blue,
    fontSize: 16,
    fontWeight: "600",
  },

  loadingScreen: {
    flex: 1,
    backgroundColor: "#E8EAED",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  loadingCard: {
    backgroundColor: GM.card,
    borderRadius: 20,
    padding: 32,
    alignItems: "center",
    gap: 16,
    width: "100%",
    maxWidth: 320,
    ...SHADOW,
  },
  loadingText: {
    color: GM.text,
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
  },
  loadingBtn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: GM.blue,
  },
  loadingBtnText: {
    color: GM.card,
    fontWeight: "700",
    fontSize: 15,
  },
});
