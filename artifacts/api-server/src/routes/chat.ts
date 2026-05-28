import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { requireAuth, type AuthedHandler } from "../middlewares/requireAuth";
import { isMissingTableError } from "../lib/dbErrors";

const router: IRouter = Router();

const UuidParam = z.string().uuid();

const SendMessageBody = z.object({
  body: z.string().min(1).max(2000),
});


const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 120_000);

const sseClients = new Map<string, Set<Response>>();

function broadcastToRoom(roomId: string, event: string, data: unknown) {
  const supa = getSupabaseAdmin();
  void (async () => {
    try {
      const { data: members } = await supa
        .from("chat_room_members")
        .select("user_id")
        .eq("room_id", roomId);
      if (!members) return;
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const m of members as Array<{ user_id: string }>) {
        const clients = sseClients.get(m.user_id);
        if (clients) {
          for (const client of clients) {
            try { client.write(payload); } catch { /* client gone */ }
          }
        }
      }
    } catch {
      /* best effort */
    }
  })();
}

router.get(
  "/chat/rooms",
  requireAuth(async (_req, res, userId) => {
    const supa = getSupabaseAdmin();

    const { data: memberships, error: mErr } = await supa
      .from("chat_room_members")
      .select("room_id, last_read_at, archived_at, role, joined_at")
      .eq("user_id", userId);

    if (mErr) {
      if (isMissingTableError(mErr)) {
        res.json({ rooms: [] });
        return;
      }
      res.status(500).json({ error: "Failed to load chat rooms" });
      return;
    }

    interface MembershipRow {
      room_id: string;
      last_read_at: string | null;
      archived_at: string | null;
      role: string;
      joined_at: string;
    }
    const ms = (memberships ?? []) as MembershipRow[];
    if (ms.length === 0) {
      res.json({ rooms: [] });
      return;
    }

    const roomIds = ms.map((m) => m.room_id);

    const [roomsRes, roomMembersRes, blocksRes] = await Promise.all([
      supa
        .from("chat_rooms")
        .select("id, kind, group_id, created_at")
        .in("id", roomIds),
      supa
        .from("chat_room_members")
        .select("room_id, user_id, users(id, display_name, avatar_url)")
        .in("room_id", roomIds),
      supa
        .from("user_blocks")
        .select("blocked_user_id")
        .eq("blocker_user_id", userId),
    ]);

    const blockedSet = new Set(
      ((blocksRes.data ?? []) as Array<{ blocked_user_id: string }>).map(
        (b) => b.blocked_user_id,
      ),
    );

    interface RoomRow {
      id: string;
      kind: string;
      group_id: string | null;
      created_at: string;
    }
    const roomMap = new Map<string, RoomRow>();
    for (const r of (roomsRes.data ?? []) as RoomRow[]) roomMap.set(r.id, r);

    interface MsgRow {
      id: string;
      room_id: string;
      sender_user_id: string;
      body: string;
      created_at: string;
      deleted_at: string | null;
    }

    const perRoomPromises = ms.map(async (m) => {
      const [lastMsgRes, unreadRes] = await Promise.all([
        supa
          .from("chat_messages")
          .select("id, room_id, sender_user_id, body, created_at, deleted_at")
          .eq("room_id", m.room_id)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(1),
        ((): PromiseLike<{ count: number | null }> => {
          let q = supa
            .from("chat_messages")
            .select("id", { count: "exact", head: true })
            .eq("room_id", m.room_id)
            .is("deleted_at", null)
            .neq("sender_user_id", userId);
          if (m.last_read_at) {
            q = q.gt("created_at", m.last_read_at);
          }
          return q;
        })(),
      ]);
      const lastMsg = ((lastMsgRes.data ?? []) as MsgRow[])[0] ?? null;
      return {
        room_id: m.room_id,
        lastMsg,
        unreadCount: unreadRes.count ?? 0,
      };
    });
    const perRoomResults = await Promise.all(perRoomPromises);
    const lastMsgMap = new Map<string, MsgRow>();
    const unreadCountMap = new Map<string, number>();
    for (const r of perRoomResults) {
      if (r.lastMsg) lastMsgMap.set(r.room_id, r.lastMsg);
      unreadCountMap.set(r.room_id, r.unreadCount);
    }

    interface RoomMemberRow {
      room_id: string;
      user_id: string;
      users: { id: string; display_name: string | null; avatar_url: string | null } |
        Array<{ id: string; display_name: string | null; avatar_url: string | null }> | null;
    }
    const roomMembersMap = new Map<string, RoomMemberRow[]>();
    for (const rm of (roomMembersRes.data ?? []) as RoomMemberRow[]) {
      const arr = roomMembersMap.get(rm.room_id) ?? [];
      arr.push(rm);
      roomMembersMap.set(rm.room_id, arr);
    }

    const groupIds = [...roomMap.values()]
      .filter((r) => r.kind === "group" && r.group_id)
      .map((r) => r.group_id as string);
    let groupNames = new Map<string, string>();
    if (groupIds.length > 0) {
      const { data: groups } = await supa
        .from("groups")
        .select("id, name")
        .in("id", groupIds);
      for (const g of (groups ?? []) as Array<{ id: string; name: string }>) {
        groupNames.set(g.id, g.name);
      }
    }

    const rooms = ms.map((m) => {
      const room = roomMap.get(m.room_id);
      if (!room) return null;

      const lastMsg = lastMsgMap.get(m.room_id);

      const unreadCount = unreadCountMap.get(m.room_id) ?? 0;

      let name: string | null = null;
      let avatar_url: string | null = null;
      let other_user_id: string | null = null;

      if (room.kind === "group" && room.group_id) {
        name = groupNames.get(room.group_id) ?? "Group Chat";
      } else if (room.kind === "dm") {
        const members = roomMembersMap.get(m.room_id) ?? [];
        const other = members.find((rm) => rm.user_id !== userId);
        if (other) {
          const u = Array.isArray(other.users) ? other.users[0] : other.users;
          name = u?.display_name ?? "Direct Message";
          avatar_url = u?.avatar_url ?? null;
          other_user_id = other.user_id;
        } else {
          name = "Direct Message";
        }
      }

      return {
        id: room.id,
        kind: room.kind,
        group_id: room.group_id,
        name,
        avatar_url,
        other_user_id,
        unread_count: unreadCount,
        archived: !!m.archived_at,
        last_message: lastMsg
          ? {
              id: lastMsg.id,
              sender_user_id: lastMsg.sender_user_id,
              body: blockedSet.has(lastMsg.sender_user_id) ? null : lastMsg.body,
              created_at: lastMsg.created_at,
            }
          : null,
        created_at: room.created_at,
      };
    }).filter((r): r is NonNullable<typeof r> => r != null);

    rooms.sort((a, b) => {
      const aTime = a.last_message?.created_at ?? a.created_at;
      const bTime = b.last_message?.created_at ?? b.created_at;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });

    res.json({ rooms });
  }),
);

