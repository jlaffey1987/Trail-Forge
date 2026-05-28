/**
 * Single-trail detail screen. Header, stats, elevation chart, photo
 * gallery, community notes, amendments, and share-to-groups action.
 */
import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";

import { ElevationChart } from "@/components/ElevationChart";
import colors from "@/constants/colors";
import {
  listMyGroups,
  listTrailAmendments,
  listTrailNotes,
  listTrailShares,
  searchTrailsByBbox,
  shareTrailToGroups,
  type Group,
  type TrailNote,
} from "@/lib/api";
import {
  cacheTiles,
  isTrailSavedOffline,
  removeOfflineTrail,
  saveTrailOffline,
  type TileDownloadProgress,
} from "@/lib/offlineStore";
import { difficultyColor, difficultyLabel } from "@/lib/trailColors";

export default function TrailDetailScreen() {
  const { trailId, ids } = useLocalSearchParams<{
    trailId: string;
    ids?: string;
  }>();
  const id = String(trailId ?? "");
  const { width } = useWindowDimensions();
  const qc = useQueryClient();

  const siblingIds = useMemo<string[]>(() => {
    if (!ids) return [];
    return String(ids)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }, [ids]);

  const currentIdx = siblingIds.indexOf(id);
  const prevId = currentIdx > 0 ? siblingIds[currentIdx - 1] : null;
  const nextId =
    currentIdx >= 0 && currentIdx < siblingIds.length - 1
      ? siblingIds[currentIdx + 1]
      : null;

  const q = useQuery({
    queryKey: ["trail-by-id", id],
    queryFn: () => searchTrailsByBbox({ ids: id, limit: 1 }),
    enabled: id.length > 0,
  });
  const trail = q.data?.trails?.[0];

  const notesQ = useQuery({
    queryKey: ["trail-notes", id],
    queryFn: () => listTrailNotes(id),
    enabled: id.length > 0,
  });
  const amendmentsQ = useQuery({
    queryKey: ["trail-amendments", id],
    queryFn: () => listTrailAmendments(id),
    enabled: id.length > 0,
  });

  const [shareOpen, setShareOpen] = useState(false);
  const [isSavedOffline, setIsSavedOffline] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<TileDownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!id) return;
    void isTrailSavedOffline(id).then(setIsSavedOffline);
  }, [id]);

  function navigateTo(targetId: string) {
    const path = `/trail/${encodeURIComponent(targetId)}` as const;
    if (siblingIds.length > 0) {
      router.replace(`${path}?ids=${encodeURIComponent(siblingIds.join(","))}`);
    } else {
      router.replace(path);
    }
  }

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.light.primary} />
      </View>
    );
  }

  if (!trail) {
    return (
      <View style={styles.center}>
        <Feather name="frown" size={36} color={colors.light.mutedForeground} />
        <Text style={styles.notFound}>Trail not found</Text>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.link}>← Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const pendingAmendments = (amendmentsQ.data?.items ?? []).filter(
    (a) => a.status === "pending",
  ).length;
  const notes = notesQ.data?.items ?? [];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 18, paddingBottom: 80 }}
    >
      {siblingIds.length > 1 ? (
        <View style={styles.navBar}>
          <TouchableOpacity
            onPress={() => prevId && navigateTo(prevId)}
            disabled={!prevId}
            style={[styles.navBtn, !prevId && { opacity: 0.4 }]}
          >
            <Feather name="chevron-left" size={16} color={colors.light.foreground} />
            <Text style={styles.navBtnText}>Prev</Text>
          </TouchableOpacity>
          <Text style={styles.navCounter}>
            {currentIdx + 1} / {siblingIds.length}
          </Text>
          <TouchableOpacity
            onPress={() => nextId && navigateTo(nextId)}
            disabled={!nextId}
            style={[styles.navBtn, !nextId && { opacity: 0.4 }]}
          >
            <Text style={styles.navBtnText}>Next</Text>
            <Feather name="chevron-right" size={16} color={colors.light.foreground} />
          </TouchableOpacity>
        </View>
      ) : null}

      <Text style={styles.h1}>{trail.name}</Text>

      <View style={styles.badges}>
        <View
          style={[
            styles.diffBadge,
            { borderColor: difficultyColor(trail.difficulty) },
          ]}
        >
          <View
            style={[
              styles.diffDot,
              { backgroundColor: difficultyColor(trail.difficulty) },
            ]}
          />
          <Text style={styles.diffText}>{difficultyLabel(trail.difficulty)}</Text>
        </View>
        {trail.terrain ? (
          <View style={styles.terrain}>
            <Text style={styles.terrainText}>{trail.terrain}</Text>
          </View>
        ) : null}
        {trail.legal_status ? (
          <View style={[styles.terrain, styles.legalBadge]}>
            <Feather
              name="shield"
              size={12}
              color={colors.light.primaryForeground}
            />
            <Text style={styles.legalText}>{trail.legal_status}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Distance</Text>
          <Text style={styles.statValue}>
            {trail.distance_km != null
              ? `${trail.distance_km.toFixed(2)} km`
              : "—"}
          </Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Elevation</Text>
          <Text style={styles.statValue}>
            {trail.elevation_gain_m != null
              ? `${Math.round(trail.elevation_gain_m)} m`
              : "—"}
          </Text>
        </View>
      </View>

      {/* Offline download progress */}
      {downloadProgress ? (
        <View style={styles.downloadBar}>
          <View
            style={[
              styles.downloadFill,
              {
                width: `${Math.round(
                  ((downloadProgress.downloaded + downloadProgress.failed) /
                    Math.max(1, downloadProgress.total)) * 100,
                )}%`,
              },
            ]}
          />
          <Text style={styles.downloadText}>
            Caching tiles {downloadProgress.downloaded}/{downloadProgress.total}
            {downloadProgress.failed > 0 ? ` (${downloadProgress.failed} failed)` : ""}
          </Text>
        </View>
      ) : null}

      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.actionBtn, isSavedOffline && { borderColor: colors.light.primary }]}
          disabled={downloading}
          onPress={async () => {
            if (isSavedOffline) {
              Alert.alert("Remove offline data?", "Trail map data will be removed.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Remove",
                  style: "destructive",
                  onPress: async () => {
                    await removeOfflineTrail(trail.id);
                    setIsSavedOffline(false);
                  },
                },
              ]);
              return;
            }
            setDownloading(true);
            setDownloadProgress(null);

            // Build bbox from trail path.
            const path = trail.path as unknown as Array<[number, number]> | null;
            let bbox = {
              minLat: 90, maxLat: -90, minLon: 180, maxLon: -180,
            };
            if (Array.isArray(path)) {
              for (const [lon, lat] of path) {
                if (lat < bbox.minLat) bbox.minLat = lat;
                if (lat > bbox.maxLat) bbox.maxLat = lat;
                if (lon < bbox.minLon) bbox.minLon = lon;
                if (lon > bbox.maxLon) bbox.maxLon = lon;
              }
            }

            // Save trail data.
            await saveTrailOffline({
              id: trail.id,
              name: trail.name,
              difficulty: trail.difficulty ?? null,
              distance_km: trail.distance_km ?? null,
              path: Array.isArray(path) ? path : [],
              legal_status: trail.legal_status ?? null,
              terrain: trail.terrain ?? null,
              bbox,
            });

            // Download map tiles.
            const progress = await cacheTiles(bbox, (p) => setDownloadProgress(p));
            setDownloadProgress(progress);
            setIsSavedOffline(true);
            setDownloading(false);

            setTimeout(() => setDownloadProgress(null), 2000);
          }}
        >
          {downloading ? (
            <ActivityIndicator size="small" color={colors.light.foreground} />
          ) : (
            <Feather
              name={isSavedOffline ? "check-circle" : "download"}
              size={14}
              color={isSavedOffline ? colors.light.primary : colors.light.foreground}
            />
          )}
          <Text style={[styles.actionBtnText, isSavedOffline && { color: colors.light.primary }]}>
            {isSavedOffline ? "Saved offline" : "Save offline"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => setShareOpen(true)}
        >
          <Feather name="share-2" size={14} color={colors.light.foreground} />
          <Text style={styles.actionBtnText}>Share to group</Text>
        </TouchableOpacity>
        {pendingAmendments > 0 ? (
          <View style={styles.amendmentBadge}>
            <Feather
              name="edit-3"
              size={12}
              color={colors.light.foreground}
            />
            <Text style={styles.actionBtnText}>
              {pendingAmendments} pending amendment
              {pendingAmendments === 1 ? "" : "s"}
            </Text>
          </View>
        ) : null}
      </View>

      {Array.isArray(trail.altitudes) && trail.altitudes.length > 1 ? (
        <View style={{ marginTop: 18 }}>
          <Text style={styles.sectionLabel}>Elevation profile</Text>
          <ElevationChart
            altitudes={trail.altitudes as number[]}
            width={width - 36}
          />
        </View>
      ) : null}

      {Array.isArray(trail.photo_urls) && trail.photo_urls.length > 0 ? (
        <View style={{ marginTop: 22 }}>
          <Text style={styles.sectionLabel}>
            Photos ({trail.photo_urls.length})
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingVertical: 6 }}
          >
            {trail.photo_urls.map((url) => (
              <Image
                key={url}
                source={{ uri: url }}
                style={styles.photo}
                contentFit="cover"
                transition={200}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}

      <View style={{ marginTop: 22 }}>
        <Text style={styles.sectionLabel}>Community notes</Text>
        {notesQ.isLoading ? (
          <ActivityIndicator color={colors.light.primary} />
        ) : notes.length === 0 ? (
          <Text style={styles.muted}>
            No notes yet. Riders' updates on closures, washouts and
            line-of-sight changes will show up here.
          </Text>
        ) : (
          notes.slice(0, 5).map((n: TrailNote) => (
            <View key={n.id} style={styles.note}>
              <Text style={styles.noteAuthor}>
                {n.author?.display_name ?? "Anon"} •
                {" "}
                {new Date(n.created_at).toLocaleDateString()}
              </Text>
              <Text style={styles.noteBody}>{n.body}</Text>
            </View>
          ))
        )}
      </View>

      <ShareToGroupsModal
        visible={shareOpen}
        onDismiss={() => setShareOpen(false)}
        onShared={() => {
          setShareOpen(false);
          void qc.invalidateQueries({ queryKey: ["my-groups"] });
        }}
        trailId={id}
      />
    </ScrollView>
  );
}

