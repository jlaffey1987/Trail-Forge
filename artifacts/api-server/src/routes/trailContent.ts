import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { getAuth } from "@clerk/express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

// ---------------------------------------------------------------------------
// Schema definitions (kept inline — the OpenAPI codegen surface only covers
// the original auth + storage foundation endpoints).
// ---------------------------------------------------------------------------

const NoteKindSchema = z.enum(["info", "warning", "condition"]);

const PostNoteBody = z.object({
  body: z.string().trim().min(1).max(2000),
  kind: NoteKindSchema.optional().default("info"),
});

const PatchNoteBody = z.object({
  body: z.string().trim().min(1).max(2000).optional(),
  kind: NoteKindSchema.optional(),
});

const PhotoUploadUrlBody = z.object({
  contentType: z
    .string()
    .min(1)
    .refine((s) => s.startsWith("image/"), "contentType must be an image/*"),
});

const CreatePhotoBody = z.object({
  storageKey: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  caption: z.string().max(500).optional(),
});

const AmendmentChangeable = z.object({
  name: z.string().min(1).max(200).optional(),
  difficulty: z.number().int().min(1).max(10).nullable().optional(),
  type: z.string().max(100).nullable().optional(),
  legal_status: z.string().max(100).nullable().optional(),
  terrain: z.string().max(100).nullable().optional(),
});

const CreateAmendmentBody = z.object({
  proposedChanges: AmendmentChangeable,
  reason: z.string().trim().min(1).max(2000),
  replacementGpxStorageKey: z.string().min(1).optional(),
});

const AmendmentGpxUploadBody = z.object({
  contentType: z.string().min(1).optional(),
});

const DecisionBody = z.object({
  decisionReason: z.string().max(2000).optional(),
});

const TrailIdParam = z.string().uuid();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AuthedHandler {
  (req: Request, res: Response, userId: string): Promise<void>;
}

/** Wrap a handler that requires a Clerk session. */
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

async function isModeratorOrOwner(
  userId: string,
  trailId: string,
): Promise<{ isOwner: boolean; isModerator: boolean }> {
  const supa = getSupabaseAdmin();
  const [{ data: trail }, { data: user }] = await Promise.all([
    supa.from("trails").select("owner_user_id").eq("id", trailId).maybeSingle(),
    supa.from("users").select("is_moderator").eq("id", userId).maybeSingle(),
  ]);
  return {
    isOwner: trail?.owner_user_id === userId,
    isModerator: !!(user as { is_moderator?: boolean } | null)?.is_moderator,
  };
}

/**
 * Validate the trail id path param. Returns null if invalid (and writes the
 * 400 response itself).
 */
function getTrailId(req: Request, res: Response): string | null {
  const parsed = TrailIdParam.safeParse(req.params.trailId);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid trail id" });
    return null;
  }
  return parsed.data;
}

// ===========================================================================
// PERMISSIONS
// ===========================================================================

router.get(
  "/trails/:trailId/permissions",
  async (req: Request, res: Response) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    const auth = getAuth(req);
    if (!auth.userId) {
      res.json({ isOwner: false, isModerator: false, canModerate: false });
      return;
    }
    try {
      const { isOwner, isModerator } = await isModeratorOrOwner(auth.userId, trailId);
      res.json({ isOwner, isModerator, canModerate: isOwner || isModerator });
    } catch (err) {
      req.log.error({ err }, "permissions check failed");
      res.json({ isOwner: false, isModerator: false, canModerate: false });
    }
  },
);

// ===========================================================================
// NOTES
// ===========================================================================

router.get(
  "/trails/:trailId/notes",
  async (req: Request, res: Response) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    try {
      const supa = getSupabaseAdmin();
      const { data, error } = await supa
        .from("trail_notes")
        .select(
          "id, trail_id, author_user_id, body, kind, created_at, updated_at, hidden_at, users(id, display_name, avatar_url)",
        )
        .eq("trail_id", trailId)
        .is("hidden_at", null)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) {
        if (isMissingTableError(error)) {
          res.json({ items: [] });
          return;
        }
        req.log.error({ err: error }, "list notes failed");
        res.status(500).json({ error: "Failed to list notes" });
        return;
      }
      res.json({ items: data ?? [] });
    } catch (err) {
      req.log.error({ err }, "list notes failed");
      res.status(500).json({ error: "Failed to list notes" });
    }
  },
);