router.get(
  "/chat/rooms/:roomId/messages",
  requireAuth(async (req, res, userId) => {
    const idParse = UuidParam.safeParse(req.params.roomId);
    if (!idParse.success) {
      res.status(400).json({ error: "Invalid room id" });
      return;
    }
    const roomId = idParse.data;
    const supa = getSupabaseAdmin();

    const { data: membership } = await supa
      .from("chat_room_members")
      .select("room_id, role")
      .eq("room_id", roomId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership) {
      res.status(403).json({ error: "Not a member of this room" });
      return;
    }
    const userRole = (membership as { role: string } | null)?.role ?? "member";

    const before = typeof req.query.before === "string" ? req.query.before : null;
    const limitParam = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
    const limit = Math.min(Math.max(limitParam, 1), 100);

    let q = supa
      .from("chat_messages")
      .select("id, room_id, sender_user_id, body, created_at, deleted_at, deleted_by, users:sender_user_id(id, display_name, avatar_url)")
      .eq("room_id", roomId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (before) {
      q = q.lt("created_at", before);
    }

    const { data: msgs, error: mErr } = await q;
    if (mErr) {
      if (isMissingTableError(mErr)) {
        res.json({ messages: [], hasMore: false });
        return;
      }
      res.status(500).json({ error: "Failed to load messages" });
      return;
    }

    const { data: blocks } = await supa
      .from("user_blocks")
      .select("blocked_user_id")
      .eq("blocker_user_id", userId);
    const blockedSet = new Set(
      ((blocks ?? []) as Array<{ blocked_user_id: string }>).map((b) => b.blocked_user_id),
    );

    interface MsgRow {
      id: string;
      room_id: string;
      sender_user_id: string;
      body: string;
      created_at: string;
      deleted_at: string | null;
      deleted_by: string | null;
      users: { id: string; display_name: string | null; avatar_url: string | null } |
        Array<{ id: string; display_name: string | null; avatar_url: string | null }> | null;
    }
    const rows = (msgs ?? []) as MsgRow[];
    const messages = rows.map((m) => {
      const u = Array.isArray(m.users) ? m.users[0] : m.users;
      const isBlocked = blockedSet.has(m.sender_user_id);
      return {
        id: m.id,
        room_id: m.room_id,
        sender_user_id: m.sender_user_id,
        sender_display_name: u?.display_name ?? null,
        sender_avatar_url: u?.avatar_url ?? null,
        body: m.deleted_at ? null : isBlocked ? null : m.body,
        created_at: m.created_at,
        deleted: !!m.deleted_at,
        blocked: isBlocked && !m.deleted_at,
      };
    });

    messages.reverse();

    res.json({
      messages,
      hasMore: rows.length === limit,
      userRole,
    });
  }),
);

router.post(
  "/chat/rooms/:roomId/messages",
  requireAuth(async (req, res, userId) => {
    const idParse = UuidParam.safeParse(req.params.roomId);
    if (!idParse.success) {
      res.status(400).json({ error: "Invalid room id" });
      return;
    }
    const parsed = SendMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid message body" });
      return;
    }
    const roomId = idParse.data;

    if (!checkRateLimit(userId)) {
      res.status(429).json({ error: "Too many messages. Please wait a moment." });
      return;
    }

    const supa = getSupabaseAdmin();

    const { data: membership } = await supa
      .from("chat_room_members")
      .select("room_id")
      .eq("room_id", roomId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership) {
      res.status(403).json({ error: "Not a member of this room" });
      return;
    }

    const { data: room } = await supa
      .from("chat_rooms")
      .select("id, kind")
      .eq("id", roomId)
      .maybeSingle();

    if (room && (room as { kind: string }).kind === "dm") {
      const { data: otherMembers } = await supa
        .from("chat_room_members")
        .select("user_id")
        .eq("room_id", roomId)
        .neq("user_id", userId);
      const otherId = ((otherMembers ?? []) as Array<{ user_id: string }>)[0]?.user_id;
      if (otherId) {
        const { count: blockCount } = await supa
          .from("user_blocks")
          .select("blocker_user_id", { count: "exact", head: true })
          .or(`and(blocker_user_id.eq.${otherId},blocked_user_id.eq.${userId}),and(blocker_user_id.eq.${userId},blocked_user_id.eq.${otherId})`);
        if ((blockCount ?? 0) > 0) {
          res.status(403).json({ error: "Cannot send messages in this conversation" });
          return;
        }
      }
    }

    const { data: sender } = await supa
      .from("users")
      .select("id, display_name, avatar_url")
      .eq("id", userId)
      .maybeSingle();

    const { data: msg, error: insertErr } = await supa
      .from("chat_messages")
      .insert({
        room_id: roomId,
        sender_user_id: userId,
        body: parsed.data.body,
      })
      .select()
      .single();

    if (insertErr) {
      req.log.error({ err: insertErr }, "send chat message failed");
      res.status(500).json({ error: "Failed to send message" });
      return;
    }

    await supa
      .from("chat_room_members")
      .update({ archived_at: null })
      .eq("room_id", roomId)
      .not("archived_at", "is", null);

    const senderInfo = sender as { id: string; display_name: string | null; avatar_url: string | null } | null;
    const msgRow = msg as { id: string; room_id: string; sender_user_id: string; body: string; created_at: string };
    const responseMsg = {
      id: msgRow.id,
      room_id: msgRow.room_id,
      sender_user_id: msgRow.sender_user_id,
      sender_display_name: senderInfo?.display_name ?? null,
      sender_avatar_url: senderInfo?.avatar_url ?? null,
      body: msgRow.body,
      created_at: msgRow.created_at,
      deleted: false,
      blocked: false,
    };

    broadcastToRoom(roomId, "new_message", responseMsg);

    res.json(responseMsg);
  }),
);

