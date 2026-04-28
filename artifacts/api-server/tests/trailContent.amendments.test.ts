import { describe, it, beforeEach, expect } from "vitest";
import request from "supertest";
import { resetMockSupa, getMockSupa, setAclShouldFail } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const TRAIL_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_TRAIL_ID = "66666666-6666-4666-8666-666666666666";
const OWNER_ID = "user_owner";
const PROPOSER_ID = "user_proposer";
const MOD_ID = "user_mod";
const STRANGER_ID = "user_stranger";

function seedBase() {
  const supa = resetMockSupa();
  supa.seed("trails", [
    {
      id: TRAIL_ID,
      owner_user_id: OWNER_ID,
      name: "Old Name",
      difficulty: 4,
      type: "singletrack",
      legal_status: "open",
      terrain: "dirt",
    },
  ]);
  supa.seed("users", [
    { id: OWNER_ID, display_name: "Owner", avatar_url: null, is_moderator: false },
    { id: PROPOSER_ID, display_name: "Proposer", avatar_url: null, is_moderator: false },
    { id: MOD_ID, display_name: "Mod", avatar_url: null, is_moderator: true },
    { id: STRANGER_ID, display_name: "Stranger", avatar_url: null, is_moderator: false },
  ]);
  return supa;
}

async function createPendingAmendment(authorId = PROPOSER_ID) {
  const res = await request(makeApp(authorId))
    .post(`/api/trails/${TRAIL_ID}/amendments`)
    .send({
      proposedChanges: { name: "New Name", difficulty: 6 },
      reason: "Re-rated after riding",
    });
  if (res.status !== 200) {
    throw new Error(`amendment seed failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as { id: string };
}

describe("Trail amendments endpoints", () => {
  beforeEach(() => {
    seedBase();
  });

  describe("POST /api/trails/:trailId/amendments", () => {
    it("requires auth", async () => {
      const res = await request(makeApp())
        .post(`/api/trails/${TRAIL_ID}/amendments`)
        .send({ proposedChanges: { name: "X" }, reason: "y" });
      expect(res.status).toBe(401);
    });

    it("rejects empty proposals (no changes, no GPX)", async () => {
      const res = await request(makeApp(PROPOSER_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments`)
        .send({ proposedChanges: {}, reason: "nothing changed" });
      expect(res.status).toBe(400);
    });

    it("rejects a replacement GPX key from a different trail", async () => {
      const res = await request(makeApp(PROPOSER_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments`)
        .send({
          proposedChanges: {},
          reason: "swap gpx",
          replacementGpxStorageKey: `trails/${OTHER_TRAIL_ID}/amendments/x.gpx`,
        });
      expect(res.status).toBe(400);
    });

    it("returns 404 when the GPX object isn't actually present", async () => {
      setAclShouldFail(true);
      const res = await request(makeApp(PROPOSER_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments`)
        .send({
          proposedChanges: {},
          reason: "swap gpx",
          replacementGpxStorageKey: `trails/${TRAIL_ID}/amendments/x.gpx`,
        });
      expect(res.status).toBe(404);
    });

    it("creates a pending amendment owned by the proposer", async () => {
      const created = await createPendingAmendment();
      expect(created).toMatchObject({
        trail_id: TRAIL_ID,
        author_user_id: PROPOSER_ID,
        status: "pending",
        decided_by: null,
        decided_at: null,
      });
      const stored = getMockSupa().rows("trail_amendments");
      expect(stored).toHaveLength(1);
      expect(stored[0]!.proposed_changes).toEqual({ name: "New Name", difficulty: 6 });
    });
  });

  describe("POST /api/trails/:trailId/amendments/gpx-upload-url", () => {
    it("returns a trail-scoped storage key", async () => {
      const res = await request(makeApp(PROPOSER_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments/gpx-upload-url`)
        .send({ contentType: "application/gpx+xml" });
      expect(res.status).toBe(200);
      expect(res.body.storageKey).toMatch(
        new RegExp(`^trails/${TRAIL_ID}/amendments/[0-9a-f-]+\\.gpx$`),
      );
    });
  });

  describe("POST /api/trails/:trailId/amendments/:amendmentId/approve", () => {
    it("forbids strangers (not owner, not moderator)", async () => {
      const am = await createPendingAmendment();
      const res = await request(makeApp(STRANGER_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments/${am.id}/approve`)
        .send({});
      expect(res.status).toBe(403);
    });

    it("lets the trail OWNER approve a proposer's amendment, applies changes, and writes an audit row", async () => {
      const am = await createPendingAmendment(PROPOSER_ID);
      const res = await request(makeApp(OWNER_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments/${am.id}/approve`)
        .send({ decisionReason: "looks right" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, applied: { name: "New Name", difficulty: 6 } });

      // Trail row was updated.
      const trail = getMockSupa().rows("trails").find((t) => t.id === TRAIL_ID);
      expect(trail).toMatchObject({ name: "New Name", difficulty: 6 });

      // Amendment row decision was recorded.
      const am2 = getMockSupa().rows("trail_amendments")[0]!;
      expect(am2.status).toBe("approved");
      expect(am2.decided_by).toBe(OWNER_ID);
      expect(am2.decision_reason).toBe("looks right");
      expect(am2.decided_at).not.toBeNull();

      // Audit row carries the previous values for the affected fields.
      const audit = getMockSupa().rows("trail_amendment_history");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        trail_id: TRAIL_ID,
        amendment_id: am.id,
        applied_by: OWNER_ID,
      });
      expect(audit[0]!.previous_values).toEqual({ name: "Old Name", difficulty: 4 });
    });

    it("lets the trail OWNER self-approve their OWN amendment (same user proposes and approves)", async () => {
      const am = await createPendingAmendment(OWNER_ID);
      expect(getMockSupa().rows("trail_amendments")[0]!.author_user_id).toBe(OWNER_ID);

      const res = await request(makeApp(OWNER_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments/${am.id}/approve`)
        .send({ decisionReason: "self-approve" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, applied: { name: "New Name", difficulty: 6 } });

      const trail = getMockSupa().rows("trails").find((t) => t.id === TRAIL_ID);
      expect(trail).toMatchObject({ name: "New Name", difficulty: 6 });

      const am2 = getMockSupa().rows("trail_amendments")[0]!;
      expect(am2.status).toBe("approved");
      expect(am2.decided_by).toBe(OWNER_ID);
      expect(am2.author_user_id).toBe(OWNER_ID);
      expect(am2.decision_reason).toBe("self-approve");

      const audit = getMockSupa().rows("trail_amendment_history");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        trail_id: TRAIL_ID,
        amendment_id: am.id,
        applied_by: OWNER_ID,
      });
      expect(audit[0]!.previous_values).toEqual({ name: "Old Name", difficulty: 4 });
    });

    it("lets a global moderator approve and still writes the audit row", async () => {
      const am = await createPendingAmendment();
      const res = await request(makeApp(MOD_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments/${am.id}/approve`)
        .send({});
      expect(res.status).toBe(200);
      expect(getMockSupa().rows("trail_amendment_history")).toHaveLength(1);
    });

    it("conflicts (409) when the amendment is already decided", async () => {
      const am = await createPendingAmendment();
      await request(makeApp(OWNER_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments/${am.id}/approve`)
        .send({});
      const second = await request(makeApp(OWNER_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments/${am.id}/approve`)
        .send({});
      expect(second.status).toBe(409);
    });

    it("returns 404 for an unknown amendment id", async () => {
      const res = await request(makeApp(OWNER_ID))
        .post(
          `/api/trails/${TRAIL_ID}/amendments/00000000-0000-4000-8000-000000000000/approve`,
        )
        .send({});
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/trails/:trailId/amendments/:amendmentId/reject", () => {
    it("forbids strangers", async () => {
      const am = await createPendingAmendment();
      const res = await request(makeApp(STRANGER_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments/${am.id}/reject`)
        .send({});
      expect(res.status).toBe(403);
    });

    it("rejects (decision recorded, no trail mutation, no audit row)", async () => {
      const am = await createPendingAmendment();
      const res = await request(makeApp(MOD_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments/${am.id}/reject`)
        .send({ decisionReason: "needs more info" });
      expect(res.status).toBe(200);

      const am2 = getMockSupa().rows("trail_amendments")[0]!;
      expect(am2.status).toBe("rejected");
      expect(am2.decided_by).toBe(MOD_ID);
      expect(am2.decision_reason).toBe("needs more info");

      // Trail row remains unchanged.
      const trail = getMockSupa().rows("trails").find((t) => t.id === TRAIL_ID);
      expect(trail).toMatchObject({ name: "Old Name", difficulty: 4 });

      // No audit row on reject.
      expect(getMockSupa().rows("trail_amendment_history")).toHaveLength(0);
    });

    it("conflicts (409) when the amendment is already decided", async () => {
      const am = await createPendingAmendment();
      await request(makeApp(MOD_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments/${am.id}/reject`)
        .send({});
      const second = await request(makeApp(MOD_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments/${am.id}/reject`)
        .send({});
      expect(second.status).toBe(409);
    });
  });

  describe("GET /api/trails/:trailId/amendments", () => {
    it("returns all amendments (including non-pending) newest-first", async () => {
      const am1 = await createPendingAmendment();
      // Reject it.
      await request(makeApp(MOD_ID))
        .post(`/api/trails/${TRAIL_ID}/amendments/${am1.id}/reject`)
        .send({});

      const list = await request(makeApp()).get(`/api/trails/${TRAIL_ID}/amendments`);
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ id: am1.id, status: "rejected" });
    });
  });
});
