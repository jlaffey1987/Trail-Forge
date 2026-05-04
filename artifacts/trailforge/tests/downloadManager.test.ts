import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: {},
  fetchTrailGpxByIds: vi.fn().mockResolvedValue(new Map()),
  populateTrailGpxCache: vi.fn(),
}));

vi.mock("@/lib/trailLayer", () => ({
  getTrailBbox: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/offlineStore", () => ({
  saveTrailOffline: vi.fn().mockResolvedValue(undefined),
  tilesToDownload: vi.fn().mockReturnValue([]),
  cacheTiles: vi.fn().mockResolvedValue(0),
}));

const { estimateDownloadSize, formatBytes } = await import("@/lib/downloadManager");

describe("estimateDownloadSize", () => {
  it("returns 0 tiles when trail has no bbox", () => {
    const trail = { id: "t1", name: "Test" } as any;
    const result = estimateDownloadSize(trail);
    expect(result.tileCount).toBe(0);
    expect(result.estimatedBytes).toBe(0);
    expect(result.needsConfirm).toBe(false);
  });
});

describe("formatBytes", () => {
  it("formats bytes correctly", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1500)).toBe("1.5 KB");
    expect(formatBytes(1500000)).toBe("1.4 MB");
  });
});
