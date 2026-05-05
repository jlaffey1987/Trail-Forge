import { test, expect, type Page, type Route } from "@playwright/test";
import { signInAsE2EUser, supabaseAdmin } from "./helpers";
import { loadE2EState } from "./global-setup";

// Two synthetic public trails crafted so that:
//   1. Their bbox-derived centres land in the SAME 2°-wide cell at the
//      planner map's initial zoom (6) — clusterCellSize(6) === 2 — which
//      means clusterTrails groups them into one multi-trail cluster.
//   2. Their `path_geojson` stretches across the whole UK so the planner's
//      initial fitBounds (maxZoom: 13) caps out well below
//      CLUSTER_ZOOM_THRESHOLD (10) and the cluster marker actually renders
//      instead of being replaced by polylines.
//   3. They have unique, deterministic ids prefixed `e2e-cluster-` so the
//      mock can match the search-trails response shape exactly without
//      colliding with anything seeded in the dev DB.
const TRAIL_A_ID = "e2e-cluster-trail-aaaaaaaaaaaa";
const TRAIL_B_ID = "e2e-cluster-trail-bbbbbbbbbbbb";

interface MockTrail {
  id: string;
  user_id: null;
  owner_user_id: null;
  name: string;
  type: string;
  difficulty: number;
  distance_km: number;
  terrain: string;
  legal_status: string;
  gpx_data: null;
  is_public: true;
  created_at: string;
  bbox_min_lat: number;
  bbox_max_lat: number;
  bbox_min_lng: number;
  bbox_max_lng: number;
  description: null;
  deleted_at: null;
  source: "user";
  source_url: null;
  verification_status: "verified";
  simplified_path: null;
  path_geojson: { type: "LineString"; coordinates: [number, number][] };
  path_point_count: number;
  elevation_profile: null;
  elevation_gain_m: null;
  elevation_loss_m: null;
}

function mockTrail(
  id: string,
  name: string,
  difficulty: number,
  distance_km: number,
  // GeoJSON LineString: [lng, lat] pairs.
  coords: [number, number][],
): MockTrail {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lng, lat] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return {
    id,
    user_id: null,
    owner_user_id: null,
    name,
    type: "green-lane",
    difficulty,
    distance_km,
    terrain: "dirt",
    legal_status: "BOAT",
    gpx_data: null,
    is_public: true,
    created_at: "2026-01-01T00:00:00.000Z",
    bbox_min_lat: minLat,
    bbox_max_lat: maxLat,
    bbox_min_lng: minLng,
    bbox_max_lng: maxLng,
    description: null,
    deleted_at: null,
    source: "user",
    source_url: null,
    verification_status: "verified",
    simplified_path: null,
    path_geojson: { type: "LineString", coordinates: coords },
    path_point_count: coords.length,
    elevation_profile: null,
    elevation_gain_m: null,
    elevation_loss_m: null,
  };
}

// Centres land at (54, -3) and (54.5, -3.5) — both in cell 27:-2 at zoom 6.
const TRAIL_A = mockTrail(
  TRAIL_A_ID,
  "[e2e] Cluster Trail Alpha",
  3,
  4.2,
  [
    [-7.5, 50.0],
    [1.5, 58.0],
  ],
);
const TRAIL_B = mockTrail(
  TRAIL_B_ID,
  "[e2e] Cluster Trail Beta",
  6,
  9.7,
  [
    [-8.0, 50.5],
    [1.0, 58.5],
  ],
);

const SUPABASE_HOST_PATTERN = /\/rest\/v1\/trails(\?|$)/;
const PLANNER_SEARCH_SIGNATURE = "is_public=eq.true";

async function installSupabaseMock(page: Page): Promise<void> {
  await page.route(SUPABASE_HOST_PATTERN, async (route: Route) => {
    const req = route.request();
    const method = req.method();

    // Supabase JS uses non-simple headers (apikey, authorization), which
    // triggers a CORS preflight before the GET. Reply 204 + permissive
    // headers so the browser sends the actual request.
    if (method === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers":
            "authorization,apikey,content-type,prefer,x-client-info,range,accept",
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "access-control-max-age": "3600",
        },
      });
      return;
    }

    const url = req.url();
    // The planner's `searchTrails` is the only public-trails select that
    // matches BOTH `is_public=eq.true` AND an `order=difficulty` clause.
    // Any other trails query (e.g. trail-detail by id, bbox map fetch)
    // gets passed through to real Supabase so we don't accidentally break
    // unrelated rendering on the page.
    if (
      method === "GET" &&
      url.includes(PLANNER_SEARCH_SIGNATURE) &&
      url.includes("order=difficulty")
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "content-range",
          "content-range": "0-1/2",
        },
        body: JSON.stringify([TRAIL_A, TRAIL_B]),
      });
      return;
    }

    await route.continue();
  });
}

