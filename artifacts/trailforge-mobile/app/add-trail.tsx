/**
 * Add Trail — record, draw on map, or import a GPX file, then save.
 */
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/clerk-expo";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppShellHeader } from "@/components/shell/AppShellHeader";
import { DrawTrailMap } from "@/components/trail/DrawTrailMap";
import { SaveTrailPanel } from "@/components/trail/SaveTrailPanel";
import colors from "@/constants/colors";
import {
  validateGpxString,
  waypointsToAltitudes,
  waypointsToPath,
} from "@/lib/gpxImport";

type Step = "pick" | "draw" | "save";
type TrailSource = "mobile-draw" | "mobile-gpx";

export default function AddTrailScreen() {
  const { isSignedIn } = useAuth();
  const [step, setStep] = useState<Step>("pick");
  const [path, setPath] = useState<Array<[number, number]>>([]);
  const [distanceKm, setDistanceKm] = useState(0);
  const [source, setSource] = useState<TrailSource>("mobile-draw");
  const [altitudes, setAltitudes] = useState<number[] | undefined>();
  const [initialName, setInitialName] = useState("");
  const [importingGpx, setImportingGpx] = useState(false);

  function requireSignIn(action: () => void) {
    if (!isSignedIn) {
      Alert.alert(
        "Sign in required",
        "You need to be signed in to add trails.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Sign in", onPress: () => router.push("/sign-in") },
        ],
      );
      return;
    }
    action();
  }

  async function pickGpxFile() {
    setImportingGpx(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["application/gpx+xml", "application/xml", "text/xml", "*/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      const name = asset.name ?? "trail.gpx";
      if (!/\.gpx$/i.test(name)) {
        Alert.alert("Invalid file", "Please choose a .gpx file.");
        return;
      }

      const text = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      const validation = validateGpxString(text, asset.size ?? text.length);
      if (!validation.ok) {
        Alert.alert("Could not read GPX", validation.error ?? "Invalid GPX file.");
        return;
      }

      setPath(waypointsToPath(validation.waypoints));
      setDistanceKm(validation.distanceKm);
      setAltitudes(waypointsToAltitudes(validation.waypoints));
      setInitialName(validation.name ?? name.replace(/\.gpx$/i, ""));
      setSource("mobile-gpx");
      setStep("save");
    } catch (e) {
      Alert.alert(
        "Import failed",
        e instanceof Error ? e.message : "Could not read the GPX file.",
      );
    } finally {
      setImportingGpx(false);
    }
  }

  if (step === "draw") {
    return (
      <DrawTrailMap
        onCancel={() => setStep("pick")}
        onComplete={(coords, km) => {
          setPath(coords);
          setDistanceKm(km);
          setAltitudes(undefined);
          setInitialName("");
          setSource("mobile-draw");
          setStep("save");
        }}
      />
    );
  }

  if (step === "save" && path.length >= 2) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.light.background }}>
        <AppShellHeader />
        <SaveTrailPanel
          path={path}
          distanceKm={distanceKm}
          altitudes={altitudes}
          initialName={initialName}
          source={source}
          onBack={() => setStep(source === "mobile-gpx" ? "pick" : "draw")}
          onDone={() => router.replace("/(tabs)/trails")}
        />
      </View>
    );
  }

  return (
    <View style={s.root}>
      <AppShellHeader />
      <SafeAreaView edges={["bottom"]} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.content}>
          <Text style={s.title}>Add a trail</Text>
          <Text style={s.sub}>
            Record while you ride, draw on the map, or upload a GPX file.
            Save as personal, public, or share with a group.
          </Text>

          <TouchableOpacity
            style={s.card}
            onPress={() => requireSignIn(() => router.push("/record"))}
            activeOpacity={0.85}
          >
            <View style={[s.iconWrap, { backgroundColor: "#3f1d1d" }]}>
              <Feather name="disc" size={24} color="#f87171" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Record as you ride</Text>
              <Text style={s.cardSub}>GPS tracks your ride — save when you stop</Text>
            </View>
            <Feather name="chevron-right" size={20} color={colors.light.mutedForeground} />
          </TouchableOpacity>

          <TouchableOpacity
            style={s.card}
            onPress={() => requireSignIn(() => setStep("draw"))}
            activeOpacity={0.85}
          >
            <View style={[s.iconWrap, { backgroundColor: "#1e3a5f" }]}>
              <Feather name="edit-3" size={24} color="#60a5fa" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Draw trail</Text>
              <Text style={s.cardSub}>Tap point by point on the map</Text>
            </View>
            <Feather name="chevron-right" size={20} color={colors.light.mutedForeground} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[s.card, importingGpx && { opacity: 0.6 }]}
            onPress={() => requireSignIn(() => void pickGpxFile())}
            activeOpacity={0.85}
            disabled={importingGpx}
          >
            <View style={[s.iconWrap, { backgroundColor: "#1a3324" }]}>
              <Feather name="upload" size={24} color="#4ade80" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>Add GPX file</Text>
              <Text style={s.cardSub}>Import a route from your device or computer</Text>
            </View>
            {importingGpx ? (
              <ActivityIndicator color={colors.light.primary} />
            ) : (
              <Feather name="chevron-right" size={20} color={colors.light.mutedForeground} />
            )}
          </TouchableOpacity>

          <TouchableOpacity style={s.cancelBtn} onPress={() => router.back()}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.light.background },
  content: { padding: 20, paddingBottom: 40 },
  title: { color: colors.light.foreground, fontSize: 26, fontWeight: "900", marginBottom: 8 },
  sub: { color: colors.light.mutedForeground, fontSize: 14, lineHeight: 20, marginBottom: 24 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: colors.light.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.light.border,
    padding: 16,
    marginBottom: 12,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { color: colors.light.foreground, fontWeight: "800", fontSize: 16 },
  cardSub: { color: colors.light.mutedForeground, fontSize: 12, marginTop: 2 },
  cancelBtn: { marginTop: 16, alignItems: "center", padding: 12 },
  cancelText: { color: colors.light.mutedForeground, fontWeight: "600" },
});
