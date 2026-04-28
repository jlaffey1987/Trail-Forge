import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { randomBytes } from "crypto";
import { z } from "zod";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GroupIdParam = z.string().uuid();
const TrailIdParam = z.string().uuid();

const CreateGroupBody = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(2000).nullish(),
  cover_photo_key: z.string().max(512).nullish(),
});

const UpdateGroupBody = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  cover_photo_key: z.string().max(512).nullable().optional(),
});

const CreateInviteBody = z
  .object({
    email: z.string().email().max(254).optional(),
    username: z.string().trim().min(1).max(64).optional(),
  })
  .refine(
    (v) => !(v.email && v.username),
    { message: "Provide email or username, not both" },
  );

const ShareTrailBody = z.object({
  group_ids: z.array(z.string().uuid()).min(0).max(50),
});

const RoleEnum = z.enum(["owner", "admin", "member"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AuthedHandler {
  (req: Request, res: Response, userId: string): Promise<void>;
}

function requireAuth(handler: AuthedHandler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      await handler(req, res, auth.userId);
    } catch (err) {
      next(err);
    }
  };
}

function isMissingTableError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    /relation .* does not exist/i.test(err.message ?? "") ||
    /Could not find the table/i.test(err.message ?? "")
  );
}

function generateInviteToken(): string {
  // 24 random bytes → 32-char URL-safe base64url string.
  return randomBytes(24).toString("base64url");
}

const INVITE_DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

async function fetchMembership(groupId: string, userId: string) {
  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from("group_members")
    .select("group_id, user_id, role, joined_at")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error && !isMissingTableError(error)) return { error };
  if (!data) return { notMember: true as const };
  return {
    member: data as {
      group_id: string;
      user_id: string;
      role: "owner" | "admin" | "member";
      joined_at: string;
    },
  };
}

// ---------------------------------------------------------------------------
// LIST groups the caller belongs to
// ---------------------------------------------------------------------------

router.get(
  "/groups",
  requireAuth(async (_req, res, userId) => {
    const supa = getSupabaseAdmin();
    const { data: memberships, error: mErr } = await supa
      .from("group_members")
      .select("group_id, role, joined_at, groups(*)")
      .eq("user_id", userId);
    if (mErr) {
      if (isMissingTableError(mErr)) {
        res.json({ items: [] });
        return;
      }
      res.status(500).json({ error: "Failed to load groups" });
      return;
    }
    interface Row {
      group_id: string;
      role: string;
      joined_at: string;
      groups: Record<string, unknown> | Record<string, unknown>[] | null;
    }
    const rows = (memberships ?? []) as Row[];
    const items = rows
      .map((r) => {
        const g = Array.isArray(r.groups) ? r.groups[0] : r.groups;
        if (!g) return null;
        return { ...g, role: r.role, joined_at: r.joined_at };
      })
      .filter(
        (x): x is Record<string, unknown> & { role: string; joined_at: string } =>
          x != null,
      );

    // Pending invites count for the caller (by email).
    let invitesPending = 0;
    try {
      const cu = await clerkClient.users.getUser(userId);
      const email = (
        cu.primaryEmailAddress?.emailAddress ??
        cu.emailAddresses[0]?.emailAddress ??
        ""
      ).toLowerCase();
      if (email) {
        const { count } = await supa
          .from("group_invites")
          .select("id", { head: true, count: "exact" })
          .ilike("email", email)
          .is("accepted_at", null)
          .gt("expires_at", new Date().toISOString());
        invitesPending = count ?? 0;
      }
    } catch {
      // ignore — clerk lookup failures shouldn't break the listing
    }

    res.json({ items, invitesPending });
  }),
);

// ---------------------------------------------------------------------------
// CREATE group
// ---------------------------------------------------------------------------

router.post(
  "/groups",
  requireAuth(async (req, res, userId) => {
    const parsed = CreateGroupBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid group payload" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data: group, error: gErr } = await supa
      .from("groups")
      .insert({
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        cover_photo_key: parsed.data.cover_photo_key ?? null,
        owner_user_id: userId,
      })
      .select()
      .single();
    if (gErr) {
      if (isMissingTableError(gErr)) {
        res.status(503).json({
          error:
            "Groups feature not yet provisioned — apply migration 0006_groups.sql",
        });
        return;
      }
      req.log.error({ err: gErr }, "create group failed");
      res.status(500).json({ error: "Failed to create group" });
      return;
    }
    // Auto-add owner as a member with owner role.
    const { error: mErr } = await supa
      .from("group_members")
      .insert({ group_id: group.id, user_id: userId, role: "owner" });
    if (mErr) {
      req.log.error({ err: mErr }, "create owner membership failed");
    }
    res.json(group);
  }),
);

// ---------------------------------------------------------------------------
// GET group detail (members + invites + shared trail count)
// ---------------------------------------------------------------------------

