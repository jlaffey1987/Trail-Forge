import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { z } from "zod";
import { CreateTrailBody, CreateTrailResponse } from "@workspace/api-zod";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { mintGpxUploadTicket, consumeGpxUploadTicket } from "../lib/uploadTickets";

const objectStorage = new ObjectStorageService();

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Schemas (kept inline alongside the auto-generated CreateTrailBody — these
// extend the surface area beyond what the OpenAPI spec covers today).
// ---------------------------------------------------------------------------

const TrailIdParam = z.string().uuid();

const PrivacyEnum = z.enum(["private", "public", "group"]);

const ExtraTrailFields = z.object({
  description: z.string().max(5000).nullish(),
  privacy: PrivacyEnum.optional(),
  // Object-storage path for the original GPX artifact, e.g.
  // "/objects/trails/source/<uuid>.gpx" (returned by
  // POST /trails/gpx/upload-url).
  gpx_object_path: z.string().min(1).max(512).nullish(),
});

const PatchTrailBody = z.object({
  name: z.string().min(1).max(200).optional(),
  difficulty: z.number().int().min(1).max(10).nullable().optional(),
  type: z.string().max(100).nullable().optional(),
  legal_status: z.string().max(100).nullable().optional(),
  terrain: z.string().max(100).nullable().optional(),
  distance_km: z.number().nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  is_public: z.boolean().optional(),
  privacy: PrivacyEnum.optional(),
});

const ReplaceGpxBody = z.object({
  gpx_data: z.string().min(1),
  distance_km: z.number().nullable().optional(),
  bbox_min_lat: z.number().nullable().optional(),
  bbox_max_lat: z.number().nullable().optional(),
  bbox_min_lng: z.number().nullable().optional(),
  bbox_max_lng: z.number().nullable().optional(),
  // New object-storage path. The previous gpx_object_path on the trail (if
  // any) is deleted from object storage as part of the replace.
  gpx_object_path: z.string().min(1).max(512).nullish(),
});

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

function isMissingColumnError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === "42703" || /column .* does not exist/i.test(err.message ?? "");
}

function getTrailId(req: Request, res: Response): string | null {
  const parsed = TrailIdParam.safeParse(req.params.trailId);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid trail id" });
    return null;
  }
  return parsed.data;
}

async function fetchOwnedTrailRow(trailId: string, userId: string) {
  const supa = getSupabaseAdmin();
  let { data, error } = await supa
    .from("trails")
    .select("id, owner_user_id, deleted_at, gpx_object_path")
    .eq("id", trailId)
    .maybeSingle();
  if (error && isMissingColumnError(error)) {
    // gpx_object_path / deleted_at not yet present (older migration window).
    const retry = await supa
      .from("trails")
      .select("id, owner_user_id")
      .eq("id", trailId)
      .maybeSingle();
    data = retry.data as typeof data;
    error = retry.error;
  }
  if (error) return { error };
  if (!data) return { notFound: true as const };
  if (data.owner_user_id !== userId) return { forbidden: true as const };
  return { trail: data as { id: string; owner_user_id: string; deleted_at?: string | null; gpx_object_path?: string | null } };
}

/**
 * Best-effort delete of an object-storage entity associated with a trail.
 * Logs failures but never throws — storage cleanup is non-fatal so we don't
 * leave a half-deleted trail in the database when GCS hiccups.
 */
async function tryDeleteGpxObject(rawPath: string | null | undefined, log: { error: (obj: unknown, msg?: string) => void }) {
  if (!rawPath) return;
  try {
    await objectStorage.deleteObjectEntity(rawPath);
  } catch (err) {
    log.error({ err, rawPath }, "failed to delete gpx object from storage");
  }
}

// ---------------------------------------------------------------------------
// Issue a signed PUT URL for uploading a GPX file to object storage. The
// client uploads the raw .gpx body directly to GCS, then sends the returned
// `objectPath` along with `POST /trails` (or `PUT /trails/:id/gpx`) so the
// server can persist a reference and finalize the ACL.
// ---------------------------------------------------------------------------

