/**
 * Map tab — react-native-maps centered on the user's location, with
 * polylines for every trail returned by the search endpoint within the
 * visible region. Tap a polyline to open the TrailDetailSheet.
 */
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import * as Location from "expo-location";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, {
  PROVIDER_DEFAULT,
  PROVIDER_GOOGLE,
  Polyline,
  Region,
} from "react-native-maps";

import {
  TrailDetailSheet,
  type TrailDetailData,
} from "@/components/TrailDetailSheet";
import colors from "@/constants/colors";
import { searchTrailsByBbox, type MapTrail as ApiTrail } from "@/lib/api";
import { difficultyColor } from "@/lib/trailColors";
import { publishVisibleTrails } from "@/lib/visibleTrails";

type DifficultyFilter = "all" | "green" | "blue" | "black" | "double-black";

function matchesDifficulty(
  trail: ApiTrail,
  filter: DifficultyFilter,
): boolean {
  if (filter === "all") return true;
  const raw = (trail.difficulty ?? trail.ai_difficulty ?? "").toLowerCase();
  if (filter === "green") return raw.includes("green") || raw.includes("easy");
  if (filter === "blue")
    return (
      raw.includes("blue") || raw.includes("intermediate") || raw === "moderate"
    );
  if (filter === "black")
    return raw.includes("black") && !raw.includes("double");
  if (filter === "double-black")
    return raw.includes("double") || raw.includes("expert");
  return true;
}

// Default region centred on a generic mid-Atlantic ride hub so the map
// has *something* to show before location loads.
const FALLBACK_REGION: Region = {
  latitude: 39.7,
  longitude: -77.5,
  latitudeDelta: 1.6,
  longitudeDelta: 1.6,
};

export default function MapTab() {
  const mapRef = useRef<MapView | null>(null);
  const [region, setRegion] = useState<Region>(FALLBACK_REGION);
  const [permission, setPermission] = useState<
    "unknown" | "granted" | "denied"
  >("unknown");
  const [selected, setSelected] = useState<TrailDetailData | null>(null);
  const [difficultyFilter, setDifficultyFilter] = useState<DifficultyFilter>("all");
  const [mapKind, setMapKind] = useState<"standard" | "satellite">("standard");

  // Fetch trails for the current viewport. We hit the bbox-aware route
  // directly rather than through the generated `useSearchTrails` hook —
  // the OpenAPI spec only advertises `q`/`limit`, but the server route
  // also accepts `bbox`. Wiring it through React Query gives us the same
  // dedupe + staleTime semantics without forcing a spec change.
  const bbox = bboxFromRegion(region);
  const trailsQ = useQuery({
    queryKey: ["trails-bbox", bbox],
    queryFn: () => searchTrailsByBbox({ bbox, limit: 200 }),
    staleTime: 60_000,
  });

  const trails: ApiTrail[] = useMemo(() => {
    const all = trailsQ.data?.trails ?? [];
    return all.filter((t) => matchesDifficulty(t, difficultyFilter));
  }, [trailsQ.data, difficultyFilter]);

  // Publish the currently-visible viewport so the AI tab can ground
  // replies on what the user is actually looking at. Cap the id list so
  // we don't blow up the JSON payload sent to /api/ai/chat.
  useEffect(() => {
    publishVisibleTrails({
      bbox: {
        minLng: region.longitude - region.longitudeDelta / 2,
        maxLng: region.longitude + region.longitudeDelta / 2,
        minLat: region.latitude - region.latitudeDelta / 2,
        maxLat: region.latitude + region.latitudeDelta / 2,
      },
      trailIds: trails.slice(0, 20).map((t) => t.id),
    });
  }, [region, trails]);

  useEffect(() => {
    void (async () => {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== "granted") {
        setPermission("denied");
        return;
      }
      setPermission("granted");
      try {
        const here = await Location.getLastKnownPositionAsync();
        const pos =
          here ??
          (await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          }));
        const next: Region = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          latitudeDelta: 0.08,
          longitudeDelta: 0.08,
        };
        setRegion(next);
        mapRef.current?.animateToRegion(next, 600);
      } catch {
        // ignore — keep fallback region
      }
    })();
  }, []);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        mapType={mapKind}
        style={StyleSheet.absoluteFill}
        initialRegion={FALLBACK_REGION}
        showsUserLocation={permission === "granted"}
        showsMyLocationButton={false}
        onRegionChangeComplete={setRegion}
      >
        {trails.map((t) => {
          const coords = extractCoords(t.path);
          if (coords.length < 2) return null;
          return (
            <Polyline
              key={t.id}
              coordinates={coords}
              strokeColor={difficultyColor(t.difficulty)}
              strokeWidth={4}
              tappable
              onPress={() =>
                setSelected({
                  id: t.id,
                  name: t.name,
                  difficulty: t.difficulty,
                  ai_difficulty: t.ai_difficulty ?? null,
                  terrain: t.terrain ?? null,
                  distance_km: t.distance_km ?? null,
                  elevation_gain_m: t.elevation_gain_m ?? null,
                  altitudes: t.altitudes ?? [],
                  photo_urls: t.photo_urls ?? [],
                })
              }
            />
          );
        })}
      </MapView>

      <View style={styles.headerCard} pointerEvents="box-none">
        <View style={styles.statusPill} pointerEvents="none">
          {trailsQ.isFetching ? (
            <ActivityIndicator
              color={colors.light.primary}
              size="small"
            />
          ) : (
            <Feather name="map" size={14} color={colors.light.primary} />
          )}
          <Text style={styles.statusText}>
            {trails.length} trail{trails.length === 1 ? "" : "s"} in view
          </Text>
        </View>

        <View style={{ flexDirection: "row", gap: 6 }}>
          <TouchableOpacity
            style={styles.recenterBtn}
            onPress={() =>
              setMapKind((k) => (k === "standard" ? "satellite" : "standard"))
            }
          >
            <Feather
              name={mapKind === "standard" ? "image" : "map"}
              size={18}
              color={colors.light.primary}
            />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.recenterBtn}
            onPress={() => {
              void (async () => {
                try {
                  const pos = await Location.getCurrentPositionAsync({
                    accuracy: Location.Accuracy.Balanced,
                  });
                  const next: Region = {
                    latitude: pos.coords.latitude,
                    longitude: pos.coords.longitude,
                    latitudeDelta: 0.08,
                    longitudeDelta: 0.08,
                  };
                  mapRef.current?.animateToRegion(next, 600);
                } catch {
                  // ignore
                }
              })();
            }}
          >
            <Feather
              name="navigation"
              size={18}
              color={colors.light.primary}
            />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.filterBar} pointerEvents="box-none">
        {(["all", "green", "blue", "black", "double-black"] as DifficultyFilter[]).map(
          (f) => (
            <TouchableOpacity
              key={f}
              onPress={() => setDifficultyFilter(f)}
              style={[
                styles.filterChip,
                difficultyFilter === f && styles.filterChipActive,
              ]}
            >
              <Text
                style={[
                  styles.filterChipText,
                  difficultyFilter === f && styles.filterChipTextActive,
                ]}
              >
                {f === "double-black" ? "2×black" : f}
              </Text>
            </TouchableOpacity>
          ),
        )}
      </View>

      {permission === "denied" ? (
        <View style={styles.permBanner}>
          <Text style={styles.permBannerText}>
            Location off — turn it on in Settings to see your position.
          </Text>
        </View>
      ) : null}

      <TrailDetailSheet
        visible={!!selected}
        trail={selected}
        ridden={false}
        onClose={() => setSelected(null)}
      />
    </View>
  );
}