async function cleanupPlannerRoute(userId: string): Promise<void> {
  // The "+ Route" toggle in the cluster sheet writes through the planner
  // route store, which cloud-syncs to /api/me/planner-route. Wipe the row
  // so successive runs start from an empty route.
  const supa = supabaseAdmin();
  await supa.from("planner_routes").delete().eq("user_id", userId);
}

async function clickClusterMarker(page: Page): Promise<void> {
  // The cluster marker is a Leaflet divIcon with className
  // "trail-cluster-marker". When two trails share a cell at zoom <
  // CLUSTER_ZOOM_THRESHOLD a single marker shows the count "2".
  const cluster = page.locator(".trail-cluster-marker").first();
  await expect(cluster).toBeVisible({ timeout: 15_000 });
  // The marker's clickable target is the inner div carrying the count
  // glyph — clicking the wrapper works in Leaflet but the inner div is
  // the most stable, painted element.
  await cluster.locator("div").first().click();
}

test.describe("planner cluster sheet @e2e", () => {
  test.beforeEach(async () => {
    const { userId } = loadE2EState();
    await cleanupPlannerRoute(userId);
  });

  test.afterEach(async () => {
    const { userId } = loadE2EState();
    await cleanupPlannerRoute(userId);
  });

  test("opens the multi-trail cluster sheet, toggles a row into the route, and exercises Zoom-to-area + close", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    await installSupabaseMock(page);
    await signInAsE2EUser(page);

    await page.goto("/planner");
    await expect(page.getByTestId("planner-hero")).toBeVisible({
      timeout: 30_000,
    });

    // Run the search with no filters / addresses — the mock returns our
    // two cluster trails regardless. The map mounts once results arrive
    // and fits to both trails' (UK-wide) bboxes, settling at a zoom
    // below CLUSTER_ZOOM_THRESHOLD so a cluster marker is rendered.
    await page.getByRole("button", { name: /Find Trails/i }).click();

    // The bottom results list confirms both trails came back.
    await expect(
      page.getByTestId(`planner-card-open-${TRAIL_A_ID}`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId(`planner-card-open-${TRAIL_B_ID}`),
    ).toBeVisible();

    // ---- Phase 1: cluster opens the sheet, close button dismisses it. ----
    await clickClusterMarker(page);

    const sheet = page.getByTestId("cluster-trail-list-sheet");
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("cluster-trail-list-count")).toHaveText(
      /^2 trails$/,
    );
    await expect(
      sheet.getByTestId(`cluster-trail-row-${TRAIL_A_ID}`),
    ).toBeVisible();
    await expect(
      sheet.getByTestId(`cluster-trail-row-${TRAIL_B_ID}`),
    ).toBeVisible();

    // The "×" close button is the bare dismiss path — it should hide the
    // sheet without mutating the route or the map.
    await page.getByTestId("cluster-trail-list-close").click();
    await expect(sheet).toHaveCount(0);

    // Route counter still absent (no toggle has happened yet).
    await expect(page.getByText(/in route$/)).toHaveCount(0);

    // ---- Phase 2: re-open, toggle a row, assert PlannerTab updates. ----
    await clickClusterMarker(page);
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("cluster-trail-list-count")).toHaveText(
      /^2 trails$/,
    );

    const toggleA = sheet.getByTestId(
      `cluster-trail-route-toggle-${TRAIL_A_ID}`,
    );
    await expect(toggleA).toHaveText(/^\+\s*Route$/);
    await toggleA.click();
    // The controlled sheet reflects the planner's selectedIds Set, so the
    // row's pill flips to "✓ In route" without any reload.
    await expect(toggleA).toHaveText(/In route/);
    await expect(toggleA).toHaveAttribute("aria-pressed", "true");

    // The PlannerTab's results header surfaces a "{n} in route" badge
    // sourced from the same routeTrails state the cluster toggle drives,
    // so this is the cross-component proof the toggle propagated.
    await expect(page.getByText(/^1 in route$/)).toBeVisible({
      timeout: 5_000,
    });

    // ---- Phase 3: "Zoom to area" closes the sheet AND zooms the map. ----
    // PlannerMap.onZoomToArea calls setActiveCluster(null) before
    // fitBounds, so the sheet must vanish.
    await page.getByTestId("cluster-zoom-to-area").click();
    await expect(sheet).toHaveCount(0);

    // After the zoom-in the map is past CLUSTER_ZOOM_THRESHOLD, so the
    // cluster marker is replaced by individual trail polylines. We
    // assert by waiting for the cluster marker layer to disappear.
    await expect(page.locator(".trail-cluster-marker")).toHaveCount(0, {
      timeout: 10_000,
    });

    // Sanity: the route assignment we made before zooming survives, so
    // the planner header still shows the in-route counter.
    await expect(page.getByText(/^1 in route$/)).toBeVisible();
  });
});
