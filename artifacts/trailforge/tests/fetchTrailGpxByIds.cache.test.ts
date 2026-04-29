import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the Supabase client. The cache lives at module scope inside
// `@/lib/supabase`, so each test re-imports it through the module registry
// after `vi.resetModules()` to start with an empty cache.
// ---------------------------------------------------------------------------

type GpxRow = { id: string; gpx_data: unknown };

interface MockSupabaseConfig {
  rows: GpxRow[];
  error?: { message: string; code?: string } | null;
  /** Number of millis to delay before resolving (for inflight-dedup tests). */
  delayMs?: number;
  /** Records every `.in("id", [...])` call. Inspected by tests. */
  callLog: string[][];
}

const mockConfig: MockSupabaseConfig = {
  rows: [],
  error: null,
  delayMs: 0,
  callLog: [],
};

vi.mock("@supabase/supabase-js", () => {
  return {
    createClient: () => ({
      from: (_table: string) => ({
        select: (_cols: string) => ({
          in: async (_col: string, ids: string[]) => {
            mockConfig.callLog.push([...ids]);
            if (mockConfig.delayMs && mockConfig.delayMs > 0) {
              await new Promise((r) => setTimeout(r, mockConfig.delayMs));
            }
            if (mockConfig.error) {
              return { data: null, error: mockConfig.error };
            }
            const set = new Set(ids);
            return {
              data: mockConfig.rows.filter((r) => set.has(r.id)),
              error: null,
            };
          },
        }),
      }),
      rpc: async () => ({ data: null, error: null }),
    }),
  };
});

async function loadSupabaseModule() {
  // Fresh module instance → fresh cache.
  vi.resetModules();
  return await import("@/lib/supabase");
}

