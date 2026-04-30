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
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

describe("routing.searchSuggestions", () => {
  it("returns an empty ok-result for queries shorter than 2 characters and never hits the network", async () => {
    const out = await searchSuggestions("a");
    expect(out).toEqual({ status: "ok", suggestions: [] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns the GB-bias results when Nominatim has any UK matches", async () => {
    const gbHit = [
      {
        // Use a unique place_id per test so the in-module cache from a
        // previous test can't accidentally short-circuit this lookup.
        place_id: 4242001,
        lat: "54.5",
        lon: "-3.1",
        display_name: "Keswick, Cumbria, England, United Kingdom",
      },
    ];
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(gbHit),
    );

    const out = await searchSuggestions("Keswick-uniq-1");

    expect(out.status).toBe("ok");
    if (out.status !== "ok") throw new Error("unreachable");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const url = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("countrycodes=gb");
    expect(out.suggestions).toHaveLength(1);
    expect(out.suggestions[0]).toMatchObject({
      id: "4242001",
      lat: 54.5,
      lng: -3.1,
    });
    expect(out.suggestions[0].shortLabel).toContain("Keswick");
  });

  it("falls back to the global query when GB returns nothing", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse([])); // GB empty
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          place_id: 4242002,
          lat: "40.0",
          lon: "-74.0",
          display_name: "Newark, NJ, USA",
        },
      ]),
    );

    const out = await searchSuggestions("Newark-uniq-2");

    expect(out.status).toBe("ok");
    if (out.status !== "ok") throw new Error("unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][0] as string)).not.toContain("countrycodes=gb");
    expect(out.suggestions[0].id).toBe("4242002");
  });

  it("returns a tagged error when the network fails so callers can show a retry hint instead of an empty list", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("offline"),
    );
    const out = await searchSuggestions("Manchester-uniq-3");
    expect(out.status).toBe("error");
    if (out.status !== "error") throw new Error("unreachable");
    expect(out.error).toMatch(/offline/i);
  });
});
