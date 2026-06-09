import { RIDE_POV_BANNER } from "@/constants/brandImages";

export interface DiscoveryRouteConfig {
  slug: string;
  title: string;
  subtitle: string;
  /** Match `trail_collections.name` (first hit wins). */
  collectionNames: string[];
  /** When no collection row exists, fetch trails by `source`. */
  trailSourceFallback?: string;
  offlineStorageKey: string;
  gpxExportLabel: string;
  emptyHint: string;
  discoverRegion?: string;
  /** Optional hero image — defaults to Ride POV banner. */
  heroImage?: number;
}

export const DISCOVERY_ROUTES = {
  tnt: {
    slug: "tnt",
    title: "TRANS NORTHERN TRAIL",
    subtitle: "Trails associated with the Trans Northern Trail",
    collectionNames: ["Trans Northern Trail"],
    trailSourceFallback: "TNT",
    offlineStorageKey: "@trailforge/tnt-offline-v1",
    gpxExportLabel: "Trans Northern Trail (community route)",
    emptyHint: "No TNT sections in the database yet. Run the import script after confirming the dry run.",
    discoverRegion: "England North / Scotland",
    heroImage: RIDE_POV_BANNER,
  },
} satisfies Record<string, DiscoveryRouteConfig>;

export function resolveCollection(
  collections: Array<{ id: string; name: string }>,
  names: string[],
): { id: string; name: string } | null {
  for (const want of names) {
    const hit = collections.find(
      (c) => c.name.toLowerCase() === want.toLowerCase(),
    );
    if (hit) return hit;
  }
  return null;
}