function bboxFromRegion(r: Region): string {
  const minLon = (r.longitude - r.longitudeDelta / 2).toFixed(4);
  const maxLon = (r.longitude + r.longitudeDelta / 2).toFixed(4);
  const minLat = (r.latitude - r.latitudeDelta / 2).toFixed(4);
  const maxLat = (r.latitude + r.latitudeDelta / 2).toFixed(4);
  return `${minLon},${minLat},${maxLon},${maxLat}`;
}

/**
 * Coerce the trail.path payload (which may be GeoJSON `[lon,lat]`,
 * `{lat,lon}`, `{latitude,longitude}`, or an array of any of those) into
 * react-native-maps' `{latitude, longitude}` shape. Skip anything that
 * doesn't parse.
 */
function extractCoords(
  path: unknown,
): Array<{ latitude: number; longitude: number }> {
  if (!Array.isArray(path)) return [];
  const out: Array<{ latitude: number; longitude: number }> = [];
  for (const pt of path) {
    if (Array.isArray(pt) && pt.length >= 2) {
      const [lon, lat] = pt as [unknown, unknown];
      if (typeof lat === "number" && typeof lon === "number") {
        out.push({ latitude: lat, longitude: lon });
      }
      continue;
    }
    if (pt && typeof pt === "object") {
      const o = pt as Record<string, unknown>;
      const lat =
        typeof o.lat === "number"
          ? o.lat
          : typeof o.latitude === "number"
            ? o.latitude
            : null;
      const lon =
        typeof o.lon === "number"
          ? o.lon
          : typeof o.lng === "number"
            ? o.lng
            : typeof o.longitude === "number"
              ? o.longitude
              : null;
      if (lat != null && lon != null) {
        out.push({ latitude: lat, longitude: lon });
      }
    }
  }
  return out;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
  headerCard: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  statusText: { color: colors.light.foreground, fontSize: 12, fontWeight: "600" },
  recenterBtn: {
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  permBanner: {
    position: "absolute",
    bottom: 12,
    left: 12,
    right: 12,
    backgroundColor: colors.light.card,
    borderColor: colors.light.destructive,
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
  },
  permBannerText: { color: colors.light.foreground, fontSize: 12 },
  filterBar: {
    position: "absolute",
    top: 60,
    left: 12,
    right: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.light.card,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  filterChipActive: {
    backgroundColor: colors.light.primary,
    borderColor: colors.light.primary,
  },
  filterChipText: {
    color: colors.light.foreground,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  filterChipTextActive: { color: colors.light.primaryForeground },
});
