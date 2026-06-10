/**
 * Mini map — pick where to join a discovery route (tap or drag pin).
 */
import React, { useMemo, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polyline, type Region } from "react-native-maps";

import colors from "@/constants/colors";
import type { MapTrail } from "@/lib/api";
import { trailMapCoordinates } from "@/lib/geo";
import { difficultyColor } from "@/lib/trailColors";
import {
  findTntJoinSnap,
  type TntJoinSnap,
} from "@/lib/tntNavigation";
import type { NavLatLng } from "@/lib/navigationReroute";

const AMBER = colors.light.primary;

interface Props {
  sections: MapTrail[];
  userGps: NavLatLng;
  join: TntJoinSnap;
  onJoinChange: (join: TntJoinSnap) => void;
}

export function TntJoinPickerMap({ sections, userGps, join, onJoinChange }: Props) {
  const mapRef = useRef<MapView | null>(null);

  const polylines = useMemo(
    () =>
      sections
        .map((t) => ({
          id: t.id,
          coords: trailMapCoordinates(t),
          isRoad: t.terrain === "road",
          trail: t,
        }))
        .filter((p) => p.coords.length >= 2),
    [sections],
  );

  const region = useMemo((): Region => {
    const lats = [userGps.latitude, join.snap.point.latitude];
    const lons = [userGps.longitude, join.snap.point.longitude];
    for (const p of polylines) {
      for (const c of p.coords) {
        lats.push(c.latitude);
        lons.push(c.longitude);
      }
    }
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const pad = 0.08;
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLon + maxLon) / 2,
      latitudeDelta: Math.max(0.06, (maxLat - minLat) * 1.5 + pad),
      longitudeDelta: Math.max(0.06, (maxLon - minLon) * 1.5 + pad),
    };
  }, [polylines, userGps, join]);

  function snapJoinAt(coord: NavLatLng) {
    const next = findTntJoinSnap(sections, coord);
    if (next) onJoinChange(next);
  }

  return (
    <View style={styles.wrap}>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={region}
        scrollEnabled
        zoomEnabled
        rotateEnabled={false}
        onPress={(e) => snapJoinAt(e.nativeEvent.coordinate)}
      >
        {polylines.map(({ id, coords, isRoad, trail }) => (
          <Polyline
            key={id}
            coordinates={coords}
            strokeColor={isRoad ? "#aaaaaa" : difficultyColor(trail.difficulty)}
            strokeWidth={isRoad ? 3 : 4}
            lineDashPattern={isRoad ? [8, 10] : undefined}
          />
        ))}
        <Marker
          coordinate={userGps}
          anchor={{ x: 0.5, y: 0.5 }}
          tracksViewChanges={false}
        >
          <View style={styles.gpsDot} />
        </Marker>
        <Marker
          coordinate={join.snap.point}
          anchor={{ x: 0.5, y: 0.5 }}
          draggable
          tracksViewChanges={false}
          onDragEnd={(e) => snapJoinAt(e.nativeEvent.coordinate)}
        >
          <View style={styles.joinPin}>
            <View style={styles.joinPinInner} />
          </View>
        </Marker>
      </MapView>
      <Text style={styles.hint}>
        Tap the route or drag the orange pin to choose where you join
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12 },
  map: {
    height: 200,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#44403c",
  },
  hint: {
    color: "#78716c",
    fontSize: 11,
    marginTop: 8,
    lineHeight: 16,
    textAlign: "center",
  },
  gpsDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#3b82f6",
    borderWidth: 2,
    borderColor: "#fff",
  },
  joinPin: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(245,166,35,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  joinPinInner: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: AMBER,
    borderWidth: 2,
    borderColor: "#fff",
  },
});
