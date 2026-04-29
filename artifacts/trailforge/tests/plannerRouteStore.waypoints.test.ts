import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Avoid the live Supabase client being constructed; the store imports
// `Trail` and the supabase singleton from this module.
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}));

// The store calls `fetch("/api/me/...")` to push cloud syncs. We don't
// want any real HTTP traffic in the test runner.
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
  } as unknown as Response);
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

import {
  addRouteTrail,
  addRouteWaypoint,
  removeRouteWaypoint,
  isWaypointInRoute,
  getRouteEntries,
  setRouteEntries,
  setPlannerRouteUserId,
} from "@/lib/plannerRouteStore";
import type { Trail } from "@/lib/supabase";
import type { RouteWaypoint } from "@/lib/routing";

function makeTrail(id: string, name: string): Trail {
  return {
    id,
    user_id: null,
    name,
    type: "singletrack",
    difficulty: 3,
    distance_km: 5,
    terrain: "dirt",
    legal_status: "BOAT",
    is_public: true,
    created_at: "2026-04-01T00:00:00Z",
  } as unknown as Trail;
}

function makeWp(id: string, name: string, kind: RouteWaypoint["kind"] = "fuel"): RouteWaypoint {
  return { id, name, kind, lat: 53.6, lng: -2.5 };
}

describe("plannerRouteStore — waypoint operations", () => {
  beforeEach(() => {
    // Reset both persisted AND in-memory state. The store is a module-
    // level singleton — hydration only runs at import, so we have to
    // clear the live arrays explicitly between tests.
    setPlannerRouteUserId(null);
    localStorage.clear();
    setRouteEntries([]);
  });

  it("addRouteWaypoint appends a waypoint entry to the ordered list", () => {
    const trail = makeTrail("t1", "Trail One");
    const wp = makeWp("wp-fuel-1", "Shell Garage");

    addRouteTrail(trail);
    addRouteWaypoint(wp);

    const entries = getRouteEntries();
    expect(entries.map((e) => e.kind)).toEqual(["trail", "waypoint"]);
    expect(entries[1].kind === "waypoint" && entries[1].waypoint.id).toBe("wp-fuel-1");
    expect(isWaypointInRoute("wp-fuel-1")).toBe(true);
  });

  it("addRouteWaypoint with afterTrailId inserts the waypoint after the matching trail", () => {
    const t1 = makeTrail("t1", "Trail One");
    const t2 = makeTrail("t2", "Trail Two");
    addRouteTrail(t1);
    addRouteTrail(t2);

    addRouteWaypoint(makeWp("wp-mid", "Mid stop"), { afterTrailId: "t1" });

    const entries = getRouteEntries();
    const seq = entries.map((e) =>
      e.kind === "trail" ? `T:${e.trail.id}` : `W:${e.waypoint.id}`,
    );
    expect(seq).toEqual(["T:t1", "W:wp-mid", "T:t2"]);
  });

  it("addRouteWaypoint is a no-op when the same waypoint id is added twice", () => {
    const wp = makeWp("wp-dup", "Dupe");
    addRouteWaypoint(wp);
    addRouteWaypoint(wp);

    const wpEntries = getRouteEntries().filter((e) => e.kind === "waypoint");
    expect(wpEntries).toHaveLength(1);
  });

  it("removeRouteWaypoint drops the entry from the ordered list", () => {
    const t1 = makeTrail("t1", "Trail One");
    addRouteTrail(t1);
    addRouteWaypoint(makeWp("wp-x", "X"));

    expect(isWaypointInRoute("wp-x")).toBe(true);
    removeRouteWaypoint("wp-x");
    expect(isWaypointInRoute("wp-x")).toBe(false);

    const entries = getRouteEntries();
    expect(entries.map((e) => e.kind)).toEqual(["trail"]);
  });
});
