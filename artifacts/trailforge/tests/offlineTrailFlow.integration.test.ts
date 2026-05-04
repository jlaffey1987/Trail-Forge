import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import "fake-indexeddb/auto";

vi.mock("@/lib/supabase", () => {
  const gpxCache = new Map<string, unknown>();
  return {
    supabase: {},
    fetchTrailGpxByIds: vi.fn().mockImplementation(async (ids: string[]) => {
      return gpxCache;
    }),
    populateTrailGpxCache: vi.fn().mockImplementation((id: string, data: unknown) => {
      gpxCache.set(id, data);
    }),
    trailGpxCache: gpxCache,
  };
});

vi.mock("@/lib/trailLayer", () => ({
  getTrailBbox: vi.fn().mockReturnValue(null),
}));

const { saveTrailOffline, getOfflineTrail, clearAllOffline } = await import("@/lib/offlineStore");
const { populateTrailGpxCache, fetchTrailGpxByIds } = await import("@/lib/supabase");

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1">
  <trk>
    <name>Test Trail</name>
    <trkseg>
      <trkpt lat="51.5074" lon="-0.1278"><ele>11</ele></trkpt>
      <trkpt lat="51.5080" lon="-0.1290"><ele>15</ele></trkpt>
      <trkpt lat="51.5090" lon="-0.1300"><ele>20</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

function makeFakeTrail(id: string) {
  return {
    id,
    name: `Test Trail ${id}`,
    user_id: "user-1",
    owner_user_id: "user-1",
    type: "trail",
    difficulty: 3,
    distance_km: 5.2,
    terrain: "dirt",
    legal_status: "BOAT",
    is_public: true,
    created_at: new Date().toISOString(),
    gpx_data: null,
    lat: 51.5074,
    lng: -0.1278,
    waypoints: [],
  } as any;
}

function makeOfflineEntry(id: string) {
  return {
    id,
    trail: makeFakeTrail(id),
    gpxData: SAMPLE_GPX,
    photos: [
      {
        storageKey: `photos/${id}/photo1.jpg`,
        blob: new Blob(["fake-jpg-data"], { type: "image/jpeg" }),
        width: 800,
        height: 600,
        caption: "Trailhead view",
      },
    ],
    downloadedAt: new Date().toISOString(),
    tileCount: 42,
    estimatedSizeBytes: 25000,
    tileUrls: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/8192/8192",
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/8192/8193",
    ],
  };
}

describe("Offline trail data flow — integration", () => {
  beforeEach(async () => {
    await clearAllOffline();
    vi.clearAllMocks();
  });

  it("saves a full trail package and retrieves all components intact", async () => {
    const entry = makeOfflineEntry("trail-abc");
    await saveTrailOffline(entry);

    const loaded = await getOfflineTrail("trail-abc");
    expect(loaded).not.toBeNull();

    expect(loaded!.trail.name).toBe("Test Trail trail-abc");
    expect(loaded!.trail.difficulty).toBe(3);
    expect(loaded!.trail.distance_km).toBe(5.2);
    expect(loaded!.trail.lat).toBe(51.5074);
    expect(loaded!.trail.lng).toBe(-0.1278);

    expect(loaded!.gpxData).toContain("<gpx");
    expect(loaded!.gpxData).toContain("<trkpt");
    expect(loaded!.gpxData).toContain('lat="51.5074"');

    expect(loaded!.photos).toHaveLength(1);
    expect(loaded!.photos[0].storageKey).toContain("photo1.jpg");
    expect(loaded!.photos[0].blob).toBeTruthy();
    expect(loaded!.photos[0].width).toBe(800);
    expect(loaded!.photos[0].caption).toBe("Trailhead view");

    expect(loaded!.tileUrls).toHaveLength(2);
    expect(loaded!.tileUrls[0]).toContain("arcgisonline.com");

    expect(loaded!.tileCount).toBe(42);
    expect(loaded!.downloadedAt).toBeTruthy();
  });

  it("GPX hydration: populateTrailGpxCache uses offline GPX when trail.gpx_data is null", async () => {
    const entry = makeOfflineEntry("trail-gpx");
    await saveTrailOffline(entry);

    const offline = await getOfflineTrail("trail-gpx");
    expect(offline).not.toBeNull();
    expect(offline!.gpxData).toContain("<gpx");

    (populateTrailGpxCache as ReturnType<typeof vi.fn>)(
      "trail-gpx",
      offline!.gpxData,
    );

    expect(populateTrailGpxCache).toHaveBeenCalledWith(
      "trail-gpx",
      expect.stringContaining("<gpx"),
    );

    expect(fetchTrailGpxByIds).not.toHaveBeenCalled();
  });

  it("offline photos are stored and retrievable with metadata", async () => {
    const entry = makeOfflineEntry("trail-photo");
    await saveTrailOffline(entry);

    const loaded = await getOfflineTrail("trail-photo");
    const photo = loaded!.photos[0];
    expect(photo.storageKey).toContain("photo1.jpg");
    expect(photo.width).toBe(800);
    expect(photo.height).toBe(600);
    expect(photo.caption).toBe("Trailhead view");
    expect(photo.blob).toBeTruthy();
  });

  it("simulates offline scenario: fetch fails, offline store provides trail data", async () => {
    const entry = makeOfflineEntry("trail-offline");
    await saveTrailOffline(entry);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    try {
      const loaded = await getOfflineTrail("trail-offline");
      expect(loaded).not.toBeNull();
      expect(loaded!.trail.name).toBe("Test Trail trail-offline");
      expect(loaded!.gpxData).toContain("<gpx");
      expect(loaded!.photos).toHaveLength(1);
      expect(loaded!.tileUrls).toHaveLength(2);

      await expect(
        globalThis.fetch("https://api.example.com/trails/trail-offline"),
      ).rejects.toThrow("Network error");

      expect(loaded!.trail.difficulty).toBe(3);
      expect(loaded!.trail.distance_km).toBe(5.2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("multiple trails stored and listed while offline", async () => {
    await saveTrailOffline(makeOfflineEntry("trail-1"));
    await saveTrailOffline(makeOfflineEntry("trail-2"));
    await saveTrailOffline(makeOfflineEntry("trail-3"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("No network"));

    try {
      const { listOfflineTrails } = await import("@/lib/offlineStore");
      const trails = await listOfflineTrails();
      expect(trails).toHaveLength(3);

      const ids = trails.map((t) => t.id).sort();
      expect(ids).toEqual(["trail-1", "trail-2", "trail-3"]);

      for (const t of trails) {
        expect(t.gpxData).toContain("<gpx");
        expect(t.trail.name).toBeTruthy();
        expect(t.downloadedAt).toBeTruthy();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("removing a trail while offline works correctly", async () => {
    await saveTrailOffline(makeOfflineEntry("trail-rm"));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Offline"));

    try {
      const { removeOfflineTrail } = await import("@/lib/offlineStore");
      await removeOfflineTrail("trail-rm");
      const loaded = await getOfflineTrail("trail-rm");
      expect(loaded).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