router.delete(
  "/chat/messages/:messageId",
  requireAuth(async (req, res, userId) => {
    const idParse = UuidParam.safeParse(req.params.messageId);
    if (!idParse.success) {
      res.status(400).json({ error: "Invalid message id" });
      return;
    }
    const messageId = idParse.data;
    const supa = getSupabaseAdmin();

    const { data: msg } = await supa
      .from("chat_messages")
      .select("id, room_id, sender_user_id, deleted_at")
      .eq("id", messageId)
      .maybeSingle();
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    const msgRow = msg as { id: string; room_id: string; sender_user_id: string; deleted_at: string | null };
    if (msgRow.deleted_at) {
      res.status(400).json({ error: "Message already deleted" });
      return;
    }

    const isSender = msgRow.sender_user_id === userId;
    if (!isSender) {
      const { data: room } = await supa
        .from("chat_rooms")
        .select("id, kind, group_id")
        .eq("id", msgRow.room_id)
        .maybeSingle();
      const roomRow = room as { id: string; kind: string; group_id: string | null } | null;
      if (roomRow?.kind === "group" && roomRow.group_id) {
        const { data: membership } = await supa
          .from("group_members")
          .select("role")
          .eq("group_id", roomRow.group_id)
          .eq("user_id", userId)
          .maybeSingle();
        const role = (membership as { role: string } | null)?.role;
        if (role !== "owner" && role !== "admin") {
          res.status(403).json({ error: "Only the sender or group admins can delete messages" });
          return;
        }
      } else {
        res.status(403).json({ error: "You can only delete your own messages" });
        return;
      }
    }

    const { error: delErr } = await supa
      .from("chat_messages")
      .update({ deleted_at: new Date().toISOString(), deleted_by: userId })
      .eq("id", messageId);
    if (delErr) {
      res.status(500).json({ error: "Failed to delete message" });
      return;
    }

    broadcastToRoom(msgRow.room_id, "message_deleted", { id: messageId, room_id: msgRow.room_id });

    res.json({ ok: true });
  }),
);