function ShareToGroupsModal({
  visible,
  onDismiss,
  onShared,
  trailId,
}: {
  visible: boolean;
  onDismiss: () => void;
  onShared: () => void;
  trailId: string;
}) {
  const myGroupsQ = useQuery({
    queryKey: ["my-groups"],
    queryFn: listMyGroups,
    enabled: visible,
  });
  // Pre-load existing shares; 403 means caller isn't the owner.
  const sharesQ = useQuery({
    queryKey: ["trail-shares", trailId],
    queryFn: () => listTrailShares(trailId).catch(() => ({ items: [] })),
    enabled: visible,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!visible) return;
    const initial = new Set<string>(
      (sharesQ.data?.items ?? []).map((s) => s.group_id),
    );
    setSelected(initial);
  }, [visible, sharesQ.data]);

  const shareMut = useMutation({
    mutationFn: () => shareTrailToGroups(trailId, Array.from(selected)),
    onSuccess: () => {
      Alert.alert(
        "Shared",
        selected.size === 0
          ? "Trail removed from all groups."
          : `Trail shared to ${selected.size} group${selected.size === 1 ? "" : "s"}.`,
      );
      onShared();
    },
    onError: (err) =>
      Alert.alert(
        "Share failed",
        err instanceof Error ? err.message : "Unknown error",
      ),
  });

  const groups: Group[] = myGroupsQ.data?.groups ?? [];

  // Confirm before submitting an empty selection — this would unshare
  // the trail from every group, which is destructive enough to warrant
  // a second tap.
  function onSubmit() {
    const initial = new Set<string>(
      (sharesQ.data?.items ?? []).map((s) => s.group_id),
    );
    if (selected.size === 0 && initial.size > 0) {
      Alert.alert(
        "Remove from all groups?",
        `This trail is currently shared with ${initial.size} group${
          initial.size === 1 ? "" : "s"
        }. Submitting with nothing selected will remove every share.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove all",
            style: "destructive",
            onPress: () => shareMut.mutate(),
          },
        ],
      );
      return;
    }
    shareMut.mutate();
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.modalScrim}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Share to groups</Text>
          <Text style={styles.muted}>
            Pick the groups you want to share this trail into. Submitting
            with nothing selected removes it from every group.
          </Text>
          {myGroupsQ.isLoading ? (
            <ActivityIndicator color={colors.light.primary} />
          ) : groups.length === 0 ? (
            <Text style={styles.muted}>You're not a member of any group yet.</Text>
          ) : (
            <ScrollView style={{ maxHeight: 280 }}>
              {groups.map((g) => {
                const on = selected.has(g.id);
                return (
                  <TouchableOpacity
                    key={g.id}
                    onPress={() => {
                      const next = new Set(selected);
                      if (on) next.delete(g.id);
                      else next.add(g.id);
                      setSelected(next);
                    }}
                    style={styles.modalRow}
                  >
                    <Feather
                      name={on ? "check-square" : "square"}
                      size={18}
                      color={
                        on ? colors.light.primary : colors.light.mutedForeground
                      }
                    />
                    <Text style={styles.modalRowText}>{g.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
          <View style={styles.modalActions}>
            <TouchableOpacity onPress={onDismiss} style={styles.modalCancelBtn}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onSubmit}
              disabled={shareMut.isPending || groups.length === 0}
              style={[
                styles.modalConfirmBtn,
                (shareMut.isPending || groups.length === 0) && {
                  opacity: 0.5,
                },
              ]}
            >
              {shareMut.isPending ? (
                <ActivityIndicator color={colors.light.primaryForeground} />
              ) : (
                <Text style={styles.modalConfirmText}>Share</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
  center: {
    flex: 1,
    backgroundColor: colors.light.background,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  notFound: { color: colors.light.foreground, fontSize: 16, fontWeight: "700" },
  link: { color: colors.light.primary, marginTop: 6 },
  h1: { color: colors.light.foreground, fontSize: 22, fontWeight: "800" },
  badges: { flexDirection: "row", gap: 6, marginTop: 10, flexWrap: "wrap" },
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
  diffText: { color: colors.light.foreground, fontSize: 12 },
  terrain: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.light.muted,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  terrainText: { color: colors.light.mutedForeground, fontSize: 12 },
  legalBadge: { backgroundColor: colors.light.primary },
  legalText: {
    color: colors.light.primaryForeground,
    fontSize: 12,
    fontWeight: "700",
  },
  statsRow: { flexDirection: "row", gap: 12, marginTop: 18 },
  stat: {
    flex: 1,
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  statLabel: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  statValue: {
    color: colors.light.foreground,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 2,
  },
  sectionLabel: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  downloadBar: {
    height: 28,
    borderRadius: 6,
    backgroundColor: colors.light.muted,
    overflow: "hidden",
    marginTop: 10,
    justifyContent: "center",
  },
  downloadFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.light.primary,
    opacity: 0.25,
  },
  downloadText: {
    color: colors.light.foreground,
    fontSize: 11,
    fontWeight: "700",
    textAlign: "center",
    zIndex: 1,
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 14,
    alignItems: "center",
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
  },
  actionBtnText: {
    color: colors.light.foreground,
    fontSize: 12,
    fontWeight: "600",
  },
  amendmentBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.light.muted,
    borderRadius: 8,
  },
  navBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  navBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  navBtnText: { color: colors.light.foreground, fontWeight: "600", fontSize: 13 },
  navCounter: { color: colors.light.mutedForeground, fontSize: 12 },
  note: {
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 6,
  },
  noteAuthor: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    marginBottom: 4,
  },
  noteBody: { color: colors.light.foreground, fontSize: 13 },
  muted: { color: colors.light.mutedForeground, fontSize: 13, marginTop: 4 },
  photo: {
    width: 200,
    height: 140,
    borderRadius: 10,
    backgroundColor: colors.light.muted,
  },
  modalScrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: 18,
  },
  modalCard: {
    backgroundColor: colors.light.background,
    borderRadius: 14,
    padding: 18,
    gap: 10,
    maxHeight: "85%",
  },
  modalTitle: {
    color: colors.light.foreground,
    fontWeight: "800",
    fontSize: 18,
  },
  modalRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.light.border,
  },
  modalRowText: { color: colors.light.foreground, flex: 1, fontSize: 14 },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 10,
  },
  modalCancelBtn: { paddingVertical: 10, paddingHorizontal: 14 },
  modalCancelText: {
    color: colors.light.mutedForeground,
    fontWeight: "600",
  },
  modalConfirmBtn: {
    backgroundColor: colors.light.primary,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  modalConfirmText: {
    color: colors.light.primaryForeground,
    fontWeight: "700",
  },
});
