import React, { memo } from "react";
import { Marker } from "react-native-maps";
import { Platform, StyleSheet, View } from "react-native";

import { gradeClusterColor } from "@/lib/mapZoom";

interface TrailDotMarkerProps {
  coordinate: { latitude: number; longitude: number };
  trailGrade: number | null;
  onPress: () => void;
  tracksViewChanges?: boolean;
}

function TrailDotMarker({
  coordinate,
  trailGrade,
  onPress,
  tracksViewChanges = false,
}: TrailDotMarkerProps) {
  const color = gradeClusterColor(trailGrade);
  return (
    <Marker
      coordinate={coordinate}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksViewChanges}
      onPress={onPress}
      // Passed through to supercluster leaf properties for cluster colouring.
      {...({ trailGrade } as Record<string, unknown>)}
    >
      {/* collapsable={false} required on Android or custom marker views vanish */}
      <View collapsable={false} style={styles.hit}>
        <View style={[styles.dot, { backgroundColor: color }]} />
      </View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  hit: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    ...(Platform.OS === "android" ? { elevation: 4 } : {}),
  },
  dot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#111",
  },
});

export default memo(TrailDotMarker);
