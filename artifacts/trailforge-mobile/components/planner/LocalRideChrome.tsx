/**
 * Bottom chrome on the Map tab during local ride selection (no destination).
 */
import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LocalRideReviewSheet } from "@/components/planner/LocalRideReviewSheet";
import { UpgradePrompt } from "@/components/UpgradePrompt";
import { useProfile } from "@/components/ProfileContext";
import colors from "@/constants/colors";
import { getAccuratePosition } from "@/lib/location";
import {
  autoOrderLocalRideTrails,
  buildLocalRideNavInput,
  localRideTrailsFromStore,
  startLocalRideNavigation,
} from "@/lib/localTrailRide";
import { downloadRideOfflinePack } from "@/lib/offlineRidePack";
import { canDownloadRouteOffline, canNavigate } from "@/lib/tierPolicy";
import { plannerActions, usePlannerStore } from "@/store/routePlannerStore";

const AMBER = colors.light.primary;

export function LocalRideChrome() {
  const insets = useSafeAreaInsets();
  const planner = usePlannerStore();
  const { profile } = useProfile();
  const isPremium = profile.isPremium;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadMessage, setDownloadMessage] = useState("");
  const [upgradeVisible, setUpgradeVisible] = useState(false);
  const [upgradeFeature, setUpgradeFeature] = useState("Turn-by-turn navigation");

  if (planner.mapMode !== "localRide") return null;

  const count = planner.activeTrailIds.length;

  async function openReview() {
    if (count === 0) {
      Alert.alert("Select trails", "Tap trails on the map to add them to your ride.");
      return;
    }
    setReviewOpen(true);
  }

  async function handleGoRide() {
    if (!canNavigate(isPremium)) {
      setReviewOpen(false);
      setUpgradeFeature("Turn-by-turn navigation");
      setUpgradeVisible(true);
      return;
    }
    setStarting(true);
    try {
      const pos = await getAccuratePosition();
      await startLocalRideNavigation({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        address: "You",
      });
      setReviewOpen(false);
      plannerActions.endLocalRide();
    } catch (e) {
      Alert.alert(
        "Could not start",
        e instanceof Error ? e.message : "Check location and try again.",
      );
    } finally {
      setStarting(false);
    }
  }

  async function handleOfflineDownload() {
    if (!canDownloadRouteOffline(isPremium)) {
      setUpgradeFeature("Offline route download");
      setUpgradeVisible(true);
      return;
    }
    setDownloading(true);
    setDownloadProgress(0);
    setDownloadMessage("Preparing…");
    try {
      const pos = await getAccuratePosition();
      const input = await buildLocalRideNavInput({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        address: "You",
      });
      await downloadRideOfflinePack(input, (p) => {
        setDownloadProgress(p.percent);
        setDownloadMessage(p.message);
      });
      Alert.alert(
        "Ready for offline",
        "Route, trail data, and map tiles are saved for this ride.",
      );
    } catch (e) {
      Alert.alert(
        "Download failed",
        e instanceof Error ? e.message : "Check your connection and try again.",
      );
    } finally {
      setDownloading(false);
      setDownloadProgress(0);
      setDownloadMessage("");
    }
  }

  return (
    <>
      <View style={[styles.bar, { paddingBottom: insets.bottom + 10 }]}>
        <View style={styles.hintRow}>
          <Feather name="map-pin" size={16} color={AMBER} />
          <Text style={styles.hint}>
            Tap trails to add · double-tap for details · {count} selected
            {planner.roadDistanceKm != null && count > 0
              ? ` · ~${planner.roadDistanceKm.toFixed(1)} km road`
              : ""}
          </Text>
        </View>
        <View style={styles.actions}>
          <TouchableOpacity style={styles.cancelBtn} onPress={() => plannerActions.endLocalRide()}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.rideBtn, count === 0 && styles.rideBtnDisabled]}
            onPress={() => void openReview()}
            disabled={count === 0}
          >
            <Feather name="navigation" size={18} color="#111" />
            <Text style={styles.rideBtnText}>Review & ride</Text>
          </TouchableOpacity>
        </View>
      </View>

      <LocalRideReviewSheet
        visible={reviewOpen}
        trails={localRideTrailsFromStore()}
        loop={planner.localRideLoop}
        onClose={() => setReviewOpen(false)}
        onConfirm={() => void handleGoRide()}
        onOrderChange={(ids) => plannerActions.setLocalRideTrailOrder(ids)}
        onLoopChange={(loop) => plannerActions.setLocalRideLoop(loop)}
        onAutoOrder={() => {
          void getAccuratePosition()
            .then((pos) =>
              autoOrderLocalRideTrails({
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                address: "You",
              }),
            )
            .catch(() =>
              Alert.alert("Location needed", "Enable location to auto-order trails."),
            );
        }}
        onDownloadOffline={() => void handleOfflineDownload()}
        confirming={starting}
        downloading={downloading}
        downloadProgress={downloadProgress}
        downloadMessage={downloadMessage}
        offlineLocked={!canDownloadRouteOffline(isPremium)}
      />

      <UpgradePrompt
        visible={upgradeVisible}
        featureName={upgradeFeature}
        onDismiss={() => setUpgradeVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.light.card + "F5",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.light.border,
    paddingTop: 12,
    paddingHorizontal: 16,
    zIndex: 30,
  },
  hintRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  hint: { flex: 1, color: colors.light.mutedForeground, fontSize: 13 },
  actions: { flexDirection: "row", gap: 10 },
  cancelBtn: {
    flex: 1,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.light.border,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: { color: colors.light.mutedForeground, fontSize: 15, fontWeight: "600" },
  rideBtn: {
    flex: 2,
    height: 48,
    borderRadius: 12,
    backgroundColor: AMBER,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  rideBtnDisabled: { opacity: 0.45 },
  rideBtnText: { color: "#111", fontSize: 16, fontWeight: "800" },
});
