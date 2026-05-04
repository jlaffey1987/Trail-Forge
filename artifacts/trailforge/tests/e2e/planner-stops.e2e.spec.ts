import { test, expect } from "@playwright/test";
import { signInAsE2EUser, supabaseAdmin } from "./helpers";
import { loadE2EState } from "./global-setup";

const NOMINATIM_RESULTS = [
  {
    place_id: 90001,
    lat: "53.35",
    lon: "-1.78",
    display_name: "Peak District, Derbyshire, England, United Kingdom",
    type: "administrative",
  },
];

const FUEL_NODE_ID = 999001;
const FUEL_NAME = "E2E Mock Fuel Station";
const FUEL_WP_ID = `node/${FUEL_NODE_ID}`;

const CAMPSITE_NODE_ID = 999002;
const CAMPSITE_NAME = "E2E Mock Campsite";
const CAMPSITE_WP_ID = `node/${CAMPSITE_NODE_ID}`;

function overpassBody(kind: "fuel" | "campsite"): string {
  if (kind === "fuel") {
    return JSON.stringify({
      elements: [
        {
          type: "node",
          id: FUEL_NODE_ID,
          lat: 53.35,
          lon: -1.78,
          tags: { amenity: "fuel", name: FUEL_NAME, brand: "TestBrand" },
        },
      ],
    });
  }
  return JSON.stringify({
    elements: [
      {
        type: "node",
        id: CAMPSITE_NODE_ID,
        lat: 53.35,
        lon: -1.78,
        tags: { tourism: "camp_site", name: CAMPSITE_NAME },
      },
    ],
  });
}

async function installMocks(
  page: import("@playwright/test").Page,
  poiKind: "fuel" | "campsite",
): Promise<void> {
  await page.route("**/nominatim.openstreetmap.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(NOMINATIM_RESULTS),
    }),
  );

  const body = overpassBody(poiKind);
  for (const host of [
    "**/overpass-api.de/api/interpreter**",
    "**/overpass.kumi.systems/api/interpreter**",
  ]) {
    await page.route(host, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body }),
    );
  }
}

async function cleanupPlannerRoute(userId: string): Promise<void> {
  const supa = supabaseAdmin();
  await supa.from("planner_routes").delete().eq("user_id", userId);
}

async function seedTrailIntoRoute(
  page: import("@playwright/test").Page,
  trailId: string,
): Promise<void> {
  const res = await page.evaluate(
    async ({ tId }) => {
      const r = await fetch("/api/me/planner-route", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trailIds: [tId],
          waypoints: [],
          entryOrder: [{ kind: "trail", id: tId }],
        }),
      });
      return { status: r.status, ok: r.ok };
    },
    { tId: trailId },
  );
  expect(res.ok, `Seeding trail failed (HTTP ${res.status})`).toBe(true);
}

async function waitForAuth(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { Clerk?: { user?: unknown } }).Clerk?.user,
      ),
    undefined,
    { timeout: 15_000 },
  );
}

async function typeAddressAndSelect(
  page: import("@playwright/test").Page,
): Promise<void> {
  const input = page.getByTestId("planner-start-address");
  await input.fill("Peak District");
  const dropdown = page.getByTestId("planner-start-address-suggestions");
  await expect(dropdown).toBeVisible({ timeout: 10_000 });
  await dropdown.locator("li").first().click();
  await expect(input).toHaveValue(/Peak District/);
}

async function clickPoiMarkerAndAddStop(
  page: import("@playwright/test").Page,
  kind: "fuel" | "campsite",
): Promise<void> {
  const btnTestId =
    kind === "fuel" ? "planner-poi-fuel" : "planner-poi-campsite";
  const markerColor = kind === "fuel" ? "3b82f6" : "22c55e";

  const poiBtn = page.getByTestId(btnTestId);
  await expect(poiBtn).toBeVisible({ timeout: 10_000 });
  await poiBtn.click();

  const poiMarker = page
    .locator(".leaflet-marker-icon")
    .filter({ has: page.locator(`div[style*="${markerColor}"]`) })
    .first();
  await expect(poiMarker).toBeVisible({ timeout: 15_000 });
  await poiMarker.click();

  const addBtn = page.locator("[data-trailforge-add-poi]");
  await expect(addBtn).toBeVisible({ timeout: 5_000 });
  await addBtn.click();
}

