/**
 * Planner tab — classic Replit layout.
 * Hero · start/destination · bike · difficulty · Find / Build Nav.
 */
import { Feather } from "@expo/vector-icons";
import * as Location from "expo-location";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { AppShellHeader } from "@/components/shell/AppShellHeader";
import { DifficultyScale } from "@/components/shell/DifficultyScale";
import { SectionCard } from "@/components/shell/SectionCard";
import { TabHero } from "@/components/shell/TabHero";
import { PageLoadingCover } from "@/components/PageLoadingCover";
import colors from "@/constants/colors";
import {
  geocode,
  reverseGeocode,
  shortLabel,
  distKm,
  formatDistKm,
  type NominatimResult,
} from "@/lib/nominatim";
import { getAccuratePosition } from "@/lib/location";
import { plannerActions, usePlannerStore } from "@/store/routePlannerStore";
import {
  launchFindTrailsOnMap,
  launchSuggestTrip,
} from "@/lib/plannerMapSession";

const AMBER = colors.light.primary;
const BG = colors.light.background;
const BIKE_TYPES = ["Adventure bike", "Dual sport", "Enduro bike"] as const;
type BikeType = (typeof BIKE_TYPES)[number];

const BIKE_DIFFICULTY: Record<BikeType, number[]> = {
  "Adventure bike": [1, 2, 3, 4, 5],
  "Dual sport": [3, 4, 5, 6, 7],
  "Enduro bike": [5, 6, 7, 8, 9, 10],
};