router.post(
  "/trails/:trailId/notes",
  requireAuth(async (req, res, userId) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    const parsed = PostNoteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid note body" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("trail_notes")
      .insert({
        trail_id: trailId,
        author_user_id: userId,
        body: parsed.data.body,
        kind: parsed.data.kind,
      })
      .select(
        "id, trail_id, author_user_id, body, kind, created_at, updated_at, hidden_at, users(id, display_name, avatar_url)",
      )
      .single();
    if (error) {
      req.log.error({ err: error }, "create note failed");
      res.status(500).json({ error: "Failed to create note" });
      return;
    }
    res.json(data);
  }),
);

router.patch(
  "/trails/:trailId/notes/:noteId",
  requireAuth(async (req, res, userId) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    const noteId = z.string().uuid().safeParse(req.params.noteId);
    if (!noteId.success) {
      res.status(400).json({ error: "Invalid note id" });
      return;
    }
    const parsed = PatchNoteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid note body" });
      return;
    }

    const supa = getSupabaseAdmin();
    const { data: existing } = await supa
      .from("trail_notes")
      .select("id, author_user_id")
      .eq("id", noteId.data)
      .eq("trail_id", trailId)
      .maybeSingle();
    if (!existing) {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    if (existing.author_user_id !== userId) {
      res.status(403).json({ error: "Only the author can edit this note" });
      return;
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.body != null) update.body = parsed.data.body;
    if (parsed.data.kind != null) update.kind = parsed.data.kind;

    const { data, error } = await supa
      .from("trail_notes")
      .update(update)
      .eq("id", noteId.data)
      .select(
        "id, trail_id, author_user_id, body, kind, created_at, updated_at, hidden_at, users(id, display_name, avatar_url)",
      )
      .single();
    if (error) {
      req.log.error({ err: error }, "update note failed");
      res.status(500).json({ error: "Failed to update note" });
      return;
    }
    res.json(data);
  }),
);

router.delete(
  "/trails/:trailId/notes/:noteId",
  requireAuth(async (req, res, userId) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    const noteId = z.string().uuid().safeParse(req.params.noteId);
    if (!noteId.success) {
      res.status(400).json({ error: "Invalid note id" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data: existing } = await supa
      .from("trail_notes")
      .select("id, author_user_id")
      .eq("id", noteId.data)
      .eq("trail_id", trailId)
      .maybeSingle();
    if (!existing) {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    const { isModerator } = await isModeratorOrOwner(userId, trailId);
    const isAuthor = existing.author_user_id === userId;
    if (!isAuthor && !isModerator) {
      res.status(403).json({ error: "Only the author or a moderator can remove this note" });
      return;
    }

    if (isAuthor) {
      const { error } = await supa
        .from("trail_notes")
        .delete()
        .eq("id", noteId.data);
      if (error) {
        req.log.error({ err: error }, "delete note failed");
        res.status(500).json({ error: "Failed to delete note" });
        return;
      }
    } else {
      // Moderator hide — keeps audit trail.
      const { error } = await supa
        .from("trail_notes")
        .update({ hidden_at: new Date().toISOString() })
        .eq("id", noteId.data);
      if (error) {
        req.log.error({ err: error }, "hide note failed");
        res.status(500).json({ error: "Failed to hide note" });
        return;
      }
    }
    res.json({ ok: true });
  }),
);

// ===========================================================================
// PHOTOS
// ===========================================================================

router.get(
  "/trails/:trailId/photos",
  async (req: Request, res: Response) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    try {
      const supa = getSupabaseAdmin();
      const { data, error } = await supa
        .from("trail_photos")
        .select(
          "id, trail_id, author_user_id, storage_key, width, height, caption, created_at, hidden_at, users(id, display_name, avatar_url)",
        )
        .eq("trail_id", trailId)
        .is("hidden_at", null)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) {
        if (isMissingTableError(error)) {
          res.json({ items: [] });
          return;
        }
        req.log.error({ err: error }, "list photos failed");
        res.status(500).json({ error: "Failed to list photos" });
        return;
      }
      res.json({ items: data ?? [] });
    } catch (err) {
      req.log.error({ err }, "list photos failed");
      res.status(500).json({ error: "Failed to list photos" });
    }
  },
);

router.post(
  "/trails/:trailId/photos/upload-url",
  requireAuth(async (req, res, _userId) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    const parsed = PhotoUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid contentType" });
      return;
    }
    // storage_key follows the convention required by the task —
    // `trails/{trailId}/photos/{uuid}.jpg` — to make later cleanup easy.
    const photoUuid = randomUUID();
    const subPath = `trails/${trailId}/photos/${photoUuid}.jpg`;
    try {
      const uploadURL = await objectStorage.getObjectEntityUploadURL(subPath);
      res.json({
        uploadURL,
        storageKey: subPath,
        objectPath: `/objects/${subPath}`,
      });
    } catch (err) {
      req.log.error({ err }, "photo upload-url failed");
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  }),
);

