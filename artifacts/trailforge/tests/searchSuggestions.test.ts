import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchSuggestions } from "@/lib/routing";

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe("routing.searchSuggestions", () => {
  it("returns [] for queries shorter than 2 characters and never hits the network", async () => {
    const out = await searchSuggestions("a");
    expect(out).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns the GB-bias results when Nominatim has any UK matches", async () => {
    const gbHit = [
      {
        place_id: 42,
        lat: "54.5",
        lon: "-3.1",
        display_name: "Keswick, Cumbria, England, United Kingdom",
      },
    ];
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(gbHit),
    );

    const out = await searchSuggestions("Keswick");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const url = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("countrycodes=gb");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "42", lat: 54.5, lng: -3.1 });
    expect(out[0].shortLabel).toContain("Keswick");
  });

  it("falls back to the global query when GB returns nothing", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse([])); // GB empty
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { place_id: 7, lat: "40.0", lon: "-74.0", display_name: "Newark, NJ, USA" },
      ]),
    );

    const out = await searchSuggestions("Newark");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][0] as string)).not.toContain("countrycodes=gb");
    expect(out[0].id).toBe("7");
  });

  it("swallows network errors and returns []", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("offline"),
    );
    const out = await searchSuggestions("Manchester");
    expect(out).toEqual([]);
  });
});
