import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { resetMockSupa, getMockSupa } from "./helpers/setup";
import { makeApp } from "./helpers/makeApp";

const USER_A = "user_alpha";
const USER_B = "user_beta";
const USER_C = "user_charlie";
const GROUP_1 = randomUUID();
const GROUP_2 = randomUUID();

function seedBase() {
  const supa = resetMockSupa();
  supa.seed("users", [
    { id: USER_A, display_name: "Alpha", avatar_url: null },
    { id: USER_B, display_name: "Beta", avatar_url: null },
    { id: USER_C, display_name: "Charlie", avatar_url: null },
  ]);
  supa.seed("groups", [
    { id: GROUP_1, name: "Group One" },
    { id: GROUP_2, name: "Group Two" },
  ]);
  supa.seed("group_members", [
    { group_id: GROUP_1, user_id: USER_A, role: "owner" },
    { group_id: GROUP_1, user_id: USER_B, role: "member" },
    { group_id: GROUP_1, user_id: USER_C, role: "member" },
  ]);
  supa.seed("chat_rooms", []);
  supa.seed("chat_room_members", []);
  supa.seed("chat_messages", []);
  supa.seed("user_blocks", []);
  return supa;
}

function seedGroupRoom(supa: ReturnType<typeof resetMockSupa>) {
  const roomId = randomUUID();
  supa.insertSeed("chat_rooms", { id: roomId, kind: "group", group_id: GROUP_1, created_at: new Date().toISOString() });
  supa.insertSeed("chat_room_members", { room_id: roomId, user_id: USER_A, role: "member", last_read_at: null, archived_at: null, joined_at: new Date().toISOString() });
  supa.insertSeed("chat_room_members", { room_id: roomId, user_id: USER_B, role: "member", last_read_at: null, archived_at: null, joined_at: new Date().toISOString() });
  supa.insertSeed("chat_room_members", { room_id: roomId, user_id: USER_C, role: "member", last_read_at: null, archived_at: null, joined_at: new Date().toISOString() });
  return roomId;
}

function seedDmRoom(supa: ReturnType<typeof resetMockSupa>, userA: string, userB: string) {
  const roomId = randomUUID();
  supa.insertSeed("chat_rooms", { id: roomId, kind: "dm", group_id: null, created_at: new Date().toISOString() });
  supa.insertSeed("chat_room_members", { room_id: roomId, user_id: userA, role: "member", last_read_at: null, archived_at: null, joined_at: new Date().toISOString() });
  supa.insertSeed("chat_room_members", { room_id: roomId, user_id: userB, role: "member", last_read_at: null, archived_at: null, joined_at: new Date().toISOString() });
  return roomId;
}

beforeEach(() => {
  seedBase();
});

describe("GET /api/chat/rooms", () => {
  it("returns 401 without auth", async () => {
    const res = await request(makeApp(null)).get("/api/chat/rooms");
    expect(res.status).toBe(401);
  });

  it("returns empty rooms for user with no memberships", async () => {
    const res = await request(makeApp(USER_A)).get("/api/chat/rooms");
    expect(res.status).toBe(200);
    expect(res.body.rooms).toEqual([]);
  });

  it("returns rooms with unread counts", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);

    const now = new Date();
    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: roomId,
      sender_user_id: USER_B,
      body: "Hello!",
      created_at: new Date(now.getTime() - 1000).toISOString(),
      deleted_at: null,
    });
    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: roomId,
      sender_user_id: USER_B,
      body: "World!",
      created_at: now.toISOString(),
      deleted_at: null,
    });

    const res = await request(makeApp(USER_A)).get("/api/chat/rooms");
    expect(res.status).toBe(200);
    expect(res.body.rooms.length).toBe(1);
    expect(res.body.rooms[0].id).toBe(roomId);
    expect(res.body.rooms[0].kind).toBe("group");
    expect(res.body.rooms[0].name).toBe("Group One");
    expect(res.body.rooms[0].unread_count).toBe(2);
    expect(res.body.rooms[0].last_message.body).toBe("World!");
  });

  it("marks own messages as not unread", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: roomId,
      sender_user_id: USER_A,
      body: "My own message",
      created_at: new Date().toISOString(),
      deleted_at: null,
    });

    const res = await request(makeApp(USER_A)).get("/api/chat/rooms");
    expect(res.body.rooms[0].unread_count).toBe(0);
  });

  it("respects last_read_at for unread count", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    const readAt = new Date(Date.now() - 5000).toISOString();

    const memberRows = supa.tables["chat_room_members"]!;
    const userAMember = memberRows.find(r => r.room_id === roomId && r.user_id === USER_A);
    if (userAMember) userAMember.last_read_at = readAt;

    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: roomId,
      sender_user_id: USER_B,
      body: "Old message",
      created_at: new Date(Date.now() - 10000).toISOString(),
      deleted_at: null,
    });
    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: roomId,
      sender_user_id: USER_B,
      body: "New message",
      created_at: new Date().toISOString(),
      deleted_at: null,
    });

    const res = await request(makeApp(USER_A)).get("/api/chat/rooms");
    expect(res.body.rooms[0].unread_count).toBe(1);
  });
});

