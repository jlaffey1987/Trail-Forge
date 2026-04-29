import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";

/**
 * Verifies that the RouteBuilder lazy-fetches `gpx_data` for trails that came
 * from the slim Map-tab response (no GPX) before unlocking the Download
 * Combined GPX button.
 */

const hoisted = vi.hoisted(() => ({
  fetchTrailGpxByIds: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {},
  fetchTrailGpxByIds: hoisted.fetchTrailGpxByIds,
}));

const SAMPLE_GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="trailforge-test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="53.6100" lon="-2.5500"><ele>180</ele></trkpt>
    <trkpt lat="53.6105" lon="-2.5495"><ele>182</ele></trkpt>
    <trkpt lat="53.6112" lon="-2.5488"><ele>185</ele></trkpt>
  </trkseg></trk>
</gpx>`;

const TRAIL_ID = "11111111-1111-4111-8111-111111111111";

function makeSlimTrail() {
  return {
    id: TRAIL_ID,
    user_id: null,
    name: "Slim Map Trail",
    type: "singletrack",
    difficulty: 4,
    distance_km: 5.4,
    terrain: "dirt",
    legal_status: "BOAT",
    is_public: true,
    created_at: "2026-04-01T00:00:00Z",
    // Note: gpx_data intentionally omitted — this trail came from the slim
    // bbox fetch and needs lazy hydration before GPX export will work.
  };
}

beforeEach(() => {
  hoisted.fetchTrailGpxByIds.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("RouteBuilder — lazy GPX hydration", () => {
  it("calls fetchTrailGpxByIds for trails missing gpx_data and unlocks the Download Combined GPX button once they arrive", async () => {
    // Resolve hydration only when we say so, so we can observe the
    // intermediate "Loading trail data..." state.
    let resolveHydration: (m: Map<string, unknown>) => void = () => {};
    hoisted.fetchTrailGpxByIds.mockImplementation(
      () => new Promise<Map<string, unknown>>((resolve) => {
        resolveHydration = resolve;
      }),
    );

    const RouteBuilder = (await import("@/components/RouteBuilder")).default;
    const trail = makeSlimTrail();

    render(
      <RouteBuilder
        selectedTrails={[trail as never]}
        onReorder={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
      />,
    );

    // The hydration call fired with exactly the missing trail id.
    await waitFor(() =>
      expect(hoisted.fetchTrailGpxByIds).toHaveBeenCalledWith([TRAIL_ID]),
    );

    // While hydration is pending, the Download button is disabled and shows
    // the loading label.
    const downloadBtn = screen.getByRole("button", {
      name: /loading trail data/i,
    });
    expect(downloadBtn).toBeDisabled();

    // Resolve the hydration with the full GPX XML.
    resolveHydration(new Map([[TRAIL_ID, SAMPLE_GPX]]));

    // After hydration, parseGPX yields >0 waypoints, gpxReady flips true,
    // and the button label and disabled state both update.
    await waitFor(() => {
      const btn = screen.getByRole("button", {
        name: /download combined gpx/i,
      });
      expect(btn).not.toBeDisabled();
    });

    // The "GPX data unavailable" warning must NOT be shown — the trail was
    // successfully hydrated.
    expect(
      screen.queryByText(/gpx data unavailable for some trails/i),
    ).not.toBeInTheDocument();
  });

  it("does not call fetchTrailGpxByIds when every trail already has gpx_data", async () => {
    hoisted.fetchTrailGpxByIds.mockResolvedValue(new Map());

    const RouteBuilder = (await import("@/components/RouteBuilder")).default;
    const trail = { ...makeSlimTrail(), gpx_data: SAMPLE_GPX };

    render(
      <RouteBuilder
        selectedTrails={[trail as never]}
        onReorder={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
      />,
    );

    // Already hydrated — button enabled immediately, no fetch needed.
    await waitFor(() => {
      const btn = screen.getByRole("button", {
        name: /download combined gpx/i,
      });
      expect(btn).not.toBeDisabled();
    });
    expect(hoisted.fetchTrailGpxByIds).not.toHaveBeenCalled();
  });
});
