/**
 * Start-ride sheet — plain English, large taps, premium-gated navigation.
 */
import { Feather } from "@expo/vector-icons";
import React, { useMemo } from "react";
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

import { TntJoinPickerMap } from "@/components/routes/TntJoinPickerMap";
import colors from "@/constants/colors";
import type { MapTrail } from "@/lib/api";
import type { TntDirection, TntJoinSnap } from "@/lib/tntNavigation";
import type { NavLatLng } from "@/lib/navigationReroute";
import { RIDE_LEVELS, type RideLevelId } from "@/lib/rideLevels";

const AMBER = colors.light.primary;

export interface RidePreviewStats {
  joinName: string;
  /** Road distance from your GPS to the join point (km). */
  joinDistanceKm: number;
  trailSectionCount: number;
  skippedSections: number;
  estimatedRoadBypassKm: number;
  /** Distance remaining along the route from join point (km). */
  remainingRouteKm?: number;
  /** Full route length when join map not used (imported GPX). */
  totalDistanceKm?: number;
}

interface StartRideSheetProps {
  visible: boolean;
  routeName: string;
  isPremium: boolean;
  loading: boolean;
  direction: TntDirection;
  rideLevelId: RideLevelId;
  preview: RidePreviewStats | null;
  /** TNT — interactive join map (tap / drag pin). */
  joinMap?: {
    sections: MapTrail[];
    userGps: NavLatLng;
    join: TntJoinSnap;
    onJoinChange: (join: TntJoinSnap) => void;
  };
  onClose: () => void;
  onSetDirection: (direction: TntDirection) => void;
  onSelectLevel: (id: RideLevelId) => void;
  onStart: () => void;
  onUpgrade: () => void;
  onViewMap: () => void;
  showRideLevels?: boolean;
}