router.post(
  "/trails/:trailId/photos",
  requireAuth(async (req, res, userId) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    const parsed = CreatePhotoBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid photo metadata" });
      return;
    }
    const expectedPrefix = `trails/${trailId}/photos/`;
    if (!parsed.data.storageKey.startsWith(expectedPrefix)) {
      res.status(400).json({ error: "storageKey does not match this trail" });
      return;
    }

    // Stamp ACL — public so anyone viewing the trail can render the image.
    try {
      await objectStorage.trySetObjectEntityAclPolicy(
        `/objects/${parsed.data.storageKey}`,
        { owner: userId, visibility: "public" },
      );
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Photo upload not completed" });
        return;
      }
      req.log.error({ err }, "set photo ACL failed");
      res.status(500).json({ error: "Failed to finalize photo" });
      return;
    }

    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("trail_photos")
      .insert({
        trail_id: trailId,
        author_user_id: userId,
        storage_key: parsed.data.storageKey,
        width: parsed.data.width ?? null,
        height: parsed.data.height ?? null,
        caption: parsed.data.caption ?? null,
      })
      .select(
        "id, trail_id, author_user_id, storage_key, width, height, caption, created_at, hidden_at, users(id, display_name, avatar_url)",
      )
      .single();
    if (error) {
      req.log.error({ err: error }, "create photo failed");
      res.status(500).json({ error: "Failed to create photo" });
      return;
    }
    res.json(data);
  }),
);

router.delete(
  "/trails/:trailId/photos/:photoId",
  requireAuth(async (req, res, userId) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    const photoId = z.string().uuid().safeParse(req.params.photoId);
    if (!photoId.success) {
      res.status(400).json({ error: "Invalid photo id" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data: existing } = await supa
      .from("trail_photos")
      .select("id, author_user_id")
      .eq("id", photoId.data)
      .eq("trail_id", trailId)
      .maybeSingle();
    if (!existing) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    const { isModerator } = await isModeratorOrOwner(userId, trailId);
    const isAuthor = existing.author_user_id === userId;
    if (!isAuthor && !isModerator) {
      res.status(403).json({ error: "Only the author or a moderator can remove this photo" });
      return;
    }
    if (isAuthor) {
      const { error } = await supa
        .from("trail_photos")
        .delete()
        .eq("id", photoId.data);
      if (error) {
        req.log.error({ err: error }, "delete photo failed");
        res.status(500).json({ error: "Failed to delete photo" });
        return;
      }
    } else {
      const { error } = await supa
        .from("trail_photos")
        .update({ hidden_at: new Date().toISOString() })
        .eq("id", photoId.data);
      if (error) {
        req.log.error({ err: error }, "hide photo failed");
        res.status(500).json({ error: "Failed to hide photo" });
        return;
      }
    }
    res.json({ ok: true });
  }),
);

// ===========================================================================
// AMENDMENTS
// ===========================================================================

router.get(
  "/trails/:trailId/amendments",
  async (req: Request, res: Response) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    try {
      const supa = getSupabaseAdmin();
      const { data, error } = await supa
        .from("trail_amendments")
        .select(
          "id, trail_id, author_user_id, proposed_changes, replacement_gpx_storage_key, reason, status, decided_by, decided_at, decision_reason, created_at, users!trail_amendments_author_user_id_fkey(id, display_name, avatar_url)",
        )
        .eq("trail_id", trailId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) {
        if (isMissingTableError(error)) {
          res.json({ items: [] });
          return;
        }
        req.log.error({ err: error }, "list amendments failed");
        res.status(500).json({ error: "Failed to list amendments" });
        return;
      }
      res.json({ items: data ?? [] });
    } catch (err) {
      req.log.error({ err }, "list amendments failed");
      res.status(500).json({ error: "Failed to list amendments" });
    }
  },
);

router.post(
  "/trails/:trailId/amendments/gpx-upload-url",
  requireAuth(async (req, res, _userId) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    const parsed = AmendmentGpxUploadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    const uuid = randomUUID();
    const subPath = `trails/${trailId}/amendments/${uuid}.gpx`;
    try {
      const uploadURL = await objectStorage.getObjectEntityUploadURL(subPath);
      res.json({
        uploadURL,
        storageKey: subPath,
        objectPath: `/objects/${subPath}`,
      });
    } catch (err) {
      req.log.error({ err }, "amendment gpx upload-url failed");
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  }),
);

