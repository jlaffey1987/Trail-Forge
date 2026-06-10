/**
 * Bottom chrome on the Map tab during an active planner session.
 */
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import colors from "@/constants/colors";
import { useProfile } from "@/components/ProfileContext";
import { UpgradePrompt } from "@/components/UpgradePrompt";
import { SuggestTrailsReviewSheet } from "@/components/planner/SuggestTrailsReviewSheet";
import { apiJson } from "@/lib/api";
import { exportGpxFile, trailsToGpxInput, type GpxDevice } from "@/lib/gpxExport";
import type { MapTrail } from "@/lib/api";
import {
  activeTrailsFromStore,
  applyMapTrailBatch,
  pickTrailsAlongMapRoute,
  prepareTrailsForNavigation,
  rebuildPlannerRoadRoute,
  toggleTrailOnRoute,
} from "@/lib/plannerMapSession";
import { setActiveNavRoute } from "@/lib/activeNavRoute";
import { navRouteCacheKey } from "@/lib/offlineNavRoute";
import { downloadRideOfflinePack } from "@/lib/offlineRidePack";
import type { NavRouteInput } from "@/lib/navigation";
import {
  canDownloadRouteOffline,
  canExportRouteGpx,
  canNavigate,
  canSaveRouteDraft,
} from "@/lib/tierPolicy";
import {
  getPlannerState,
  plannerActions,
  usePlannerStore,
} from "@/store/routePlannerStore";

const AMBER = colors.light.primary;