export default function PlannerTab() {
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");
  const [startPt, setStartPt] = useState<{ lat: number; lon: number; label: string } | null>(null);
  const [endPt, setEndPt] = useState<{ lat: number; lon: number; label: string } | null>(null);
  const [locating, setLocating] = useState(true);
  const [difficulty, setDifficulty] = useState<number[]>([]);
  const [bikes, setBikes] = useState<BikeType[]>([]);
  const [searching, setSearching] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const planner = usePlannerStore();

  // Auto GPS on mount
  useEffect(() => {
    void useCurrentLocation();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleDifficulty = (level: number) => {
    setDifficulty((prev) =>
      prev.includes(level) ? prev.filter((d) => d !== level) : [...prev, level],
    );
  };

  const selectBike = (bike: BikeType) => {
    if (bikes.includes(bike)) {
      setBikes([]);
      return;
    }
    setBikes([bike]);
    setDifficulty(BIKE_DIFFICULTY[bike]);
  };

  const useCurrentLocation = async () => {
    setLocating(true);
    setSearchError(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setSearchError("Location permission denied — enable in Settings");
        return;
      }
      const pos = await getAccuratePosition();
      const { latitude: lat, longitude: lon } = pos.coords;
      const rev = await reverseGeocode(lat, lon);
      const label = rev?.display_name
        ? `Near ${shortLabel(rev.display_name)}`
        : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      const pt = { lat, lon, label };
      setStartPt(pt);
      setStartText(label);
      plannerActions.setFrom({ lat, lon, address: label });
    } catch {
      setSearchError("Could not get your location");
    } finally {
      setLocating(false);
    }
  };

  const resolvePoint = async (
    query: string,
    bias?: { lat: number; lon: number },
  ): Promise<{ lat: number; lon: number; label: string } | null> => {
    const q = query.trim();
    if (!q) return null;
    const hits = await geocode(q, bias);
    if (!hits[0]) return null;
    const label = shortLabel(hits[0].display_name);
    return { lat: parseFloat(hits[0].lat), lon: parseFloat(hits[0].lon), label };
  };

  const resolveEndpoints = async (): Promise<{
    from: { lat: number; lon: number; address: string };
    to: { lat: number; lon: number; address: string };
  } | null> => {
    let from = startPt;
    let to = endPt;
    if (!from && startText.trim()) {
      const pt = await resolvePoint(startText, startPt ?? undefined);
      if (pt) {
        from = pt;
        setStartPt(pt);
      }
    }
    if (!to && endText.trim()) {
      const bias = startPt ?? from ?? undefined;
      const pt = await resolvePoint(endText, bias ? { lat: bias.lat, lon: bias.lon } : undefined);
      if (pt) {
        to = pt;
        setEndPt(pt);
      }
    }
    if (!from) {
      setSearchError("Set a start location first");
      return null;
    }
    if (!to) {
      setSearchError("Set a destination to plan a trip");
      return null;
    }
    const fromLoc = { lat: from.lat, lon: from.lon, address: from.label };
    const toLoc = { lat: to.lat, lon: to.lon, address: to.label };
    plannerActions.setFrom(fromLoc);
    plannerActions.setTo(toLoc);
    return { from: fromLoc, to: toLoc };
  };

  const handleSuggestForTrip = async () => {
    setSuggesting(true);
    setSearchError(null);
    try {
      const pts = await resolveEndpoints();
      if (!pts) return;
      await launchSuggestTrip(pts.from, pts.to, difficulty);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Could not suggest trails");
    } finally {
      setSuggesting(false);
    }
  };

  const handleFindTrails = async () => {
    setSearching(true);
    setSearchError(null);
    try {
      const pts = await resolveEndpoints();
      if (!pts) return;
      await launchFindTrailsOnMap(pts.from, pts.to, difficulty);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const handleBuildNav = async () => {
    if (planner.routeReady && planner.from && planner.to) {
      router.push("/(tabs)/map");
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const pts = await resolveEndpoints();
      if (!pts) return;
      await launchFindTrailsOnMap(pts.from, pts.to, difficulty);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Could not open map planner");
    } finally {
      setSearching(false);
    }
  };

  const diffHint = useMemo(() => {
    if (difficulty.length === 0) return undefined;
    if (difficulty.length === 1) return `Grade ${difficulty[0]}`;
    return `${difficulty.length} selected`;
  }, [difficulty]);

  return (
    <View style={s.root}>
      <AppShellHeader />
      <PageLoadingCover loading={locating && !startPt} message="Getting your location…">
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <TabHero
          title="Trail"
          titleAccent="Planner"
          subtitle="Address-to-address trip with road + trail navigation"
        />

        <View style={s.form}>
          {/* Location panel */}
          <View style={s.locPanel}>
            <TouchableOpacity
              style={s.useGpsBtn}
              onPress={() => void useCurrentLocation()}
              disabled={locating}
            >
              {locating ? (
                <ActivityIndicator size="small" color={AMBER} />
              ) : (
                <Feather name="crosshair" size={14} color={AMBER} />
              )}
              <Text style={s.useGpsText}>Use my current location as start</Text>
            </TouchableOpacity>

            <AddressField
              value={locating ? "Getting your location…" : startText}
              onChangeText={setStartText}
              placeholder="Start address (UK or Ireland — e.g. Stranraer)"
              dotColor="#22c55e"
              editable={!locating}
              gpsLoading={locating}
              bias={startPt ? { lat: startPt.lat, lon: startPt.lon } : undefined}
              onResolved={(pt) => {
                setStartPt(pt);
                plannerActions.setFrom({ lat: pt.lat, lon: pt.lon, address: pt.label });
              }}
            />
            <AddressField
              value={endText}
              onChangeText={setEndText}
              placeholder="Destination (UK or Ireland — e.g. Snowdonia)"
              dotColor={AMBER}
              bias={startPt ? { lat: startPt.lat, lon: startPt.lon } : endPt ? { lat: endPt.lat, lon: endPt.lon } : undefined}
              onResolved={(pt) => {
                setEndPt(pt);
                plannerActions.setTo({ lat: pt.lat, lon: pt.lon, address: pt.label });
              }}
            />
          </View>

          <SectionCard label="Bike type">
            <View style={s.bikeRow}>
              {BIKE_TYPES.map((bike) => {
                const active = bikes.includes(bike);
                return (
                  <Pressable
                    key={bike}
                    onPress={() => selectBike(bike)}
                    style={[s.bikeChip, active && s.bikeChipActive]}
                  >
                    <Text style={[s.bikeText, active && s.bikeTextActive]}>{bike}</Text>
                  </Pressable>
                );
              })}
            </View>
          </SectionCard>

          <SectionCard label="Difficulty" hint={diffHint}>
            <DifficultyScale selected={difficulty} onToggle={toggleDifficulty} />
          </SectionCard>

          <TouchableOpacity
            style={s.suggestBtn}
            disabled={!startPt || !endPt || suggesting}
            onPress={() => void handleSuggestForTrip()}
          >
            {suggesting ? (
              <ActivityIndicator size="small" color={AMBER} />
            ) : (
              <Feather name="zap" size={16} color={AMBER} />
            )}
            <Text style={s.suggestText}>
              {suggesting ? "Finding trails along your route…" : "Suggest trails for this trip"}
            </Text>
          </TouchableOpacity>

          <View style={s.actionRow}>
            <TouchableOpacity
              style={s.findBtn}
              onPress={() => void handleFindTrails()}
              disabled={searching}
            >
              {searching ? (
                <ActivityIndicator color="#1a0e05" />
              ) : (
                <Text style={s.findBtnText}>Find Trails</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={s.navBtn}
              onPress={() => void handleBuildNav()}
            >
              <Feather name="navigation" size={16} color="#fff" />
              <Text style={s.navBtnText}>Build Nav</Text>
            </TouchableOpacity>
          </View>

          {searchError ? (
            <Text style={s.errorText}>{searchError}</Text>
          ) : (
            <Text style={s.helperText}>
              Suggest or Find Trails opens the map with your route. Tap trails to add or remove.
            </Text>
          )}

          {planner.routeReady && planner.from && planner.to ? (
            <TouchableOpacity
              style={s.navBtn}
              onPress={() => router.push("/(tabs)/map")}
            >
              <Feather name="map" size={16} color="#fff" />
              <Text style={s.navBtnText}>Open route on map</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </ScrollView>
      </PageLoadingCover>
    </View>
  );
}

function AddressField({
  value,
  onChangeText,
  placeholder,
  dotColor,
  onResolved,
  editable = true,
  gpsLoading = false,
  bias,
}: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
  dotColor: string;
  onResolved: (pt: { lat: number; lon: number; label: string }) => void;
  editable?: boolean;
  gpsLoading?: boolean;
  bias?: { lat: number; lon: number };
}) {
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  useEffect(() => {
    if (!focused || value.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      setSearchLoading(true);
      void geocode(value, bias)
        .then(setResults)
        .finally(() => setSearchLoading(false));
    }, 300);
    return () => clearTimeout(t);
  }, [value, focused, bias?.lat, bias?.lon]);

  const showDist = bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lon);

  return (
    <View>
      <View style={s.inputRow}>
        <View style={[s.dot, { backgroundColor: dotColor }]} />
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor="#78716c"
          style={s.input}
          editable={editable}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 200)}
        />
        {(gpsLoading || searchLoading) && (
          <ActivityIndicator size="small" color={AMBER} style={{ marginRight: 8 }} />
        )}
      </View>
      {focused && results.length > 0 && (
        <View style={s.dropdown}>
          {results.map((r) => {
            const rLat = parseFloat(r.lat);
            const rLon = parseFloat(r.lon);
            const km = showDist ? distKm(bias!.lat, bias!.lon, rLat, rLon) : null;
            return (
              <Pressable
                key={r.place_id}
                style={s.dropItem}
                onPress={() => {
                  const label = shortLabel(r.display_name);
                  onChangeText(label);
                  onResolved({ lat: rLat, lon: rLon, label });
                  setFocused(false);
                  setResults([]);
                }}
              >
                <Text style={s.dropText} numberOfLines={2}>{shortLabel(r.display_name)}</Text>
                {km != null ? (
                  <Text style={s.dropDist}>{formatDistKm(km)}</Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 32 },
  form: { paddingHorizontal: 16, paddingTop: 16 },
  locPanel: {
    borderRadius: 16,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(240,168,50,0.18)",
    backgroundColor: "rgba(34,24,14,0.55)",
    gap: 8,
  },
  useGpsBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(245,166,35,0.3)",
    backgroundColor: "#1c1917",
  },
  useGpsText: {
    color: AMBER,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1c1917",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#44403c",
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginLeft: 12 },
  input: {
    flex: 1,
    color: "#fff",
    fontSize: 14,
    paddingVertical: 12,
    paddingHorizontal: 10,
  },
  dropdown: {
    marginTop: 4,
    backgroundColor: "#292524",
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  dropItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#44403c",
  },
  dropText: { flex: 1, color: "#e7e5e4", fontSize: 13 },
  dropDist: { color: AMBER, fontSize: 11, fontWeight: "700" },
  bikeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bikeChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#44403c",
  },
  bikeChipActive: {
    backgroundColor: "rgba(245,166,35,0.15)",
    borderColor: AMBER,
  },
  bikeText: { fontSize: 12, color: "#a8a29e", fontWeight: "600" },
  bikeTextActive: { color: AMBER },
  suggestBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "rgba(245,166,35,0.4)",
    backgroundColor: "rgba(245,166,35,0.08)",
    marginBottom: 12,
  },
  suggestText: {
    color: AMBER,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  actionRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  findBtn: {
    flex: 1,
    paddingVertical: 18,
    borderRadius: 14,
    backgroundColor: AMBER,
    alignItems: "center",
    justifyContent: "center",
  },
  findBtnText: {
    color: "#1a0e05",
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  navBtn: {
    flex: 1,
    flexDirection: "row",
    gap: 8,
    paddingVertical: 18,
    borderRadius: 14,
    backgroundColor: "#2563eb",
    alignItems: "center",
    justifyContent: "center",
  },
  navBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  helperText: {
    textAlign: "center",
    color: "#57534e",
    fontSize: 12,
    marginTop: 4,
    marginBottom: 16,
  },
  errorText: {
    textAlign: "center",
    color: "#fca5a5",
    fontSize: 12,
    marginBottom: 16,
  },
  results: { marginTop: 8 },
  resultsTitle: {
    fontSize: 11,
    fontWeight: "800",
    color: "#a8a29e",
    letterSpacing: 1.2,
    marginBottom: 10,
  },
  resultCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#1c1917",
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#292524",
  },
  gradeBadge: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  gradeBadgeText: { color: "#000", fontWeight: "900", fontSize: 14 },
  resultName: { color: "#fff", fontWeight: "700", fontSize: 15 },
  resultMeta: { color: "#78716c", fontSize: 12, marginTop: 2 },
});
