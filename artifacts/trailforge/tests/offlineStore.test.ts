import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";

vi.mock("@/lib/supabase", () => ({
  supabase: {},
}));

const { saveTrailOffline, getOfflineTrail, removeOfflineTrail, listOfflineTrails, clearAllOffline } = await import("@/lib/offlineStore");

function makeFakeTrail(id: string) {
  return {
    id,
    name: `Trail ${id}`,
    user_id: "u1",
    owner_user_id: "u1",
    type: "trail",
    difficulty: 3,
    distance_km: 10,
    terrain: "dirt",
    legal_status: "BOAT",
    is_public: true,
    created_at: new Date().toISOString(),
  } as any;
}

function makeOfflineTrail(id: string, tileUrls: string[] = []) {
  return {
    id,
    trail: makeFakeTrail(id),
    gpxData: `<gpx><trk><name>${id}</name></trk></gpx>`,
    photos: [],
    downloadedAt: new Date().toISOString(),
    tileCount: tileUrls.length,
    estimatedSizeBytes: 1000,
    tileUrls,
  };
}

describe("offlineStore", () => {
  beforeEach(async () => {
    await clearAllOffline();
  });

  it("saves and retrieves a trail", async () => {
    const entry = makeOfflineTrail("t1");
    await saveTrailOffline(entry);
    const result = await getOfflineTrail("t1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("t1");
    expect(result!.gpxData).toContain("<gpx>");
    expect(result!.tileUrls).toEqual([]);
  });

  it("lists all offline trails", async () => {
    await saveTrailOffline(makeOfflineTrail("t1"));
    await saveTrailOffline(makeOfflineTrail("t2"));
    const list = await listOfflineTrails();
    expect(list).toHaveLength(2);
    const ids = list.map((t) => t.id).sort();
    expect(ids).toEqual(["t1", "t2"]);
  });

  it("removes a trail", async () => {
    await saveTrailOffline(makeOfflineTrail("t1"));
    await removeOfflineTrail("t1");
    const result = await getOfflineTrail("t1");
    expect(result).toBeNull();
  });

  it("stores tileUrls per trail", async () => {
    const urls = ["https://tile.example.com/1", "https://tile.example.com/2"];
    await saveTrailOffline(makeOfflineTrail("t1", urls));
    const result = await getOfflineTrail("t1");
    expect(result!.tileUrls).toEqual(urls);
  });

  it("stores downloadedAt timestamp", async () => {
    const entry = makeOfflineTrail("t1");
    await saveTrailOffline(entry);
    const result = await getOfflineTrail("t1");
    expect(result!.downloadedAt).toBeTruthy();
    expect(new Date(result!.downloadedAt).getTime()).not.toBeNaN();
  });

  it("clearAllOffline removes everything", async () => {
    await saveTrailOffline(makeOfflineTrail("t1"));
    await saveTrailOffline(makeOfflineTrail("t2"));
    await clearAllOffline();
    const list = await listOfflineTrails();
    expect(list).toHaveLength(0);
  });

  it("getOfflineTrail returns null for unknown id", async () => {
    const result = await getOfflineTrail("nonexistent");
    expect(result).toBeNull();
  });
});