router.post(
  "/trails/:trailId/amendments",
  requireAuth(async (req, res, userId) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    const parsed = CreateAmendmentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid amendment body" });
      return;
    }
    const proposed = parsed.data.proposedChanges;
    const hasField = Object.values(proposed).some((v) => v !== undefined);
    if (!hasField && !parsed.data.replacementGpxStorageKey) {
      res.status(400).json({
        error: "An amendment must propose at least one change or a new GPX",
      });
      return;
    }

    if (parsed.data.replacementGpxStorageKey) {
      const expectedPrefix = `trails/${trailId}/amendments/`;
      if (!parsed.data.replacementGpxStorageKey.startsWith(expectedPrefix)) {
        res.status(400).json({ error: "replacementGpxStorageKey does not match this trail" });
        return;
      }
      try {
        await objectStorage.trySetObjectEntityAclPolicy(
          `/objects/${parsed.data.replacementGpxStorageKey}`,
          { owner: userId, visibility: "private" },
        );
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          res.status(404).json({ error: "Replacement GPX upload not completed" });
          return;
        }
        req.log.error({ err }, "set amendment gpx ACL failed");
        res.status(500).json({ error: "Failed to finalize amendment" });
        return;
      }
    }

    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("trail_amendments")
      .insert({
        trail_id: trailId,
        author_user_id: userId,
        proposed_changes: proposed,
        reason: parsed.data.reason,
        replacement_gpx_storage_key: parsed.data.replacementGpxStorageKey ?? null,
      })
      .select(
        "id, trail_id, author_user_id, proposed_changes, replacement_gpx_storage_key, reason, status, decided_by, decided_at, decision_reason, created_at, users!trail_amendments_author_user_id_fkey(id, display_name, avatar_url)",
      )
      .single();
    if (error) {
      req.log.error({ err: error }, "create amendment failed");
      res.status(500).json({ error: "Failed to create amendment" });
      return;
    }
    res.json(data);
  }),
);

const AMENDABLE_FIELDS = [
  "name",
  "difficulty",
  "type",
  "legal_status",
  "terrain",
] as const;
type AmendableField = (typeof AMENDABLE_FIELDS)[number];

router.post(
  "/trails/:trailId/amendments/:amendmentId/approve",
  requireAuth(async (req, res, userId) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    const amendmentId = z.string().uuid().safeParse(req.params.amendmentId);
    if (!amendmentId.success) {
      res.status(400).json({ error: "Invalid amendment id" });
      return;
    }
    const decision = DecisionBody.safeParse(req.body ?? {});
    if (!decision.success) {
      res.status(400).json({ error: "Invalid decision body" });
      return;
    }

    const supa = getSupabaseAdmin();
    const { isOwner, isModerator } = await isModeratorOrOwner(userId, trailId);
    if (!isOwner && !isModerator) {
      res.status(403).json({ error: "Only the trail owner or a moderator can approve" });
      return;
    }

    const { data: amendment } = await supa
      .from("trail_amendments")
      .select("id, status, proposed_changes")
      .eq("id", amendmentId.data)
      .eq("trail_id", trailId)
      .maybeSingle();
    if (!amendment) {
      res.status(404).json({ error: "Amendment not found" });
      return;
    }
    if (amendment.status !== "pending") {
      res.status(409).json({ error: `Amendment already ${amendment.status}` });
      return;
    }

    const { data: trailRow } = await supa
      .from("trails")
      .select("id, name, difficulty, type, legal_status, terrain")
      .eq("id", trailId)
      .maybeSingle();
    if (!trailRow) {
      res.status(404).json({ error: "Trail not found" });
      return;
    }

    const proposed = (amendment.proposed_changes ?? {}) as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    const previous: Record<string, unknown> = {};
    for (const field of AMENDABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(proposed, field)) {
        update[field] = proposed[field as AmendableField];
        previous[field] = (trailRow as Record<string, unknown>)[field];
      }
    }

    if (Object.keys(update).length > 0) {
      const { error: trailErr } = await supa
        .from("trails")
        .update(update)
        .eq("id", trailId);
      if (trailErr) {
        req.log.error({ err: trailErr }, "apply amendment to trail failed");
        res.status(500).json({ error: "Failed to apply amendment" });
        return;
      }
    }

    const decidedAt = new Date().toISOString();
    const { error: amErr } = await supa
      .from("trail_amendments")
      .update({
        status: "approved",
        decided_by: userId,
        decided_at: decidedAt,
        decision_reason: decision.data.decisionReason ?? null,
      })
      .eq("id", amendmentId.data);
    if (amErr) {
      req.log.error({ err: amErr }, "mark amendment approved failed");
      res.status(500).json({ error: "Failed to record decision" });
      return;
    }

    // Always write the audit row, even when the field-level update was a no-op
    // (e.g. only a replacement GPX was attached) so the decision itself is logged.
    const { error: histErr } = await supa
      .from("trail_amendment_history")
      .insert({
        trail_id: trailId,
        amendment_id: amendmentId.data,
        previous_values: previous,
        applied_at: decidedAt,
        applied_by: userId,
      });
    if (histErr) {
      req.log.warn({ err: histErr }, "amendment audit insert failed");
    }

    res.json({ ok: true, applied: update });
  }),
);

