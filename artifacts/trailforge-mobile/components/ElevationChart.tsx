/**
 * Tiny SVG sparkline of a trail's elevation profile. Same conceptual
 * widget as the web's chart, drawn with `react-native-svg` so we don't
 * pull in a heavy native chart library.
 *
 * Input is the raw trail GPX altitudes resampled by the API to ~120
 * points. We just normalise to the bounding box and draw a single
 * polyline plus a faint baseline.
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Polyline, Line, Rect } from "react-native-svg";

import colors from "@/constants/colors";

interface ElevationChartProps {
  altitudes: number[];
  width: number;
  height?: number;
}

export function ElevationChart({
  altitudes,
  width,
  height = 72,
}: ElevationChartProps) {
  if (!altitudes || altitudes.length < 2) {
    return (
      <View style={[styles.empty, { width, height }]}>
        <Text style={styles.emptyText}>No elevation data</Text>
      </View>
    );
  }

  const min = Math.min(...altitudes);
  const max = Math.max(...altitudes);
  const span = Math.max(1, max - min);
  const stepX = width / (altitudes.length - 1);
  const padY = 6;
  const usable = height - padY * 2;

  const points = altitudes
    .map((alt, i) => {
      const x = i * stepX;
      const y = padY + usable - ((alt - min) / span) * usable;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <View>
      <Svg width={width} height={height}>
        <Rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill={colors.light.muted}
          rx={8}
        />
        <Line
          x1={0}
          x2={width}
          y1={height / 2}
          y2={height / 2}
          stroke={colors.light.border}
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <Polyline
          points={points}
          fill="none"
          stroke={colors.light.primary}
          strokeWidth={2}
        />
      </Svg>
      <View style={styles.labels}>
        <Text style={styles.label}>{Math.round(min)} m</Text>
        <Text style={styles.label}>+{Math.round(max - min)} m gain</Text>
        <Text style={styles.label}>{Math.round(max)} m</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    backgroundColor: colors.light.muted,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: { color: colors.light.mutedForeground, fontSize: 11 },
  labels: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
    paddingHorizontal: 4,
  },
  label: { color: colors.light.mutedForeground, fontSize: 10 },
});