router.get(
  "/groups/:groupId",
  requireAuth(async (req, res, userId) => {
    const idParse = GroupIdParam.safeParse(req.params.groupId);
    if (!idParse.success) {
      res.status(400).json({ error: "Invalid group id" });
      return;
    }
    const groupId = idParse.data;
    const ms = await fetchMembership(groupId, userId);
    if ("error" in ms && ms.error) {
      req.log.error({ err: ms.error }, "membership load failed");
      res.status(500).json({ error: "Failed to load group" });
      return;
    }
    if ("notMember" in ms) {
      res.status(403).json({ error: "Not a member of this group" });
      return;
    }
    const callerRole = ms.member.role;

    const supa = getSupabaseAdmin();
    const { data: group, error: gErr } = await supa
      .from("groups")
      .select("*")
      .eq("id", groupId)
      .maybeSingle();
    if (gErr || !group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    const { data: members } = await supa
      .from("group_members")
      .select("user_id, role, joined_at, users(id, display_name, email, avatar_url)")
      .eq("group_id", groupId)
      .order("joined_at", { ascending: true });

    interface MemberRow {
      user_id: string;
      role: string;
      joined_at: string;
      users:
        | { id: string; display_name: string | null; email: string | null; avatar_url: string | null }
        | { id: string; display_name: string | null; email: string | null; avatar_url: string | null }[]
        | null;
    }
    const memberItems = ((members ?? []) as MemberRow[]).map((m) => {
      const u = Array.isArray(m.users) ? m.users[0] : m.users;
      return {
        user_id: m.user_id,
        role: m.role,
        joined_at: m.joined_at,
        display_name: u?.display_name ?? null,
        email: u?.email ?? null,
        avatar_url: u?.avatar_url ?? null,
      };
    });

    let invites: Array<Record<string, unknown>> = [];
    if (callerRole === "owner" || callerRole === "admin") {
      const { data: inv } = await supa
        .from("group_invites")
        .select("id, token, email, expires_at, accepted_at, created_at, created_by_user_id")
        .eq("group_id", groupId)
        .order("created_at", { ascending: false });
      invites = (inv ?? []) as Array<Record<string, unknown>>;
    }

    const { count: sharedCount } = await supa
      .from("trail_shares")
      .select("trail_id", { head: true, count: "exact" })
      .eq("group_id", groupId);

    res.json({
      group,
      callerRole,
      members: memberItems,
      invites,
      sharedTrailCount: sharedCount ?? 0,
    });
  }),
);

// ---------------------------------------------------------------------------
// UPDATE group (owner/admin only)
// ---------------------------------------------------------------------------

router.patch(
  "/groups/:groupId",
  requireAuth(async (req, res, userId) => {
    const idParse = GroupIdParam.safeParse(req.params.groupId);
    if (!idParse.success) {
      res.status(400).json({ error: "Invalid group id" });
      return;
    }
    const parsed = UpdateGroupBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid update payload" });
      return;
    }
    const ms = await fetchMembership(idParse.data, userId);
    if ("notMember" in ms) {
      res.status(403).json({ error: "Not a member" });
      return;
    }
    if ("error" in ms && ms.error) {
      res.status(500).json({ error: "Failed to load membership" });
      return;
    }
    if (ms.member.role !== "owner" && ms.member.role !== "admin") {
      res.status(403).json({ error: "Only owners or admins can edit a group" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("groups")
      .update(parsed.data)
      .eq("id", idParse.data)
      .select()
      .single();
    if (error) {
      res.status(500).json({ error: "Failed to update group" });
      return;
    }
    res.json(data);
  }),
);

// ---------------------------------------------------------------------------
// DELETE group (owner only)
// ---------------------------------------------------------------------------

router.delete(
  "/groups/:groupId",
  requireAuth(async (req, res, userId) => {
    const idParse = GroupIdParam.safeParse(req.params.groupId);
    if (!idParse.success) {
      res.status(400).json({ error: "Invalid group id" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data: g, error: gErr } = await supa
      .from("groups")
      .select("id, owner_user_id")
      .eq("id", idParse.data)
      .maybeSingle();
    if (gErr || !g) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (g.owner_user_id !== userId) {
      res.status(403).json({ error: "Only the owner can delete a group" });
      return;
    }
    const { error } = await supa.from("groups").delete().eq("id", idParse.data);
    if (error) {
      res.status(500).json({ error: "Failed to delete group" });
      return;
    }
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// LEAVE group (any non-owner member)
// ---------------------------------------------------------------------------

router.post(
  "/groups/:groupId/leave",
  requireAuth(async (req, res, userId) => {
    const idParse = GroupIdParam.safeParse(req.params.groupId);
    if (!idParse.success) {
      res.status(400).json({ error: "Invalid group id" });
      return;
    }
    const ms = await fetchMembership(idParse.data, userId);
    if ("notMember" in ms) {
      res.status(404).json({ error: "Not a member" });
      return;
    }
    if ("error" in ms && ms.error) {
      res.status(500).json({ error: "Failed to load membership" });
      return;
    }
    if (ms.member.role === "owner") {
      res.status(400).json({ error: "Owners must transfer ownership before leaving" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { error } = await supa
      .from("group_members")
      .delete()
      .eq("group_id", idParse.data)
      .eq("user_id", userId);
    if (error) {
      res.status(500).json({ error: "Failed to leave group" });
      return;
    }
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// REMOVE member (owner / admin)
// ---------------------------------------------------------------------------

router.delete(
  "/groups/:groupId/members/:userId",
  requireAuth(async (req, res, callerId) => {
    const idParse = GroupIdParam.safeParse(req.params.groupId);
    if (!idParse.success) {
      res.status(400).json({ error: "Invalid group id" });
      return;
    }
    const rawTarget = req.params.userId;
    const targetUserId = Array.isArray(rawTarget) ? rawTarget[0] : rawTarget;
    if (!targetUserId) {
      res.status(400).json({ error: "Missing user id" });
      return;
    }
    const callerMs = await fetchMembership(idParse.data, callerId);
    if ("notMember" in callerMs) {
      res.status(403).json({ error: "Not a member" });
      return;
    }
    if ("error" in callerMs && callerMs.error) {
      res.status(500).json({ error: "Failed to load membership" });
      return;
    }
    if (callerMs.member.role !== "owner" && callerMs.member.role !== "admin") {
      res.status(403).json({ error: "Only owners or admins can remove members" });
      return;
    }
    if (targetUserId === callerId) {
      res.status(400).json({ error: "Use POST /leave to leave a group" });
      return;
    }
    // Don't allow removing the owner.
    const targetMs = await fetchMembership(idParse.data, targetUserId);
    if ("notMember" in targetMs) {
      res.status(404).json({ error: "User is not a member" });
      return;
    }
    if ("error" in targetMs && targetMs.error) {
      res.status(500).json({ error: "Failed to load target membership" });
      return;
    }
    if (targetMs.member.role === "owner") {
      res.status(400).json({ error: "Cannot remove the group owner" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { error } = await supa
      .from("group_members")
      .delete()
      .eq("group_id", idParse.data)
      .eq("user_id", targetUserId);
    if (error) {
      res.status(500).json({ error: "Failed to remove member" });
      return;
    }
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// TRANSFER ownership (owner only)
// ---------------------------------------------------------------------------

router.post(
  "/groups/:groupId/transfer",
  requireAuth(async (req, res, callerId) => {
    const idParse = GroupIdParam.safeParse(req.params.groupId);
    if (!idParse.success) {
      res.status(400).json({ error: "Invalid group id" });
      return;
    }
    const parsed = z.object({ to_user_id: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing to_user_id" });
      return;
    }
    const callerMs = await fetchMembership(idParse.data, callerId);
    if ("notMember" in callerMs) {
      res.status(403).json({ error: "Not a member" });
      return;
    }
    if ("error" in callerMs && callerMs.error) {
      res.status(500).json({ error: "Failed to load membership" });
      return;
    }
    if (callerMs.member.role !== "owner") {
      res.status(403).json({ error: "Only the current owner can transfer ownership" });
      return;
    }
    const targetMs = await fetchMembership(idParse.data, parsed.data.to_user_id);
    if ("notMember" in targetMs) {
      res.status(400).json({ error: "Target user is not a group member" });
      return;
    }
    const supa = getSupabaseAdmin();
    // Atomic transfer via DB function (demote, promote, update groups row in
    // a single transaction).
    const { error: rpcErr } = await supa.rpc("transfer_group_ownership", {
      p_group_id: idParse.data,
      p_from_user_id: callerId,
      p_to_user_id: parsed.data.to_user_id,
    });
    if (rpcErr) {
      const msg = (rpcErr.message ?? "").toLowerCase();
      if (msg.includes("not the current owner")) {
        res.status(403).json({ error: "Only the current owner can transfer ownership" });
        return;
      }
      if (msg.includes("not a member")) {
        res.status(400).json({ error: "Target user is not a group member" });
        return;
      }
      if (msg.includes("cannot transfer to self")) {
        res.status(400).json({ error: "Cannot transfer ownership to yourself" });
        return;
      }
      if (isMissingTableError(rpcErr)) {
        res.status(503).json({
          error:
            "Groups feature not yet provisioned — apply migration 0006_groups.sql",
        });
        return;
      }
      req.log.error({ err: rpcErr }, "transfer ownership rpc failed");
      res.status(500).json({ error: "Failed to transfer ownership" });
      return;
    }
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// CREATE invite (link or by email). Owner / admin only.
// ---------------------------------------------------------------------------

router.post(
  "/groups/:groupId/invites",
  requireAuth(async (req, res, callerId) => {
    const idParse = GroupIdParam.safeParse(req.params.groupId);
    if (!idParse.success) {
      res.status(400).json({ error: "Invalid group id" });
      return;
    }
    const callerMs = await fetchMembership(idParse.data, callerId);
    if ("notMember" in callerMs) {
      res.status(403).json({ error: "Not a member" });
      return;
    }
    if ("error" in callerMs && callerMs.error) {
      res.status(500).json({ error: "Failed to load membership" });
      return;
    }
    if (callerMs.member.role !== "owner" && callerMs.member.role !== "admin") {
      res.status(403).json({ error: "Only owners or admins can invite" });
      return;
    }
    const parsed = CreateInviteBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid invite payload" });
      return;
    }
    let email: string | null = parsed.data.email ? parsed.data.email.toLowerCase() : null;
    let targetUserId: string | null = null;
    if (parsed.data.username) {
      // Resolve a Clerk username → userId. Returns 404 if no match.
      try {
        const lookup = await clerkClient.users.getUserList({
          username: [parsed.data.username],
          limit: 1,
        });
        const list = Array.isArray(lookup)
          ? (lookup as Array<{ id: string }>)
          : ((lookup as { data?: Array<{ id: string }> }).data ?? []);
        if (list.length === 0) {
          res.status(404).json({ error: "No user found with that username" });
          return;
        }
        targetUserId = list[0].id;
      } catch (err) {
        req.log.error({ err }, "username lookup failed");
        res.status(502).json({ error: "Username lookup failed" });
        return;
      }
      if (targetUserId === callerId) {
        res.status(400).json({ error: "Cannot invite yourself" });
        return;
      }
      // If the target is already a member, short-circuit.
      const existing = await fetchMembership(idParse.data, targetUserId);
      if ("member" in existing) {
        res.status(409).json({ error: "User is already a member" });
        return;
      }
      // Best-effort: ensure a `users` row exists so the FK holds. The
      // /me/sync flow normally creates it on sign-in; insert here if
      // the invitee hasn't synced yet.
      const supaForUser = getSupabaseAdmin();
      await supaForUser
        .from("users")
        .upsert({ id: targetUserId }, { onConflict: "id", ignoreDuplicates: true });
    }
    const supa = getSupabaseAdmin();
    const token = generateInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_DEFAULT_TTL_MS).toISOString();
    const { data, error } = await supa
      .from("group_invites")
      .insert({
        group_id: idParse.data,
        token,
        email,
        target_user_id: targetUserId,
        expires_at: expiresAt,
        created_by_user_id: callerId,
      })
      .select()
      .single();
    if (error) {
      req.log.error({ err: error }, "create invite failed");
      res.status(500).json({ error: "Failed to create invite" });
      return;
    }
    res.json(data);
  }),
);

// ---------------------------------------------------------------------------
// REVOKE invite (owner / admin)
// ---------------------------------------------------------------------------

router.delete(
  "/groups/:groupId/invites/:inviteId",
  requireAuth(async (req, res, callerId) => {
    const idParse = GroupIdParam.safeParse(req.params.groupId);
    if (!idParse.success) {
      res.status(400).json({ error: "Invalid group id" });
      return;
    }
    const inviteId = req.params.inviteId;
    const callerMs = await fetchMembership(idParse.data, callerId);
    if ("notMember" in callerMs || ("error" in callerMs && callerMs.error)) {
      res.status(403).json({ error: "Not a member" });
      return;
    }
    if (callerMs.member.role !== "owner" && callerMs.member.role !== "admin") {
      res.status(403).json({ error: "Only owners or admins can revoke invites" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { error } = await supa
      .from("group_invites")
      .delete()
      .eq("id", inviteId)
      .eq("group_id", idParse.data);
    if (error) {
      res.status(500).json({ error: "Failed to revoke invite" });
      return;
    }
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// LOOKUP invite by token (public — used by the accept page to show context)
// ---------------------------------------------------------------------------

router.get("/invites/:token", async (req: Request, res: Response) => {
  const token = req.params.token;
  if (!token) {
    res.status(400).json({ error: "Missing token" });
    return;
  }
  try {
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("group_invites")
      .select("id, group_id, email, expires_at, accepted_at, groups(name, description)")
      .eq("token", token)
      .maybeSingle();
    if (error || !data) {
      res.status(404).json({ error: "Invite not found" });
      return;
    }
    const accepted = data.accepted_at != null;
    const expired = new Date(data.expires_at).getTime() < Date.now();
    interface GroupRel {
      name: string;
      description: string | null;
    }
    const g = Array.isArray(data.groups) ? data.groups[0] : data.groups;
    res.json({
      id: data.id,
      group_id: data.group_id,
      email: data.email,
      expires_at: data.expires_at,
      accepted,
      expired,
      group: g as GroupRel | null,
    });
  } catch (err) {
    req.log.error({ err }, "invite lookup failed");
    res.status(500).json({ error: "Failed to look up invite" });
  }
});

// ---------------------------------------------------------------------------
// ACCEPT invite (signed-in)
// ---------------------------------------------------------------------------

router.post(
  "/invites/:token/accept",
  requireAuth(async (req, res, userId) => {
    const token = req.params.token;
    if (!token) {
      res.status(400).json({ error: "Missing token" });
      return;
    }
    // Look up the caller's verified primary email so the DB function can
    // enforce email-binding when the invite specifies one.
    let callerEmail: string | null = null;
    try {
      const cu = await clerkClient.users.getUser(userId);
      const primary = cu.emailAddresses.find(
        (e) => e.id === cu.primaryEmailAddressId,
      ) ?? cu.emailAddresses[0];
      const verifiedStatus = primary?.verification?.status;
      if (primary?.emailAddress && verifiedStatus === "verified") {
        callerEmail = primary.emailAddress.toLowerCase();
      }
    } catch (err) {
      req.log.warn({ err }, "clerk user lookup failed during invite accept");
    }
    const supa = getSupabaseAdmin();
    const { data, error } = await supa.rpc("claim_group_invite", {
      p_token: token,
      p_user_id: userId,
      p_user_email: callerEmail,
    });
    if (error) {
      const code = error.code;
      if (code === "P0002") {
        res.status(404).json({ error: "Invite not found or already used" });
        return;
      }
      if (code === "P0003") {
        res.status(410).json({ error: "Invite expired" });
        return;
      }
      if (code === "P0004") {
        res
          .status(403)
          .json({ error: "This invite is for a different email address" });
        return;
      }
      if (code === "P0005") {
        res.status(403).json({ error: "This invite is for a different user" });
        return;
      }
      if (isMissingTableError(error)) {
        res.status(503).json({
          error:
            "Groups feature not yet provisioned — apply migration 0006_groups.sql",
        });
        return;
      }
      req.log.error({ err: error }, "accept invite rpc failed");
      res.status(500).json({ error: "Failed to accept invite" });
      return;
    }
    res.json({ ok: true, group_id: data });
  }),
);

// ---------------------------------------------------------------------------
// ACCEPT a pending invite by id (no token in the URL — must be addressed to
// the caller by email match or target_user_id binding). Used by the in-app
// invites inbox.
// ---------------------------------------------------------------------------

router.post(
  "/me/invites/:inviteId/accept",
  requireAuth(async (req, res, userId) => {
    const inviteId = req.params.inviteId;
    const supa = getSupabaseAdmin();
    let callerEmail: string | null = null;
    try {
      const cu = await clerkClient.users.getUser(userId);
      const primary = cu.emailAddresses.find(
        (e) => e.id === cu.primaryEmailAddressId,
      ) ?? cu.emailAddresses[0];
      if (primary?.emailAddress && primary.verification?.status === "verified") {
        callerEmail = primary.emailAddress.toLowerCase();
      }
    } catch {
      // ignore
    }
    const { data: invite, error: lookupErr } = await supa
      .from("group_invites")
      .select("token, email, target_user_id, accepted_at, declined_at")
      .eq("id", inviteId)
      .maybeSingle();
    if (lookupErr || !invite) {
      res.status(404).json({ error: "Invite not found" });
      return;
    }
    if (invite.accepted_at) {
      res.status(409).json({ error: "Invite already used" });
      return;
    }
    if (invite.declined_at) {
      res.status(410).json({ error: "Invite was declined" });
      return;
    }
    const matchesEmail =
      invite.email != null && callerEmail != null
        ? invite.email.toLowerCase() === callerEmail
        : false;
    const matchesTarget = invite.target_user_id === userId;
    if (!matchesEmail && !matchesTarget) {
      res.status(403).json({ error: "This invite is not addressed to you" });
      return;
    }
    const { data: groupId, error: rpcErr } = await supa.rpc("claim_group_invite", {
      p_token: invite.token,
      p_user_id: userId,
      p_user_email: callerEmail,
    });
    if (rpcErr) {
      const code = rpcErr.code;
      if (code === "P0002") {
        res.status(404).json({ error: "Invite not found or already used" });
        return;
      }
      if (code === "P0003") {
        res.status(410).json({ error: "Invite expired" });
        return;
      }
      if (code === "P0004" || code === "P0005") {
        res.status(403).json({ error: "This invite is not addressed to you" });
        return;
      }
      req.log.error({ err: rpcErr }, "accept invite by id rpc failed");
      res.status(500).json({ error: "Failed to accept invite" });
      return;
    }
    res.json({ ok: true, group_id: groupId });
  }),
);

// ---------------------------------------------------------------------------
// DECLINE invite by id (must be addressed to the caller — by email match or
// by target_user_id binding).
// ---------------------------------------------------------------------------

router.post(
  "/me/invites/:inviteId/decline",
  requireAuth(async (req, res, userId) => {
    const inviteId = req.params.inviteId;
    const supa = getSupabaseAdmin();
    let callerEmail: string | null = null;
    try {
      const cu = await clerkClient.users.getUser(userId);
      const primary = cu.emailAddresses.find(
        (e) => e.id === cu.primaryEmailAddressId,
      ) ?? cu.emailAddresses[0];
      if (primary?.emailAddress && primary.verification?.status === "verified") {
        callerEmail = primary.emailAddress.toLowerCase();
      }
    } catch {
      // ignore
    }
    const { data: invite, error: lookupErr } = await supa
      .from("group_invites")
      .select("id, email, target_user_id, accepted_at, declined_at")
      .eq("id", inviteId)
      .maybeSingle();
    if (lookupErr || !invite) {
      res.status(404).json({ error: "Invite not found" });
      return;
    }
    if (invite.accepted_at) {
      res.status(409).json({ error: "Invite already used" });
      return;
    }
    if (invite.declined_at) {
      res.json({ ok: true });
      return;
    }
    const matchesEmail =
      invite.email != null && callerEmail != null
        ? invite.email.toLowerCase() === callerEmail
        : false;
    const matchesTarget = invite.target_user_id === userId;
    if (!matchesEmail && !matchesTarget) {
      res.status(403).json({ error: "This invite is not addressed to you" });
      return;
    }
    const { error: upErr } = await supa
      .from("group_invites")
      .update({
        declined_at: new Date().toISOString(),
        declined_by_user_id: userId,
      })
      .eq("id", inviteId)
      .is("accepted_at", null)
      .is("declined_at", null);
    if (upErr) {
      req.log.error({ err: upErr }, "decline invite failed");
      res.status(500).json({ error: "Failed to decline invite" });
      return;
    }
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// LIST pending invites addressed to the caller (by email match OR
// by target_user_id binding). Used by the in-app invites inbox.
// ---------------------------------------------------------------------------

router.get(
  "/me/invites",
  requireAuth(async (req, res, userId) => {
    const supa = getSupabaseAdmin();
    let email: string | null = null;
    try {
      const cu = await clerkClient.users.getUser(userId);
      const primary = cu.emailAddresses.find(
        (e) => e.id === cu.primaryEmailAddressId,
      ) ?? cu.emailAddresses[0];
      if (primary?.emailAddress && primary.verification?.status === "verified") {
        email = primary.emailAddress.toLowerCase();
      }
    } catch {
      // ignore
    }
    const nowIso = new Date().toISOString();
    // Two parallel queries (email-bound + user-bound) merged.
    const [byEmailRes, byTargetRes] = await Promise.all([
      email
        ? supa
            .from("group_invites")
            .select("id, group_id, email, target_user_id, expires_at, created_at, groups(name, description)")
            .ilike("email", email)
            .is("accepted_at", null)
            .is("declined_at", null)
            .gt("expires_at", nowIso)
        : Promise.resolve({ data: [] as unknown[], error: null }),
      supa
        .from("group_invites")
        .select("id, group_id, email, target_user_id, expires_at, created_at, groups(name, description)")
        .eq("target_user_id", userId)
        .is("accepted_at", null)
        .is("declined_at", null)
        .gt("expires_at", nowIso),
    ]);
    if (byEmailRes.error && !isMissingTableError(byEmailRes.error)) {
      req.log.error({ err: byEmailRes.error }, "list invites (email) failed");
      res.status(500).json({ error: "Failed to load invites" });
      return;
    }
    if (byTargetRes.error && !isMissingTableError(byTargetRes.error)) {
      req.log.error({ err: byTargetRes.error }, "list invites (target) failed");
      res.status(500).json({ error: "Failed to load invites" });
      return;
    }
    interface InviteRow {
      id: string;
      group_id: string;
      email: string | null;
      target_user_id: string | null;
      expires_at: string;
      created_at: string;
      groups: { name: string; description: string | null } | { name: string; description: string | null }[] | null;
    }
    const seen = new Set<string>();
    const merged: Array<Record<string, unknown>> = [];
    for (const row of [
      ...((byEmailRes.data ?? []) as InviteRow[]),
      ...((byTargetRes.data ?? []) as InviteRow[]),
    ]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const g = Array.isArray(row.groups) ? row.groups[0] : row.groups;
      merged.push({
        id: row.id,
        group_id: row.group_id,
        email: row.email,
        target_user_id: row.target_user_id,
        expires_at: row.expires_at,
        created_at: row.created_at,
        group: g,
      });
    }
    merged.sort((a, b) =>
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
    );
    res.json({ items: merged });
  }),
);

// ---------------------------------------------------------------------------
// LIST recent activity ("notifications") for groups the caller belongs to.
//
// The feed is computed on demand from the existing append-only source rows
// (no separate event log) — each tick we union together:
//
//   * trail_shares  → "<actor> shared <trail> into <group>"
//   * group_members → "<actor> joined <group>"   (covers accepted invites,
//                       which simply create a group_members row)
//
// Self-events are filtered out (you don't need a notification for an action
// you took yourself). Trails that have been soft-deleted are dropped from
// the page so we never hand out a deep-link the user can't open.
//
// Pagination: client passes ?before=<ISO occurred_at> to walk older events.
// Returns the page itself plus a `nextBefore` cursor and a server-side
// `unreadCount` (total events newer than `users.notifications_read_at`,
// across all the caller's groups — not just the current page).
//
//   GET /api/me/notifications?limit=20&before=2026-04-01T00:00:00Z
// ---------------------------------------------------------------------------

router.get(
  "/me/notifications",
  requireAuth(async (req, res, userId) => {
    const supa = getSupabaseAdmin();

    const limitRaw = Number.parseInt(String(req.query.limit ?? "20"), 10);
    const limit = Math.min(
      Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1),
      100,
    );
    // Cursor format: "<iso>" (legacy, no tie-breaker) or "<iso>|<id>". The
    // composite form lets us page deterministically through events that share
    // an `occurred_at` timestamp without dropping rows on the boundary.
    const beforeRaw =
      typeof req.query.before === "string" ? req.query.before : null;
    let beforeIso: string | null = null;
    let beforeId: string | null = null;
    if (beforeRaw) {
      const pipe = beforeRaw.indexOf("|");
      const isoPart = pipe >= 0 ? beforeRaw.slice(0, pipe) : beforeRaw;
      const idPart = pipe >= 0 ? beforeRaw.slice(pipe + 1) : "";
      if (!Number.isNaN(Date.parse(isoPart))) {
        beforeIso = isoPart;
        beforeId = idPart || null;
      }
    }

    // -- group memberships --
    const { data: memberships, error: mErr } = await supa
      .from("group_members")
      .select("group_id")
      .eq("user_id", userId);
    if (mErr && !isMissingTableError(mErr)) {
      req.log.error({ err: mErr }, "notifications memberships load failed");
      res.status(500).json({ error: "Failed to load notifications" });
      return;
    }
    const groupIds = ((memberships ?? []) as Array<{ group_id: string }>).map(
      (m) => m.group_id,
    );

    // -- last-read cursor (used both for unread badge + per-item flag) --
    let lastReadAt: string | null = null;
    {
      const { data: userRow, error: uErr } = await supa
        .from("users")
        .select("notifications_read_at")
        .eq("id", userId)
        .maybeSingle();
      if (uErr && !isMissingTableError(uErr) && uErr.code !== "42703") {
        req.log.warn({ err: uErr }, "notifications read-cursor load failed");
      }
      const v = (userRow as { notifications_read_at?: string | null } | null)
        ?.notifications_read_at;
      if (typeof v === "string") lastReadAt = v;
    }

    if (groupIds.length === 0) {
      res.json({
        items: [],
        unreadCount: 0,
        lastReadAt,
        nextBefore: null,
      });
      return;
    }

    // Over-fetch a bit so we still hit `limit` after merge + deleted-trail drops.
    const fetchLimit = limit * 2 + 5;

    // We use `.lte` here (not `.lt`) so rows that share the boundary
    // timestamp aren't dropped. Final tie-break filtering happens after the
    // union, using the composite `(occurred_at, id)` cursor.
    let sharesQ = supa
      .from("trail_shares")
      .select("trail_id, group_id, shared_by_user_id, shared_at")
      .in("group_id", groupIds)
      .neq("shared_by_user_id", userId)
      .order("shared_at", { ascending: false })
      .limit(fetchLimit);
    if (beforeIso) sharesQ = sharesQ.lte("shared_at", beforeIso);

    let joinsQ = supa
      .from("group_members")
      .select("user_id, group_id, joined_at, role")
      .in("group_id", groupIds)
      .neq("user_id", userId)
      .order("joined_at", { ascending: false })
      .limit(fetchLimit);
    if (beforeIso) joinsQ = joinsQ.lte("joined_at", beforeIso);

    const [sharesRes, joinsRes] = await Promise.all([sharesQ, joinsQ]);

    if (sharesRes.error && !isMissingTableError(sharesRes.error)) {
      req.log.error(
        { err: sharesRes.error },
        "notifications trail_shares load failed",
      );
      res.status(500).json({ error: "Failed to load notifications" });
      return;
    }
    if (joinsRes.error && !isMissingTableError(joinsRes.error)) {
      req.log.error(
        { err: joinsRes.error },
        "notifications group_members load failed",
      );
      res.status(500).json({ error: "Failed to load notifications" });
      return;
    }

    interface ShareRow {
      trail_id: string;
      group_id: string;
      shared_by_user_id: string;
      shared_at: string;
    }
    interface JoinRow {
      user_id: string;
      group_id: string;
      joined_at: string;
      role: string;
    }
    const shareRows = (sharesRes.data ?? []) as ShareRow[];
    const joinRows = (joinsRes.data ?? []) as JoinRow[];

    // Hydrate referenced trails / groups / users in three parallel batches.
    const trailIds = [...new Set(shareRows.map((r) => r.trail_id))];
    const groupSet = new Set<string>();
    shareRows.forEach((r) => groupSet.add(r.group_id));
    joinRows.forEach((r) => groupSet.add(r.group_id));
    const userIdSet = new Set<string>();
    shareRows.forEach((r) => userIdSet.add(r.shared_by_user_id));
    joinRows.forEach((r) => userIdSet.add(r.user_id));

    const [trailsRes, groupsRes, usersRes] = await Promise.all([
      trailIds.length > 0
        ? supa
            .from("trails")
            .select("id, name, deleted_at")
            .in("id", trailIds)
        : Promise.resolve({
            data: [] as Array<Record<string, unknown>>,
            error: null,
          }),
      groupSet.size > 0
        ? supa.from("groups").select("id, name").in("id", [...groupSet])
        : Promise.resolve({
            data: [] as Array<Record<string, unknown>>,
            error: null,
          }),
      userIdSet.size > 0
        ? supa
            .from("users")
            .select("id, display_name, email, avatar_url")
            .in("id", [...userIdSet])
        : Promise.resolve({
            data: [] as Array<Record<string, unknown>>,
            error: null,
          }),
    ]);

    interface TrailLite {
      id: string;
      name: string | null;
      deleted_at: string | null;
    }
    interface GroupLite {
      id: string;
      name: string;
    }
    interface UserLite {
      id: string;
      display_name: string | null;
      email: string | null;
      avatar_url: string | null;
    }
    const trails = new Map<string, TrailLite>();
    for (const t of (trailsRes.data ?? []) as TrailLite[]) trails.set(t.id, t);
    const groups = new Map<string, GroupLite>();
    for (const g of (groupsRes.data ?? []) as GroupLite[]) groups.set(g.id, g);
    const users = new Map<string, UserLite>();
    for (const u of (usersRes.data ?? []) as UserLite[]) users.set(u.id, u);

    interface NotifBase {
      id: string;
      occurred_at: string;
      group: { id: string; name: string };
      actor: {
        id: string;
        display_name: string | null;
        email: string | null;
        avatar_url: string | null;
      };
      unread: boolean;
    }
    type Notif =
      | (NotifBase & {
          type: "trail_shared";
          trail: { id: string; name: string };
        })
      | (NotifBase & { type: "member_joined" });

    const isUnread = (iso: string) =>
      !lastReadAt || new Date(iso).getTime() > new Date(lastReadAt).getTime();

    const items: Notif[] = [];

    for (const r of shareRows) {
      const tr = trails.get(r.trail_id);
      if (!tr || tr.deleted_at != null) continue; // skip deleted trails
      const g = groups.get(r.group_id);
      if (!g) continue;
      const u = users.get(r.shared_by_user_id);
      items.push({
        id: `share:${r.trail_id}:${r.group_id}`,
        type: "trail_shared",
        occurred_at: r.shared_at,
        group: { id: g.id, name: g.name },
        trail: { id: tr.id, name: tr.name ?? "Trail" },
        actor: {
          id: r.shared_by_user_id,
          display_name: u?.display_name ?? null,
          email: u?.email ?? null,
          avatar_url: u?.avatar_url ?? null,
        },
        unread: isUnread(r.shared_at),
      });
    }
    for (const r of joinRows) {
      const g = groups.get(r.group_id);
      if (!g) continue;
      const u = users.get(r.user_id);
      items.push({
        id: `join:${r.user_id}:${r.group_id}`,
        type: "member_joined",
        occurred_at: r.joined_at,
        group: { id: g.id, name: g.name },
        actor: {
          id: r.user_id,
          display_name: u?.display_name ?? null,
          email: u?.email ?? null,
          avatar_url: u?.avatar_url ?? null,
        },
        unread: isUnread(r.joined_at),
      });
    }

    // Sort by `(occurred_at desc, id desc)` — the composite key matches the
    // tuple comparison we do for the cursor below.
    items.sort((a, b) => {
      const c = b.occurred_at.localeCompare(a.occurred_at);
      return c !== 0 ? c : b.id.localeCompare(a.id);
    });

    // Tuple-cursor filter: keep items strictly less-than the previous page's
    // last item under `(occurred_at, id)` ordering. Without this, rows that
    // share a timestamp with the boundary row would be returned twice (since
    // we used `.lte` above to avoid silently dropping ties).
    const filtered =
      beforeIso && beforeId
        ? items.filter(
            (it) =>
              it.occurred_at < beforeIso ||
              (it.occurred_at === beforeIso && it.id < beforeId),
          )
        : items;

    const page = filtered.slice(0, limit);
    const nextBefore =
      page.length === limit
        ? `${page[page.length - 1].occurred_at}|${page[page.length - 1].id}`
        : null;

    // Server-side total unread count (across all groups, not just this page).
    // Aligns with the visible feed: the share count uses an inner-join on
    // `trails` filtered by `deleted_at IS NULL` so soft-deleted trails don't
    // inflate the badge over what the panel actually displays. Run in
    // parallel to keep the request snappy.
    const cutoff = lastReadAt ?? "1970-01-01T00:00:00Z";
    const [unreadSharesRes, unreadJoinsRes] = await Promise.all([
      supa
        .from("trail_shares")
        .select("trail_id, trails!inner(deleted_at)", {
          head: true,
          count: "exact",
        })
        .in("group_id", groupIds)
        .neq("shared_by_user_id", userId)
        .gt("shared_at", cutoff)
        .is("trails.deleted_at", null),
      supa
        .from("group_members")
        .select("user_id", { head: true, count: "exact" })
        .in("group_id", groupIds)
        .neq("user_id", userId)
        .gt("joined_at", cutoff),
    ]);
    const unreadCount =
      (unreadSharesRes.count ?? 0) + (unreadJoinsRes.count ?? 0);

    res.json({ items: page, unreadCount, lastReadAt, nextBefore });
  }),
);

// ---------------------------------------------------------------------------
// MARK ALL notifications read — bumps users.notifications_read_at to now().
// Subsequent /me/notifications calls will report `unreadCount: 0` until new
// activity occurs.
// ---------------------------------------------------------------------------

router.post(
  "/me/notifications/read",
  requireAuth(async (req, res, userId) => {
    const supa = getSupabaseAdmin();
    const nowIso = new Date().toISOString();
    const { error } = await supa
      .from("users")
      .update({ notifications_read_at: nowIso })
      .eq("id", userId);
    if (error) {
      if (isMissingTableError(error) || error.code === "42703") {
        res.status(503).json({
          error:
            "Notifications feature not yet provisioned — apply migration 0010_group_notifications.sql",
        });
        return;
      }
      req.log.error({ err: error }, "mark notifications read failed");
      res.status(500).json({ error: "Failed to mark notifications read" });
      return;
    }
    res.json({ ok: true, last_read_at: nowIso });
  }),
);

// ---------------------------------------------------------------------------
// AUTO-ACCEPT pending email invites for the caller. Called on sign-in via the
// existing /me/sync flow. Returns count of newly-joined groups.
// ---------------------------------------------------------------------------

router.post(
  "/me/invites/auto-accept",
  requireAuth(async (req, res, userId) => {
    const supa = getSupabaseAdmin();
    // Only auto-accept email-bound invites when the caller's primary email is
    // *verified* in Clerk. Otherwise an attacker who controlled an unverified
    // email row on a Clerk user could silently join private groups they were
    // never invited to. Target-user-bound invites are always safe to claim
    // because they bind on Clerk user id directly.
    let verifiedEmail: string | null = null;
    try {
      const cu = await clerkClient.users.getUser(userId);
      const primary =
        cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId) ??
        cu.emailAddresses[0];
      if (
        primary?.emailAddress &&
        primary.verification?.status === "verified"
      ) {
        verifiedEmail = primary.emailAddress.toLowerCase();
      }
    } catch {
      // Treat as no verified email — only target-bound invites will be claimed.
    }
    const nowIso = new Date().toISOString();
    const queries: Array<Promise<{ data: unknown[] | null; error: unknown }>> = [];
    if (verifiedEmail) {
      queries.push(
        supa
          .from("group_invites")
          .select("token")
          .ilike("email", verifiedEmail)
          .is("accepted_at", null)
          .is("declined_at", null)
          .gt("expires_at", nowIso) as unknown as Promise<{ data: unknown[] | null; error: unknown }>,
      );
    }
    queries.push(
      supa
        .from("group_invites")
        .select("token")
        .eq("target_user_id", userId)
        .is("accepted_at", null)
        .is("declined_at", null)
        .gt("expires_at", nowIso) as unknown as Promise<{ data: unknown[] | null; error: unknown }>,
    );
    const results = await Promise.all(queries);
    const tokens = new Set<string>();
    for (const r of results) {
      for (const row of (r.data ?? []) as Array<{ token: string }>) {
        if (row.token) tokens.add(row.token);
      }
    }
    let accepted = 0;
    for (const token of tokens) {
      // claim_group_invite enforces email/target binding inside the RPC, so
      // even if a stale row slipped into the candidate set it will be rejected
      // with P0004/P0005 unless it actually matches the caller.
      const { error: rpcErr } = await supa.rpc("claim_group_invite", {
        p_token: token,
        p_user_id: userId,
        p_user_email: verifiedEmail,
      });
      if (!rpcErr) accepted += 1;
    }
    res.json({ accepted });
  }),
);

// ---------------------------------------------------------------------------
// LIST trail shares for a trail (owner only — for the EditTrailDialog "Sharing" panel)
// ---------------------------------------------------------------------------

router.get(
  "/trails/:trailId/shares",
  requireAuth(async (req, res, userId) => {
    const tParse = TrailIdParam.safeParse(req.params.trailId);
    if (!tParse.success) {
      res.status(400).json({ error: "Invalid trail id" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data: trail, error: tErr } = await supa
      .from("trails")
      .select("owner_user_id")
      .eq("id", tParse.data)
      .maybeSingle();
    if (tErr || !trail) {
      res.status(404).json({ error: "Trail not found" });
      return;
    }
    if (trail.owner_user_id !== userId) {
      res.status(403).json({ error: "Only the trail owner can list shares" });
      return;
    }
    const { data, error } = await supa
      .from("trail_shares")
      .select("group_id, shared_at, groups(name)")
      .eq("trail_id", tParse.data);
    if (error) {
      if (isMissingTableError(error)) {
        res.json({ items: [] });
        return;
      }
      res.status(500).json({ error: "Failed to load shares" });
      return;
    }
    interface ShareRow {
      group_id: string;
      shared_at: string;
      groups: { name: string } | { name: string }[] | null;
    }
    const items = ((data ?? []) as ShareRow[]).map((r) => {
      const g = Array.isArray(r.groups) ? r.groups[0] : r.groups;
      return { group_id: r.group_id, shared_at: r.shared_at, name: g?.name ?? null };
    });
    res.json({ items });
  }),
);

// ---------------------------------------------------------------------------
// REPLACE trail shares (owner only). Body: { group_ids: string[] }.
// Adds new shares, removes shares not in the list. Each group_id must be
// one the caller is a member of.
//
// This is the second step of the two-step group-share flow: the trail row
// itself is created/updated by `routes/trails.ts` (POST /trails or
// PATCH /trails/:id) with `privacy: "group"` (which keeps `is_public=false`),
// and group visibility is layered on by writing rows here. Reads come back
// out via `GET /me/group-trails` further below.
// ---------------------------------------------------------------------------

router.put(
  "/trails/:trailId/shares",
  requireAuth(async (req, res, userId) => {
    const tParse = TrailIdParam.safeParse(req.params.trailId);
    if (!tParse.success) {
      res.status(400).json({ error: "Invalid trail id" });
      return;
    }
    const parsed = ShareTrailBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid share payload" });
      return;
    }

    const supa = getSupabaseAdmin();
    const { data: trail, error: tErr } = await supa
      .from("trails")
      .select("id, owner_user_id")
      .eq("id", tParse.data)
      .maybeSingle();
    if (tErr || !trail) {
      res.status(404).json({ error: "Trail not found" });
      return;
    }
    if (trail.owner_user_id !== userId) {
      res.status(403).json({ error: "Only the trail owner can change shares" });
      return;
    }

    // Verify caller belongs to every requested group_id.
    if (parsed.data.group_ids.length > 0) {
      const { data: memberships } = await supa
        .from("group_members")
        .select("group_id")
        .eq("user_id", userId)
        .in("group_id", parsed.data.group_ids);
      const owned = new Set(((memberships ?? []) as Array<{ group_id: string }>).map((m) => m.group_id));
      const missing = parsed.data.group_ids.filter((g) => !owned.has(g));
      if (missing.length > 0) {
        res.status(403).json({ error: "Cannot share into a group you don't belong to" });
        return;
      }
    }

    // Diff against existing shares.
    const { data: existing } = await supa
      .from("trail_shares")
      .select("group_id")
      .eq("trail_id", tParse.data);
    const existingSet = new Set(((existing ?? []) as Array<{ group_id: string }>).map((r) => r.group_id));
    const targetSet = new Set(parsed.data.group_ids);

    const toAdd = parsed.data.group_ids.filter((g) => !existingSet.has(g));
    const toRemove = [...existingSet].filter((g) => !targetSet.has(g));

    if (toAdd.length > 0) {
      const { error: insErr } = await supa
        .from("trail_shares")
        .insert(toAdd.map((gid) => ({
          trail_id: tParse.data,
          group_id: gid,
          shared_by_user_id: userId,
        })));
      if (insErr && insErr.code !== "23505") {
        req.log.error({ err: insErr }, "trail_shares insert failed");
        res.status(500).json({ error: "Failed to add shares" });
        return;
      }
    }
    if (toRemove.length > 0) {
      const { error: delErr } = await supa
        .from("trail_shares")
        .delete()
        .eq("trail_id", tParse.data)
        .in("group_id", toRemove);
      if (delErr) {
        req.log.error({ err: delErr }, "trail_shares delete failed");
        res.status(500).json({ error: "Failed to remove shares" });
        return;
      }
    }

    res.json({ ok: true, added: toAdd.length, removed: toRemove.length });
  }),
);

// ---------------------------------------------------------------------------
// LIST trails the caller can see beyond what anon already returns
// (used by Map + Discover). Combines:
//   * trails the caller owns (public OR private)
//   * trails shared into any group the caller is a member of
// EXCLUDING trails that are already public (those are picked up by the
// existing anon-key Supabase read). Each trail row is decorated with
// `shared_groups: [{ id, name }]` so the UI can badge them.
//
//   GET /me/group-trails?bbox=minLat,minLng,maxLat,maxLng
//   GET /me/group-trails             (no bbox — for Discover feed)
// ---------------------------------------------------------------------------

const BboxQuery = z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);

router.get(
  "/me/group-trails",
  requireAuth(async (req, res, userId) => {
    const supa = getSupabaseAdmin();

    // -- Group memberships → trail shares --
    const { data: memberships, error: mErr } = await supa
      .from("group_members")
      .select("group_id")
      .eq("user_id", userId);
    if (mErr && !isMissingTableError(mErr)) {
      res.status(500).json({ error: "Failed to load groups" });
      return;
    }
    const groupIds = ((memberships ?? []) as Array<{ group_id: string }>).map(
      (m) => m.group_id,
    );

    const sharesByTrail = new Map<string, Array<{ id: string; name: string }>>();
    if (groupIds.length > 0) {
      const { data: shares, error: sErr } = await supa
        .from("trail_shares")
        .select("trail_id, group_id, groups(name)")
        .in("group_id", groupIds);
      if (sErr && !isMissingTableError(sErr)) {
        res.status(500).json({ error: "Failed to load trail shares" });
        return;
      }
      interface ShareRow {
        trail_id: string;
        group_id: string;
        groups: { name: string } | { name: string }[] | null;
      }
      for (const r of (shares ?? []) as ShareRow[]) {
        const g = Array.isArray(r.groups) ? r.groups[0] : r.groups;
        const list = sharesByTrail.get(r.trail_id) ?? [];
        list.push({ id: r.group_id, name: g?.name ?? "Group" });
        sharesByTrail.set(r.trail_id, list);
      }
    }
    const sharedTrailIds = [...sharesByTrail.keys()];

    // -- Owner trails (private; public is excluded so we don't double-fetch) --
    // We always run this so the caller's own private trails show on the
    // map / discover even when they're not in any group.
    const bboxRaw = typeof req.query.bbox === "string" ? req.query.bbox : null;
    let bbox: [number, number, number, number] | null = null;
    if (bboxRaw) {
      const parsed = BboxQuery.safeParse(bboxRaw);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid bbox" });
        return;
      }
      const nums = bboxRaw.split(",").map(Number);
      bbox = [nums[0], nums[1], nums[2], nums[3]];
    }

    let sharedRows: unknown[] = [];
    if (sharedTrailIds.length > 0) {
      let q = supa.from("trails").select("*").in("id", sharedTrailIds);
      if (bbox) {
        q = q
          .lte("bbox_min_lat", bbox[2])
          .gte("bbox_max_lat", bbox[0])
          .lte("bbox_min_lng", bbox[3])
          .gte("bbox_max_lng", bbox[1]);
      }
      const { data, error } = await q.limit(500);
      if (error) {
        if (isMissingTableError(error) || error.code === "42703") {
          const retry = await supa
            .from("trails")
            .select("*")
            .in("id", sharedTrailIds)
            .limit(500);
          if (retry.error) {
            res.status(500).json({ error: "Failed to load group-shared trails" });
            return;
          }
          sharedRows = retry.data ?? [];
        } else {
          res.status(500).json({ error: "Failed to load group-shared trails" });
          return;
        }
      } else {
        sharedRows = data ?? [];
      }
    }

    let ownerRows: unknown[] = [];
    {
      let q = supa
        .from("trails")
        .select("*")
        .eq("owner_user_id", userId)
        .eq("is_public", false);
      if (bbox) {
        q = q
          .lte("bbox_min_lat", bbox[2])
          .gte("bbox_max_lat", bbox[0])
          .lte("bbox_min_lng", bbox[3])
          .gte("bbox_max_lng", bbox[1]);
      }
      const { data, error } = await q.limit(500);
      if (error) {
        if (isMissingTableError(error) || error.code === "42703") {
          const retry = await supa
            .from("trails")
            .select("*")
            .eq("owner_user_id", userId)
            .eq("is_public", false)
            .limit(500);
          if (!retry.error) ownerRows = retry.data ?? [];
        } else if (!isMissingTableError(error)) {
          req.log.warn({ err: error }, "owner-private trail load failed");
        }
      } else {
        ownerRows = data ?? [];
      }
    }

    res.json({ items: filterAndDecorate([...sharedRows, ...ownerRows], sharesByTrail) });
  }),
);

function filterAndDecorate(
  raw: unknown,
  sharesByTrail: Map<string, Array<{ id: string; name: string }>>,
): Array<Record<string, unknown>> {
  const rows = (raw ?? []) as Array<Record<string, unknown> & {
    id: string;
    deleted_at?: string | null;
    is_public?: boolean | null;
  }>;
  // Dedup by id (owner + shared can overlap when an owner shares their
  // own private trail into a group they belong to).
  const byId = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (r.deleted_at != null) continue;
    if (byId.has(r.id)) continue;
    byId.set(r.id, { ...r, shared_groups: sharesByTrail.get(r.id) ?? [] });
  }
  return [...byId.values()];
}

export default router;
