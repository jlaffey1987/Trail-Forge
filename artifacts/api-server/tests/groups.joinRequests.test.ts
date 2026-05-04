import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const OWNER_ID = "user_owner";
const ADMIN_ID = "user_admin";
const JOINER_ID = "user_joiner";
const STRANGER_ID = "user_stranger";

const GROUP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_PRIVATE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function seedBase() {
  const supa = resetMockSupa();
  supa.seed("users", [
    { id: OWNER_ID, display_name: "Owner" },
    { id: ADMIN_ID, display_name: "Admin" },
    { id: JOINER_ID, display_name: "Joiner" },
    { id: STRANGER_ID, display_name: "Stranger" },
  ]);
  supa.seed("groups", [
    { id: GROUP_ID, name: "Open Group", discoverable: true },
    { id: GROUP_PRIVATE, name: "Private Group", discoverable: false },
  ]);
  supa.seed("group_members", [
    { group_id: GROUP_ID, user_id: OWNER_ID, role: "owner" },
    { group_id: GROUP_ID, user_id: ADMIN_ID, role: "admin" },
  ]);
  supa.seed("group_join_requests", []);
  supa.seed("group_activity_events", []);
  return supa;
}

describe("POST /api/groups/:groupId/join-requests — create join request", () => {
  beforeEach(() => seedBase());

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(makeApp()).post(
      `/api/groups/${GROUP_ID}/join-requests`,
    );
    expect(res.status).toBe(401);
  });

  it("creates a pending join request for a discoverable group", async () => {
    const res = await request(makeApp(JOINER_ID))
      .post(`/api/groups/${GROUP_ID}/join-requests`)
      .send({ message: "I'd like to join!" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "pending" });
    expect(res.body.id).toBeDefined();

    const rows = getMockSupa().rows("group_join_requests");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      group_id: GROUP_ID,
      user_id: JOINER_ID,
      status: "pending",
      message: "I'd like to join!",
    });
  });

  it("returns the existing pending request idempotently", async () => {
    const first = await request(makeApp(JOINER_ID))
      .post(`/api/groups/${GROUP_ID}/join-requests`)
      .send({});
    expect(first.status).toBe(200);

    const second = await request(makeApp(JOINER_ID))
      .post(`/api/groups/${GROUP_ID}/join-requests`)
      .send({});
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);

    expect(getMockSupa().rows("group_join_requests")).toHaveLength(1);
  });

  it("rejects requests to a non-discoverable group with 403", async () => {
    const res = await request(makeApp(JOINER_ID))
      .post(`/api/groups/${GROUP_PRIVATE}/join-requests`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not accepting/i);
  });

  it("rejects requests from an existing member with 409", async () => {
    const res = await request(makeApp(OWNER_ID))
      .post(`/api/groups/${GROUP_ID}/join-requests`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already a member/i);
  });

  it("returns 404 for a non-existent group", async () => {
    const res = await request(makeApp(JOINER_ID))
      .post(`/api/groups/99999999-9999-4999-8999-999999999999/join-requests`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid group id", async () => {
    const res = await request(makeApp(JOINER_ID))
      .post(`/api/groups/not-a-uuid/join-requests`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/groups/:groupId/join-requests/:requestId/approve", () => {
  let requestId: string;

  beforeEach(async () => {
    seedBase();
    const res = await request(makeApp(JOINER_ID))
      .post(`/api/groups/${GROUP_ID}/join-requests`)
      .send({ message: "Please let me in" });
    requestId = res.body.id;
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(makeApp()).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/approve`,
    );
    expect(res.status).toBe(401);
  });

  it("rejects approval by a regular member (not owner/admin) with 403", async () => {
    getMockSupa().insertSeed("group_members", {
      group_id: GROUP_ID,
      user_id: STRANGER_ID,
      role: "member",
    });
    const res = await request(makeApp(STRANGER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/approve`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only owners or admins/i);
  });

  it("rejects approval by a non-member with 403", async () => {
    const res = await request(makeApp(STRANGER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/approve`,
    );
    expect(res.status).toBe(403);
  });

  it("owner approves — joiner is added to group_members and request status becomes approved", async () => {
    const res = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/approve`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const members = getMockSupa().rows("group_members");
    const joinerMembership = members.find(
      (m) => m.user_id === JOINER_ID && m.group_id === GROUP_ID,
    );
    expect(joinerMembership).toBeDefined();
    expect(joinerMembership!.role).toBe("member");

    const requests = getMockSupa().rows("group_join_requests");
    const jr = requests.find((r) => r.id === requestId);
    expect(jr).toBeDefined();
    expect(jr!.status).toBe("approved");
    expect(jr!.decided_by_user_id).toBe(OWNER_ID);
    expect(jr!.decided_at).toBeDefined();
  });

  it("admin approves — same result as owner approval", async () => {
    const res = await request(makeApp(ADMIN_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/approve`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const members = getMockSupa().rows("group_members");
    const joinerMembership = members.find(
      (m) => m.user_id === JOINER_ID && m.group_id === GROUP_ID,
    );
    expect(joinerMembership).toBeDefined();

    const requests = getMockSupa().rows("group_join_requests");
    const jr = requests.find((r) => r.id === requestId);
    expect(jr!.status).toBe("approved");
    expect(jr!.decided_by_user_id).toBe(ADMIN_ID);
  });

  it("returns 409 when approving an already-approved request", async () => {
    await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/approve`,
    );
    const res = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/approve`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not pending/i);
  });

  it("returns 404 for a non-existent request id", async () => {
    const res = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/00000000-0000-0000-0000-000000000000/approve`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid group id", async () => {
    const res = await request(makeApp(OWNER_ID)).post(
      `/api/groups/not-a-uuid/join-requests/${requestId}/approve`,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/groups/:groupId/join-requests/:requestId/decline", () => {
  let requestId: string;

  beforeEach(async () => {
    seedBase();
    const res = await request(makeApp(JOINER_ID))
      .post(`/api/groups/${GROUP_ID}/join-requests`)
      .send({});
    requestId = res.body.id;
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(makeApp()).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/decline`,
    );
    expect(res.status).toBe(401);
  });

  it("rejects decline by a regular member (not owner/admin) with 403", async () => {
    getMockSupa().insertSeed("group_members", {
      group_id: GROUP_ID,
      user_id: STRANGER_ID,
      role: "member",
    });
    const res = await request(makeApp(STRANGER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/decline`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only owners or admins/i);
  });

  it("rejects decline by a non-member with 403", async () => {
    const res = await request(makeApp(STRANGER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/decline`,
    );
    expect(res.status).toBe(403);
  });

  it("owner declines — request status becomes declined and joiner is NOT added to members", async () => {
    const res = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/decline`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const members = getMockSupa().rows("group_members");
    const joinerMembership = members.find(
      (m) => m.user_id === JOINER_ID && m.group_id === GROUP_ID,
    );
    expect(joinerMembership).toBeUndefined();

    const requests = getMockSupa().rows("group_join_requests");
    const jr = requests.find((r) => r.id === requestId);
    expect(jr).toBeDefined();
    expect(jr!.status).toBe("declined");
    expect(jr!.decided_by_user_id).toBe(OWNER_ID);
    expect(jr!.decided_at).toBeDefined();
  });

  it("admin declines — same result as owner decline", async () => {
    const res = await request(makeApp(ADMIN_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/decline`,
    );
    expect(res.status).toBe(200);

    const requests = getMockSupa().rows("group_join_requests");
    const jr = requests.find((r) => r.id === requestId);
    expect(jr!.status).toBe("declined");
    expect(jr!.decided_by_user_id).toBe(ADMIN_ID);
  });

  it("returns 409 when declining an already-declined request", async () => {
    await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/decline`,
    );
    const res = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${requestId}/decline`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not pending/i);
  });

  it("returns 404 for a non-existent request id", async () => {
    const res = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/00000000-0000-0000-0000-000000000000/decline`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid group id", async () => {
    const res = await request(makeApp(OWNER_ID)).post(
      `/api/groups/not-a-uuid/join-requests/${requestId}/decline`,
    );
    expect(res.status).toBe(400);
  });
});

describe("full lifecycle — request → approve → membership verified", () => {
  beforeEach(() => seedBase());

  it("joiner requests, owner approves, joiner is a group member", async () => {
    const createRes = await request(makeApp(JOINER_ID))
      .post(`/api/groups/${GROUP_ID}/join-requests`)
      .send({ message: "Excited to ride with you!" });
    expect(createRes.status).toBe(200);
    const reqId = createRes.body.id;

    const approveRes = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${reqId}/approve`,
    );
    expect(approveRes.status).toBe(200);

    const members = getMockSupa().rows("group_members");
    const joinerRow = members.find(
      (m) => m.user_id === JOINER_ID && m.group_id === GROUP_ID,
    );
    expect(joinerRow).toBeDefined();
    expect(joinerRow!.role).toBe("member");

    const jrs = getMockSupa().rows("group_join_requests");
    const jr = jrs.find((r) => r.id === reqId);
    expect(jr!.status).toBe("approved");
    expect(jr!.decided_by_user_id).toBe(OWNER_ID);
  });

  it("joiner requests, owner declines, joiner is NOT a member", async () => {
    const createRes = await request(makeApp(JOINER_ID))
      .post(`/api/groups/${GROUP_ID}/join-requests`)
      .send({});
    expect(createRes.status).toBe(200);
    const reqId = createRes.body.id;

    const declineRes = await request(makeApp(OWNER_ID)).post(
      `/api/groups/${GROUP_ID}/join-requests/${reqId}/decline`,
    );
    expect(declineRes.status).toBe(200);

    const members = getMockSupa().rows("group_members");
    const joinerRow = members.find(
      (m) => m.user_id === JOINER_ID && m.group_id === GROUP_ID,
    );
    expect(joinerRow).toBeUndefined();

    const jrs = getMockSupa().rows("group_join_requests");
    const jr = jrs.find((r) => r.id === reqId);
    expect(jr!.status).toBe("declined");
  });
});
