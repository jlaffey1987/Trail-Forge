import { useLocalSearchParams } from "expo-router";
import React, { useMemo } from "react";
import { ActivityIndicator, View } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { DiscoveryRouteScreen } from "@/components/routes/DiscoveryRouteScreen";
import { fetchTrailCollections } from "@/lib/api";
import type { DiscoveryRouteConfig } from "@/lib/discoveryRouteConfig";

export default function CollectionRouteScreen() {
  const { collectionId } = useLocalSearchParams<{ collectionId: string }>();
  const collectionsQ = useQuery({
    queryKey: ["trail-collections"],
    queryFn: fetchTrailCollections,
  });

  const config = useMemo((): DiscoveryRouteConfig | null => {
    const c = collectionsQ.data?.find((x) => x.id === collectionId);
    if (!c) return null;
    return {
      slug: c.id,
      title: c.name.toUpperCase(),
      subtitle: c.description ?? `Trails associated with ${c.name}`,
      collectionNames: [c.name],
      offlineStorageKey: `@trailforge/collection-offline-${c.id}`,
      gpxExportLabel: `${c.name} (community route)`,
      emptyHint: "No sections linked to this collection yet.",
      discoverRegion: c.region ?? undefined,
    };
  }, [collectionsQ.data, collectionId]);

  if (collectionsQ.isLoading || !config) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#111" }}>
        <ActivityIndicator size="large" color="#F5A623" />
      </View>
    );
  }

  return <DiscoveryRouteScreen config={config} />;
}