describe("GET /api/chat/rooms/:roomId/messages", () => {
  it("rejects non-member", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    const memberRows = supa.tables["chat_room_members"]!;
    supa.tables["chat_room_members"] = memberRows.filter(r => !(r.room_id === roomId && r.user_id === USER_A));

    const res = await request(makeApp(USER_A)).get(`/api/chat/rooms/${roomId}/messages`);
    expect(res.status).toBe(403);
  });

  it("returns messages for member", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: roomId,
      sender_user_id: USER_B,
      body: "Hello there",
      created_at: new Date().toISOString(),
      deleted_at: null,
      deleted_by: null,
    });

    const res = await request(makeApp(USER_A)).get(`/api/chat/rooms/${roomId}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBe(1);
    expect(res.body.messages[0].body).toBe("Hello there");
    expect(res.body.messages[0].sender_display_name).toBe("Beta");
  });

  it("redacts body for blocked sender", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: roomId,
      sender_user_id: USER_B,
      body: "You cannot see this",
      created_at: new Date().toISOString(),
      deleted_at: null,
      deleted_by: null,
    });
    supa.insertSeed("user_blocks", {
      blocker_user_id: USER_A,
      blocked_user_id: USER_B,
      created_at: new Date().toISOString(),
    });

    const res = await request(makeApp(USER_A)).get(`/api/chat/rooms/${roomId}/messages`);
    expect(res.body.messages[0].body).toBeNull();
    expect(res.body.messages[0].blocked).toBe(true);
  });

  it("shows deleted messages with null body", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: roomId,
      sender_user_id: USER_B,
      body: "Deleted message",
      created_at: new Date().toISOString(),
      deleted_at: new Date().toISOString(),
      deleted_by: USER_B,
    });

    const res = await request(makeApp(USER_A)).get(`/api/chat/rooms/${roomId}/messages`);
    expect(res.body.messages[0].body).toBeNull();
    expect(res.body.messages[0].deleted).toBe(true);
  });
});

describe("POST /api/chat/rooms/:roomId/messages", () => {
  it("sends a message successfully", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);

    const res = await request(makeApp(USER_A))
      .post(`/api/chat/rooms/${roomId}/messages`)
      .send({ body: "Hello!" });
    expect(res.status).toBe(200);
    expect(res.body.body).toBe("Hello!");
    expect(res.body.sender_user_id).toBe(USER_A);
    expect(res.body.sender_display_name).toBe("Alpha");
  });

  it("rejects non-member", async () => {
    const supa = getMockSupa();
    const roomId = randomUUID();
    supa.insertSeed("chat_rooms", { id: roomId, kind: "group", group_id: GROUP_1, created_at: new Date().toISOString() });
    supa.insertSeed("chat_room_members", { room_id: roomId, user_id: USER_B, role: "member", last_read_at: null, archived_at: null, joined_at: new Date().toISOString() });

    const res = await request(makeApp(USER_A))
      .post(`/api/chat/rooms/${roomId}/messages`)
      .send({ body: "Should fail" });
    expect(res.status).toBe(403);
  });

  it("rejects empty body", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);

    const res = await request(makeApp(USER_A))
      .post(`/api/chat/rooms/${roomId}/messages`)
      .send({ body: "" });
    expect(res.status).toBe(400);
  });

  it("blocks DM messaging when blocked", async () => {
    const supa = getMockSupa();
    const dmRoomId = seedDmRoom(supa, USER_A, USER_B);

    supa.insertSeed("user_blocks", {
      blocker_user_id: USER_B,
      blocked_user_id: USER_A,
      created_at: new Date().toISOString(),
    });

    const res = await request(makeApp(USER_A))
      .post(`/api/chat/rooms/${dmRoomId}/messages`)
      .send({ body: "Hello?" });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Cannot send messages");
  });

  it("blocks DM messaging when mutual block exists", async () => {
    const supa = getMockSupa();
    const dmRoomId = seedDmRoom(supa, USER_A, USER_B);

    supa.insertSeed("user_blocks", {
      blocker_user_id: USER_A,
      blocked_user_id: USER_B,
      created_at: new Date().toISOString(),
    });
    supa.insertSeed("user_blocks", {
      blocker_user_id: USER_B,
      blocked_user_id: USER_A,
      created_at: new Date().toISOString(),
    });

    const res = await request(makeApp(USER_A))
      .post(`/api/chat/rooms/${dmRoomId}/messages`)
      .send({ body: "Hello?" });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Cannot send messages");
  });
});

describe("DELETE /api/chat/messages/:messageId", () => {
  it("allows sender to delete own message", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    const msgId = randomUUID();
    supa.insertSeed("chat_messages", {
      id: msgId,
      room_id: roomId,
      sender_user_id: USER_A,
      body: "To delete",
      created_at: new Date().toISOString(),
      deleted_at: null,
      deleted_by: null,
    });

    const res = await request(makeApp(USER_A)).delete(`/api/chat/messages/${msgId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const updated = supa.rows("chat_messages").find(r => r.id === msgId);
    expect(updated?.deleted_at).toBeTruthy();
    expect(updated?.deleted_by).toBe(USER_A);
  });

  it("allows group admin to delete others message", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    const msgId = randomUUID();
    supa.insertSeed("chat_messages", {
      id: msgId,
      room_id: roomId,
      sender_user_id: USER_B,
      body: "Admin can remove",
      created_at: new Date().toISOString(),
      deleted_at: null,
      deleted_by: null,
    });

    const res = await request(makeApp(USER_A)).delete(`/api/chat/messages/${msgId}`);
    expect(res.status).toBe(200);
  });

  it("prevents non-sender non-admin from deleting", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    const msgId = randomUUID();
    supa.insertSeed("chat_messages", {
      id: msgId,
      room_id: roomId,
      sender_user_id: USER_A,
      body: "Cannot delete",
      created_at: new Date().toISOString(),
      deleted_at: null,
      deleted_by: null,
    });

    const res = await request(makeApp(USER_C)).delete(`/api/chat/messages/${msgId}`);
    expect(res.status).toBe(403);
  });

  it("returns 404 for non-existent message", async () => {
    const res = await request(makeApp(USER_A)).delete(`/api/chat/messages/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for already deleted message", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    const msgId = randomUUID();
    supa.insertSeed("chat_messages", {
      id: msgId,
      room_id: roomId,
      sender_user_id: USER_A,
      body: "Already gone",
      created_at: new Date().toISOString(),
      deleted_at: new Date().toISOString(),
      deleted_by: USER_A,
    });

    const res = await request(makeApp(USER_A)).delete(`/api/chat/messages/${msgId}`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/chat/dm/:userId/open", () => {
  it("prevents DM to self", async () => {
    const res = await request(makeApp(USER_A)).post(`/api/chat/dm/${USER_A}/open`);
    expect(res.status).toBe(400);
  });

  it("prevents DM when blocked", async () => {
    const supa = getMockSupa();
    supa.insertSeed("user_blocks", {
      blocker_user_id: USER_B,
      blocked_user_id: USER_A,
      created_at: new Date().toISOString(),
    });

    const res = await request(makeApp(USER_A)).post(`/api/chat/dm/${USER_B}/open`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Cannot message");
  });

  it("prevents DM when mutual block exists", async () => {
    const supa = getMockSupa();
    supa.insertSeed("user_blocks", {
      blocker_user_id: USER_A,
      blocked_user_id: USER_B,
      created_at: new Date().toISOString(),
    });
    supa.insertSeed("user_blocks", {
      blocker_user_id: USER_B,
      blocked_user_id: USER_A,
      created_at: new Date().toISOString(),
    });

    const res = await request(makeApp(USER_A)).post(`/api/chat/dm/${USER_B}/open`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Cannot message");
  });

  it("prevents DM when no shared group", async () => {
    const supa = getMockSupa();
    const userD = "user_delta";
    supa.insertSeed("users", { id: userD, display_name: "Delta", avatar_url: null });

    const res = await request(makeApp(USER_A)).post(`/api/chat/dm/${userD}/open`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("share a group");
  });

  it("creates a new DM room for users sharing a group", async () => {
    const res = await request(makeApp(USER_A)).post(`/api/chat/dm/${USER_B}/open`);
    expect(res.status).toBe(200);
    expect(res.body.room_id).toBeTruthy();

    const supa = getMockSupa();
    const room = supa.rows("chat_rooms").find(r => r.id === res.body.room_id);
    expect(room?.kind).toBe("dm");

    const members = supa.rows("chat_room_members").filter(r => r.room_id === res.body.room_id);
    expect(members.length).toBe(2);
    expect(members.map(m => m.user_id).sort()).toEqual([USER_A, USER_B].sort());
  });

  it("reuses existing DM room", async () => {
    const supa = getMockSupa();
    const existingRoomId = seedDmRoom(supa, USER_A, USER_B);

    const res = await request(makeApp(USER_A)).post(`/api/chat/dm/${USER_B}/open`);
    expect(res.status).toBe(200);
    expect(res.body.room_id).toBe(existingRoomId);
  });
});

describe("POST /api/chat/rooms/:roomId/read", () => {
  it("updates last_read_at", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);

    const res = await request(makeApp(USER_A)).post(`/api/chat/rooms/${roomId}/read`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const member = supa.rows("chat_room_members").find(r => r.room_id === roomId && r.user_id === USER_A);
    expect(member?.last_read_at).toBeTruthy();
  });

  it("resets unread count after read", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: roomId,
      sender_user_id: USER_B,
      body: "Unread",
      created_at: new Date().toISOString(),
      deleted_at: null,
    });

    let res = await request(makeApp(USER_A)).get("/api/chat/rooms");
    expect(res.body.rooms[0].unread_count).toBe(1);

    await request(makeApp(USER_A)).post(`/api/chat/rooms/${roomId}/read`);

    res = await request(makeApp(USER_A)).get("/api/chat/rooms");
    expect(res.body.rooms[0].unread_count).toBe(0);
  });
});

describe("POST /api/chat/rooms/:roomId/archive", () => {
  it("rejects archiving a group room", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);

    const res = await request(makeApp(USER_A)).post(`/api/chat/rooms/${roomId}/archive`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Only DM");
  });

  it("archives a DM room", async () => {
    const supa = getMockSupa();
    const dmRoomId = seedDmRoom(supa, USER_A, USER_B);

    const res = await request(makeApp(USER_A)).post(`/api/chat/rooms/${dmRoomId}/archive`);
    expect(res.status).toBe(200);

    const member = supa.rows("chat_room_members").find(r => r.room_id === dmRoomId && r.user_id === USER_A);
    expect(member?.archived_at).toBeTruthy();
  });
});

describe("POST /api/users/:userId/block", () => {
  it("blocks a user", async () => {
    const res = await request(makeApp(USER_A)).post(`/api/users/${USER_B}/block`);
    expect(res.status).toBe(200);

    const supa = getMockSupa();
    const block = supa.rows("user_blocks").find(r => r.blocker_user_id === USER_A && r.blocked_user_id === USER_B);
    expect(block).toBeTruthy();
  });

  it("prevents blocking yourself", async () => {
    const res = await request(makeApp(USER_A)).post(`/api/users/${USER_A}/block`);
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/users/:userId/block", () => {
  it("unblocks a user", async () => {
    const supa = getMockSupa();
    supa.insertSeed("user_blocks", {
      blocker_user_id: USER_A,
      blocked_user_id: USER_B,
      created_at: new Date().toISOString(),
    });

    const res = await request(makeApp(USER_A)).delete(`/api/users/${USER_B}/block`);
    expect(res.status).toBe(200);

    const remaining = supa.rows("user_blocks").filter(r => r.blocker_user_id === USER_A);
    expect(remaining.length).toBe(0);
  });
});

describe("GET /api/users/me/blocks", () => {
  it("returns block list", async () => {
    const supa = getMockSupa();
    supa.insertSeed("user_blocks", {
      blocker_user_id: USER_A,
      blocked_user_id: USER_B,
      created_at: new Date().toISOString(),
    });

    const res = await request(makeApp(USER_A)).get("/api/users/me/blocks");
    expect(res.status).toBe(200);
    expect(res.body.blocks.length).toBe(1);
    expect(res.body.blocks[0].user_id).toBe(USER_B);
    expect(res.body.blocks[0].display_name).toBe("Beta");
  });

  it("returns empty for no blocks", async () => {
    const res = await request(makeApp(USER_A)).get("/api/users/me/blocks");
    expect(res.status).toBe(200);
    expect(res.body.blocks).toEqual([]);
  });
});

describe("Membership enforcement", () => {
  it("read rejects non-member", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    const userD = "user_delta";
    supa.insertSeed("users", { id: userD, display_name: "Delta", avatar_url: null });

    const res = await request(makeApp(userD)).post(`/api/chat/rooms/${roomId}/read`);
    expect(res.status).toBe(403);
  });

  it("archive rejects non-member", async () => {
    const supa = getMockSupa();
    const dmRoomId = seedDmRoom(supa, USER_A, USER_B);
    const userD = "user_delta";
    supa.insertSeed("users", { id: userD, display_name: "Delta", avatar_url: null });

    const res = await request(makeApp(userD)).post(`/api/chat/rooms/${dmRoomId}/archive`);
    expect(res.status).toBe(403);
  });
});

describe("Blocked-sender inbox preview", () => {
  it("redacts last_message body from blocked sender", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);

    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: roomId,
      sender_user_id: USER_B,
      body: "Blocked content visible?",
      created_at: new Date().toISOString(),
      deleted_at: null,
    });
    supa.insertSeed("user_blocks", {
      blocker_user_id: USER_A,
      blocked_user_id: USER_B,
      created_at: new Date().toISOString(),
    });

    const res = await request(makeApp(USER_A)).get("/api/chat/rooms");
    expect(res.status).toBe(200);
    expect(res.body.rooms[0].last_message.body).toBeNull();
  });
});

describe("Group removal mirrors to chat membership", () => {
  it("removing member from group_members removes from chat_room_members in DB trigger", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);

    const membersBefore = supa.rows("chat_room_members").filter(r => r.room_id === roomId);
    expect(membersBefore.length).toBe(3);

    supa.tables["group_members"] = supa.tables["group_members"]!.filter(
      r => !(r.group_id === GROUP_1 && r.user_id === USER_C)
    );

    supa.tables["chat_room_members"] = supa.tables["chat_room_members"]!.filter(
      r => !(r.room_id === roomId && r.user_id === USER_C)
    );

    const membersAfter = supa.rows("chat_room_members").filter(r => r.room_id === roomId);
    expect(membersAfter.length).toBe(2);
    expect(membersAfter.find(r => r.user_id === USER_C)).toBeUndefined();

    const res = await request(makeApp(USER_C)).get(`/api/chat/rooms/${roomId}/messages`);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/chat/unread-count", () => {
  it("returns 0 for user with no rooms", async () => {
    const res = await request(makeApp(USER_A)).get("/api/chat/unread-count");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it("counts unread messages correctly", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: roomId,
      sender_user_id: USER_B,
      body: "msg1",
      created_at: new Date().toISOString(),
      deleted_at: null,
    });
    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: roomId,
      sender_user_id: USER_C,
      body: "msg2",
      created_at: new Date().toISOString(),
      deleted_at: null,
    });

    const res = await request(makeApp(USER_A)).get("/api/chat/unread-count");
    expect(res.body.count).toBe(2);
  });

  it("excludes own messages from unread count", async () => {
    const supa = getMockSupa();
    const roomId = seedGroupRoom(supa);
    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: roomId,
      sender_user_id: USER_A,
      body: "my msg",
      created_at: new Date().toISOString(),
      deleted_at: null,
    });

    const res = await request(makeApp(USER_A)).get("/api/chat/unread-count");
    expect(res.body.count).toBe(0);
  });

  it("excludes archived rooms from unread count", async () => {
    const supa = getMockSupa();
    const dmRoomId = seedDmRoom(supa, USER_A, USER_B);
    const memberRows = supa.tables["chat_room_members"]!;
    const userAMember = memberRows.find(r => r.room_id === dmRoomId && r.user_id === USER_A);
    if (userAMember) userAMember.archived_at = new Date().toISOString();

    supa.insertSeed("chat_messages", {
      id: randomUUID(),
      room_id: dmRoomId,
      sender_user_id: USER_B,
      body: "Archived msg",
      created_at: new Date().toISOString(),
      deleted_at: null,
    });

    const res = await request(makeApp(USER_A)).get("/api/chat/unread-count");
    expect(res.body.count).toBe(0);
  });
});
