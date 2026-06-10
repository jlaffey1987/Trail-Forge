/**
 * Review & reorder trails before a local ride (no destination).
 */
import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { DraggableTrailOrderList } from "@/components/planner/DraggableTrailOrderList";
import colors from "@/constants/colors";
import type { MapTrail } from "@/lib/api";

const AMBER = colors.light.primary;

interface Props {
  visible: boolean;
  trails: MapTrail[];
  loop: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onOrderChange: (trailIds: string[]) => void;
  onLoopChange: (loop: boolean) => void;
  onAutoOrder: () => void;
  onDownloadOffline?: () => void;
  confirming?: boolean;
  downloading?: boolean;
  downloadProgress?: number;
  downloadMessage?: string;
  offlineLocked?: boolean;
}

export function LocalRideReviewSheet({
  visible,
  trails,
  loop,
  onClose,
  onConfirm,
  onOrderChange,
  onLoopChange,
  onAutoOrder,
  onDownloadOffline,
  confirming = false,
  downloading = false,
  downloadProgress = 0,
  downloadMessage,
  offlineLocked = false,
}: Props) {
  const [dragging, setDragging] = useState(false);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <Text style={styles.title}>Your ride</Text>
          <Text style={styles.sub}>
            Drag to reorder trails. Use auto-order for the shortest links from your location.
          </Text>

          <TouchableOpacity style={styles.autoBtn} onPress={onAutoOrder}>
            <Feather name="shuffle" size={16} color={AMBER} />
            <Text style={styles.autoBtnText}>Re-order from my location</Text>
          </TouchableOpacity>

          <View style={styles.loopRow}>
            <View style={styles.loopCopy}>
              <Feather name="rotate-cw" size={18} color={AMBER} />
              <Text style={styles.loopLabel}>Loop back to start</Text>
            </View>
            <Switch
              value={loop}
              onValueChange={onLoopChange}
              trackColor={{ false: colors.light.border, true: AMBER + "88" }}
              thumbColor={loop ? AMBER : colors.light.mutedForeground}
            />
          </View>

          <DraggableTrailOrderList
            trails={trails}
            onOrderChange={onOrderChange}
            onDragStateChange={setDragging}
          />

          {onDownloadOffline ? (
            <TouchableOpacity
              style={[styles.offlineBtn, offlineLocked && styles.offlineBtnLocked]}
              onPress={onDownloadOffline}
              disabled={downloading || confirming || trails.length === 0}
            >
              {downloading ? (
                <>
                  <ActivityIndicator color={AMBER} size="small" />
                  <View style={styles.offlineProgress}>
                    <Text style={styles.offlineBtnText}>
                      {downloadMessage ?? "Downloading…"}
                    </Text>
                    <View style={styles.progressTrack}>
                      <View
                        style={[styles.progressFill, { width: `${downloadProgress}%` }]}
                      />
                    </View>
                  </View>
                </>
              ) : (
                <>
                  <Feather
                    name={offlineLocked ? "lock" : "download-cloud"}
                    size={18}
                    color={offlineLocked ? colors.light.mutedForeground : AMBER}
                  />
                  <Text
                    style={[
                      styles.offlineBtnText,
                      offlineLocked && styles.offlineBtnTextLocked,
                    ]}
                  >
                    {offlineLocked ? "Download for offline (Premium)" : "Download for offline"}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}

          <TouchableOpacity
            style={[styles.goBtn, (confirming || dragging) && styles.goBtnDisabled]}
            onPress={onConfirm}
            disabled={confirming || dragging}
          >
            <Feather name="navigation" size={20} color="#111" />
            <Text style={styles.goBtnText}>
              {confirming ? "Starting…" : loop ? "Go ride (loop)" : "Go ride"}
            </Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.light.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingBottom: 32,
    maxHeight: "82%",
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.light.border,
    alignSelf: "center",
    marginTop: 10,
    marginBottom: 14,
  },
  title: { color: "#fff", fontSize: 20, fontWeight: "800", marginBottom: 6 },
  sub: { color: colors.light.mutedForeground, fontSize: 14, lineHeight: 20, marginBottom: 12 },
  autoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    marginBottom: 10,
    paddingVertical: 6,
  },
  autoBtnText: { color: AMBER, fontSize: 14, fontWeight: "600" },
  loopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
    paddingVertical: 4,
  },
  loopCopy: { flexDirection: "row", alignItems: "center", gap: 8 },
  loopLabel: { color: "#fff", fontSize: 15, fontWeight: "600" },
  offlineBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: colors.light.border,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 12,
    marginBottom: 10,
  },
  offlineBtnLocked: { opacity: 0.75 },
  offlineBtnText: { color: AMBER, fontSize: 15, fontWeight: "600", flex: 1 },
  offlineBtnTextLocked: { color: colors.light.mutedForeground },
  offlineProgress: { flex: 1, gap: 6 },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.light.border,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: AMBER,
    borderRadius: 2,
  },
  goBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: AMBER,
    borderRadius: 14,
    height: 52,
  },
  goBtnDisabled: { opacity: 0.7 },
  goBtnText: { color: "#111", fontSize: 17, fontWeight: "800" },
});
