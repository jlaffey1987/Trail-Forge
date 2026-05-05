/**
 * Planner tab — set an A and B point, fetch suggested trails along the
 * corridor, and persist the result as a named saved route.
 *
 * Suggestions come from `getPlannerSuggestions` (direct fetch — Task #214
 * has not yet merged into the OpenAPI contract). When that ships, swap
 * to `useGetPlannerSuggestions`.
 */
import { Feather } from "@expo/vector-icons";
import { useMutation } from "@tanstack/react-query";
import {
  useCreateMySavedRoute,
  useListMySavedRoutes,
} from "@workspace/api-client-react";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
// expo-file-system 55 split into a new `Paths`/`File` API and a legacy
// module. The legacy `documentDirectory`/`writeAsStringAsync` shape is
// still the simplest way to write a one-shot text file before sharing,
// so we import from the legacy entry deliberately.
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import MapView, {
  Marker,
  PROVIDER_DEFAULT,
  PROVIDER_GOOGLE,
  Polyline,
  Region,
} from "react-native-maps";

import colors from "@/constants/colors";
import {
  buildGpx,
  getPlannerSuggestions,
  searchTrailsByBbox,
  type MapTrail,
  type PlannerSuggestion,
} from "@/lib/api";
import { difficultyColor } from "@/lib/trailColors";
import { geocode, type NominatimResult } from "@/lib/nominatim";

interface Endpoint {
  label: string;
  lat: number;
  lon: number;
}

interface SavedRoutePreload {
  id: string;
  name: string;
  trail_ids?: string[] | null;
  trailIds?: string[] | null;
  waypoints?: Array<{
    id?: string;
    lat: number;
    lon: number;
    label?: string | null;
  }> | null;
}

