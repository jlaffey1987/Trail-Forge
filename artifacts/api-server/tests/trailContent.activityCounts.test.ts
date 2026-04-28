import { describe, it, beforeEach, expect } from "vitest";
import request from "supertest";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const TRAIL_A = "77777777-7777-4777-8777-777777777777";
const TRAIL_B = "88888888-8888-4888-8888-888888888888";
const TRAIL_C = "99999999-9999-4999-8999-999999999999";

describe("GET /api/trails/activity-counts", () => {
  beforeEach(() => {
    resetMockSupa();
  });

  it("returns an empty map when no ids are provided", async () => {
    const res = await request(makeApp()).get(`/api/trails/activity-counts?ids=`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ counts: {} });
  });

  it("filters out non-uuid ids and returns counts for valid ids", async () => {
    const supa = getMockSupa();
    supa.seed("trail_notes", [
      { id: "n1", trail_id: TRAIL_A, hidden_at: null },
      { id: "n2", trail_id: TRAIL_A, hidden_at: null },
      { id: "n3", trail_id: TRAIL_B, hidden_at: null },
      { id: "n4", trail_id: TRAIL_A, hidden_at: "2026-01-01T00:00:00Z" }, // hidden — excluded
    ]);
    supa.seed("trail_photos", [
      { id: "p1", trail_id: TRAIL_A, hidden_at: null },
      { id: "p2", trail_id: TRAIL_C, hidden_at: null },
    ]);
    supa.seed("trail_amendments", [
      { id: "a1", trail_id: TRAIL_B, status: "pending" },
      { id: "a2", trail_id: TRAIL_B, status: "approved" }, // not pending — excluded
      { id: "a3", trail_id: TRAIL_C, status: "pending" },
    ]);

    const res = await request(makeApp()).get(
      `/api/trails/activity-counts?ids=${TRAIL_A},${TRAIL_B},${TRAIL_C},garbage,not-a-uuid`,
    );
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      [TRAIL_A]: { notes: 2, photos: 1, pending: 0 },
      [TRAIL_B]: { notes: 1, photos: 0, pending: 1 },
      [TRAIL_C]: { notes: 0, photos: 1, pending: 1 },
    });
  });

  it("rejects (400) when more than 200 ids are sent", async () => {
    const ids = Array.from(
      { length: 201 },
      (_, i) =>
        // crank out 201 unique uuid-shaped strings.
        `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    ).join(",");
    const res = await request(makeApp()).get(`/api/trails/activity-counts?ids=${ids}`);
    expect(res.status).toBe(400);
  });

  it("tolerates a missing table by returning 0 for that count category", async () => {
    const supa = getMockSupa();
    // Notes table missing entirely; photos has data; amendments empty.
    supa.missingTables.add("trail_notes");
    supa.seed("trail_photos", [{ id: "p1", trail_id: TRAIL_A, hidden_at: null }]);

    const res = await request(makeApp()).get(`/api/trails/activity-counts?ids=${TRAIL_A}`);
    expect(res.status).toBe(200);
    expect(res.body.counts[TRAIL_A]).toEqual({ notes: 0, photos: 1, pending: 0 });
  });
});
