/**
 * plannerRouteStore — hydrate-on-sign-in precedence.
 *
 * The store has three branches when Clerk hands us a freshly-known user
 * id (`setPlannerRouteUserId(userId)`):
 *
 *   1. Empty local + non-empty server         → adopt server (cross-device).
 *   2. Non-empty local + empty server         → claim local for the user
 *                                                and push it via PUT.
 *   3. Local already claimed by this user     → re-fetch and adopt server
 *                                                (server is the source of
 *                                                truth across devices).
 *   4. Anonymous local + non-empty server     → server still wins; the
 *                                                anonymous trails the user
 *                                                had open are dropped.
 *
 * These tests pin each branch by stubbing `fetch` and watching what the
 * store does to its in-memory state and the outgoing PUT body.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
  },
}));

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
  } as unknown as Response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

import {
  addRouteTrail,
  getRouteTrails,
  setRouteEntries,
  setPlannerRouteUserId,
  resetPlannerRouteCloudState,
} from "@/lib/plannerRouteStore";
import type { Trail } from "@/lib/supabase";

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

interface CloudRoute {
  trailIds: string[];
  trails: Trail[];
  waypoints?: unknown[];
  entryOrder?: { kind: "trail" | "waypoint"; id: string }[];
  updatedAt?: string | null;
}

/**
 * Wire `fetch` to return the given cloud route on GET and a noop OK on
 * PUT, mirroring the real `/api/me/planner-route` contract.
 */
function respondWithCloudRoute(route: CloudRoute) {
  fetchMock.mockImplementation(
    async (_url: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return {
          ok: true,
          json: async () => ({
            waypoints: [],
            entryOrder: [],
            updatedAt: null,
            ...route,
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ updatedAt: null, persisted: true }),
      } as unknown as Response;
    },
  );
}

function putCalls(): RequestInit[] {
  return fetchMock.mock.calls
    .map((c) => c[1] as RequestInit | undefined)
    .filter((init): init is RequestInit => init?.method === "PUT");
}

describe("plannerRouteStore — hydrate on sign-in", () => {
  beforeEach(() => {
    // Settle as anonymous, clear in-memory + persisted state. The store
    // is a module-level singleton across tests so we have to reset the
    // auth flag, the in-memory route, and localStorage explicitly.
    resetPlannerRouteCloudState();
    setPlannerRouteUserId(null);
    setRouteEntries([]);
    localStorage.clear();
  });

  it("adopts the server route when local is empty (cross-device hydrate)", async () => {
    const remoteTrail = makeTrail("server-trail", "From server");
    respondWithCloudRoute({
      trailIds: ["server-trail"],
      trails: [remoteTrail],
      entryOrder: [{ kind: "trail", id: "server-trail" }],
    });

    setPlannerRouteUserId("user_remote_device");

    await vi.waitFor(() => {
      expect(getRouteTrails()).toHaveLength(1);
    });
    expect(getRouteTrails()[0].id).toBe("server-trail");

    // No PUT — server already had a route, nothing to push back.
    expect(putCalls()).toHaveLength(0);
  });

  it("claims the local route and pushes it when the server is empty", async () => {
    addRouteTrail(makeTrail("local-only", "Local Only"));
    expect(getRouteTrails().map((t) => t.id)).toEqual(["local-only"]);

    respondWithCloudRoute({ trailIds: [], trails: [] });

    setPlannerRouteUserId("user_first_login");

    // The push is debounced by ~600ms inside the store, so allow real
    // time to pass. The PUT body should mirror the local-only route.
    await vi.waitFor(
      () => {
        expect(putCalls().length).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );

    expect(getRouteTrails().map((t) => t.id)).toEqual(["local-only"]);
    const lastPut = putCalls().at(-1)!;
    const body = JSON.parse(lastPut.body as string) as {
      trailIds: string[];
    };
    expect(body.trailIds).toEqual(["local-only"]);
  });

  it("server wins over the same user's stale local route on re-entry", async () => {
    // Phase 1: sign in once with an empty server so the store claims the
    // user. Then build a local route, simulating a Phase-1 device.
    respondWithCloudRoute({ trailIds: [], trails: [] });
    setPlannerRouteUserId("user_repeat");

    // Wait for the initial GET to land so `localOwnerId` is set to the
    // signed-in user before we proceed.
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    // Yield once more so the IIFE that processes the GET response runs.
    await new Promise((r) => setTimeout(r, 0));

    addRouteTrail(makeTrail("stale-local", "Stale local"));
    expect(getRouteTrails().map((t) => t.id)).toEqual(["stale-local"]);

    // Phase 2: another device PUT a different route in the meantime.
    // Tear down auth state to simulate a fresh sign-in flow on this
    // device, then return the new server route on the next GET.
    resetPlannerRouteCloudState();
    const remoteTrail = makeTrail("fresh-server", "From newer device");
    respondWithCloudRoute({
      trailIds: ["fresh-server"],
      trails: [remoteTrail],
      entryOrder: [{ kind: "trail", id: "fresh-server" }],
    });

    setPlannerRouteUserId("user_repeat");

    // Server wins — `wasAlreadyClaimedByThisUser` was true, so the
    // hydrate path adopts the remote route unconditionally.
    await vi.waitFor(() => {
      expect(getRouteTrails().map((t) => t.id)).toEqual(["fresh-server"]);
    });
  });

  it("server wins over an anonymous local route on first sign-in", async () => {
    // User was tinkering with a route while signed out. They sign in
    // and the server already has a route (built earlier on a different
    // device). The Phase-A contract is "server wins if non-empty",
    // even if it means the anonymous trails on this device are dropped.
    addRouteTrail(makeTrail("anon-local", "Anonymous"));
    expect(getRouteTrails().map((t) => t.id)).toEqual(["anon-local"]);

    const remoteTrail = makeTrail("server-route", "Server");
    respondWithCloudRoute({
      trailIds: ["server-route"],
      trails: [remoteTrail],
      entryOrder: [{ kind: "trail", id: "server-route" }],
    });

    setPlannerRouteUserId("user_new_signin");

    await vi.waitFor(() => {
      expect(getRouteTrails().map((t) => t.id)).toEqual(["server-route"]);
    });
  });
});