router.post(
  "/chat/dm/:userId/open",
  requireAuth(async (req, res, callerId) => {
    const targetUserId = req.params.userId;
    if (!targetUserId || targetUserId === callerId) {
      res.status(400).json({ error: "Invalid target user" });
      return;
    }

    const supa = getSupabaseAdmin();

    const { count: blockCount } = await supa
      .from("user_blocks")
      .select("blocker_user_id", { count: "exact", head: true })
      .or(`and(blocker_user_id.eq.${targetUserId},blocked_user_id.eq.${callerId}),and(blocker_user_id.eq.${callerId},blocked_user_id.eq.${targetUserId})`);
    if ((blockCount ?? 0) > 0) {
      res.status(403).json({ error: "Cannot message this user" });
      return;
    }

    const { data: callerGroups } = await supa
      .from("group_members")
      .select("group_id")
      .eq("user_id", callerId);
    const { data: targetGroups } = await supa
      .from("group_members")
      .select("group_id")
      .eq("user_id", targetUserId);

    const callerGroupIds = new Set(
      ((callerGroups ?? []) as Array<{ group_id: string }>).map((g) => g.group_id),
    );
    const sharedGroup = ((targetGroups ?? []) as Array<{ group_id: string }>).find(
      (g) => callerGroupIds.has(g.group_id),
    );
    if (!sharedGroup) {
      res.status(403).json({ error: "You can only message riders who share a group with you" });
      return;
    }

    const { data: existingRooms } = await supa
      .from("chat_rooms")
      .select("id")
      .eq("kind", "dm");

    let existingRoomId: string | null = null;
    if (existingRooms && (existingRooms as Array<{ id: string }>).length > 0) {
      const dmRoomIds = (existingRooms as Array<{ id: string }>).map((r) => r.id);

      const batchSize = 100;
      for (let i = 0; i < dmRoomIds.length; i += batchSize) {
        const batch = dmRoomIds.slice(i, i + batchSize);
        const { data: callerRoomMembers } = await supa
          .from("chat_room_members")
          .select("room_id")
          .in("room_id", batch)
          .eq("user_id", callerId);
        if (!callerRoomMembers || (callerRoomMembers as Array<{ room_id: string }>).length === 0) continue;

        const callerRoomIds = (callerRoomMembers as Array<{ room_id: string }>).map((m) => m.room_id);
        const { data: targetRoomMembers } = await supa
          .from("chat_room_members")
          .select("room_id")
          .in("room_id", callerRoomIds)
          .eq("user_id", targetUserId);

        if (targetRoomMembers && (targetRoomMembers as Array<{ room_id: string }>).length > 0) {
          existingRoomId = (targetRoomMembers as Array<{ room_id: string }>)[0].room_id;
          break;
        }
      }
    }

    if (existingRoomId) {
      await supa
        .from("chat_room_members")
        .update({ archived_at: null })
        .eq("room_id", existingRoomId)
        .eq("user_id", callerId);
      res.json({ room_id: existingRoomId });
      return;
    }

    const { data: newRoom, error: roomErr } = await supa
      .from("chat_rooms")
      .insert({ kind: "dm" })
      .select()
      .single();
    if (roomErr || !newRoom) {
      req.log.error({ err: roomErr }, "create DM room failed");
      res.status(500).json({ error: "Failed to create conversation" });
      return;
    }

    const newRoomId = (newRoom as { id: string }).id;
    const { error: memErr } = await supa
      .from("chat_room_members")
      .insert([
        { room_id: newRoomId, user_id: callerId, role: "member" },
        { room_id: newRoomId, user_id: targetUserId, role: "member" },
      ]);
    if (memErr) {
      req.log.error({ err: memErr }, "create DM room members failed");
    }

    res.json({ room_id: newRoomId });
  }),
);

