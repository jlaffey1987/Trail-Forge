import { StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";

/**
 * Web-only stub for the Map tab.
 *
 * `react-native-maps` is iOS / Android only — it imports native modules
 * that Metro cannot resolve when bundling for web (the Replit preview
 * pane). The real map screen lives in `map.tsx` and is automatically
 * picked by Metro on native platforms; this `.web.tsx` sibling shadows
 * it on web with a friendly placeholder so the bundler succeeds.
 */
export default function MapWebStub() {
  const c = useColors();
  return (
    <View
      style={[styles.container, { backgroundColor: c.background }]}
      accessibilityLabel="Map preview unavailable on web"
    >
      <Text style={[styles.title, { color: c.foreground }]}>
        Map preview unavailable on web
      </Text>
      <Text style={[styles.body, { color: c.mutedForeground }]}>
        TrailForge Mobile uses native Apple/Google Maps via{" "}
        <Text style={{ color: c.primary }}>react-native-maps</Text>, which only
        runs on iOS and Android. Open this app in Expo Go on your phone to see
        the real map with trail polylines.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  title: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 12,
    textAlign: "center",
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    maxWidth: 360,
  },
});
