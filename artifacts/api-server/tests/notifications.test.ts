import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const USER_ME = "user_me";
const USER_A = "user_alpha";
const USER_B = "user_beta";
const USER_NONAME = "user_noname";

const GROUP_ADMIN = randomUUID();
const GROUP_PLAIN = randomUUID();

const TRAIL_ACTIVE = randomUUID();
const TRAIL_ACTIVE_2 = randomUUID();
const TRAIL_SOFT_DEL = randomUUID();

interface NotifItem {
  id: string;
  type: string;
  occurred_at: string;
  unread: boolean;
  group: { id: string; name: string };
  actor: { id: string; display_name: string | null; email: string | null; avatar_url: string | null };
  trail?: { id: string | null; name: string };
  subject?: { id: string | null; display_name: string | null; email: string | null; avatar_url: string | null };
  removed_by_admin?: boolean;
  decliner_label?: string;
}

function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString();
}

function seedBase() {
  const supa = resetMockSupa();

  supa.seed("users", [
    { id: USER_ME, display_name: "Me User", email: "me@example.com", avatar_url: null, notifications_read_at: null },
    { id: USER_A, display_name: "Alpha", email: "alpha@example.com", avatar_url: "https://img/a.jpg" },
    { id: USER_B, display_name: "Beta", email: "beta@example.com", avatar_url: null },
    { id: USER_NONAME, display_name: "", email: "noname@example.com", avatar_url: null },
  ]);

  supa.seed("groups", [
    { id: GROUP_ADMIN, name: "Admin Group" },
    { id: GROUP_PLAIN, name: "Plain Group" },
  ]);

  supa.seed("group_members", [
    { group_id: GROUP_ADMIN, user_id: USER_ME, role: "owner", joined_at: minutesAgo(200) },
    { group_id: GROUP_PLAIN, user_id: USER_ME, role: "member", joined_at: minutesAgo(200) },
  ]);

  supa.seed("trails", [
    { id: TRAIL_ACTIVE, name: "Morning Loop", deleted_at: null },
    { id: TRAIL_ACTIVE_2, name: "Evening Cruise", deleted_at: null },
    { id: TRAIL_SOFT_DEL, name: null, deleted_at: minutesAgo(5) },
  ]);

  supa.seed("trail_shares", []);
  supa.seed("group_activity_events", []);
  supa.seed("group_invites", []);

  return supa;
}

beforeEach(() => {
  seedBase();
});