router.post(
  "/chat/rooms/:roomId/read",
  requireAuth(async (req, res, userId) => {
    const idParse = UuidParam.safeParse(req.params.roomId);
    if (!idParse.success) {
      res.status(400).json({ error: "Invalid room id" });
      return;
    }
    const roomId = idParse.data;
    const supa = getSupabaseAdmin();

    const { data: membership } = await supa
      .from("chat_room_members")
      .select("room_id")
      .eq("room_id", roomId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership) {
      res.status(403).json({ error: "Not a member of this room" });
      return;
    }

    const readAt = new Date().toISOString();
    const { error } = await supa
      .from("chat_room_members")
      .update({ last_read_at: readAt })
      .eq("room_id", roomId)
      .eq("user_id", userId);

    if (error && !isMissingTableError(error)) {
      res.status(500).json({ error: "Failed to mark as read" });
      return;
    }

    broadcastToRoom(roomId, "room_read", { room_id: roomId, user_id: userId, read_at: readAt });

    res.json({ ok: true });
  }),
);

router.post(
  "/chat/rooms/:roomId/archive",
  requireAuth(async (req, res, userId) => {
    const idParse = UuidParam.safeParse(req.params.roomId);
    if (!idParse.success) {
      res.status(400).json({ error: "Invalid room id" });
      return;
    }
    const roomId = idParse.data;
    const supa = getSupabaseAdmin();

    const { data: membership } = await supa
      .from("chat_room_members")
      .select("room_id")
      .eq("room_id", roomId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership) {
      res.status(403).json({ error: "Not a member of this room" });
      return;
    }

    const { data: room } = await supa
      .from("chat_rooms")
      .select("kind")
      .eq("id", roomId)
      .maybeSingle();
    if (!room || (room as { kind: string }).kind !== "dm") {
      res.status(400).json({ error: "Only DM threads can be archived" });
      return;
    }

    const { error } = await supa
      .from("chat_room_members")
      .update({ archived_at: new Date().toISOString() })
      .eq("room_id", roomId)
      .eq("user_id", userId);

    if (error) {
      res.status(500).json({ error: "Failed to archive" });
      return;
    }

    res.json({ ok: true });
  }),
);

