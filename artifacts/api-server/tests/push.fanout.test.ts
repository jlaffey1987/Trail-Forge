/**
 * Push fan-out integration tests — verify that the `void notify…` call
 * sites in the trail and group routes actually trigger `web-push`'s
 * `sendNotification` with the correct payload, and correctly skip
 * the actor and opted-out users.
 *
 * Call sites covered:
 *
 *   notifyTrailShared:
 *     POST   /api/trails              (create trail with group sharing)
 *     PATCH  /api/trails/:id          (add groups to existing trail)
 *     PUT    /api/trails/:id/shares   (replace shares via groups route)
 *
 *   notifyMemberJoined:
 *     POST   /api/groups/:id/join-requests/:reqId/approve
 *     POST   /api/invites/:token/accept
 *     POST   /api/me/invites/:inviteId/accept
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
} from "vitest";
import request from "supertest";
import webpush from "web-push";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const ACTOR = "user_actor";
const MEMBER_A = "user_member_a";
const MEMBER_B_OPTOUT = "user_member_b";
const MEMBER_C = "user_member_c";
const JOINER = "user_joiner";

const GROUP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRAIL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const EP_A = "https://fcm.googleapis.com/fcm/send/a";
const EP_B = "https://fcm.googleapis.com/fcm/send/b";
const EP_C = "https://fcm.googleapis.com/fcm/send/c";
const EP_ACTOR = "https://fcm.googleapis.com/fcm/send/actor";
const EP_JOINER = "https://fcm.googleapis.com/fcm/send/joiner";

const sendMock = webpush.sendNotification as unknown as Mock;

const VAPID_SAVE = {
  pub: process.env.VAPID_PUBLIC_KEY,
  priv: process.env.VAPID_PRIVATE_KEY,
};

beforeAll(() => {
  process.env.VAPID_PUBLIC_KEY = "BTestPublicKeyFanout";
  process.env.VAPID_PRIVATE_KEY = "TestPrivateKeyFanout";
});

afterAll(() => {
  if (VAPID_SAVE.pub === undefined) delete process.env.VAPID_PUBLIC_KEY;
  else process.env.VAPID_PUBLIC_KEY = VAPID_SAVE.pub;
  if (VAPID_SAVE.priv === undefined) delete process.env.VAPID_PRIVATE_KEY;
  else process.env.VAPID_PRIVATE_KEY = VAPID_SAVE.priv;
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

function calledEndpoints(): string[] {
  return sendMock.mock.calls.map(
    (c: unknown[]) => (c[0] as { endpoint: string }).endpoint,
  );
}

function calledPayloads(): Array<{
  title: string;
  body: string;
  url: string;
  tag?: string;
}> {
  return sendMock.mock.calls.map((c: unknown[]) =>
    JSON.parse(c[1] as string),
  );
}

function seedBase() {
  const supa = resetMockSupa();
  supa.seed("users", [
    { id: ACTOR, display_name: "Actor", push_notifications_enabled: true },
    { id: MEMBER_A, display_name: "Alice", push_notifications_enabled: true },
    {
      id: MEMBER_B_OPTOUT,
      display_name: "Bob",
      push_notifications_enabled: false,
    },
    {
      id: MEMBER_C,
      display_name: "Charlie",
      push_notifications_enabled: true,
    },
    { id: JOINER, display_name: "Joiner", push_notifications_enabled: true },
  ]);
  supa.seed("groups", [
    { id: GROUP_ID, name: "Trail Riders", discoverable: true },
    { id: GROUP_B_ID, name: "Mountain Bikers", discoverable: true },
  ]);
  supa.seed("group_members", [
    { group_id: GROUP_ID, user_id: ACTOR, role: "owner" },
    { group_id: GROUP_ID, user_id: MEMBER_A, role: "member" },
    { group_id: GROUP_ID, user_id: MEMBER_B_OPTOUT, role: "member" },
    { group_id: GROUP_ID, user_id: MEMBER_C, role: "member" },
    { group_id: GROUP_B_ID, user_id: ACTOR, role: "owner" },
    { group_id: GROUP_B_ID, user_id: MEMBER_A, role: "member" },
  ]);
  supa.seed("push_subscriptions", [
    { id: "sub-a", user_id: MEMBER_A, endpoint: EP_A, p256dh: "kA", auth: "aA" },
    { id: "sub-b", user_id: MEMBER_B_OPTOUT, endpoint: EP_B, p256dh: "kB", auth: "aB" },
    { id: "sub-c", user_id: MEMBER_C, endpoint: EP_C, p256dh: "kC", auth: "aC" },
    { id: "sub-actor", user_id: ACTOR, endpoint: EP_ACTOR, p256dh: "kAct", auth: "aAct" },
    { id: "sub-joiner", user_id: JOINER, endpoint: EP_JOINER, p256dh: "kJ", auth: "aJ" },
  ]);
  supa.seed("trails", []);
  supa.seed("trail_shares", []);
  supa.seed("group_activity_events", []);
  supa.seed("group_join_requests", []);
  supa.seed("group_invites", []);
  return supa;
}

const validTrailBody = {
  name: "Summit Loop",
  type: "BOAT",
  difficulty: 5,
  distance_km: 3.2,
  terrain: "Mixed",
  legal_status: "BOAT",
  gpx_data: "<gpx></gpx>",
  is_public: false,
};

// ===========================================================================
// notifyTrailShared
// ===========================================================================

describe("push fan-out: notifyTrailShared", () => {
  beforeEach(() => {
    seedBase();
    sendMock.mockClear();
  });

  describe("POST /api/trails — create with group sharing", () => {
    it("sends push to enabled members with subscriptions", async () => {
      const res = await request(makeApp(ACTOR))
        .post("/api/trails")
        .send({ ...validTrailBody, privacy: "group", group_ids: [GROUP_ID] });
      expect(res.status).toBe(200);
      await flush();

      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(calledEndpoints()).toContain(EP_A);
      expect(calledEndpoints()).toContain(EP_C);
    });

    it("skips the trail creator (actor)", async () => {
      const res = await request(makeApp(ACTOR))
        .post("/api/trails")
        .send({ ...validTrailBody, privacy: "group", group_ids: [GROUP_ID] });
      expect(res.status).toBe(200);
      await flush();

      expect(calledEndpoints()).not.toContain(EP_ACTOR);
    });

    it("skips users who opted out globally (push_notifications_enabled=false)", async () => {
      const res = await request(makeApp(ACTOR))
        .post("/api/trails")
        .send({ ...validTrailBody, privacy: "group", group_ids: [GROUP_ID] });
      expect(res.status).toBe(200);
      await flush();

      expect(calledEndpoints()).not.toContain(EP_B);
    });

    it("skips members who opted out at group level (push_enabled=false)", async () => {
      const supa = getMockSupa();
      supa.tables["group_members"] = supa.tables["group_members"]!.map((r) =>
        r.user_id === MEMBER_C && r.group_id === GROUP_ID
          ? { ...r, push_enabled: false }
          : r,
      );

      const res = await request(makeApp(ACTOR))
        .post("/api/trails")
        .send({ ...validTrailBody, privacy: "group", group_ids: [GROUP_ID] });
      expect(res.status).toBe(200);
      await flush();

      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(calledEndpoints()).toEqual([EP_A]);
    });

    it("includes correct payload (title with group name, body with actor + trail name)", async () => {
      const res = await request(makeApp(ACTOR))
        .post("/api/trails")
        .send({ ...validTrailBody, privacy: "group", group_ids: [GROUP_ID] });
      expect(res.status).toBe(200);
      await flush();

      const payloads = calledPayloads();
      for (const p of payloads) {
        expect(p.title).toBe("New trail in Trail Riders");
        expect(p.body).toContain("Actor");
        expect(p.body).toContain("Summit Loop");
      }
    });
  });

  describe("PATCH /api/trails/:id — add groups to existing trail", () => {
    beforeEach(() => {
      getMockSupa().seed("trails", [
        {
          id: TRAIL_ID,
          owner_user_id: ACTOR,
          name: "Existing Trail",
          is_public: false,
        },
      ]);
    });

    it("sends push for newly-added groups", async () => {
      const res = await request(makeApp(ACTOR))
        .patch(`/api/trails/${TRAIL_ID}`)
        .send({ group_ids: [GROUP_ID] });
      expect(res.status).toBe(200);
      await flush();

      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(calledEndpoints()).toContain(EP_A);
      expect(calledEndpoints()).toContain(EP_C);
      expect(calledEndpoints()).not.toContain(EP_ACTOR);
      expect(calledEndpoints()).not.toContain(EP_B);

      const payloads = calledPayloads();
      for (const p of payloads) {
        expect(p.title).toBe("New trail in Trail Riders");
        expect(p.body).toContain("Existing Trail");
      }
    });
  });

  describe("PUT /api/trails/:id/shares — replace shares via groups route", () => {
    beforeEach(() => {
      getMockSupa().seed("trails", [
        {
          id: TRAIL_ID,
          owner_user_id: ACTOR,
          name: "Shared Trail",
          is_public: false,
        },
      ]);
    });

    it("sends push for newly-added groups only", async () => {
      const res = await request(makeApp(ACTOR))
        .put(`/api/trails/${TRAIL_ID}/shares`)
        .send({ group_ids: [GROUP_ID] });
      expect(res.status).toBe(200);
      await flush();

      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(calledEndpoints()).toContain(EP_A);
      expect(calledEndpoints()).toContain(EP_C);
      expect(calledEndpoints()).not.toContain(EP_ACTOR);
      expect(calledEndpoints()).not.toContain(EP_B);
    });

    it("does not send push for groups that were already shared", async () => {
      getMockSupa().insertSeed("trail_shares", {
        trail_id: TRAIL_ID,
        group_id: GROUP_ID,
        shared_by_user_id: ACTOR,
      });

      const res = await request(makeApp(ACTOR))
        .put(`/api/trails/${TRAIL_ID}/shares`)
        .send({ group_ids: [GROUP_ID] });
      expect(res.status).toBe(200);
      await flush();

      expect(sendMock).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// notifyMemberJoined
// ===========================================================================

describe("push fan-out: notifyMemberJoined", () => {
  beforeEach(() => {
    seedBase();
    sendMock.mockClear();
  });

  describe("POST /api/groups/:id/join-requests/:reqId/approve", () => {
    let requestId: string;

    beforeEach(async () => {
      const res = await request(makeApp(JOINER))
        .post(`/api/groups/${GROUP_ID}/join-requests`)
        .send({});
      expect(res.status).toBe(200);
      requestId = res.body.id;
      sendMock.mockClear();
    });

    it("sends push to existing group members with subscriptions", async () => {
      const res = await request(makeApp(ACTOR)).post(
        `/api/groups/${GROUP_ID}/join-requests/${requestId}/approve`,
      );
      expect(res.status).toBe(200);
      await flush();

      expect(sendMock).toHaveBeenCalledTimes(3);
      expect(calledEndpoints()).toContain(EP_ACTOR);
      expect(calledEndpoints()).toContain(EP_A);
      expect(calledEndpoints()).toContain(EP_C);
    });

    it("skips the joiner (they already know they joined)", async () => {
      const res = await request(makeApp(ACTOR)).post(
        `/api/groups/${GROUP_ID}/join-requests/${requestId}/approve`,
      );
      expect(res.status).toBe(200);
      await flush();

      expect(calledEndpoints()).not.toContain(EP_JOINER);
    });

    it("skips globally opted-out members", async () => {
      const res = await request(makeApp(ACTOR)).post(
        `/api/groups/${GROUP_ID}/join-requests/${requestId}/approve`,
      );
      expect(res.status).toBe(200);
      await flush();

      expect(calledEndpoints()).not.toContain(EP_B);
    });

    it("includes correct payload (joiner name + group name)", async () => {
      const res = await request(makeApp(ACTOR)).post(
        `/api/groups/${GROUP_ID}/join-requests/${requestId}/approve`,
      );
      expect(res.status).toBe(200);
      await flush();

      const payloads = calledPayloads();
      for (const p of payloads) {
        expect(p.title).toBe("Joiner joined Trail Riders");
        expect(p.body).toBe("Tap to see the group");
        expect(p.url).toContain(GROUP_ID);
      }
    });
  });

  describe("POST /api/invites/:token/accept", () => {
    const INVITE_TOKEN = "test-invite-token-abc123";

    beforeEach(() => {
      getMockSupa().setRpcResult("claim_group_invite", GROUP_ID);
    });

    it("sends push to existing group members", async () => {
      const res = await request(makeApp(JOINER)).post(
        `/api/invites/${INVITE_TOKEN}/accept`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, group_id: GROUP_ID });
      await flush();

      expect(sendMock).toHaveBeenCalledTimes(3);
      expect(calledEndpoints()).toContain(EP_ACTOR);
      expect(calledEndpoints()).toContain(EP_A);
      expect(calledEndpoints()).toContain(EP_C);
      expect(calledEndpoints()).not.toContain(EP_JOINER);
      expect(calledEndpoints()).not.toContain(EP_B);
    });

    it("includes correct payload", async () => {
      await request(makeApp(JOINER)).post(
        `/api/invites/${INVITE_TOKEN}/accept`,
      );
      await flush();

      const payloads = calledPayloads();
      for (const p of payloads) {
        expect(p.title).toBe("Joiner joined Trail Riders");
        expect(p.body).toBe("Tap to see the group");
      }
    });
  });

  describe("POST /api/me/invites/:inviteId/accept", () => {
    const INVITE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const INVITE_TOKEN = "token-for-invite-1";

    beforeEach(() => {
      getMockSupa().insertSeed("group_invites", {
        id: INVITE_ID,
        token: INVITE_TOKEN,
        group_id: GROUP_ID,
        email: null,
        target_user_id: JOINER,
        accepted_at: null,
        declined_at: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_by_user_id: ACTOR,
      });
      getMockSupa().setRpcResult("claim_group_invite", GROUP_ID);
    });

    it("sends push to existing group members", async () => {
      const res = await request(makeApp(JOINER)).post(
        `/api/me/invites/${INVITE_ID}/accept`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, group_id: GROUP_ID });
      await flush();

      expect(sendMock).toHaveBeenCalledTimes(3);
      expect(calledEndpoints()).toContain(EP_ACTOR);
      expect(calledEndpoints()).toContain(EP_A);
      expect(calledEndpoints()).toContain(EP_C);
      expect(calledEndpoints()).not.toContain(EP_JOINER);
      expect(calledEndpoints()).not.toContain(EP_B);
    });
  });
});