test.describe("planner fuel/campsite stops @e2e", () => {
  test.beforeEach(async () => {
    const { userId } = loadE2EState();
    await cleanupPlannerRoute(userId);
  });

  test.afterEach(async () => {
    const { userId } = loadE2EState();
    await cleanupPlannerRoute(userId);
  });

  test("adds a fuel stop via the map POI flow, verifies in Route Builder and MapRoutePanel, survives reload", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { trailId } = loadE2EState();

    await installMocks(page, "fuel");
    await signInAsE2EUser(page);

    await page.goto("/planner");
    await expect(page.getByTestId("planner-hero")).toBeVisible({
      timeout: 30_000,
    });

    await typeAddressAndSelect(page);

    await seedTrailIntoRoute(page, trailId);

    const routeLoadPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/me/planner-route") &&
        r.request().method() === "GET",
      { timeout: 15_000 },
    );
    await page.reload();
    await expect(page.getByTestId("planner-hero")).toBeVisible({
      timeout: 30_000,
    });
    await waitForAuth(page);
    await routeLoadPromise;

    await typeAddressAndSelect(page);

    const routeBar = page.getByText(/1 Trail/);
    await expect(routeBar.first()).toBeVisible({ timeout: 15_000 });

    const cloudSyncPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/me/planner-route") &&
        r.request().method() === "PUT",
      { timeout: 10_000 },
    );
    await clickPoiMarkerAndAddStop(page, "fuel");
    await cloudSyncPromise;

    const myRouteBtn = page.getByRole("button", { name: /My Route/i });
    await expect(myRouteBtn).toBeVisible({ timeout: 10_000 });
    await myRouteBtn.click();

    const rbWp = page.getByTestId(`route-builder-waypoint-${FUEL_WP_ID}`);
    await expect(rbWp).toBeVisible({ timeout: 10_000 });
    await expect(rbWp.getByText(FUEL_NAME)).toBeVisible();
    await expect(rbWp.getByText(/fuel stop/i)).toBeVisible();

    await page.goto("/map");
    await waitForAuth(page);

    const mapPanel = page.getByTestId("map-route-panel");
    await expect(mapPanel).toBeVisible({ timeout: 15_000 });

    const summary = page.getByTestId("map-route-panel-summary");
    await expect(summary).toContainText(/1 Trail/);
    await expect(summary).toContainText(/1 stop/);

    await page.getByTestId("map-route-panel-toggle").click();

    const mpWp = page.getByTestId(
      `map-route-panel-waypoint-${FUEL_WP_ID}`,
    );
    await expect(mpWp).toBeVisible({ timeout: 10_000 });
    await expect(mpWp.getByText(FUEL_NAME)).toBeVisible();
    await expect(mpWp.getByText(/fuel stop/i)).toBeVisible();

    await page.reload();
    await waitForAuth(page);

    const panelAfterReload = page.getByTestId("map-route-panel");
    await expect(panelAfterReload).toBeVisible({ timeout: 15_000 });

    const summaryAfterReload = page.getByTestId("map-route-panel-summary");
    await expect(summaryAfterReload).toContainText(/1 stop/);

    await page.getByTestId("map-route-panel-toggle").click();
    const wpAfterReload = page.getByTestId(
      `map-route-panel-waypoint-${FUEL_WP_ID}`,
    );
    await expect(wpAfterReload).toBeVisible({ timeout: 10_000 });
    await expect(wpAfterReload.getByText(FUEL_NAME)).toBeVisible();
  });

  test("campsite stop added via map POI can be removed from Route Builder", async ({
    page,
  }) => {
    const { trailId } = loadE2EState();

    await installMocks(page, "campsite");
    await signInAsE2EUser(page);

    await page.goto("/planner");
    await expect(page.getByTestId("planner-hero")).toBeVisible({
      timeout: 30_000,
    });

    await typeAddressAndSelect(page);

    await seedTrailIntoRoute(page, trailId);

    const campsiteRouteLoadPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/me/planner-route") &&
        r.request().method() === "GET",
      { timeout: 15_000 },
    );
    await page.reload();
    await expect(page.getByTestId("planner-hero")).toBeVisible({
      timeout: 30_000,
    });
    await waitForAuth(page);
    await campsiteRouteLoadPromise;

    await typeAddressAndSelect(page);

    const addSyncPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/me/planner-route") &&
        r.request().method() === "PUT",
      { timeout: 10_000 },
    );
    await clickPoiMarkerAndAddStop(page, "campsite");
    await addSyncPromise;

    const myRouteBtn = page.getByRole("button", { name: /My Route/i });
    await expect(myRouteBtn).toBeVisible({ timeout: 10_000 });
    await myRouteBtn.click();

    const wpRow = page.getByTestId(
      `route-builder-waypoint-${CAMPSITE_WP_ID}`,
    );
    await expect(wpRow).toBeVisible({ timeout: 10_000 });
    await expect(wpRow.getByText(CAMPSITE_NAME)).toBeVisible();
    await expect(wpRow.getByText(/campsite stop/i)).toBeVisible();

    const removeSyncPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/me/planner-route") &&
        r.request().method() === "PUT",
      { timeout: 10_000 },
    );

    const removeBtn = page.getByTestId(
      `route-builder-waypoint-remove-${CAMPSITE_WP_ID}`,
    );
    await removeBtn.click();

    await expect(wpRow).not.toBeVisible({ timeout: 10_000 });
    await removeSyncPromise;

    const supa = supabaseAdmin();
    const { data: route } = await supa
      .from("planner_routes")
      .select("waypoints, entry_order")
      .eq("user_id", loadE2EState().userId)
      .single();

    const wps = (route as { waypoints: unknown[] } | null)?.waypoints;
    expect(Array.isArray(wps) ? wps.length : -1).toBe(0);

    const order = (
      route as { entry_order: Array<{ kind: string }> } | null
    )?.entry_order;
    const wpEntries = order?.filter((e) => e.kind === "waypoint");
    expect(wpEntries?.length ?? -1).toBe(0);
  });
});
