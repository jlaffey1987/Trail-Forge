/**
 * Explore tab — Featured trail collections, Near You, Community Favourites,
 * Seasonal routes.  Tapping a collection loads all its sections onto the map.
 */
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import * as Location from "expo-location";
import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { apiFetch } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrailCollection {
  id: string;
  name: string;
  description: string | null;
  region: string | null;
  difficulty_min: number | null;
  difficulty_max: number | null;
  total_distance_km: number | null;
  is_featured: boolean;
  is_official: boolean;
  cover_image_url: string | null;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchCollections(): Promise<TrailCollection[]> {
  const res = await apiFetch("/api/collections");
  if (!res.ok) throw new Error("Failed to load collections");
  return (res.json() as Promise<{ collections: TrailCollection[] }>).then(d => d.collections);
}

// ---------------------------------------------------------------------------
// Difficulty badge helper
// ---------------------------------------------------------------------------

function DifficultyBadge({ min, max }: { min: number | null; max: number | null }) {
  if (min == null && max == null) return null;
  const label = min != null && max != null
    ? `Grade ${min}–${max}`
    : min != null ? `Grade ${min}+` : `Grade ${max}`;

  const color =
    (max ?? 0) >= 10 ? "#ef4444" :
    (max ?? 0) >= 7  ? "#f97316" :
    (max ?? 0) >= 4  ? "#3b82f6" : "#22c55e";

  return (
    <View style={[badge.pill, { backgroundColor: color + "22", borderColor: color }]}>
      <Text style={[badge.text, { color }]}>{label}</Text>
    </View>
  );
}

const badge = StyleSheet.create({
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  text: { fontSize: 11, fontWeight: "700" },
});

// ---------------------------------------------------------------------------
// Collection card
// ---------------------------------------------------------------------------

function CollectionCard({ item }: { item: TrailCollection }) {
  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.85}
      onPress={() => {
        router.push(
          "/map" as unknown as Parameters<typeof router.push>[0],
        );
      }}
    >
      {/* Cover colour bar based on difficulty */}
      <View
        style={[
          styles.cardBar,
          {
            backgroundColor:
              (item.difficulty_max ?? 0) >= 10 ? "#ef4444" :
              (item.difficulty_max ?? 0) >= 7  ? "#f97316" :
              (item.difficulty_max ?? 0) >= 4  ? "#3b82f6" : "#22c55e",
          },
        ]}
      />

      <View style={styles.cardBody}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>{item.name}</Text>
          {item.is_official && (
            <View style={styles.officialBadge}>
              <Feather name="check-circle" size={11} color="#D97706" />
              <Text style={styles.officialText}>Official</Text>
            </View>
          )}
        </View>

        {item.description ? (
          <Text style={styles.cardDesc} numberOfLines={2}>{item.description}</Text>
        ) : null}

        <View style={styles.cardMeta}>
          {item.region ? (
            <View style={styles.metaItem}>
              <Feather name="map-pin" size={11} color={colors.light.mutedForeground} />
              <Text style={styles.metaText}>{item.region}</Text>
            </View>
          ) : null}
          {item.total_distance_km ? (
            <View style={styles.metaItem}>
              <Feather name="trending-up" size={11} color={colors.light.mutedForeground} />
              <Text style={styles.metaText}>{Math.round(item.total_distance_km)} km</Text>
            </View>
          ) : null}
          <DifficultyBadge min={item.difficulty_min} max={item.difficulty_max} />
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionHeader({ title, icon }: { title: string; icon: keyof typeof Feather.glyphMap }) {
  return (
    <View style={styles.sectionHeader}>
      <Feather name={icon} size={16} color={colors.light.primary} />
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function ExploreTab() {
  const [nearLat, setNearLat] = useState<number | null>(null);
  const [nearLon, setNearLon] = useState<number | null>(null);

  useEffect(() => {
    void Location.requestForegroundPermissionsAsync().then(async ({ status }) => {
      if (status !== "granted") return;
      const pos = await Location.getLastKnownPositionAsync().catch(() => null)
        ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
      if (pos) { setNearLat(pos.coords.latitude); setNearLon(pos.coords.longitude); }
    });
  }, []);

  const collectionsQ = useQuery({
    queryKey: ["trail-collections"],
    queryFn: fetchCollections,
    staleTime: 5 * 60_000,
  });

  const collections = collectionsQ.data ?? [];
  const featured = collections.filter(c => c.is_featured);
  const official = collections.filter(c => c.is_official);
  const regional = nearLat != null ? collections.filter(c => c.region != null) : [];

  if (collectionsQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.light.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={collectionsQ.isFetching}
          onRefresh={() => void collectionsQ.refetch()}
          tintColor={colors.light.primary}
        />
      }
    >
      {/* Featured Routes */}
      {featured.length > 0 && (
        <>
          <SectionHeader title="Featured Routes" icon="star" />
          <FlatList
            horizontal
            data={featured}
            keyExtractor={i => i.id}
            renderItem={({ item }) => <CollectionCard item={item} />}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.horizontalList}
            scrollEnabled
          />
        </>
      )}

      {/* Official routes */}
      {official.length > 0 && (
        <>
          <SectionHeader title="Official Routes" icon="check-circle" />
          {official.map(item => <CollectionCard key={item.id} item={item} />)}
        </>
      )}

      {/* Near You */}
      {regional.length > 0 && nearLat != null && (
        <>
          <SectionHeader title="Routes Near You" icon="navigation" />
          {regional.slice(0, 4).map(item => <CollectionCard key={item.id} item={item} />)}
        </>
      )}

      {collections.length === 0 && (
        <View style={styles.empty}>
          <Feather name="map" size={40} color={colors.light.mutedForeground} />
          <Text style={styles.emptyText}>No collections yet</Text>
          <Text style={styles.emptySubtext}>Collections will appear here as trail data is imported.</Text>
        </View>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.light.background },
  content: { padding: 16, paddingBottom: 32, gap: 8 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 16,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.light.foreground,
  },

  horizontalList: { gap: 12, paddingRight: 16 },

  card: {
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
    marginBottom: 10,
    width: 240,
  },
  cardBar: { height: 4 },
  cardBody: { padding: 12, gap: 6 },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  cardTitle: { flex: 1, fontSize: 14, fontWeight: "700", color: colors.light.foreground },
  cardDesc: { fontSize: 12, color: colors.light.mutedForeground, lineHeight: 16 },
  cardMeta: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 4 },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { fontSize: 11, color: colors.light.mutedForeground },
  officialBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "#D9770622",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  officialText: { fontSize: 10, fontWeight: "600", color: "#D97706" },

  empty: { alignItems: "center", marginTop: 60, gap: 8 },
  emptyText: { fontSize: 16, fontWeight: "600", color: colors.light.foreground },
  emptySubtext: { fontSize: 13, color: colors.light.mutedForeground, textAlign: "center" },
});
