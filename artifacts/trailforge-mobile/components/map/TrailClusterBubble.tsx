import React, { memo } from "react";
import { Marker } from "react-native-maps";
import { Platform, StyleSheet, Text, View } from "react-native";

import {
  clusterBubbleSize,
  clusterColorFromGrades,
} from "@/lib/mapZoom";

export interface TrailClusterRenderProps {
  geometry: { coordinates: [number, number] };
  properties: { point_count: number; cluster_id?: number };
  id?: number;
  onPress: () => void;
  /** Supercluster leaf grades for difficulty-coloured bubbles. */
  leafGrades?: Array<number | null | undefined>;
}

function TrailClusterBubble({
  geometry,
  properties,
  onPress,
  leafGrades = [],
}: TrailClusterRenderProps) {
  const count = properties.point_count;
  const { outer, inner, fontSize } = clusterBubbleSize(count);
  const color = clusterColorFromGrades(leafGrades);

  return (
    <Marker
      coordinate={{
        longitude: geometry.coordinates[0],
        latitude: geometry.coordinates[1],
      }}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={false}
      onPress={onPress}
      zIndex={count}
    >
      <View
        collapsable={false}
        style={[styles.wrap, { width: outer, height: outer }]}
      >
        <View
          style={[
            styles.halo,
            { backgroundColor: color, width: outer, height: outer, borderRadius: outer / 2 },
          ]}
        />
        <View
          style={[
            styles.bubble,
            { backgroundColor: color, width: inner, height: inner, borderRadius: inner / 2 },
            Platform.OS === "android" ? { elevation: 6 } : null,
          ]}
        >
          <Text style={[styles.count, { fontSize }]}>{count}</Text>
        </View>
      </View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
  halo: { position: "absolute", opacity: 0.35 },
  bubble: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#111",
  },
  count: { color: "#fff", fontWeight: "900" },
});

export default memo(TrailClusterBubble);
