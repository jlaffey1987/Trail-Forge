/**
 * Start-ride sheet — plain English, large taps, premium-gated navigation.
 */
import { Feather } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import type { TntDirection } from "@/lib/tntNavigation";
import { RIDE_LEVELS, type RideLevelId } from "@/lib/rideLevels";

const AMBER = colors.light.primary;

export interface RidePreviewStats {
  joinName: string;
  joinDistanceKm: number;
  trailSectionCount: number;
  skippedSections: number;
  estimatedRoadBypassKm: number;
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
  onClose: () => void;
  onSetDirection: (direction: TntDirection) => void;
  onSelectLevel: (id: RideLevelId) => void;
  onStart: () => void;
  onUpgrade: () => void;
  onViewMap: () => void;
  /** Hide difficulty tailoring (e.g. imported third-party GPX). */
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
  onClose,
  onSetDirection,
  onSelectLevel,
  onStart,
  onUpgrade,
  onViewMap,
  showRideLevels = true,
}: StartRideSheetProps) {
  const [showDirection, setShowDirection] = useState(false);
  const level = RIDE_LEVELS.find((l) => l.id === rideLevelId) ?? RIDE_LEVELS[3];

  const canNavigate = isPremium;

  const directionLabel = useMemo(
    () =>
      direction === "forward"
        ? "Riding toward the route end"
        : "Riding toward the route start",
    [direction],
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={styles.card}>
          <Text style={styles.title}>Ready to ride?</Text>
          <Text style={styles.sub}>
            We'll join {routeName} at the nearest point to you and guide you on
            roads and trails.
          </Text>

          {preview ? (
            <View style={styles.preview}>
              <Text style={styles.previewLine}>
                Join near: {preview.joinName} ({preview.joinDistanceKm.toFixed(1)} km away)
              </Text>
              <Text style={styles.previewLine}>
                {preview.trailSectionCount} trail sections on your route
                {preview.skippedSections > 0
                  ? ` · ${preview.skippedSections} tough parts avoided`
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

          <Pressable
            style={styles.directionRow}
            onPress={() => setShowDirection((v) => !v)}
          >
            <Feather name="compass" size={16} color={AMBER} />
            <Text style={styles.directionText}>{directionLabel}</Text>
            <Feather name={showDirection ? "chevron-up" : "chevron-down"} size={16} color="#78716c" />
          </Pressable>
          {showDirection ? (
            <View style={styles.dirBtns}>
              <TouchableOpacity
                style={[styles.dirBtn, direction === "forward" && styles.dirBtnOn]}
                onPress={() => onSetDirection("forward")}
              >
                <Text style={styles.dirBtnText}>Toward route end →</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.dirBtn, direction === "reverse" && styles.dirBtnOn]}
                onPress={() => onSetDirection("reverse")}
              >
                <Text style={styles.dirBtnText}>← Toward route start</Text>
              </TouchableOpacity>
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
            <Text style={styles.secondaryText}>View route on map</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>Not now</Text>
          </TouchableOpacity>
        </View>
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
  card: {
    backgroundColor: "#1c1917",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 28,
    borderWidth: 1,
    borderColor: "#292524",
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
  },
  directionText: { flex: 1, color: "#d6d3d1", fontSize: 13, fontWeight: "600" },
  dirBtns: { flexDirection: "row", gap: 8, marginBottom: 8 },
  dirBtn: {
    flex: 1,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#44403c",
    alignItems: "center",
  },
  dirBtnOn: { borderColor: AMBER, backgroundColor: "rgba(245,166,35,0.12)" },
  dirBtnText: { color: "#e7e5e4", fontSize: 12, fontWeight: "700" },
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
