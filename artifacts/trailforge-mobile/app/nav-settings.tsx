/**
 * Navigation settings screen.
 * Accessible from Profile → Navigation Settings.
 */

import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import colors from "@/constants/colors";
import {
  loadNavPrefs,
  patchNavPrefs,
  type NavPrefs,
  NAV_PREFS_DEFAULT,
} from "@/lib/navPrefs";

const AMBER = colors.light.primary;
const BG    = colors.light.background;
const CARD  = colors.light.card;

export default function NavSettingsScreen() {
  const [prefs, setPrefs] = useState<NavPrefs>(NAV_PREFS_DEFAULT);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadNavPrefs().then(p => { setPrefs(p); setLoading(false); });
  }, []);

  async function update(patch: Partial<NavPrefs>) {
    const next = await patchNavPrefs(patch);
    setPrefs(next);
  }

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: BG, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={AMBER} />
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: BG }}>
      {/* Header */}
      <View style={ns.header}>
        <TouchableOpacity onPress={() => router.back()} style={ns.backBtn}>
          <Text style={ns.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={ns.title}>Navigation</Text>
      </View>

      <View style={ns.section}>
        <Text style={ns.sectionLabel}>POSITION MARKER</Text>
        <View style={ns.segRow}>
          <TouchableOpacity
            style={[ns.seg, prefs.markerStyle === "arrow" && ns.segActive]}
            onPress={() => void update({ markerStyle: "arrow" })}
          >
            <Text style={ns.segIcon}>↑</Text>
            <Text style={[ns.segText, prefs.markerStyle === "arrow" && ns.segTextActive]}>Arrow</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[ns.seg, prefs.markerStyle === "motorcycle" && ns.segActive]}
            onPress={() => void update({ markerStyle: "motorcycle" })}
          >
            <Text style={ns.segIcon}>🏍️</Text>
            <Text style={[ns.segText, prefs.markerStyle === "motorcycle" && ns.segTextActive]}>Motorcycle</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={ns.section}>
        <Text style={ns.sectionLabel}>DEFAULT MAP LAYER</Text>
        <View style={ns.segRow}>
          {(["standard", "satellite", "terrain"] as const).map((opt) => (
            <TouchableOpacity
              key={opt}
              style={[ns.seg, prefs.mapType === opt && ns.segActive]}
              onPress={() => void update({ mapType: opt })}
            >
              <Text style={[ns.segText, prefs.mapType === opt && ns.segTextActive]}>
                {opt.charAt(0).toUpperCase() + opt.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={ns.section}>
        <Text style={ns.sectionLabel}>SPEED UNITS</Text>
        <View style={ns.segRow}>
          <TouchableOpacity
            style={[ns.seg, prefs.speedUnit === "mph" && ns.segActive]}
            onPress={() => void update({ speedUnit: "mph" })}
          >
            <Text style={[ns.segText, prefs.speedUnit === "mph" && ns.segTextActive]}>mph</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[ns.seg, prefs.speedUnit === "kmh" && ns.segActive]}
            onPress={() => void update({ speedUnit: "kmh" })}
          >
            <Text style={[ns.segText, prefs.speedUnit === "kmh" && ns.segTextActive]}>km/h</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={ns.section}>
        <Text style={ns.sectionLabel}>NIGHT MODE</Text>
        <View style={ns.segRow}>
          {(["auto", "on", "off"] as const).map(opt => (
            <TouchableOpacity
              key={opt}
              style={[ns.seg, prefs.nightMode === opt && ns.segActive]}
              onPress={() => void update({ nightMode: opt })}
            >
              <Text style={[ns.segText, prefs.nightMode === opt && ns.segTextActive]}>
                {opt.charAt(0).toUpperCase() + opt.slice(1)}
              </Text>
              {opt === "auto" && (
                <Text style={{ color: colors.light.mutedForeground, fontSize: 10, marginTop: 2 }}>
                  Based on sunset
                </Text>
              )}
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={ns.toggleSection}>
        <SwitchRow
          label="Voice guidance"
          sub="Turn-by-turn voice prompts"
          value={prefs.voiceEnabled}
          onToggle={v => void update({ voiceEnabled: v })}
        />
        <SwitchRow
          label="Speed-adaptive zoom"
          sub="Camera zooms out at higher speeds"
          value={prefs.autoZoom}
          onToggle={v => void update({ autoZoom: v })}
        />
      </View>

      <Text style={ns.resetHint}>Settings saved automatically</Text>
    </SafeAreaView>
  );
}

function SwitchRow({
  label, sub, value, onToggle,
}: { label: string; sub?: string; value: boolean; onToggle: (v: boolean) => void }) {
  return (
    <View style={ns.switchRow}>
      <View style={{ flex: 1 }}>
        <Text style={ns.switchLabel}>{label}</Text>
        {sub && <Text style={ns.switchSub}>{sub}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ false: "#333", true: AMBER + "88" }}
        thumbColor={value ? AMBER : "#888"}
      />
    </View>
  );
}

const ns = StyleSheet.create({
  header:     { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.light.border },
  backBtn:    { marginRight: 16 },
  backText:   { color: AMBER, fontSize: 18, fontWeight: "600" },
  title:      { color: "#fff", fontSize: 20, fontWeight: "800" },
  section:    { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.light.border },
  sectionLabel: { color: colors.light.mutedForeground, fontSize: 11, fontWeight: "800", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 12 },
  segRow:     { flexDirection: "row", gap: 10 },
  seg:        { flex: 1, backgroundColor: CARD, borderRadius: 12, borderWidth: 2, borderColor: colors.light.border, alignItems: "center", justifyContent: "center", minHeight: 64, padding: 10 },
  segActive:  { borderColor: AMBER, backgroundColor: AMBER + "18" },
  segIcon:    { fontSize: 24, marginBottom: 2 },
  segText:    { color: colors.light.mutedForeground, fontSize: 14, fontWeight: "700" },
  segTextActive: { color: AMBER },
  toggleSection: { padding: 16 },
  switchRow:  { flexDirection: "row", alignItems: "center", paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.light.border },
  switchLabel:{ color: "#fff", fontSize: 16, fontWeight: "600" },
  switchSub:  { color: colors.light.mutedForeground, fontSize: 12, marginTop: 2 },
  resetHint:  { color: colors.light.mutedForeground, fontSize: 12, textAlign: "center", padding: 16 },
});