export function PlannerMapChrome() {
  const planner = usePlannerStore();
  const { profile } = useProfile();
  const insets = useSafeAreaInsets();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [reviewTrails, setReviewTrails] = useState<MapTrail[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewApplying, setReviewApplying] = useState(false);
  const [upgradeVisible, setUpgradeVisible] = useState(false);
  const [upgradeFeature, setUpgradeFeature] = useState("Turn-by-turn navigation");
  const [downloadingOffline, setDownloadingOffline] = useState(false);
  const [offlineProgress, setOfflineProgress] = useState(0);
  const [offlineMessage, setOfflineMessage] = useState("");

  useEffect(() => {
    if (!planner.pendingRouteActionsOpen || !planner.routeReady) return;
    setActionsOpen(true);
    plannerActions.clearPendingRouteActionsOpen();
  }, [planner.pendingRouteActionsOpen, planner.routeReady]);

  if (planner.mapMode !== "planning" || !planner.from || !planner.to) {
    return null;
  }

  const activeTrails = activeTrailsFromStore();
  const roadKm = planner.roadDistanceKm;

  async function handleBuildRoute() {
    await rebuildPlannerRoadRoute();
    if (getPlannerState().routeReady) {
      setActionsOpen(true);
    } else {
      Alert.alert("Route not ready", "Could not build a road route between your points.");
    }
  }

  const isPremium = profile.isPremium;

  async function handleRide() {
    if (!planner.from || !planner.to) return;
    if (!canNavigate(isPremium)) {
      setUpgradeFeature("Turn-by-turn navigation");
      setUpgradeVisible(true);
      return;
    }
    setActiveNavRoute({
      from: {
        latitude: planner.from.lat,
        longitude: planner.from.lon,
        label: planner.from.address,
      },
      to: {
        latitude: planner.to.lat,
        longitude: planner.to.lon,
        label: planner.to.address,
      },
      trails: prepareTrailsForNavigation(planner.from, planner.to, activeTrails),
      cacheKey: navRouteCacheKey(activeTrails.map((t) => t.id)),
    });
    setActionsOpen(false);
    router.push("/navigate");
  }

  async function handleOfflineDownload() {
    if (!planner.from || !planner.to) return;
    if (!canDownloadRouteOffline(isPremium)) {
      setUpgradeFeature("Offline route download");
      setUpgradeVisible(true);
      return;
    }
    setDownloadingOffline(true);
    setOfflineProgress(0);
    setOfflineMessage("Preparing…");
    try {
      const input: NavRouteInput = {
        from: {
          latitude: planner.from.lat,
          longitude: planner.from.lon,
          label: planner.from.address,
        },
        to: {
          latitude: planner.to.lat,
          longitude: planner.to.lon,
          label: planner.to.address,
        },
        trails: prepareTrailsForNavigation(planner.from, planner.to, activeTrails),
        cacheKey: navRouteCacheKey(activeTrails.map((t) => t.id)),
      };
      await downloadRideOfflinePack(input, (p) => {
        setOfflineProgress(p.percent);
        setOfflineMessage(p.message);
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
      setDownloadingOffline(false);
      setOfflineProgress(0);
      setOfflineMessage("");
    }
  }

  async function handleSaveRoute() {
    if (!canSaveRouteDraft()) return;
    setBusy("save");
    try {
      const name =
        planner.savedRouteName ||
        `${planner.from!.address.split(",")[0].trim()} → ${planner.to!.address.split(",")[0].trim()}`;
      await apiJson("/api/me/saved-routes", {
        method: "POST",
        body: JSON.stringify({
          name,
          trailIds: planner.activeTrailIds,
          isPublic: false,
          waypoints: [
            { id: "from", lat: planner.from!.lat, lon: planner.from!.lon, label: planner.from!.address },
            { id: "to", lat: planner.to!.lat, lon: planner.to!.lon, label: planner.to!.address },
          ],
        }),
      });
      plannerActions.setSavedRouteName(name);
      Alert.alert(
        "Draft saved",
        isPremium
          ? `"${name}" is in My Routes.`
          : `"${name}" is saved as your draft. Upgrade to Premium for turn-by-turn navigation and GPX export.`,
      );
    } catch (e) {
      Alert.alert("Save failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(null);
    }
  }

  async function handleExport(device: GpxDevice) {
    if (!canExportRouteGpx(isPremium)) {
      setUpgradeFeature("GPX export");
      setUpgradeVisible(true);
      return;
    }
    setBusy("export");
    try {
      const name =
        planner.savedRouteName ||
        `${planner.from!.address.split(",")[0].trim()} trip`;
      await exportGpxFile(trailsToGpxInput(name, activeTrails), device);
    } catch (e) {
      Alert.alert("Export failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(null);
      setActionsOpen(false);
    }
  }

  return (
    <>
      <View style={[s.panel, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={s.panelHeader}>
          <View style={{ flex: 1 }}>
            <Text style={s.panelTitle} numberOfLines={1}>
              {planner.planningSource === "suggest" ? "Suggested trip" : "Plan your trip"}
            </Text>
            <Text style={s.panelSub} numberOfLines={1}>
              {planner.from.address.split(",")[0]} → {planner.to.address.split(",")[0]}
            </Text>
          </View>
          <TouchableOpacity onPress={() => plannerActions.endMapPlanning()} hitSlop={12}>
            <Feather name="x" size={20} color={colors.light.mutedForeground} />
          </TouchableOpacity>
        </View>

        <Text style={s.meta}>
          {activeTrails.length} trail{activeTrails.length === 1 ? "" : "s"} selected
          {roadKm != null ? ` · ~${roadKm.toFixed(0)} km road` : ""}
          {planner.isRebuildingRoute ? " · updating route…" : ""}
        </Text>

        {activeTrails.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chipScroll}>
            {activeTrails.map((t) => (
              <View key={t.id} style={s.chip}>
                <Text style={s.chipText} numberOfLines={1}>{t.name}</Text>
                <Pressable
                  onPress={() => void toggleTrailOnRoute(t)}
                  hitSlop={8}
                >
                  <Feather name="x" size={12} color={colors.light.mutedForeground} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : (
          <Text style={s.hint}>Tap trails on the map to add or remove them from your route.</Text>
        )}

        <TouchableOpacity
          style={s.suggestBtn}
          disabled={suggesting || planner.isRebuildingRoute}
          onPress={() => {
            setSuggesting(true);
            void pickTrailsAlongMapRoute(4)
              .then((picked) => {
                if (picked.length === 0) {
                  Alert.alert(
                    "No matches",
                    "No suitable trails along your route right now. Try widening difficulty or tap a trail on the map.",
                  );
                  return;
                }
                setReviewTrails(picked);
                setReviewOpen(true);
              })
              .catch(() => Alert.alert("Could not suggest trails", "Check your connection and try again."))
              .finally(() => setSuggesting(false));
          }}
        >
          {suggesting ? (
            <ActivityIndicator size="small" color={AMBER} />
          ) : (
            <>
              <Feather name="plus-circle" size={16} color={AMBER} />
              <Text style={s.suggestBtnText}>Add trails along route</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.buildBtn, (planner.isCalculating || planner.isRebuildingRoute) && { opacity: 0.6 }]}
          onPress={() => void handleBuildRoute()}
          disabled={planner.isCalculating || planner.isRebuildingRoute}
        >
          {planner.isCalculating || planner.isRebuildingRoute ? (
            <ActivityIndicator color="#1a0e05" />
          ) : (
            <>
              <Feather name="map" size={16} color="#1a0e05" />
              <Text style={s.buildText}>Review route</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      <Modal visible={actionsOpen} transparent animationType="slide" onRequestClose={() => setActionsOpen(false)}>
        <Pressable style={s.modalBackdrop} onPress={() => setActionsOpen(false)}>
          <Pressable style={[s.modalSheet, { paddingBottom: Math.max(insets.bottom, 20) }]}>
            <Text style={s.modalTitle}>Your route is ready</Text>
            {!isPremium ? (
              <Text style={s.modalHint}>
                Save your draft free. Navigation and GPX export need Premium.
              </Text>
            ) : null}
            <ActionRow
              icon="play"
              label="Start navigation"
              locked={!isPremium}
              onPress={() => void handleRide()}
            />
            <ActionRow
              icon="save"
              label="Save draft to My Routes"
              loading={busy === "save"}
              onPress={() => void handleSaveRoute()}
            />
            <ActionRow
              icon="download-cloud"
              label="Download for offline"
              locked={!isPremium}
              loading={downloadingOffline}
              onPress={() => void handleOfflineDownload()}
            />
            {downloadingOffline ? (
              <View style={s.offlineProgressWrap}>
                <Text style={s.offlineProgressText}>
                  {offlineMessage || "Downloading…"}
                </Text>
                <View style={s.offlineProgressTrack}>
                  <View
                    style={[s.offlineProgressFill, { width: `${offlineProgress}%` }]}
                  />
                </View>
              </View>
            ) : null}
            <ActionRow
              icon="download"
              label="Export GPX (Garmin inReach)"
              locked={!isPremium}
              loading={busy === "export"}
              onPress={() => void handleExport("garminInreach")}
            />
            <ActionRow
              icon="smartphone"
              label="Export GPX (generic)"
              locked={!isPremium}
              onPress={() => void handleExport("generic")}
            />
            <TouchableOpacity style={s.dismissBtn} onPress={() => setActionsOpen(false)}>
              <Text style={s.dismissText}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
      <SuggestTrailsReviewSheet
        visible={reviewOpen}
        trails={reviewTrails}
        loading={reviewApplying}
        onCancel={() => {
          setReviewOpen(false);
          setReviewTrails([]);
        }}
        onConfirm={() => {
          setReviewApplying(true);
          void applyMapTrailBatch(reviewTrails)
            .then(() => {
              setReviewOpen(false);
              setReviewTrails([]);
            })
            .catch(() => Alert.alert("Could not add trails", "Try again."))
            .finally(() => setReviewApplying(false));
        }}
      />
      <UpgradePrompt
        visible={upgradeVisible}
        featureName={upgradeFeature}
        onDismiss={() => setUpgradeVisible(false)}
      />
    </>
  );
}

function ActionRow({
  icon,
  label,
  onPress,
  loading,
  locked,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  onPress: () => void;
  loading?: boolean;
  locked?: boolean;
}) {
  return (
    <TouchableOpacity style={s.actionRow} onPress={onPress} disabled={loading}>
      <Feather name={icon} size={18} color={locked ? "#78716c" : AMBER} />
      <Text style={[s.actionText, locked && { color: colors.light.mutedForeground }]}>{label}</Text>
      {locked ? <Feather name="lock" size={14} color="#78716c" /> : null}
      {loading ? <ActivityIndicator size="small" color={AMBER} /> : null}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  panel: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 88,
    backgroundColor: colors.light.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.light.border,
    padding: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 10,
  },
  panelHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 6 },
  panelTitle: { color: colors.light.foreground, fontWeight: "800", fontSize: 15 },
  panelSub: { color: colors.light.mutedForeground, fontSize: 12, marginTop: 2 },
  meta: { color: colors.light.mutedForeground, fontSize: 11, marginBottom: 8 },
  hint: { color: colors.light.mutedForeground, fontSize: 12, marginBottom: 10, lineHeight: 17 },
  suggestBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: AMBER + "66",
    backgroundColor: AMBER + "14",
    marginBottom: 10,
  },
  suggestBtnText: { color: AMBER, fontWeight: "800", fontSize: 13 },
  chipScroll: { marginBottom: 10, maxHeight: 36 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#2a1e00",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 6,
    maxWidth: 160,
    borderWidth: 1,
    borderColor: AMBER,
  },
  chipText: { color: AMBER, fontSize: 11, fontWeight: "700", flex: 1 },
  buildBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: AMBER,
    borderRadius: 12,
    paddingVertical: 12,
  },
  buildText: { color: "#1a0e05", fontWeight: "900", fontSize: 13, letterSpacing: 0.5 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: colors.light.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
  },
  modalTitle: { color: colors.light.foreground, fontSize: 18, fontWeight: "900", marginBottom: 8 },
  modalHint: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.light.border,
  },
  actionText: { color: colors.light.foreground, fontWeight: "600", fontSize: 15, flex: 1 },
  offlineProgressWrap: { marginBottom: 8, gap: 6 },
  offlineProgressText: { color: colors.light.mutedForeground, fontSize: 13 },
  offlineProgressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.light.border,
    overflow: "hidden",
  },
  offlineProgressFill: {
    height: "100%",
    backgroundColor: AMBER,
    borderRadius: 2,
  },
  dismissBtn: { marginTop: 12, alignItems: "center", padding: 10 },
  dismissText: { color: colors.light.mutedForeground, fontWeight: "600" },
});
