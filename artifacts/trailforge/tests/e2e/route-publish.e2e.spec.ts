/**
 * Round-4 happy-path browser flow for the saved/published-routes feature.
 *
 * Covers:
 *   - publishing a public route (seeded via the API client through the
 *     real `POST /api/me/saved-routes` contract — what the planner's
 *     "Save route" button does under the hood)
 *   - viewing the route on the Discover routes feed (region badge,
 *     opens detail sheet)
 *   - liking the route (count increments + toggle styling)
 *   - posting a top-level comment (renders in thread)
 *   - "Follow this route" navigates to the planner with the route loaded
 *
 * The test reuses the shared e2e Clerk user + the seeded e2e trail from
 * `global-setup.ts`. Cleanup wipes the seeded saved_route + its likes/
 * comments so reruns are idempotent.
 */
import { test, expect } from "@playwright/test";
import { signInAsE2EUser, supabaseAdmin } from "./helpers";
import { loadE2EState } from "./global-setup";

const ROUTE_NAME_PREFIX = "[e2e] route-publish flow";

async function cleanupRoutes(userId: string): Promise<void> {
  const supa = supabaseAdmin();
  // Find any prior runs' rows by name prefix so we don't leak between
  // test invocations or pollute the discover feed.
  const { data: existing } = await supa
    .from("saved_routes")
    .select("id")
    .eq("user_id", userId)
    .like("name", `${ROUTE_NAME_PREFIX}%`);
  const ids = (existing ?? []).map((r) => (r as { id: string }).id);
  if (ids.length > 0) {
    await supa.from("route_comments").delete().in("route_id", ids);
    await supa.from("route_likes").delete().in("route_id", ids);
    await supa.from("route_trails").delete().in("route_id", ids);
    await supa.from("saved_routes").delete().in("id", ids);
  }
}

test.describe("route publish + engage flow @e2e", () => {
  test.beforeEach(async () => {
    const { userId } = loadE2EState();
    await cleanupRoutes(userId);
  });

  test.afterEach(async () => {
    const { userId } = loadE2EState();
    await cleanupRoutes(userId);
  });

  test("publishes a public route, then likes/comments/follows it from Discover", async ({
    page,
  }) => {
    const { trailId, userId } = loadE2EState();
    const routeName = `${ROUTE_NAME_PREFIX} · ${Date.now()}`;

    await signInAsE2EUser(page);

    // ---- Publish a public route via the real server contract ----
    // Mirrors what the planner's "Save route" button posts: trail_ids,
    // ride_type, region, isPublic. Using the in-page fetch carries the
    // Clerk session token automatically.
    const postResult = await page.evaluate(
      async ({ name, tId }) => {
        const res = await fetch("/api/me/saved-routes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            description: "Round-4 e2e — publish + like + comment + follow",
            trailIds: [tId],
            rideType: "adventure",
            region: "Peak District",
            isPublic: true,
          }),
        });
        const body = (await res.json().catch(() => null)) as
          | { id?: string; error?: string }
          | null;
        return { status: res.status, body };
      },
      { name: routeName, tId: trailId },
    );
    expect(postResult.status, JSON.stringify(postResult)).toBe(200);
    const routeId = postResult.body?.id;
    expect(routeId, JSON.stringify(postResult)).toBeTruthy();
    if (!routeId) return;

    // Belt-and-braces sanity: the row landed under the e2e user.
    const supa = supabaseAdmin();
    const { data: row } = await supa
      .from("saved_routes")
      .select("id, user_id, is_public, region")
      .eq("id", routeId)
      .single();
    expect((row as { user_id: string }).user_id).toBe(userId);
    expect((row as { is_public: boolean }).is_public).toBe(true);
    expect((row as { region: string | null }).region).toBe("Peak District");

    // ---- Discover: route card surfaces, region badge renders ----
    await page.goto("/discover");
    const card = page.getByTestId(`discover-route-${routeId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.scrollIntoViewIfNeeded();
    await expect(
      page.getByTestId(`discover-route-region-${routeId}`),
    ).toHaveText(/Peak District/);

    // ---- Open detail sheet ----
    await card.click();
    const sheet = page.getByTestId("route-detail-sheet");
    await expect(sheet).toBeVisible();
    await expect(
      page.getByTestId("route-detail-trail-list").locator("li"),
    ).toHaveCount(1);

    // ---- Like ----
    const likeBtn = page.getByTestId("route-detail-like");
    // Starts at 0, then 1 after click. We assert against the button's
    // text (the SVG isn't part of textContent).
    await expect(likeBtn).toContainText("0");
    await likeBtn.click();
    await expect(likeBtn).toContainText("1", { timeout: 10_000 });

    // ---- Comment ----
    const commentBody = `e2e comment · ${Date.now()}`;
    await page.getByTestId("route-detail-comment-input").fill(commentBody);
    await page.getByTestId("route-detail-comment-submit").click();
    await expect(
      page.getByTestId("route-detail-comments").getByText(commentBody),
    ).toBeVisible({ timeout: 10_000 });

    // ---- Follow this route → /planner ----
    await page.getByTestId("route-detail-follow").click();
    await page.waitForURL(/\/planner(\?|$)/, { timeout: 10_000 });
    await expect(page.getByTestId("planner-hero")).toBeVisible({
      timeout: 15_000,
    });

    // Final invariant: the server reflects the like + comment we made.
    const { data: finalRow } = await supa
      .from("saved_routes")
      .select("likes_count, comments_count")
      .eq("id", routeId)
      .single();
    expect((finalRow as { likes_count: number }).likes_count).toBe(1);
    expect((finalRow as { comments_count: number }).comments_count).toBe(1);
  });
});