export function StartRideSheet({
  visible,
  routeName,
  isPremium,
  loading,
  direction,
  rideLevelId,
  preview,
  joinMap,
  onClose,
  onSetDirection,
  onSelectLevel,
  onStart,
  onUpgrade,
  onViewMap,
  showRideLevels = true,
}: StartRideSheetProps) {
  const level = RIDE_LEVELS.find((l) => l.id === rideLevelId) ?? RIDE_LEVELS[3];
  const canNavigate = isPremium;

  const directionLabel = useMemo(
    () =>
      direction === "forward"
        ? "Riding the route ahead of the join point"
        : "Riding back toward the route start",
    [direction],
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.scrim}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scrollContent}
        >
          <View style={styles.card}>
            <Text style={styles.title}>Ready to ride?</Text>
            <Text style={styles.sub}>
              {joinMap
                ? `Choose where to join ${routeName}. Blue dot is you — orange pin is your join point.`
                : `We'll join your track at the nearest point and guide you turn by turn.`}
            </Text>

            {joinMap ? (
              <TntJoinPickerMap
                sections={joinMap.sections}
                userGps={joinMap.userGps}
                join={joinMap.join}
                onJoinChange={joinMap.onJoinChange}
              />
            ) : null}

            {preview ? (
              <View style={styles.preview}>
                <Text style={styles.previewLine}>
                  Join at: {preview.joinName}
                </Text>
                <Text style={styles.previewLine}>
                  {preview.joinDistanceKm.toFixed(1)} km on roads to reach join
                  {preview.remainingRouteKm != null
                    ? ` · ${preview.remainingRouteKm} km remaining on route`
                    : ""}
                </Text>
                <Text style={styles.previewLine}>
                  {preview.trailSectionCount} trail sections on your ride
                  {preview.skippedSections > 0
                    ? ` · ${preview.skippedSections} tough parts skipped`
                    : ""}
                </Text>
                {preview.estimatedRoadBypassKm > 0.5 ? (
                  <Text style={styles.previewMuted}>
                    Includes ~{Math.round(preview.estimatedRoadBypassKm)} km on main roads
                  </Text>
                ) : null}
              </View>
            ) : null}

            {!isPremium ? (
              <View style={styles.premiumBanner}>
                <Feather name="lock" size={18} color={AMBER} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.premiumTitle}>Navigation is Premium</Text>
                  <Text style={styles.premiumBody}>
                    Upgrade for turn-by-turn guidance
                    {showRideLevels
                      ? " and a route matched to how challenging you want today's ride to be."
                      : " on your imported track."}
                  </Text>
                </View>
              </View>
            ) : showRideLevels ? (
              <>
                <Text style={styles.label}>HOW CHALLENGING TODAY?</Text>
                <View style={styles.levelCol}>
                  {RIDE_LEVELS.map((l) => {
                    const active = l.id === rideLevelId;
                    const locked = l.requiresPremium && !isPremium;
                    return (
                      <TouchableOpacity
                        key={l.id}
                        style={[styles.levelCard, active && styles.levelCardActive]}
                        onPress={() => {
                          if (locked) onUpgrade();
                          else onSelectLevel(l.id);
                        }}
                        activeOpacity={0.85}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.levelTitle, active && styles.levelTitleActive]}>
                            {l.title}
                          </Text>
                          <Text style={styles.levelSub}>{l.subtitle}</Text>
                        </View>
                        {locked ? (
                          <Feather name="lock" size={16} color="#78716c" />
                        ) : active ? (
                          <Feather name="check-circle" size={20} color={AMBER} />
                        ) : null}
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {level.detail ? (
                  <Text style={styles.levelDetail}>{level.detail}</Text>
                ) : null}
              </>
            ) : (
              <Text style={styles.levelDetail}>
                Your imported track will be used as-is for turn-by-turn guidance.
              </Text>
            )}

            {joinMap ? (
              <View style={styles.directionRow}>
                <Feather name="compass" size={16} color={AMBER} />
                <Text style={styles.directionText}>{directionLabel}</Text>
                <Pressable
                  onPress={() =>
                    onSetDirection(direction === "forward" ? "reverse" : "forward")
                  }
                  hitSlop={8}
                >
                  <Text style={styles.flipLink}>Flip direction</Text>
                </Pressable>
              </View>
            ) : null}

            {canNavigate ? (
              <TouchableOpacity
                style={styles.goBtn}
                disabled={loading || !preview}
                onPress={onStart}
              >
                {loading ? (
                  <>
                    <ActivityIndicator color="#1a0e05" size="small" />
                    <Text style={[styles.goText, { marginLeft: 10 }]}>
                      Planning your route…
                    </Text>
                  </>
                ) : (
                  <Text style={styles.goText}>START RIDING</Text>
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.goBtn} onPress={onUpgrade}>
                <Text style={styles.goText}>UPGRADE TO START NAVIGATION</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity style={styles.secondaryBtn} onPress={onViewMap}>
              <Text style={styles.secondaryText}>View full route on map</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.cancel} onPress={onClose}>
              <Text style={styles.cancelText}>Not now</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  scrollContent: { flexGrow: 1, justifyContent: "flex-end" },
  card: {
    backgroundColor: "#1c1917",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 28,
    borderWidth: 1,
    borderColor: "#292524",
    maxHeight: "92%",
  },
  title: { color: "#fff", fontSize: 22, fontWeight: "900", marginBottom: 8 },
  sub: { color: "#a8a29e", fontSize: 14, lineHeight: 20, marginBottom: 14 },
  preview: {
    backgroundColor: "#292524",
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
    gap: 4,
  },
  previewLine: { color: "#e7e5e4", fontSize: 13, fontWeight: "600" },
  previewMuted: { color: "#78716c", fontSize: 12, marginTop: 2 },
  premiumBanner: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: "rgba(245,166,35,0.1)",
    borderRadius: 10,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "rgba(245,166,35,0.35)",
  },
  premiumTitle: { color: AMBER, fontWeight: "800", fontSize: 14, marginBottom: 4 },
  premiumBody: { color: "#a8a29e", fontSize: 12, lineHeight: 17 },
  label: {
    color: AMBER,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
    marginBottom: 8,
  },
  levelCol: { gap: 8, marginBottom: 8 },
  levelCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#44403c",
    backgroundColor: "#292524",
    gap: 10,
  },
  levelCardActive: {
    borderColor: AMBER,
    backgroundColor: "rgba(245,166,35,0.1)",
  },
  levelTitle: { color: "#fff", fontWeight: "800", fontSize: 16 },
  levelTitleActive: { color: AMBER },
  levelSub: { color: "#78716c", fontSize: 12, marginTop: 2 },
  levelDetail: { color: "#78716c", fontSize: 12, lineHeight: 17, marginBottom: 10 },
  directionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    marginBottom: 4,
  },
  directionText: { flex: 1, color: "#d6d3d1", fontSize: 13, fontWeight: "600" },
  flipLink: { color: AMBER, fontSize: 12, fontWeight: "800" },
  goBtn: {
    marginTop: 8,
    height: 54,
    borderRadius: 12,
    backgroundColor: AMBER,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },
  goText: { color: "#1a0e05", fontWeight: "900", fontSize: 16, letterSpacing: 0.5 },
  secondaryBtn: { alignItems: "center", paddingTop: 14 },
  secondaryText: { color: AMBER, fontWeight: "700", fontSize: 14 },
  cancel: { alignItems: "center", paddingTop: 10 },
  cancelText: { color: "#78716c", fontSize: 14 },
});