router.post(
  "/trails/:trailId/amendments/:amendmentId/reject",
  requireAuth(async (req, res, userId) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;
    const amendmentId = z.string().uuid().safeParse(req.params.amendmentId);
    if (!amendmentId.success) {
      res.status(400).json({ error: "Invalid amendment id" });
      return;
    }
    const decision = DecisionBody.safeParse(req.body ?? {});
    if (!decision.success) {
      res.status(400).json({ error: "Invalid decision body" });
      return;
    }
    const { isOwner, isModerator } = await isModeratorOrOwner(userId, trailId);
    if (!isOwner && !isModerator) {
      res.status(403).json({ error: "Only the trail owner or a moderator can reject" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data: amendment } = await supa
      .from("trail_amendments")
      .select("id, status")
      .eq("id", amendmentId.data)
      .eq("trail_id", trailId)
      .maybeSingle();
    if (!amendment) {
      res.status(404).json({ error: "Amendment not found" });
      return;
    }
    if (amendment.status !== "pending") {
      res.status(409).json({ error: `Amendment already ${amendment.status}` });
      return;
    }
    const { error } = await supa
      .from("trail_amendments")
      .update({
        status: "rejected",
        decided_by: userId,
        decided_at: new Date().toISOString(),
        decision_reason: decision.data.decisionReason ?? null,
      })
      .eq("id", amendmentId.data);
    if (error) {
      req.log.error({ err: error }, "reject amendment failed");
      res.status(500).json({ error: "Failed to reject amendment" });
      return;
    }
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Counts (for trail card summaries)
// ---------------------------------------------------------------------------
router.get(
  "/trails/activity-counts",
  async (req: Request, res: Response) => {
    const idsParam = typeof req.query.ids === "string" ? req.query.ids : "";
    const ids = idsParam
      .split(",")
      .map((s) => s.trim())
      .filter((s) => z.string().uuid().safeParse(s).success);
    if (ids.length === 0) {
      res.json({ counts: {} });
      return;
    }
    if (ids.length > 200) {
      res.status(400).json({ error: "Too many ids (max 200)" });
      return;
    }

    try {
      const supa = getSupabaseAdmin();
      const [notesRes, photosRes, amendsRes] = await Promise.all([
        supa
          .from("trail_notes")
          .select("trail_id")
          .in("trail_id", ids)
          .is("hidden_at", null),
        supa
          .from("trail_photos")
          .select("trail_id")
          .in("trail_id", ids)
          .is("hidden_at", null),
        supa
          .from("trail_amendments")
          .select("trail_id, status")
          .in("trail_id", ids)
          .eq("status", "pending"),
      ]);

      const counts: Record<string, { notes: number; photos: number; pending: number }> = {};
      for (const id of ids) {
        counts[id] = { notes: 0, photos: 0, pending: 0 };
      }
      const tally = (rows: { trail_id: string }[] | null, key: "notes" | "photos" | "pending") => {
        if (!rows) return;
        for (const r of rows) {
          if (counts[r.trail_id]) counts[r.trail_id][key] += 1;
        }
      };
      // Tolerate missing tables — leaves counts at 0.
      if (!isMissingTableError(notesRes.error ?? null)) tally(notesRes.data ?? null, "notes");
      if (!isMissingTableError(photosRes.error ?? null)) tally(photosRes.data ?? null, "photos");
      if (!isMissingTableError(amendsRes.error ?? null)) tally(amendsRes.data ?? null, "pending");

      res.json({ counts });
    } catch (err) {
      req.log.error({ err }, "activity-counts failed");
      res.json({ counts: {} });
    }
  },
);

export default router;
