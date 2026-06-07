/**
 * Tap-to-draw trail route on a map. Used by Add Trail flow.
 */
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, {
  Marker,
  Polyline,
  PROVIDER_DEFAULT,
  PROVIDER_GOOGLE,
  type Region,
} from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";

import colors from "@/constants/colors";
import { haversineKm } from "@/lib/geo";

const AMBER = colors.light.primary;
const CARD = colors.light.card;
const TEXT = colors.light.foreground;
const BORDER = colors.light.border;
const GREEN = "#22c55e";
const RED = "#ef4444";

export interface DrawnPoint {
  lat: number;
  lon: number;
}

interface DrawTrailMapProps {
  onComplete: (path: Array<[number, number]>, distanceKm: number) => void;
  onCancel: () => void;
}

export function DrawTrailMap({ onComplete, onCancel }: DrawTrailMapProps) {
  const [pts, setPts] = useState<DrawnPoint[]>([]);
  const [region, setRegion] = useState<Region>({
    latitude: 54.5,
    longitude: -2.5,
    latitudeDelta: 0.08,
    longitudeDelta: 0.08,
  });
  const mapRef = useRef<MapView | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") return;
        const pos =
          (await Location.getLastKnownPositionAsync())
          ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
        const next: Region = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          latitudeDelta: 0.06,
          longitudeDelta: 0.06,
        };
        setRegion(next);
        mapRef.current?.animateToRegion(next, 500);
      } catch {
        // keep UK default
      }
    })();
  }, []);

  const coords = pts.map((p) => ({ latitude: p.lat, longitude: p.lon }));
  const distKm = useMemo(() => {
    let d = 0;
    for (let i = 1; i < pts.length; i++) {
      d += haversineKm(
        { lat: pts[i - 1].lat, lon: pts[i - 1].lon },
        { lat: pts[i].lat, lon: pts[i].lon },
      );
    }
    return d;
  }, [pts]);

  function handlePress(e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) {
    void Haptics.selectionAsync();
    setPts((prev) => [
      ...prev,
      { lat: e.nativeEvent.coordinate.latitude, lon: e.nativeEvent.coordinate.longitude },
    ]);
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <StatusBar barStyle="light-content" />
      <MapView
        ref={mapRef}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        showsUserLocation
        userInterfaceStyle="dark"
        onPress={handlePress}
      >
        {coords.length >= 2 && (
          <Polyline coordinates={coords} strokeColor={AMBER} strokeWidth={4} />
        )}
        {pts.map((p, i) => (
          <Marker
            key={`${p.lat}-${p.lon}-${i}`}
            coordinate={{ latitude: p.lat, longitude: p.lon }}
            pinColor={i === 0 ? GREEN : i === pts.length - 1 ? RED : AMBER}
          />
        ))}
      </MapView>

      <SafeAreaView style={s.header}>
        <View style={s.hud}>
          <Text style={s.hudText}>
            {pts.length === 0
              ? "Tap the map to draw your trail point by point"
              : `${pts.length} points · ${distKm.toFixed(2)} km`}
          </Text>
        </View>
      </SafeAreaView>

      <View style={s.controls}>
        <TouchableOpacity style={s.ctrlBtn} onPress={onCancel}>
          <Feather name="x" size={20} color={TEXT} />
          <Text style={s.ctrlLabel}>Cancel</Text>
        </TouchableOpacity>
        {pts.length > 0 && (
          <TouchableOpacity style={s.ctrlBtn} onPress={() => setPts((p) => p.slice(0, -1))}>
            <Feather name="corner-up-left" size={20} color={TEXT} />
            <Text style={s.ctrlLabel}>Undo</Text>
          </TouchableOpacity>
        )}
        {pts.length >= 2 && (
          <TouchableOpacity
            style={[s.ctrlBtn, s.doneBtn]}
            onPress={() => {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              onComplete(
                pts.map((p) => [p.lon, p.lat] as [number, number]),
                distKm,
              );
            }}
          >
            <Feather name="check" size={20} color="#000" />
            <Text style={[s.ctrlLabel, { color: "#000" }]}>Save route</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  header: { position: "absolute", top: 0, left: 0, right: 0 },
  hud: {
    margin: 16,
    backgroundColor: CARD,
    borderColor: AMBER,
    borderWidth: 1.5,
    borderRadius: 12,
    padding: 14,
    alignSelf: "stretch",
  },
  hudText: { color: TEXT, fontSize: 15, fontWeight: "700" },
  controls: {
    position: "absolute",
    bottom: 40,
    left: 16,
    right: 16,
    flexDirection: "row",
    gap: 10,
    justifyContent: "flex-end",
  },
  ctrlBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: CARD,
    borderColor: BORDER,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  doneBtn: { backgroundColor: AMBER, borderColor: AMBER },
  ctrlLabel: { color: TEXT, fontSize: 13, fontWeight: "700" },
});