router.post(
  "/trails/gpx/upload-url",
  requireAuth(async (_req, res, userId) => {
    // Mint a server-side ticket bound to this user. The trail-create /
    // replace-GPX routes will only finalize ACLs for paths that match an
    // outstanding ticket owned by the same user, so an attacker who learns
    // someone else's object path cannot reassign ownership.
    const { storageKey } = mintGpxUploadTicket(userId);
    try {
      const uploadURL = await objectStorage.getObjectEntityUploadURL(storageKey);
      res.json({
        uploadURL,
        storageKey,
        objectPath: `/objects/${storageKey}`,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to generate upload URL" });
      // eslint-disable-next-line no-console
      console.error("[trails] gpx upload-url failed", err);
    }
  }),
);

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

router.post("/trails", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = CreateTrailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing required trail fields" });
    return;
  }
  const extras = ExtraTrailFields.safeParse(req.body);
  if (!extras.success) {
    res.status(400).json({ error: "Invalid description / privacy" });
    return;
  }

  // Privacy selector takes precedence over is_public, defaulting to PRIVATE
  // for safety. Group sharing is not yet implemented; we treat it as private
  // until the groups task lands.
  const data = parsed.data;
  let isPublic = data.is_public ?? false;
  if (extras.data.privacy === "public") isPublic = true;
  else if (extras.data.privacy === "private") isPublic = false;
  else if (extras.data.privacy === "group") isPublic = false;

  try {
    const supa = getSupabaseAdmin();
    const insert: Record<string, unknown> = {
      ...data,
      is_public: isPublic,
      owner_user_id: auth.userId,
    };
    if (extras.data.description != null) {
      insert.description = extras.data.description;
    }

    // If the client uploaded the original GPX to object storage and passed
    // back the objectPath, finalize the ACL (private; owner = caller) and
    // persist the path on the trail row.
    const rawObjectPath = extras.data.gpx_object_path ?? null;
    let normalizedObjectPath: string | null = null;
    if (rawObjectPath) {
      // Verify the path was minted for this user via /trails/gpx/upload-url.
      // Without this check, an attacker who learns another user's object path
      // could submit it here and have the server reassign ACL ownership to
      // themselves.
      if (!consumeGpxUploadTicket(rawObjectPath, auth.userId)) {
        res.status(403).json({
          error: "GPX upload ticket missing, expired, or owned by another user",
        });
        return;
      }
      try {
        normalizedObjectPath = await objectStorage.trySetObjectEntityAclPolicy(
          rawObjectPath,
          { owner: auth.userId, visibility: "private" },
        );
        insert.gpx_object_path = normalizedObjectPath;
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          res.status(400).json({ error: "GPX upload not completed — objectPath not found" });
          return;
        }
        req.log.error({ err }, "gpx finalize failed");
        res.status(500).json({ error: "Failed to finalize GPX upload" });
        return;
      }
    }

    let { data: row, error } = await supa
      .from("trails")
      .insert(insert)
      .select()
      .single();
    // Retry once dropping any optional columns that the current DB doesn't
    // know about yet (migration 0005 may not have been applied). We strip
    // them one at a time so we still persist what we can.
    if (error && isMissingColumnError(error)) {
      const cleaned: Record<string, unknown> = { ...insert };
      delete cleaned.description;
      delete cleaned.gpx_object_path;
      const retry = await supa.from("trails").insert(cleaned).select().single();
      row = retry.data;
      error = retry.error;
    }
    if (error) {
      req.log.error({ err: error }, "createTrail failed");
      res.status(500).json({ error: "Failed to create trail" });
      return;
    }
    res.json(CreateTrailResponse.parse(row));
  } catch (err) {
    req.log.error({ err }, "createTrail failed");
    res.status(500).json({ error: "Failed to create trail" });
  }
});

// ---------------------------------------------------------------------------
// List own trails
// ---------------------------------------------------------------------------

router.get(
  "/me/trails",
  requireAuth(async (_req, res, userId) => {
    const supa = getSupabaseAdmin();
    let query = supa
      .from("trails")
      .select("*")
      .eq("owner_user_id", userId)
      .order("created_at", { ascending: false })
      .limit(500);
    let { data, error } = await query;
    if (error && isMissingColumnError(error)) {
      // owner_user_id column missing (migration 0002 not yet applied).
      res.json({ items: [] });
      return;
    }
    if (error && isMissingTableError(error)) {
      res.json({ items: [] });
      return;
    }
    if (error) {
      res.status(500).json({ error: "Failed to load owned trails" });
      return;
    }
    // Filter out soft-deleted client-side so a missing deleted_at column does
    // not break the response.
    const rows = (data ?? []) as Array<Record<string, unknown> & { deleted_at?: string | null }>;
    const live = rows.filter((r) => r.deleted_at == null);
    res.json({ items: live });
  }),
);