beforeEach(() => {
  mockConfig.rows = [];
  mockConfig.error = null;
  mockConfig.delayMs = 0;
  mockConfig.callLog = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchTrailGpxByIds — in-memory cache", () => {
  it("hits Supabase the first time and serves the cache on the second call", async () => {
    const { fetchTrailGpxByIds } = await loadSupabaseModule();
    mockConfig.rows = [
      { id: "t1", gpx_data: "<gpx>1</gpx>" },
      { id: "t2", gpx_data: "<gpx>2</gpx>" },
    ];

    const first = await fetchTrailGpxByIds(["t1", "t2"]);
    expect(first.get("t1")).toBe("<gpx>1</gpx>");
    expect(first.get("t2")).toBe("<gpx>2</gpx>");
    expect(mockConfig.callLog).toHaveLength(1);
    expect(mockConfig.callLog[0].sort()).toEqual(["t1", "t2"]);

    const second = await fetchTrailGpxByIds(["t1", "t2"]);
    expect(second.get("t1")).toBe("<gpx>1</gpx>");
    expect(second.get("t2")).toBe("<gpx>2</gpx>");
    // No additional Supabase round-trip — both ids were served from cache.
    expect(mockConfig.callLog).toHaveLength(1);
  });

  it("only fetches the ids that aren't already cached", async () => {
    const { fetchTrailGpxByIds } = await loadSupabaseModule();
    mockConfig.rows = [
      { id: "a", gpx_data: "A" },
      { id: "b", gpx_data: "B" },
      { id: "c", gpx_data: "C" },
    ];

    await fetchTrailGpxByIds(["a"]);
    await fetchTrailGpxByIds(["a", "b", "c"]);

    expect(mockConfig.callLog).toEqual([["a"], expect.arrayContaining(["b", "c"])]);
    expect(mockConfig.callLog[1]).toHaveLength(2);
  });

  it("dedupes ids within a single call", async () => {
    const { fetchTrailGpxByIds } = await loadSupabaseModule();
    mockConfig.rows = [{ id: "x", gpx_data: "X" }];
    const out = await fetchTrailGpxByIds(["x", "x", "x"]);
    expect(out.get("x")).toBe("X");
    expect(mockConfig.callLog).toEqual([["x"]]);
  });

  it("shares one network request across concurrent callers for the same id", async () => {
    const { fetchTrailGpxByIds } = await loadSupabaseModule();
    mockConfig.rows = [{ id: "t1", gpx_data: "G" }];
    mockConfig.delayMs = 20;

    // Kick off two overlapping fetches before the first resolves —
    // simulates the user re-ordering planner trails mid-flight.
    const [r1, r2] = await Promise.all([
      fetchTrailGpxByIds(["t1"]),
      fetchTrailGpxByIds(["t1"]),
    ]);

    expect(r1.get("t1")).toBe("G");
    expect(r2.get("t1")).toBe("G");
    expect(mockConfig.callLog).toHaveLength(1);
  });

  it("does not cache and does not crash when Supabase returns an error", async () => {
    const { fetchTrailGpxByIds } = await loadSupabaseModule();
    mockConfig.error = { message: "boom", code: "42P01" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await fetchTrailGpxByIds(["t1"]);
    expect(r.size).toBe(0);

    // Recover and verify the next call retries Supabase (i.e. no negative
    // caching of the failure).
    mockConfig.error = null;
    mockConfig.rows = [{ id: "t1", gpx_data: "OK" }];
    const r2 = await fetchTrailGpxByIds(["t1"]);
    expect(r2.get("t1")).toBe("OK");
    expect(mockConfig.callLog).toHaveLength(2);

    errSpy.mockRestore();
  });

  it("returns an empty map without touching Supabase for an empty id list", async () => {
    const { fetchTrailGpxByIds } = await loadSupabaseModule();
    const r = await fetchTrailGpxByIds([]);
    expect(r.size).toBe(0);
    expect(mockConfig.callLog).toHaveLength(0);
  });
});

describe("invalidateTrailGpxCache", () => {
  it("forces a re-fetch for the invalidated id only", async () => {
    const { fetchTrailGpxByIds, invalidateTrailGpxCache } =
      await loadSupabaseModule();
    mockConfig.rows = [
      { id: "t1", gpx_data: "v1" },
      { id: "t2", gpx_data: "T2" },
    ];

    await fetchTrailGpxByIds(["t1", "t2"]);
    expect(mockConfig.callLog).toHaveLength(1);

    invalidateTrailGpxCache("t1");
    mockConfig.rows = [
      { id: "t1", gpx_data: "v2" },
      { id: "t2", gpx_data: "T2" },
    ];

    const after = await fetchTrailGpxByIds(["t1", "t2"]);
    // t1 was re-fetched and reflects the new payload, t2 stayed cached.
    expect(after.get("t1")).toBe("v2");
    expect(after.get("t2")).toBe("T2");
    expect(mockConfig.callLog).toHaveLength(2);
    expect(mockConfig.callLog[1]).toEqual(["t1"]);
  });

  it("invalidating during an in-flight fetch discards the stale result instead of repopulating the cache", async () => {
    const {
      fetchTrailGpxByIds,
      invalidateTrailGpxCache,
      __getCachedTrailGpx,
    } = await loadSupabaseModule();

    mockConfig.rows = [{ id: "t1", gpx_data: "OLD" }];
    mockConfig.delayMs = 30;

    // Kick off a fetch but don't await it yet.
    const inflight = fetchTrailGpxByIds(["t1"]);
    // Mid-flight, the user re-uploads / mutates the trail. The stale
    // response that's already on the wire must NOT land in the cache.
    invalidateTrailGpxCache("t1");
    const result = await inflight;
    // The racing fetch's result was dropped, so the caller gets nothing
    // for this id and the cache stays empty until the next read.
    expect(result.has("t1")).toBe(false);
    expect(__getCachedTrailGpx("t1")).toBeUndefined();

    // The very next call goes back to Supabase and returns the fresh value.
    mockConfig.delayMs = 0;
    mockConfig.rows = [{ id: "t1", gpx_data: "NEW" }];
    const after = await fetchTrailGpxByIds(["t1"]);
    expect(after.get("t1")).toBe("NEW");
    expect(__getCachedTrailGpx("t1")).toBe("NEW");
    // One initial fetch + one post-invalidation fetch = 2 total.
    expect(mockConfig.callLog).toHaveLength(2);
  });

  it("clears the entire cache when called with no arguments", async () => {
    const { fetchTrailGpxByIds, invalidateTrailGpxCache } =
      await loadSupabaseModule();
    mockConfig.rows = [
      { id: "a", gpx_data: "A" },
      { id: "b", gpx_data: "B" },
    ];

    await fetchTrailGpxByIds(["a", "b"]);
    expect(mockConfig.callLog).toHaveLength(1);

    invalidateTrailGpxCache();
    await fetchTrailGpxByIds(["a", "b"]);
    expect(mockConfig.callLog).toHaveLength(2);
  });
});

describe("mutations invalidate the GPX cache", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: { location: { origin: "http://localhost" } },
      writable: true,
      configurable: true,
    });
  });

  it("replaceOwnedTrailGpx evicts the cached GPX so the next read sees the new XML", async () => {
    const {
      fetchTrailGpxByIds,
      replaceOwnedTrailGpx,
      __getCachedTrailGpx,
    } = await loadSupabaseModule();

    mockConfig.rows = [{ id: "t1", gpx_data: "OLD" }];
    await fetchTrailGpxByIds(["t1"]);
    expect(__getCachedTrailGpx("t1")).toBe("OLD");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "t1", name: "T1", gpx_data: "NEW" }),
      }),
    );

    await replaceOwnedTrailGpx("t1", { gpx_data: "NEW" });
    expect(__getCachedTrailGpx("t1")).toBeUndefined();

    mockConfig.rows = [{ id: "t1", gpx_data: "NEW" }];
    const r = await fetchTrailGpxByIds(["t1"]);
    expect(r.get("t1")).toBe("NEW");
    expect(mockConfig.callLog).toHaveLength(2);

    vi.unstubAllGlobals();
  });

  it("updateOwnedTrail and deleteOwnedTrail also drop the cached entry", async () => {
    const {
      fetchTrailGpxByIds,
      updateOwnedTrail,
      deleteOwnedTrail,
      __getCachedTrailGpx,
    } = await loadSupabaseModule();

    mockConfig.rows = [
      { id: "t1", gpx_data: "X" },
      { id: "t2", gpx_data: "Y" },
    ];
    await fetchTrailGpxByIds(["t1", "t2"]);
    expect(__getCachedTrailGpx("t1")).toBe("X");
    expect(__getCachedTrailGpx("t2")).toBe("Y");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "t1", name: "T1" }),
        text: async () => "",
      }),
    );

    await updateOwnedTrail("t1", { name: "renamed" });
    expect(__getCachedTrailGpx("t1")).toBeUndefined();
    // t2 is untouched.
    expect(__getCachedTrailGpx("t2")).toBe("Y");

    await deleteOwnedTrail("t2");
    expect(__getCachedTrailGpx("t2")).toBeUndefined();

    vi.unstubAllGlobals();
  });
});
