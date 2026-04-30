import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchSuggestions } from "@/lib/routing";
import { searchPoisInBbox } from "@/lib/poi";

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Both throttles MUST serialize concurrent callers — a naive `lastAt +
 * setTimeout` check would let two parallel callers (e.g. start- and
 * end-address fields both querying at once) pass the elapsed check
 * together and fire side-by-side, violating Nominatim's 1 req/s and
 * Overpass's usage policy. The architect flagged this regression risk.
 *
 * We assert on the *gap between outbound fetch timestamps*, not on
 * promise-resolve order, so a slow fetch mock doesn't poison the test.
 */
describe("upstream throttle serializes concurrent callers", () => {
  it("Nominatim: two parallel queries are spaced ≥ ~1s apart", async () => {
    const callTimes: number[] = [];
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async () => {
      callTimes.push(Date.now());
      return jsonResponse([
        {
          place_id: 9_000_000 + callTimes.length,
          lat: "51.5",
          lon: "-0.1",
          display_name: `Place ${callTimes.length}, City, UK`,
        },
      ]);
    });

    // Use unique queries so the per-query single-flight Map doesn't
    // dedupe them into a single request — we WANT both to actually
    // race the throttle.
    const [a, b] = await Promise.all([
      searchSuggestions("ThrottleQ-A"),
      searchSuggestions("ThrottleQ-B"),
    ]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");

    expect(callTimes.length).toBeGreaterThanOrEqual(2);
    const gap = callTimes[1] - callTimes[0];
    // 1100 ms intended; allow a small scheduler-jitter floor.
    expect(gap).toBeGreaterThanOrEqual(1000);
  }, 10_000);

  it("Overpass: two parallel queries are spaced ≥ ~2s apart", async () => {
    const callTimes: number[] = [];
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async () => {
      callTimes.push(Date.now());
      return jsonResponse({ elements: [] });
    });

    // Two distinct kinds + bboxes so neither cache nor single-flight
    // dedupes them — both must actually go through the throttle.
    const [a, b] = await Promise.all([
      searchPoisInBbox("fuel", {
        minLat: 50.111,
        minLng: -1.111,
        maxLat: 50.222,
        maxLng: -1.000,
      }),
      searchPoisInBbox("campsite", {
        minLat: 50.333,
        minLng: -1.444,
        maxLat: 50.444,
        maxLng: -1.333,
      }),
    ]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");

    expect(callTimes.length).toBeGreaterThanOrEqual(2);
    const gap = callTimes[1] - callTimes[0];
    // 2000 ms intended; allow a small scheduler-jitter floor.
    expect(gap).toBeGreaterThanOrEqual(1800);
  }, 10_000);
});