// ---------------------------------------------------------------------------
// Update metadata
// ---------------------------------------------------------------------------

router.patch(
  "/trails/:trailId",
  requireAuth(async (req, res, userId) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;

    const parsed = PatchTrailBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid update body" });
      return;
    }

    const owned = await fetchOwnedTrailRow(trailId, userId);
    if ("error" in owned && owned.error) {
      req.log.error({ err: owned.error }, "patch trail load failed");
      res.status(500).json({ error: "Failed to load trail" });
      return;
    }
    if ("notFound" in owned) {
      res.status(404).json({ error: "Trail not found" });
      return;
    }
    if ("forbidden" in owned) {
      res.status(403).json({ error: "Only the trail owner can update this trail" });
      return;
    }

    const update: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.privacy === "public") update.is_public = true;
    else if (parsed.data.privacy === "private") update.is_public = false;
    else if (parsed.data.privacy === "group") update.is_public = false;
    delete update.privacy;

    const supa = getSupabaseAdmin();
    let { data: row, error } = await supa
      .from("trails")
      .update(update)
      .eq("id", trailId)
      .eq("owner_user_id", userId)
      .select()
      .single();
    if (error && isMissingColumnError(error) && "description" in update) {
      const { description: _omit, ...withoutDesc } = update;
      const retry = await supa
        .from("trails")
        .update(withoutDesc)
        .eq("id", trailId)
        .eq("owner_user_id", userId)
        .select()
        .single();
      row = retry.data;
      error = retry.error;
    }
    if (error) {
      req.log.error({ err: error }, "patch trail failed");
      res.status(500).json({ error: "Failed to update trail" });
      return;
    }
    res.json(row);
  }),
);

// ---------------------------------------------------------------------------
// Replace GPX (re-uploads a new track for an existing trail)
// ---------------------------------------------------------------------------

router.put(
  "/trails/:trailId/gpx",
  requireAuth(async (req, res, userId) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;

    const parsed = ReplaceGpxBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid GPX payload" });
      return;
    }

    const owned = await fetchOwnedTrailRow(trailId, userId);
    if ("notFound" in owned) {
      res.status(404).json({ error: "Trail not found" });
      return;
    }
    if ("forbidden" in owned) {
      res.status(403).json({ error: "Only the trail owner can replace its GPX" });
      return;
    }
    if ("error" in owned && owned.error) {
      req.log.error({ err: owned.error }, "replace gpx load failed");
      res.status(500).json({ error: "Failed to load trail" });
      return;
    }

    // Finalize ACL on the new object (if provided). The path must match an
    // outstanding upload ticket owned by this user — see the security note on
    // `consumeGpxUploadTicket` in trail-create above.
    let normalizedNewObjectPath: string | null = null;
    if (parsed.data.gpx_object_path) {
      if (!consumeGpxUploadTicket(parsed.data.gpx_object_path, userId)) {
        res.status(403).json({
          error: "GPX upload ticket missing, expired, or owned by another user",
        });
        return;
      }
      try {
        normalizedNewObjectPath = await objectStorage.trySetObjectEntityAclPolicy(
          parsed.data.gpx_object_path,
          { owner: userId, visibility: "private" },
        );
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          res.status(400).json({ error: "Replacement GPX upload not completed" });
          return;
        }
        req.log.error({ err }, "replace gpx finalize failed");
        res.status(500).json({ error: "Failed to finalize replacement GPX" });
        return;
      }
    }

    const supa = getSupabaseAdmin();
    const update: Record<string, unknown> = {
      gpx_data: parsed.data.gpx_data,
      distance_km: parsed.data.distance_km ?? null,
      bbox_min_lat: parsed.data.bbox_min_lat ?? null,
      bbox_max_lat: parsed.data.bbox_max_lat ?? null,
      bbox_min_lng: parsed.data.bbox_min_lng ?? null,
      bbox_max_lng: parsed.data.bbox_max_lng ?? null,
    };
    if (normalizedNewObjectPath != null) {
      update.gpx_object_path = normalizedNewObjectPath;
    }

    let { data, error } = await supa
      .from("trails")
      .update(update)
      .eq("id", trailId)
      .eq("owner_user_id", userId)
      .select()
      .single();
    if (error && isMissingColumnError(error) && "gpx_object_path" in update) {
      const { gpx_object_path: _omit, ...withoutPath } = update;
      const retry = await supa
        .from("trails")
        .update(withoutPath)
        .eq("id", trailId)
        .eq("owner_user_id", userId)
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }
    if (error) {
      req.log.error({ err: error }, "replace gpx failed");
      // If we already finalized a new object but the DB write failed, try
      // to remove the orphaned object so we don't leak storage.
      await tryDeleteGpxObject(normalizedNewObjectPath, req.log);
      res.status(500).json({ error: "Failed to replace GPX" });
      return;
    }

    // Best-effort: remove the previous GPX artifact from object storage now
    // that the trail row points at the new one.
    const previousPath = (owned.trail as { gpx_object_path?: string | null }).gpx_object_path ?? null;
    if (previousPath && previousPath !== normalizedNewObjectPath) {
      await tryDeleteGpxObject(previousPath, req.log);
    }

    res.json(data);
  }),
);

