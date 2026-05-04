import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import "fake-indexeddb/auto";

const TRAIL_ID = "offline-trail-001";
const VIEWER_ID = "user_offline_viewer";

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1">
  <trk><name>Offline Test Trail</name>
    <trkseg>
      <trkpt lat="51.5074" lon="-0.1278"><ele>11</ele></trkpt>
      <trkpt lat="51.5080" lon="-0.1290"><ele>15</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

vi.mock("@clerk/react", () => ({
  useUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: {
      id: VIEWER_ID,
      primaryEmailAddress: { emailAddress: "offline@example.com" },
      emailAddresses: [{ emailAddress: "offline@example.com" }],
      firstName: "Off",
      lastName: "Line",
      fullName: "Off Line",
      username: "offline",
      imageUrl: null,
    },
  }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/", () => {}],
}));

const gpxCacheMap = new Map<string, unknown>();
const populateSpy = vi.fn((id: string, data: unknown) => {
  gpxCacheMap.set(id, data);
});
const fetchGpxSpy = vi.fn().mockResolvedValue(new Map());

vi.mock("@/lib/supabase", () => ({
  supabase: {},
  saveTrail: vi.fn().mockResolvedValue(true),
  fetchTrailGpxByIds: fetchGpxSpy,
  populateTrailGpxCache: populateSpy,
}));

vi.mock("@/lib/users", () => ({
  syncCurrentUser: vi.fn().mockResolvedValue({
    id: VIEWER_ID,
    email: "offline@example.com",
    display_name: "Off Line",
    avatar_url: null,
    created_at: new Date().toISOString(),
  }),
}));

vi.mock("@/lib/plannerRouteStore", () => ({
  isInRoute: () => false,
  addRouteTrail: vi.fn(),
  removeRouteTrail: vi.fn(),
  subscribeRouteTrails: () => () => {},
  getRouteTrails: () => [],
  PLANNER_MAX_TRAILS: 20,
}));

const { saveTrailOffline, clearAllOffline } = await import("@/lib/offlineStore");

function fakeTrail() {
  return {
    id: TRAIL_ID,
    user_id: null,
    owner_user_id: "user_owner",
    name: "Offline Test Trail",
    type: "singletrack",
    difficulty: 5,
    distance_km: 8.3,
    terrain: "dirt",
    legal_status: "BOAT",
    gpx_data: null,
    is_public: true,
    created_at: new Date().toISOString(),
    source: "user",
    verification_status: "verified",
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await clearAllOffline();
  gpxCacheMap.clear();
  populateSpy.mockClear();
  fetchGpxSpy.mockClear();

  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const u = new URL(url, "http://test.local");
      const path = u.pathname;

      if (path === "/api/admin/whoami") {
        return new Response(JSON.stringify({ isAdmin: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/api/trails/activity-counts") {
        return new Response(
          JSON.stringify({
            counts: {
              [TRAIL_ID]: { notes: 0, photos: 0, pending: 0 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (path.includes("/permissions")) {
        return new Response(
          JSON.stringify({ isOwner: false, isModerator: false, canModerate: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Network error: offline simulation for ${path}`);
    });
});

afterEach(() => {
  fetchSpy.mockRestore();
  cleanup();
});

describe("TrailDetailSheet — offline trail opening", () => {
  it("renders trail name and metadata from the trail prop even when network fails", async () => {
    const TrailDetailSheet = (await import("@/components/TrailDetailSheet")).default;

    render(<TrailDetailSheet trail={fakeTrail() as never} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId("trail-detail-name")).toHaveTextContent("Offline Test Trail"),
    );

    await waitFor(() =>
      expect(screen.getByTestId("trail-detail-counts")).toBeInTheDocument(),
    );
  });

  it("hydrates GPX from offline IndexedDB when trail.gpx_data is null and network fails", async () => {
    await saveTrailOffline({
      id: TRAIL_ID,
      trail: fakeTrail() as any,
      gpxData: SAMPLE_GPX,
      photos: [],
      downloadedAt: new Date().toISOString(),
      tileCount: 10,
      estimatedSizeBytes: 5000,
      tileUrls: [],
    });

    fetchGpxSpy.mockRejectedValue(new Error("Network error"));

    const TrailDetailSheet = (await import("@/components/TrailDetailSheet")).default;

    render(<TrailDetailSheet trail={fakeTrail() as never} onClose={() => {}} />);

    await waitFor(() => {
      expect(populateSpy).toHaveBeenCalledWith(
        TRAIL_ID,
        expect.stringContaining("<gpx"),
      );
    }, { timeout: 3000 });

    expect(fetchGpxSpy).not.toHaveBeenCalled();
  });

  it("shows offline badge when trail is stored in IndexedDB", async () => {
    await saveTrailOffline({
      id: TRAIL_ID,
      trail: fakeTrail() as any,
      gpxData: SAMPLE_GPX,
      photos: [],
      downloadedAt: new Date().toISOString(),
      tileCount: 10,
      estimatedSizeBytes: 5000,
      tileUrls: [],
    });

    const TrailDetailSheet = (await import("@/components/TrailDetailSheet")).default;

    render(<TrailDetailSheet trail={fakeTrail() as never} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("trail-detail-offline-badge")).toBeInTheDocument();
    }, { timeout: 3000 });

    expect(screen.getByTestId("trail-detail-offline-badge")).toHaveTextContent(/offline/i);
  });

  it("does NOT show offline badge when trail is not in IndexedDB", async () => {
    const TrailDetailSheet = (await import("@/components/TrailDetailSheet")).default;

    render(<TrailDetailSheet trail={fakeTrail() as never} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId("trail-detail-name")).toHaveTextContent("Offline Test Trail"),
    );

    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByTestId("trail-detail-offline-badge")).not.toBeInTheDocument();
  });
});
