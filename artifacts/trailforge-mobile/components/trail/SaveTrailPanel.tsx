/**
 * Name, grade, and visibility form for drawn or recorded trails.
 */
import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, { Polyline, PROVIDER_DEFAULT, PROVIDER_GOOGLE, type Region } from "react-native-maps";

import colors from "@/constants/colors";
import { buildGpx, createTrailFromRide, listMyGroups, type Group } from "@/lib/api";

export type TrailVisibility = "private" | "public" | "group";

const GRADE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const VISIBILITY_OPTIONS: { id: TrailVisibility; label: string; sub: string }[] = [
  { id: "private", label: "Personal only", sub: "Only you can see this trail" },
  { id: "public", label: "Public", sub: "Visible to all TrailForge riders" },
  { id: "group", label: "Private group", sub: "Shared with a riding group" },
];

interface SaveTrailPanelProps {
  path: Array<[number, number]>;
  distanceKm: number;
  source?: string;
  initialName?: string;
  altitudes?: number[];
  onDone: (trailId?: string) => void;
  onBack?: () => void;
}

export function SaveTrailPanel({
  path,
  distanceKm,
  source = "mobile-draw",
  initialName = "",
  altitudes,
  onDone,
  onBack,
}: SaveTrailPanelProps) {
  const [name, setName] = useState(initialName);
  const [grade, setGrade] = useState<number | null>(5);
  const [visibility, setVisibility] = useState<TrailVisibility>("private");
  const [groupId, setGroupId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const groupsQ = useQuery({
    queryKey: ["my-groups"],
    queryFn: listMyGroups,
    enabled: visibility === "group",
  });

  const coords = useMemo(
    () => path.map(([lon, lat]) => ({ latitude: lat, longitude: lon })),
    [path],
  );

  const region = useMemo<Region>(() => {
    if (coords.length === 0) {
      return { latitude: 54.5, longitude: -2.5, latitudeDelta: 0.1, longitudeDelta: 0.1 };
    }
    let minLat = coords[0].latitude;
    let maxLat = coords[0].latitude;
    let minLon = coords[0].longitude;
    let maxLon = coords[0].longitude;
    for (const c of coords) {
      minLat = Math.min(minLat, c.latitude);
      maxLat = Math.max(maxLat, c.latitude);
      minLon = Math.min(minLon, c.longitude);
      maxLon = Math.max(maxLon, c.longitude);
    }
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLon + maxLon) / 2,
      latitudeDelta: Math.max(0.01, (maxLat - minLat) * 1.5),
      longitudeDelta: Math.max(0.01, (maxLon - minLon) * 1.5),
    };
  }, [coords]);

  const saveMut = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error("Give your trail a name.");
      if (visibility === "group" && !groupId) {
        throw new Error("Pick a group to share with.");
      }
      return createTrailFromRide({
        name: name.trim(),
        path,
        altitudes,
        difficulty: grade,
        visibility,
        groupId: visibility === "group" ? groupId ?? undefined : undefined,
        source,
      });
    },
    onSuccess: (res) => {
      Alert.alert("Trail saved", `"${name.trim()}" is ready to ride.`, [
        { text: "OK", onPress: () => onDone(res.id) },
      ]);
    },
    onError: (err) =>
      Alert.alert("Save failed", err instanceof Error ? err.message : "Unknown error"),
  });

  async function exportGpx() {
    if (path.length < 2) return;
    setExporting(true);
    try {
      const trailName = name.trim() || "TrailForge Trail";
      const gpx = buildGpx(
        trailName,
        path.map(([lon, lat]) => ({ lat, lon })),
      );
      const file = `${FileSystem.cacheDirectory}TrailForge-${Date.now()}.gpx`;
      await FileSystem.writeAsStringAsync(file, gpx, { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file, {
          mimeType: "application/gpx+xml",
          dialogTitle: "Export GPX",
        });
      } else {
        Alert.alert("GPX ready", `Saved to ${file}`);
      }
    } catch (e) {
      Alert.alert("Export failed", e instanceof Error ? e.message : "Could not export GPX");
    } finally {
      setExporting(false);
    }
  }

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      {onBack ? (
        <TouchableOpacity onPress={onBack} style={s.backRow}>
          <Feather name="arrow-left" size={20} color={colors.light.foreground} />
          <Text style={s.backText}>Back</Text>
        </TouchableOpacity>
      ) : null}

      <Text style={s.title}>Save your trail</Text>
      <Text style={s.meta}>{distanceKm.toFixed(2)} km · {path.length} points</Text>

      {coords.length >= 2 ? (
        <View style={s.mapWrap}>
          <MapView
            style={{ flex: 1 }}
            provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
            initialRegion={region}
            scrollEnabled={false}
            zoomEnabled={false}
          >
            <Polyline coordinates={coords} strokeColor={colors.light.primary} strokeWidth={3} />
          </MapView>
        </View>
      ) : null}

      <Text style={s.label}>Trail name</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="e.g. Forest loop near Kielder"
        placeholderTextColor={colors.light.mutedForeground}
        style={s.input}
      />

      <Text style={s.label}>Difficulty (1–10)</Text>
      <View style={s.gradeRow}>
        {GRADE_OPTIONS.map((g) => (
          <Pressable
            key={g}
            onPress={() => setGrade(grade === g ? null : g)}
            style={[s.gradeChip, grade === g && s.gradeChipActive]}
          >
            <Text style={[s.gradeText, grade === g && s.gradeTextActive]}>{g}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={s.label}>Who can see this trail?</Text>
      {VISIBILITY_OPTIONS.map((opt) => (
        <Pressable
          key={opt.id}
          onPress={() => setVisibility(opt.id)}
          style={[s.visCard, visibility === opt.id && s.visCardActive]}
        >
          <View style={{ flex: 1 }}>
            <Text style={[s.visLabel, visibility === opt.id && s.visLabelActive]}>{opt.label}</Text>
            <Text style={s.visSub}>{opt.sub}</Text>
          </View>
          {visibility === opt.id && (
            <Feather name="check-circle" size={20} color={colors.light.primary} />
          )}
        </Pressable>
      ))}

      {visibility === "group" ? (
        <View style={{ marginTop: 8 }}>
          {groupsQ.isLoading ? (
            <ActivityIndicator color={colors.light.primary} />
          ) : (groupsQ.data?.groups ?? []).length === 0 ? (
            <Text style={s.hint}>Join or create a group in Discover first.</Text>
          ) : (
            (groupsQ.data?.groups ?? []).map((g: Group) => (
              <Pressable
                key={g.id}
                onPress={() => setGroupId(g.id)}
                style={[s.groupRow, groupId === g.id && s.groupRowActive]}
              >
                <Feather
                  name={groupId === g.id ? "check-circle" : "circle"}
                  size={16}
                  color={groupId === g.id ? colors.light.primary : colors.light.mutedForeground}
                />
                <Text style={s.groupText}>{g.name}</Text>
              </Pressable>
            ))
          )}
        </View>
      ) : null}

      <TouchableOpacity
        style={[s.exportBtn, exporting && { opacity: 0.6 }]}
        onPress={() => void exportGpx()}
        disabled={exporting || path.length < 2}
      >
        <Feather name="download" size={16} color={colors.light.primary} />
        <Text style={s.exportText}>Export GPX file</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[s.saveBtn, (!name.trim() || saveMut.isPending) && { opacity: 0.5 }]}
        onPress={() => saveMut.mutate()}
        disabled={!name.trim() || saveMut.isPending}
      >
        {saveMut.isPending ? (
          <ActivityIndicator color="#000" />
        ) : (
          <Text style={s.saveText}>Save trail</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.light.background },
  content: { padding: 20, paddingBottom: 48 },
  backRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  backText: { color: colors.light.foreground, fontWeight: "600" },
  title: { color: colors.light.foreground, fontSize: 22, fontWeight: "900" },
  meta: { color: colors.light.mutedForeground, marginTop: 4, marginBottom: 16 },
  mapWrap: {
    height: 160,
    borderRadius: 12,
    overflow: "hidden",
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  label: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 8,
    marginTop: 12,
  },
  input: {
    backgroundColor: colors.light.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.light.border,
    color: colors.light.foreground,
    padding: 14,
    fontSize: 16,
  },
  gradeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  gradeChip: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.light.border,
    alignItems: "center",
    justifyContent: "center",
  },
  gradeChipActive: { backgroundColor: colors.light.primary, borderColor: colors.light.primary },
  gradeText: { color: colors.light.mutedForeground, fontWeight: "800" },
  gradeTextActive: { color: "#000" },
  visCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    marginBottom: 8,
  },
  visCardActive: { borderColor: colors.light.primary, backgroundColor: "#2a1e00" },
  visLabel: { color: colors.light.foreground, fontWeight: "700", fontSize: 15 },
  visLabelActive: { color: colors.light.primary },
  visSub: { color: colors.light.mutedForeground, fontSize: 12, marginTop: 2 },
  hint: { color: colors.light.mutedForeground, fontSize: 13 },
  groupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.light.border,
    marginBottom: 6,
  },
  groupRowActive: { borderColor: colors.light.primary },
  groupText: { color: colors.light.foreground, fontWeight: "600" },
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 20,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.light.primary,
  },
  exportText: { color: colors.light.primary, fontWeight: "700" },
  saveBtn: {
    marginTop: 12,
    backgroundColor: colors.light.primary,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
  },
  saveText: { color: "#000", fontWeight: "900", fontSize: 16, letterSpacing: 0.5 },
});
