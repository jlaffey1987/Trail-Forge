/**
 * Map tab — react-native-maps centered on the user's location, with
 * polylines for every trail returned by the search endpoint within the
 * visible region. Tap a polyline to open the TrailDetailSheet.
 */
import { Feather } from "@expo/vector-icons";
import { useSearchTrails } from "@workspace/api-client-react";
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
import { difficultyColor } from "@/lib/trailColors";

interface ApiTrail {
  id: string;
  name: string;
  difficulty: string | null;
  ai_difficulty?: string | null;
  terrain?: string | null;
  distance_km?: number | null;
  elevation_gain_m?: number | null;
  // GPX path samples — array of [lon, lat] pairs (GeoJSON convention) or
  // similar. The web client normalises these in `trailLayer.ts`; we do
  // the same here below in `extractCoords`.
  path?: unknown;
  altitudes?: number[];
  photo_urls?: string[];
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

  // Fetch trails for the current viewport. The generated hook will refetch
  // every time bbox params change, with React Query dedupe and caching.
  const trailsQ = useSearchTrails(
    {
      // Use the visible region as a coarse bbox; the API does its own
      // capping. Numbers are rounded to 4 decimal places (~11m) so small
      // pan jitter doesn't trigger redundant refetches.
      bbox: bboxFromRegion(region),
      limit: 200,
    } as never,
    // Cast to `never` because the orval-generated type marks `queryKey`
    // as required even though the hook fills it in for us.
    {
      query: {
        // Don't blink the map every time we re-query while the user pans.
        staleTime: 60_000,
      },
    } as never,
  );

  const trails: ApiTrail[] = useMemo(() => {
    const data = trailsQ.data as { trails?: ApiTrail[] } | undefined;
    return data?.trails ?? [];
  }, [trailsQ.data]);

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
          <Feather name="navigation" size={18} color={colors.light.primary} />
        </TouchableOpacity>
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
});