// ---------------------------------------------------------------------------
// Delete (soft-delete; hard-delete only when no community content exists)
// ---------------------------------------------------------------------------

router.delete(
  "/trails/:trailId",
  requireAuth(async (req, res, userId) => {
    const trailId = getTrailId(req, res);
    if (!trailId) return;

    const owned = await fetchOwnedTrailRow(trailId, userId);
    if ("notFound" in owned) {
      res.status(404).json({ error: "Trail not found" });
      return;
    }
    if ("forbidden" in owned) {
      res.status(403).json({ error: "Only the trail owner can delete this trail" });
      return;
    }
    if ("error" in owned && owned.error) {
      req.log.error({ err: owned.error }, "delete trail load failed");
      res.status(500).json({ error: "Failed to load trail" });
      return;
    }

    const supa = getSupabaseAdmin();

    // Check for community content. If none, hard-delete (cascades to nothing).
    let canHardDelete = true;
    for (const table of ["trail_notes", "trail_photos", "trail_amendments"] as const) {
      try {
        const { count, error } = await supa
          .from(table)
          .select("id", { head: true, count: "exact" })
          .eq("trail_id", trailId);
        if (error) {
          if (isMissingTableError(error)) continue;
          // If we can't tell, prefer the safe option (soft-delete).
          canHardDelete = false;
          continue;
        }
        if ((count ?? 0) > 0) {
          canHardDelete = false;
          break;
        }
      } catch {
        canHardDelete = false;
      }
    }

    if (canHardDelete) {
      const { error } = await supa
        .from("trails")
        .delete()
        .eq("id", trailId)
        .eq("owner_user_id", userId);
      if (error) {
        req.log.error({ err: error }, "hard delete trail failed");
        res.status(500).json({ error: "Failed to delete trail" });
        return;
      }
      // Hard-delete also removes the GPX artifact from object storage. For
      // soft-delete we keep the object so moderators can still inspect it.
      const objectPath = (owned.trail as { gpx_object_path?: string | null }).gpx_object_path ?? null;
      await tryDeleteGpxObject(objectPath, req.log);
      res.json({ ok: true, mode: "hard" });
      return;
    }

    // Soft-delete: stamp deleted_at. Falls back to flipping is_public=false
    // when the column is missing (migration 0005 not yet applied).
    let { error } = await supa
      .from("trails")
      .update({ deleted_at: new Date().toISOString(), is_public: false })
      .eq("id", trailId)
      .eq("owner_user_id", userId);
    if (error && isMissingColumnError(error)) {
      const retry = await supa
        .from("trails")
        .update({ is_public: false })
        .eq("id", trailId)
        .eq("owner_user_id", userId);
      error = retry.error;
    }
    if (error) {
      req.log.error({ err: error }, "soft delete trail failed");
      res.status(500).json({ error: "Failed to delete trail" });
      return;
    }
    res.json({ ok: true, mode: "soft" });
  }),
);

export default router;