router.post(
  "/users/:userId/block",
  requireAuth(async (req, res, callerId) => {
    const targetUserId = req.params.userId;
    if (!targetUserId || targetUserId === callerId) {
      res.status(400).json({ error: "Cannot block yourself" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { error } = await supa
      .from("user_blocks")
      .upsert(
        { blocker_user_id: callerId, blocked_user_id: targetUserId },
        { onConflict: "blocker_user_id,blocked_user_id" },
      );
    if (error) {
      if (isMissingTableError(error)) {
        res.status(503).json({ error: "Chat feature not yet provisioned" });
        return;
      }
      res.status(500).json({ error: "Failed to block user" });
      return;
    }
    res.json({ ok: true });
  }),
);

router.delete(
  "/users/:userId/block",
  requireAuth(async (req, res, callerId) => {
    const targetUserId = req.params.userId;
    if (!targetUserId) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { error } = await supa
      .from("user_blocks")
      .delete()
      .eq("blocker_user_id", callerId)
      .eq("blocked_user_id", targetUserId);
    if (error && !isMissingTableError(error)) {
      res.status(500).json({ error: "Failed to unblock user" });
      return;
    }
    res.json({ ok: true });
  }),
);

router.get(
  "/users/me/blocks",
  requireAuth(async (_req, res, userId) => {
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("user_blocks")
      .select("blocked_user_id, created_at, users:blocked_user_id(id, display_name, avatar_url)")
      .eq("blocker_user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      if (isMissingTableError(error)) {
        res.json({ blocks: [] });
        return;
      }
      res.status(500).json({ error: "Failed to load block list" });
      return;
    }
    interface BlockRow {
      blocked_user_id: string;
      created_at: string;
      users: { id: string; display_name: string | null; avatar_url: string | null } |
        Array<{ id: string; display_name: string | null; avatar_url: string | null }> | null;
    }
    const blocks = ((data ?? []) as BlockRow[]).map((b) => {
      const u = Array.isArray(b.users) ? b.users[0] : b.users;
      return {
        user_id: b.blocked_user_id,
        display_name: u?.display_name ?? null,
        avatar_url: u?.avatar_url ?? null,
        created_at: b.created_at,
      };
    });
    res.json({ blocks });
  }),
);

router.get(
  "/chat/stream",
  requireAuth(async (req, res, userId) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(`event: connected\ndata: ${JSON.stringify({ userId })}\n\n`);

    let clients = sseClients.get(userId);
    if (!clients) {
      clients = new Set();
      sseClients.set(userId, clients);
    }
    clients.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 30_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      const c = sseClients.get(userId);
      if (c) {
        c.delete(res);
        if (c.size === 0) sseClients.delete(userId);
      }
    };

    req.on("close", cleanup);
    req.on("error", cleanup);
  }),
);

router.get(
  "/chat/unread-count",
  requireAuth(async (_req, res, userId) => {
    const supa = getSupabaseAdmin();

    const { data: memberships } = await supa
      .from("chat_room_members")
      .select("room_id, last_read_at, archived_at")
      .eq("user_id", userId);

    if (!memberships || (memberships as unknown[]).length === 0) {
      res.json({ count: 0 });
      return;
    }

    interface MRow { room_id: string; last_read_at: string | null; archived_at: string | null }
    const ms = memberships as MRow[];
    const activeMs = ms.filter((m) => !m.archived_at);

    if (activeMs.length === 0) {
      res.json({ count: 0 });
      return;
    }

    const roomIds = activeMs.map((m) => m.room_id);
    const { data: msgs } = await supa
      .from("chat_messages")
      .select("room_id, created_at, sender_user_id")
      .in("room_id", roomIds)
      .is("deleted_at", null)
      .neq("sender_user_id", userId);

    if (!msgs) {
      res.json({ count: 0 });
      return;
    }

    const readMap = new Map<string, string | null>();
    for (const m of activeMs) readMap.set(m.room_id, m.last_read_at);

    let count = 0;
    for (const msg of msgs as Array<{ room_id: string; created_at: string; sender_user_id: string }>) {
      const lastRead = readMap.get(msg.room_id);
      if (!lastRead || new Date(msg.created_at) > new Date(lastRead)) {
        count++;
      }
    }

    res.json({ count });
  }),
);

export default router;
