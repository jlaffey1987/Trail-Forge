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
import { useCreateMySavedRoute } from "@workspace/api-client-react";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { getPlannerSuggestions, type PlannerSuggestion } from "@/lib/api";
import { geocode, type NominatimResult } from "@/lib/nominatim";

interface Endpoint {
  label: string;
  lat: number;
  lon: number;
}

export default function PlannerTab() {
  const [from, setFrom] = useState<Endpoint | null>(null);
  const [to, setTo] = useState<Endpoint | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [routeName, setRouteName] = useState("");

  const suggestionsMut = useMutation({
    mutationFn: getPlannerSuggestions,
  });
  const createRoute = useCreateMySavedRoute();

  const suggestions = suggestionsMut.data?.suggestions ?? [];

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
          waypoints: [
            { id: "from", lat: from.lat, lon: from.lon, label: from.label },
            { id: "to", lat: to.lat, lon: to.lon, label: to.label },
          ],
        },
      });
      Alert.alert("Saved", `Route "${routeName.trim()}" saved.`);
      setRouteName("");
      setSelected([]);
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
        </View>
      ) : null}
    </ScrollView>
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
});