describe("GET /api/me/notifications", () => {
  it("returns 401 without auth", async () => {
    const res = await request(makeApp(null)).get("/api/me/notifications");
    expect(res.status).toBe(401);
  });

  it("returns empty feed when user has no group memberships", async () => {
    getMockSupa().seed("group_members", []);
    const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.unreadCount).toBe(0);
  });

  describe("self-event filtering", () => {
    it("excludes trails shared by the caller", async () => {
      getMockSupa().insertSeed("trail_shares", {
        trail_id: TRAIL_ACTIVE,
        group_id: GROUP_ADMIN,
        shared_by_user_id: USER_ME,
        shared_at: minutesAgo(10),
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      expect((res.body.items as NotifItem[]).filter(i => i.type === "trail_shared")).toHaveLength(0);
    });

    it("excludes the caller's own group join", async () => {
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      expect((res.body.items as NotifItem[]).filter(i => i.type === "member_joined")).toHaveLength(0);
    });

    it("excludes activity events performed by the caller", async () => {
      getMockSupa().insertSeed("group_activity_events", {
        id: randomUUID(),
        type: "member_left",
        group_id: GROUP_ADMIN,
        actor_user_id: USER_ME,
        subject_user_id: USER_ME,
        trail_id: null,
        trail_name_snapshot: null,
        occurred_at: minutesAgo(10),
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      expect((res.body.items as NotifItem[]).filter(i => i.type === "member_left")).toHaveLength(0);
    });

    it("excludes invites declined by the caller", async () => {
      getMockSupa().insertSeed("group_invites", {
        id: randomUUID(),
        group_id: GROUP_ADMIN,
        email: "someone@example.com",
        target_user_id: null,
        declined_at: minutesAgo(10),
        declined_by_user_id: USER_ME,
        created_by_user_id: USER_A,
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      expect((res.body.items as NotifItem[]).filter(i => i.type === "invite_declined")).toHaveLength(0);
    });
  });

  describe("trail_shared", () => {
    it("includes a trail shared by another user", async () => {
      getMockSupa().insertSeed("trail_shares", {
        trail_id: TRAIL_ACTIVE,
        group_id: GROUP_ADMIN,
        shared_by_user_id: USER_A,
        shared_at: minutesAgo(10),
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      const shares = (res.body.items as NotifItem[]).filter(i => i.type === "trail_shared");
      expect(shares).toHaveLength(1);
      expect(shares[0].trail).toEqual({ id: TRAIL_ACTIVE, name: "Morning Loop" });
      expect(shares[0].actor.display_name).toBe("Alpha");
      expect(shares[0].group.name).toBe("Admin Group");
      expect(shares[0].unread).toBe(true);
    });

    it("excludes soft-deleted trails from the feed", async () => {
      getMockSupa().insertSeed("trail_shares", {
        trail_id: TRAIL_SOFT_DEL,
        group_id: GROUP_ADMIN,
        shared_by_user_id: USER_A,
        shared_at: minutesAgo(10),
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      expect((res.body.items as NotifItem[]).filter(i => i.type === "trail_shared")).toHaveLength(0);
    });
  });

  describe("member_joined", () => {
    it("includes another user joining a group", async () => {
      getMockSupa().insertSeed("group_members", {
        group_id: GROUP_ADMIN,
        user_id: USER_A,
        role: "member",
        joined_at: minutesAgo(15),
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      const joins = (res.body.items as NotifItem[]).filter(i => i.type === "member_joined");
      expect(joins).toHaveLength(1);
      expect(joins[0].actor.display_name).toBe("Alpha");
      expect(joins[0].group.name).toBe("Admin Group");
    });
  });

  describe("member_left", () => {
    it("voluntary leave: removed_by_admin is false when actor equals subject", async () => {
      getMockSupa().insertSeed("group_activity_events", {
        id: randomUUID(),
        type: "member_left",
        group_id: GROUP_ADMIN,
        actor_user_id: USER_A,
        subject_user_id: USER_A,
        trail_id: null,
        trail_name_snapshot: null,
        occurred_at: minutesAgo(10),
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      const lefts = (res.body.items as NotifItem[]).filter(i => i.type === "member_left");
      expect(lefts).toHaveLength(1);
      expect(lefts[0].removed_by_admin).toBe(false);
      expect(lefts[0].actor.id).toBe(USER_A);
      expect(lefts[0].subject?.id).toBe(USER_A);
    });

    it("admin removal: removed_by_admin is true when actor differs from subject", async () => {
      getMockSupa().insertSeed("group_activity_events", {
        id: randomUUID(),
        type: "member_left",
        group_id: GROUP_ADMIN,
        actor_user_id: USER_A,
        subject_user_id: USER_B,
        trail_id: null,
        trail_name_snapshot: null,
        occurred_at: minutesAgo(10),
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      const lefts = (res.body.items as NotifItem[]).filter(i => i.type === "member_left");
      expect(lefts).toHaveLength(1);
      expect(lefts[0].removed_by_admin).toBe(true);
      expect(lefts[0].actor.id).toBe(USER_A);
      expect(lefts[0].subject?.id).toBe(USER_B);
    });
  });

  describe("trail_unshared", () => {
    it("uses live trail name when trail still exists", async () => {
      getMockSupa().insertSeed("group_activity_events", {
        id: randomUUID(),
        type: "trail_unshared",
        group_id: GROUP_ADMIN,
        actor_user_id: USER_A,
        trail_id: TRAIL_ACTIVE,
        trail_name_snapshot: "Old Name",
        subject_user_id: null,
        occurred_at: minutesAgo(10),
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      const items = (res.body.items as NotifItem[]).filter(i => i.type === "trail_unshared");
      expect(items).toHaveLength(1);
      expect(items[0].trail?.name).toBe("Morning Loop");
      expect(items[0].trail?.id).toBe(TRAIL_ACTIVE);
    });

    it("falls back to snapshot name when trail is hard-deleted", async () => {
      const goneId = randomUUID();
      getMockSupa().insertSeed("group_activity_events", {
        id: randomUUID(),
        type: "trail_unshared",
        group_id: GROUP_ADMIN,
        actor_user_id: USER_A,
        trail_id: goneId,
        trail_name_snapshot: "Ghost Trail",
        subject_user_id: null,
        occurred_at: minutesAgo(10),
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      const items = (res.body.items as NotifItem[]).filter(i => i.type === "trail_unshared");
      expect(items).toHaveLength(1);
      expect(items[0].trail?.name).toBe("Ghost Trail");
    });

    it("falls back to snapshot name when trail is soft-deleted", async () => {
      getMockSupa().insertSeed("group_activity_events", {
        id: randomUUID(),
        type: "trail_unshared",
        group_id: GROUP_ADMIN,
        actor_user_id: USER_A,
        trail_id: TRAIL_SOFT_DEL,
        trail_name_snapshot: "Sunset Ride",
        subject_user_id: null,
        occurred_at: minutesAgo(10),
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      const items = (res.body.items as NotifItem[]).filter(i => i.type === "trail_unshared");
      expect(items).toHaveLength(1);
      expect(items[0].trail?.name).toBe("Sunset Ride");
      expect(items[0].trail?.id).toBeNull();
    });
  });

  describe("invite_declined — admin-only visibility", () => {
    it("visible to group owner", async () => {
      getMockSupa().insertSeed("group_invites", {
        id: randomUUID(),
        group_id: GROUP_ADMIN,
        email: "invitee@example.com",
        target_user_id: null,
        declined_at: minutesAgo(10),
        declined_by_user_id: USER_A,
        created_by_user_id: USER_ME,
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      const declines = (res.body.items as NotifItem[]).filter(i => i.type === "invite_declined");
      expect(declines).toHaveLength(1);
      expect(declines[0].group.name).toBe("Admin Group");
      expect(declines[0].decliner_label).toBe("Alpha");
    });

    it("hidden from regular group members", async () => {
      getMockSupa().insertSeed("group_invites", {
        id: randomUUID(),
        group_id: GROUP_PLAIN,
        email: "invitee@example.com",
        target_user_id: null,
        declined_at: minutesAgo(10),
        declined_by_user_id: USER_A,
        created_by_user_id: USER_B,
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      expect((res.body.items as NotifItem[]).filter(i => i.type === "invite_declined")).toHaveLength(0);
    });

    it("uses email prefix as decliner_label when display_name is empty", async () => {
      getMockSupa().insertSeed("group_invites", {
        id: randomUUID(),
        group_id: GROUP_ADMIN,
        email: "noname@example.com",
        target_user_id: null,
        declined_at: minutesAgo(10),
        declined_by_user_id: USER_NONAME,
        created_by_user_id: USER_ME,
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      const declines = (res.body.items as NotifItem[]).filter(i => i.type === "invite_declined");
      expect(declines).toHaveLength(1);
      expect(declines[0].decliner_label).toBe("noname");
    });
  });

  describe("union ordering", () => {
    it("merges mixed-source events by (occurred_at desc, id desc) including ties", async () => {
      const supa = getMockSupa();
      const tieTime = minutesAgo(10);

      supa.insertSeed("trail_shares", {
        trail_id: TRAIL_ACTIVE,
        group_id: GROUP_ADMIN,
        shared_by_user_id: USER_A,
        shared_at: tieTime,
      });

      const eventId = randomUUID();
      supa.insertSeed("group_activity_events", {
        id: eventId,
        type: "member_left",
        group_id: GROUP_ADMIN,
        actor_user_id: USER_A,
        subject_user_id: USER_A,
        trail_id: null,
        trail_name_snapshot: null,
        occurred_at: tieTime,
      });

      supa.insertSeed("group_members", {
        group_id: GROUP_ADMIN,
        user_id: USER_B,
        role: "member",
        joined_at: minutesAgo(5),
      });

      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(3);

      for (let i = 1; i < res.body.items.length; i++) {
        const prev = res.body.items[i - 1];
        const curr = res.body.items[i];
        const cmp = curr.occurred_at.localeCompare(prev.occurred_at);
        expect(cmp).toBeLessThanOrEqual(0);
        if (cmp === 0) {
          expect(curr.id.localeCompare(prev.id)).toBeLessThan(0);
        }
      }

      const types = (res.body.items as NotifItem[]).map(i => i.type);
      expect(types).toContain("trail_shared");
      expect(types).toContain("member_left");
      expect(types).toContain("member_joined");
    });
  });

  describe("unread count", () => {
    it("all items are unread when notifications_read_at is null", async () => {
      const supa = getMockSupa();
      supa.insertSeed("trail_shares", {
        trail_id: TRAIL_ACTIVE,
        group_id: GROUP_ADMIN,
        shared_by_user_id: USER_A,
        shared_at: minutesAgo(10),
      });
      supa.insertSeed("group_members", {
        group_id: GROUP_ADMIN,
        user_id: USER_B,
        role: "member",
        joined_at: minutesAgo(5),
      });
      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(2);
      const allUnread = (res.body.items as NotifItem[]).every(i => i.unread === true);
      expect(allUnread).toBe(true);
      expect(res.body.unreadCount).toBe(res.body.items.length);
    });

    it("counts only items newer than notifications_read_at", async () => {
      const supa = getMockSupa();
      const readCursor = minutesAgo(15);
      const users = supa.rows("users");
      supa.seed("users", users.map(u =>
        u.id === USER_ME ? { ...u, notifications_read_at: readCursor } : u,
      ));

      supa.insertSeed("trail_shares", {
        trail_id: TRAIL_ACTIVE,
        group_id: GROUP_ADMIN,
        shared_by_user_id: USER_A,
        shared_at: minutesAgo(20),
      });
      supa.insertSeed("group_members", {
        group_id: GROUP_ADMIN,
        user_id: USER_B,
        role: "member",
        joined_at: minutesAgo(5),
      });

      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);

      const unreadItems = (res.body.items as NotifItem[]).filter(i => i.unread);
      expect(unreadItems).toHaveLength(1);
      expect(unreadItems[0].type).toBe("member_joined");

      expect(res.body.unreadCount).toBe(1);
    });

    it("excludes soft-deleted trail shares from both feed and unread count", async () => {
      const supa = getMockSupa();

      supa.insertSeed("trail_shares", {
        trail_id: TRAIL_ACTIVE,
        group_id: GROUP_ADMIN,
        shared_by_user_id: USER_A,
        shared_at: minutesAgo(3),
      });
      supa.insertSeed("trail_shares", {
        trail_id: TRAIL_SOFT_DEL,
        group_id: GROUP_ADMIN,
        shared_by_user_id: USER_A,
        shared_at: minutesAgo(2),
      });

      const res = await request(makeApp(USER_ME)).get("/api/me/notifications");
      expect(res.status).toBe(200);

      const shares = (res.body.items as NotifItem[]).filter(i => i.type === "trail_shared");
      expect(shares).toHaveLength(1);
      expect(shares[0].trail?.id).toBe(TRAIL_ACTIVE);

      expect(res.body.unreadCount).toBe(1);
    });
  });
});

describe("POST /api/me/notifications/read", () => {
  it("returns 401 without auth", async () => {
    const res = await request(makeApp(null)).post("/api/me/notifications/read");
    expect(res.status).toBe(401);
  });

  it("updates notifications_read_at and returns ok", async () => {
    const before = new Date().toISOString();
    const res = await request(makeApp(USER_ME)).post("/api/me/notifications/read");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.last_read_at).toBe("string");
    expect(new Date(res.body.last_read_at).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());

    const userRow = getMockSupa().rows("users").find(u => u.id === USER_ME);
    expect(userRow?.notifications_read_at).toBe(res.body.last_read_at);
  });
});