export default function PlannerTab() {
  // When the Trails tab navigates here with `?routeId=…`, hydrate the
  // form from that saved route so the user can pick up where they left
  // off. We use the existing list-mine query (no per-id GET in the
  // spec) and grab the matching record once it loads.
  const { routeId } = useLocalSearchParams<{ routeId?: string }>();
  const savedRoutes = useListMySavedRoutes({
    query: {
      queryKey: ["list-my-saved-routes-for-preload"],
      enabled: !!routeId,
    },
  });

  const [from, setFrom] = useState<Endpoint | null>(null);
  const [to, setTo] = useState<Endpoint | null>(null);
  // Intermediate stops (fuel / campsite / custom). Mirrors the web
  // planner's waypoints model — backend accepts up to PLANNER_MAX_WAYPOINTS
  // entries with `kind: "fuel"|"campsite"|"custom"`.
  const [waypoints, setWaypoints] = useState<
    Array<{
      id: string;
      lat: number;
      lng: number;
      name: string;
      kind: "fuel" | "campsite" | "custom";
    }>
  >([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [routeName, setRouteName] = useState("");
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!routeId || hydratedFor === routeId) return;
    const list =
      (savedRoutes.data as { routes?: SavedRoutePreload[] } | undefined)
        ?.routes ?? [];
    const match = list.find((r) => r.id === routeId);
    if (!match) return;
    const ids = match.trail_ids ?? match.trailIds ?? [];
    const wps = match.waypoints ?? [];
    const fromWp = wps[0];
    const toWp = wps[wps.length - 1];
    setRouteName(match.name);
    setSelected(ids);
    if (fromWp) {
      setFrom({
        label: fromWp.label ?? "Start",
        lat: fromWp.lat,
        lon: fromWp.lon,
      });
    }
    if (toWp && wps.length > 1) {
      setTo({
        label: toWp.label ?? "End",
        lat: toWp.lat,
        lon: toWp.lon,
      });
    }
    // Restore intermediate stops between from/to (skipping the first and
    // last entries which represent the endpoints themselves).
    if (wps.length > 2) {
      const stops = wps.slice(1, -1).map((w, idx) => ({
        id: w.id ?? `wp-${idx}`,
        lat: w.lat,
        lng: w.lon,
        name: w.label ?? "Stop",
        kind: "custom" as const,
      }));
      setWaypoints(stops);
    }
    setHydratedFor(routeId);
  }, [routeId, savedRoutes.data, hydratedFor]);

  const suggestionsMut = useMutation({
    mutationFn: getPlannerSuggestions,
  });
  const createRoute = useCreateMySavedRoute();

  const suggestions = suggestionsMut.data?.suggestions ?? [];

  // Pull the polylines for whatever trails the user has ticked so the
  // corridor preview can render them on the inline map. We deliberately
  // re-use the same bbox/id-filter trail search the export-GPX flow does.
  const selectedKey = selected.slice().sort().join(",");
  const previewTrailsQ = useQuery({
    queryKey: ["planner-preview-trails", selectedKey],
    queryFn: () =>
      selected.length === 0
        ? Promise.resolve({ trails: [] as MapTrail[] })
        : searchTrailsByBbox({ ids: selectedKey, limit: 200 }),
    enabled: selected.length > 0,
    staleTime: 30_000,
  });
  const previewTrails: MapTrail[] = previewTrailsQ.data?.trails ?? [];

  // Refetch whenever both endpoints are set.
  useEffect(() => {
    if (from && to) {
      suggestionsMut.mutate({
        fromLat: from.lat,
        fromLon: from.lon,
        toLat: to.lat,
        toLon: to.lon,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from?.lat, from?.lon, to?.lat, to?.lon]);

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const [exporting, setExporting] = useState(false);

  async function onExportGpx() {
    if (!from || !to) {
      Alert.alert("Set endpoints first", "Pick a From and To before exporting.");
      return;
    }
    setExporting(true);
    try {
      // Build a GPX with the From waypoint, every selected trail's polyline,
      // and the To waypoint. We hit the bbox/id-filter trail search to grab
      // the paths for the trails the user has ticked.
      const points: Array<{ lat: number; lon: number }> = [
        { lat: from.lat, lon: from.lon },
      ];
      if (selected.length > 0) {
        const res = await searchTrailsByBbox({
          ids: selected.join(","),
          limit: 200,
        });
        for (const t of res.trails) {
          if (!Array.isArray(t.path)) continue;
          for (const p of t.path) {
            if (Array.isArray(p) && p.length >= 2) {
              const [lon, lat] = p as [unknown, unknown];
              if (typeof lat === "number" && typeof lon === "number") {
                points.push({ lat, lon });
              }
            }
          }
        }
      }
      // Insert any intermediate stops the user added (fuel/campsite/custom)
      // before the final To endpoint so they show up as GPX waypoints.
      for (const wp of waypoints) {
        points.push({ lat: wp.lat, lon: wp.lng });
      }
      points.push({ lat: to.lat, lon: to.lon });
      const gpx = buildGpx(routeName.trim() || "TrailForge route", points);
      // Write the GPX to the cache dir as a real .gpx file, then hand off to
      // the OS share-sheet via expo-sharing so the user can save / send it
      // as an attachment instead of a raw text blob.
      const safeName = (routeName.trim() || "TrailForge-route").replace(
        /[^a-zA-Z0-9_-]+/g,
        "_",
      );
      const baseDir =
        FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
      if (!baseDir) {
        throw new Error("No writable directory available on this device.");
      }
      const fileUri = `${baseDir}${safeName}.gpx`;
      await FileSystem.writeAsStringAsync(fileUri, gpx, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType: "application/gpx+xml",
          dialogTitle: `${routeName.trim() || "Route"}.gpx`,
          UTI: "com.topografix.gpx",
        });
      } else {
        Alert.alert(
          "Saved",
          `GPX written to ${fileUri}. Sharing not available on this device.`,
        );
      }
    } catch (err) {
      Alert.alert(
        "Export failed",
        err instanceof Error ? err.message : "Unknown error",
      );
    } finally {
      setExporting(false);
    }
  }

  async function onSave() {
    if (!from || !to || !routeName.trim()) {
      Alert.alert("Missing info", "Set both endpoints and give the route a name.");
      return;
    }
    try {
      // SaveRouteRequest only carries `name + trailIds + waypoints` per the
      // spec — the A/B endpoints are encoded as the first/last waypoints
      // so the route round-trips cleanly. The geocoded labels stay local
      // (matches the web's "LOCAL-ONLY" planner endpoints rule).
      await createRoute.mutateAsync({
        data: {
          name: routeName.trim(),
          trailIds: selected,
          // Persist start + intermediate stops + end as the waypoint array.
          // The Phase-A schema only carries lat/lon/label — `kind` lives
          // in the planner_state row; we keep it locally for the map
          // marker badges.
          waypoints: [
            { id: "from", lat: from.lat, lon: from.lon, label: from.label },
            ...waypoints.map((w) => ({
              id: w.id,
              lat: w.lat,
              lon: w.lng,
              label: w.name,
            })),
            { id: "to", lat: to.lat, lon: to.lon, label: to.label },
          ],
        },
      });
      Alert.alert("Saved", `Route "${routeName.trim()}" saved.`);
      setRouteName("");
      setSelected([]);
      setWaypoints([]);
    } catch (err) {
      Alert.alert(
        "Save failed",
        err instanceof Error ? err.message : "Unknown error",
      );
    }
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.h1}>Plan a ride</Text>
      <Text style={styles.sub}>
        Pick a start and end. We'll suggest singletrack along the way.
      </Text>

      <EndpointPicker
        label="From"
        value={from}
        onChange={setFrom}
        placeholder="Search a starting point…"
      />
      <EndpointPicker
        label="To"
        value={to}
        onChange={setTo}
        placeholder="Search a destination…"
      />

      {from && to ? (
        <>
          <View style={styles.previewBlock}>
            <Text style={styles.sectionLabel}>Corridor preview</Text>
            <CorridorMap
              from={from}
              to={to}
              trails={previewTrails}
              waypoints={waypoints}
            />
          </View>
          <WaypointsSection
            waypoints={waypoints}
            onAdd={(wp) => setWaypoints((prev) => [...prev, wp])}
            onRemove={(id) =>
              setWaypoints((prev) => prev.filter((w) => w.id !== id))
            }
          />
        </>
      ) : null}

      <View style={styles.suggestionsHeader}>
        <Text style={styles.sectionTitle}>Suggested trails</Text>
        {suggestionsMut.isPending ? (
          <ActivityIndicator color={colors.light.primary} />
        ) : (
          <Text style={styles.sectionMeta}>
            {suggestions.length} match{suggestions.length === 1 ? "" : "es"}
          </Text>
        )}
      </View>

      {!from || !to ? (
        <EmptyState
          icon="navigation"
          title="Set two endpoints"
          body="Type a city or address into both From and To to see suggestions."
        />
      ) : suggestions.length === 0 && !suggestionsMut.isPending ? (
        <EmptyState
          icon="map"
          title="No trails along this corridor yet"
          body="Try widening your route or check back as the catalog grows."
        />
      ) : (
        suggestions.map((s) => (
          <SuggestionRow
            key={s.trailId}
            suggestion={s}
            selected={selected.includes(s.trailId)}
            onToggle={() => toggle(s.trailId)}
          />
        ))
      )}

      {from && to ? (
        <View style={styles.saveRow}>
          <TextInput
            value={routeName}
            onChangeText={setRouteName}
            placeholder="Name this route"
            placeholderTextColor={colors.light.mutedForeground}
            style={styles.routeNameInput}
          />
          <TouchableOpacity
            onPress={onSave}
            disabled={createRoute.isPending}
            style={[
              styles.saveBtn,
              createRoute.isPending && { opacity: 0.6 },
            ]}
          >
            {createRoute.isPending ? (
              <ActivityIndicator color={colors.light.primaryForeground} />
            ) : (
              <Text style={styles.saveBtnText}>Save route</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onExportGpx}
            disabled={exporting}
            style={[styles.gpxBtn, exporting && { opacity: 0.6 }]}
          >
            {exporting ? (
              <ActivityIndicator color={colors.light.foreground} />
            ) : (
              <>
                <Feather
                  name="download"
                  size={16}
                  color={colors.light.foreground}
                />
                <Text style={styles.gpxBtnText}>GPX</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      ) : null}
    </ScrollView>
  );
}

function CorridorMap({
  from,
  to,
  trails,
  waypoints,
}: {
  from: Endpoint;
  to: Endpoint;
  trails: MapTrail[];
  waypoints: Array<{
    id: string;
    lat: number;
    lng: number;
    name: string;
    kind: "fuel" | "campsite" | "custom";
  }>;
}) {
  // Frame the bbox around both endpoints with a small padding ratio so
  // the markers sit comfortably inside the visible region.
  const region = useMemo<Region>(() => {
    const lat = (from.lat + to.lat) / 2;
    const lon = (from.lon + to.lon) / 2;
    const latDelta = Math.max(0.05, Math.abs(from.lat - to.lat) * 1.6);
    const lonDelta = Math.max(0.05, Math.abs(from.lon - to.lon) * 1.6);
    return { latitude: lat, longitude: lon, latitudeDelta: latDelta, longitudeDelta: lonDelta };
  }, [from, to]);

  const polylines = useMemo(() => {
    const out: Array<{
      key: string;
      coords: Array<{ latitude: number; longitude: number }>;
      color: string;
    }> = [];
    for (const t of trails) {
      if (!Array.isArray(t.path)) continue;
      const coords: Array<{ latitude: number; longitude: number }> = [];
      for (const p of t.path) {
        if (Array.isArray(p) && p.length >= 2) {
          const [lon, lat] = p as [unknown, unknown];
          if (typeof lat === "number" && typeof lon === "number") {
            coords.push({ latitude: lat, longitude: lon });
          }
        }
      }
      if (coords.length >= 2) {
        out.push({
          key: t.id,
          coords,
          color: difficultyColor(t.difficulty),
        });
      }
    }
    return out;
  }, [trails]);

  return (
    <View style={styles.mapWrap}>
      <MapView
        style={styles.map}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        initialRegion={region}
        region={region}
        showsUserLocation={false}
        toolbarEnabled={false}
      >
        <Marker
          coordinate={{ latitude: from.lat, longitude: from.lon }}
          title="From"
          pinColor="green"
        />
        <Marker
          coordinate={{ latitude: to.lat, longitude: to.lon }}
          title="To"
          pinColor="red"
        />
        {waypoints.map((w) => (
          <Marker
            key={w.id}
            coordinate={{ latitude: w.lat, longitude: w.lng }}
            title={w.name}
            description={w.kind}
            pinColor={
              w.kind === "fuel"
                ? "orange"
                : w.kind === "campsite"
                  ? "purple"
                  : "blue"
            }
          />
        ))}
        {polylines.map((p) => (
          <Polyline
            key={p.key}
            coordinates={p.coords}
            strokeColor={p.color}
            strokeWidth={3}
          />
        ))}
      </MapView>
    </View>
  );
}

function EndpointPicker({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: Endpoint | null;
  onChange: (next: Endpoint | null) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query || value) return;
    setLoading(true);
    const handle = setTimeout(async () => {
      const r = await geocode(query);
      setResults(r);
      setLoading(false);
    }, 350);
    return () => clearTimeout(handle);
  }, [query, value]);

  if (value) {
    return (
      <View style={styles.endpointBlock}>
        <Text style={styles.endpointLabel}>{label}</Text>
        <View style={styles.endpointPill}>
          <Text style={styles.endpointPillText} numberOfLines={2}>
            {value.label}
          </Text>
          <Pressable
            onPress={() => {
              onChange(null);
              setQuery("");
            }}
            hitSlop={8}
          >
            <Feather name="x" size={16} color={colors.light.mutedForeground} />
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.endpointBlock}>
      <Text style={styles.endpointLabel}>{label}</Text>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={placeholder}
        placeholderTextColor={colors.light.mutedForeground}
        style={styles.input}
      />
      {loading ? (
        <ActivityIndicator
          color={colors.light.primary}
          style={{ marginTop: 6 }}
        />
      ) : null}
      {results.length > 0 ? (
        <View style={styles.resultsList}>
          {results.map((r) => (
            <TouchableOpacity
              key={r.place_id}
              onPress={() => {
                onChange({
                  label: r.display_name,
                  lat: parseFloat(r.lat),
                  lon: parseFloat(r.lon),
                });
                setResults([]);
                setQuery("");
              }}
              style={styles.resultRow}
            >
              <Feather name="map-pin" size={14} color={colors.light.primary} />
              <Text style={styles.resultText} numberOfLines={2}>
                {r.display_name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Lets the rider add intermediate stops (fuel / campsite / custom) to a
 * planned route between A and B. Stops are geocoded via Nominatim and
 * categorised by `kind` so the corridor map can pin them in distinct
 * colours. The list ordering matches the order the rider will traverse
 * them.
 */
function WaypointsSection({
  waypoints,
  onAdd,
  onRemove,
}: {
  waypoints: Array<{
    id: string;
    lat: number;
    lng: number;
    name: string;
    kind: "fuel" | "campsite" | "custom";
  }>;
  onAdd: (wp: {
    id: string;
    lat: number;
    lng: number;
    name: string;
    kind: "fuel" | "campsite" | "custom";
  }) => void;
  onRemove: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<"fuel" | "campsite" | "custom">("custom");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!adding || !query) return;
    setLoading(true);
    const handle = setTimeout(() => {
      geocode(query)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(handle);
  }, [adding, query]);

  return (
    <View style={styles.waypointsBlock}>
      <View style={styles.waypointsHeader}>
        <Text style={styles.sectionLabel}>
          Stops along the way ({waypoints.length})
        </Text>
        {!adding ? (
          <TouchableOpacity
            onPress={() => setAdding(true)}
            style={styles.addStopBtn}
          >
            <Feather name="plus" size={14} color={colors.light.primary} />
            <Text style={styles.addStopBtnText}>Add stop</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {waypoints.map((w, i) => (
        <View key={w.id} style={styles.waypointRow}>
          <View style={styles.waypointKindDot}>
            <Feather
              name={
                w.kind === "fuel"
                  ? "droplet"
                  : w.kind === "campsite"
                    ? "moon"
                    : "map-pin"
              }
              size={14}
              color={colors.light.primary}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.waypointName} numberOfLines={1}>
              {i + 1}. {w.name}
            </Text>
            <Text style={styles.waypointMeta}>{w.kind}</Text>
          </View>
          <Pressable onPress={() => onRemove(w.id)} hitSlop={8}>
            <Feather name="x" size={16} color={colors.light.mutedForeground} />
          </Pressable>
        </View>
      ))}
      {adding ? (
        <View style={styles.addStopForm}>
          <View style={styles.kindRow}>
            {(["custom", "fuel", "campsite"] as const).map((k) => (
              <TouchableOpacity
                key={k}
                onPress={() => setKind(k)}
                style={[
                  styles.kindChip,
                  kind === k && styles.kindChipActive,
                ]}
              >
                <Text
                  style={[
                    styles.kindChipText,
                    kind === k && styles.kindChipTextActive,
                  ]}
                >
                  {k}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search a place…"
            placeholderTextColor={colors.light.mutedForeground}
            style={styles.input}
          />
          {loading ? (
            <ActivityIndicator
              color={colors.light.primary}
              style={{ marginTop: 6 }}
            />
          ) : null}
          {results.length > 0 ? (
            <View style={styles.resultsList}>
              {results.slice(0, 5).map((r) => (
                <TouchableOpacity
                  key={r.place_id}
                  onPress={() => {
                    onAdd({
                      id: `wp-${Date.now()}`,
                      lat: parseFloat(r.lat),
                      lng: parseFloat(r.lon),
                      name: r.display_name.split(",")[0] ?? "Stop",
                      kind,
                    });
                    setAdding(false);
                    setQuery("");
                    setResults([]);
                  }}
                  style={styles.resultRow}
                >
                  <Feather
                    name="map-pin"
                    size={14}
                    color={colors.light.primary}
                  />
                  <Text style={styles.resultText} numberOfLines={2}>
                    {r.display_name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
          <TouchableOpacity
            onPress={() => {
              setAdding(false);
              setQuery("");
              setResults([]);
            }}
            style={styles.cancelStopBtn}
          >
            <Text style={styles.cancelStopBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

function SuggestionRow({
  suggestion,
  selected,
  onToggle,
}: {
  suggestion: PlannerSuggestion;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onToggle}
      style={[styles.suggestion, selected && styles.suggestionSelected]}
    >
      <Feather
        name={selected ? "check-circle" : "circle"}
        size={20}
        color={selected ? colors.light.primary : colors.light.mutedForeground}
      />
      <View style={{ flex: 1 }}>
        <Text style={styles.suggestionName} numberOfLines={1}>
          {suggestion.name}
        </Text>
        <Text style={styles.suggestionMeta}>
          {suggestion.distance_km != null
            ? `${suggestion.distance_km.toFixed(1)} km`
            : "—"}
          {"  •  "}
          {suggestion.difficulty ?? "Unknown"}
          {"  •  "}+{Math.round(suggestion.detourMeters)} m detour
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  body: string;
}) {
  return (
    <View style={styles.empty}>
      <Feather name={icon} size={28} color={colors.light.mutedForeground} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
  h1: { color: colors.light.foreground, fontSize: 22, fontWeight: "800" },
  sub: { color: colors.light.mutedForeground, marginTop: 4, marginBottom: 18 },
  endpointBlock: { marginBottom: 14 },
  endpointLabel: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  endpointPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.light.card,
    borderColor: colors.light.primary,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  endpointPillText: { color: colors.light.foreground, flex: 1, fontSize: 13 },
  input: {
    backgroundColor: colors.light.input,
    color: colors.light.foreground,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    fontSize: 14,
  },
  resultsList: {
    marginTop: 6,
    backgroundColor: colors.light.card,
    borderRadius: 10,
    borderColor: colors.light.border,
    borderWidth: 1,
  },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.light.border,
  },
  resultText: { color: colors.light.foreground, flex: 1, fontSize: 13 },
  suggestionsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 10,
    marginBottom: 8,
  },
  sectionTitle: { color: colors.light.foreground, fontWeight: "700" },
  sectionMeta: { color: colors.light.mutedForeground, fontSize: 12 },
  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  suggestionSelected: { borderColor: colors.light.primary },
  suggestionName: { color: colors.light.foreground, fontWeight: "600" },
  suggestionMeta: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    marginTop: 2,
  },
  saveRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 14,
  },
  routeNameInput: {
    flex: 1,
    backgroundColor: colors.light.input,
    color: colors.light.foreground,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    fontSize: 14,
  },
  saveBtn: {
    backgroundColor: colors.light.primary,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
  },
  saveBtnText: { color: colors.light.primaryForeground, fontWeight: "700" },
  gpxBtn: {
    backgroundColor: colors.light.muted,
    borderWidth: 1,
    borderColor: colors.light.border,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  gpxBtnText: {
    color: colors.light.foreground,
    fontWeight: "700",
    fontSize: 13,
  },
  empty: {
    alignItems: "center",
    paddingVertical: 32,
    paddingHorizontal: 16,
    gap: 6,
  },
  emptyTitle: {
    color: colors.light.foreground,
    fontWeight: "700",
    marginTop: 6,
  },
  emptyBody: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    textAlign: "center",
  },
  previewBlock: { marginTop: 12, marginBottom: 6 },
  waypointsBlock: { marginTop: 4, marginBottom: 8 },
  waypointsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  addStopBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: colors.light.primary,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  addStopBtnText: {
    color: colors.light.primary,
    fontSize: 12,
    fontWeight: "600",
  },
  waypointRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 6,
  },
  waypointKindDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.light.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  waypointName: {
    color: colors.light.foreground,
    fontSize: 13,
    fontWeight: "600",
  },
  waypointMeta: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    marginTop: 1,
  },
  addStopForm: {
    backgroundColor: colors.light.muted,
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
  },
  kindRow: { flexDirection: "row", gap: 6, marginBottom: 8 },
  kindChip: {
    borderWidth: 1,
    borderColor: colors.light.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: colors.light.card,
  },
  kindChipActive: {
    backgroundColor: colors.light.primary,
    borderColor: colors.light.primary,
  },
  kindChipText: { color: colors.light.foreground, fontSize: 12 },
  kindChipTextActive: { color: colors.light.primaryForeground },
  cancelStopBtn: { alignSelf: "flex-end", marginTop: 8 },
  cancelStopBtnText: { color: colors.light.mutedForeground, fontSize: 12 },
  sectionLabel: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  mapWrap: {
    height: 200,
    borderRadius: 12,
    overflow: "hidden",
    borderColor: colors.light.border,
    borderWidth: 1,
  },
  map: { flex: 1 },
});
