import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { z } from "zod";
import { CreateTrailBody, CreateTrailResponse, SearchTrailsQueryParams, SearchTrailsResponse } from "@workspace/api-zod";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { requireAuth, type AuthedHandler } from "../middlewares/requireAuth";
import { isMissingTableError, isMissingColumnError } from "../lib/dbErrors";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { mintGpxUploadTicket, consumeGpxUploadTicket } from "../lib/uploadTickets";
import { notifyTrailShared, notifyTrailUnshared } from "../lib/pushNotifications";
import { logger } from "../lib/logger";

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
  // Optional group ids to share the new trail into. When privacy=group, the
  // server creates the matching `trail_shares` rows in the same handler — if
  // the share insert fails, the trail row is rolled back so the user never
  // ends up with a private trail they thought they shared. See POST /trails.
  group_ids: z.array(z.string().uuid()).max(50).optional(),
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
  // Optional replacement set of group ids to share the trail into. When
  // present, the server diffs against the current `trail_shares` and applies
  // the additions / removals BEFORE touching trail metadata so a share-write
  // failure cannot leave the trail with stale visibility.
  group_ids: z.array(z.string().uuid()).max(50).optional(),
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
 * Verify the caller belongs to every requested group id. Returns the missing
 * ids (empty array = all good). When the `group_members` table is missing
 * (older Supabase migration window) we treat every requested id as missing
 * so the caller cannot smuggle in shares against a partial schema.
 */
async function findMissingGroupMemberships(
  groupIds: string[],
  userId: string,
): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from("group_members")
    .select("group_id")
    .eq("user_id", userId)
    .in("group_id", groupIds);
  if (error) return [...groupIds];
  const owned = new Set(((data ?? []) as Array<{ group_id: string }>).map((m) => m.group_id));
  return groupIds.filter((g) => !owned.has(g));
}

/**
 * Insert `trail_shares` rows for a freshly-created trail. Returns the
 * underlying error if the insert fails so the caller can roll back the
 * trail row. A no-op for empty `groupIds`.
 */
async function insertTrailShares(
  trailId: string,
  groupIds: string[],
  userId: string,
): Promise<{ error: { code?: string; message?: string } | null }> {
  if (groupIds.length === 0) return { error: null };
  const supa = getSupabaseAdmin();
  const { error } = await supa.from("trail_shares").insert(
    groupIds.map((gid) => ({
      trail_id: trailId,
      group_id: gid,
      shared_by_user_id: userId,
    })),
  );
  // Duplicate inserts (caller picked the same group twice in some edge case)
  // are treated as success — the share already exists.
  if (error && error.code === "23505") return { error: null };
  return { error };
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
// Search
// ---------------------------------------------------------------------------

const SEARCH_COLUMNS = [
  "id",
  "name",
  "type",
  "difficulty",
  "distance_km",
  "terrain",
  "legal_status",
  "source_region",
  "is_public",
  "verification_status",
  "bbox_min_lat",
  "bbox_max_lat",
  "bbox_min_lng",
  "bbox_max_lng",
  "simplified_path",
  "path_geojson",
].join(",");

router.get("/trails/search", async (req: Request, res: Response) => {
  const parsed = SearchTrailsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid query parameter 'q'" });
    return;
  }
  const { q, limit } = parsed.data;
  const escaped = q.replace(/[%_\\]/g, (ch) => `\\${ch}`);
  const pattern = `%${escaped}%`;
  const supa = getSupabaseAdmin();

  const stripDeleted = (rows: unknown[]): unknown[] =>
    (rows as Array<Record<string, unknown> & { deleted_at?: string | null }>)
      .filter((r) => r.deleted_at == null);

  const buildPublicQuery = (cols: string) =>
    supa
      .from("trails")
      .select(cols)
      .eq("is_public", true)
      .is("deleted_at", null)
      .neq("verification_status", "ai-approximated")
      .or(`name.ilike.${pattern},source_region.ilike.${pattern}`)
      .order("distance_km", { ascending: false, nullsFirst: false })
      .limit(limit);

  let { data: publicResults, error } = await buildPublicQuery(SEARCH_COLUMNS);
  if (error && isMissingColumnError(error)) {
    ({ data: publicResults, error } = await buildPublicQuery("*"));
  }
  if (error) {
    req.log.error({ err: error }, "trail search public query failed");
    res.status(500).json({ error: "Search failed" });
    return;
  }

  let results: unknown[] = stripDeleted((publicResults as unknown[]) ?? []);
  const publicIds = new Set(
    (results as Array<{ id: string }>).map((r) => r.id),
  );

  const auth = getAuth(req);
  if (auth.userId) {
    const buildOwnedQuery = (cols: string) =>
      supa
        .from("trails")
        .select(cols)
        .eq("owner_user_id", auth.userId)
        .eq("is_public", false)
        .is("deleted_at", null)
        .neq("verification_status", "ai-approximated")
        .or(`name.ilike.${pattern},source_region.ilike.${pattern}`)
        .order("distance_km", { ascending: false, nullsFirst: false })
        .limit(limit);

    let { data: ownedResults, error: oErr } =
      await buildOwnedQuery(SEARCH_COLUMNS);
    if (oErr && isMissingColumnError(oErr)) {
      ({ data: ownedResults, error: oErr } = await buildOwnedQuery("*"));
    }
    if (!oErr && ownedResults) {
      for (const row of stripDeleted(ownedResults as unknown[])) {
        const id = (row as { id: string }).id;
        if (!publicIds.has(id)) {
          publicIds.add(id);
          results.push(row);
        }
      }
    }

    const { data: memberships } = await supa
      .from("group_members")
      .select("group_id")
      .eq("user_id", auth.userId);

    if (memberships && memberships.length > 0) {
      const groupIds = (memberships as Array<{ group_id: string }>).map(
        (m) => m.group_id,
      );
      const { data: shares } = await supa
        .from("trail_shares")
        .select("trail_id")
        .in("group_id", groupIds);

      if (shares && shares.length > 0) {
        const sharedTrailIds = [
          ...new Set(
            (shares as Array<{ trail_id: string }>).map((s) => s.trail_id),
          ),
        ];
        const extraIds = sharedTrailIds.filter((id) => !publicIds.has(id));

        if (extraIds.length > 0) {
          const buildGroupQuery = (cols: string) =>
            supa
              .from("trails")
              .select(cols)
              .in("id", extraIds)
              .is("deleted_at", null)
              .neq("verification_status", "ai-approximated")
              .or(`name.ilike.${pattern},source_region.ilike.${pattern}`)
              .order("distance_km", { ascending: false, nullsFirst: false })
              .limit(limit);

          let { data: groupResults, error: gErr } =
            await buildGroupQuery(SEARCH_COLUMNS);
          if (gErr && isMissingColumnError(gErr)) {
            ({ data: groupResults, error: gErr } = await buildGroupQuery("*"));
          }
          if (!gErr && groupResults) {
            for (const row of stripDeleted(groupResults as unknown[])) {
              const id = (row as { id: string }).id;
              if (!publicIds.has(id)) {
                publicIds.add(id);
                results.push(row);
              }
            }
          }
        }
      }
    }
  }

  type RowWithName = Record<string, unknown> & { name?: string; distance_km?: number | null };
  const qLower = q.toLowerCase();
  results = (results as RowWithName[])
    .sort((a, b) => {
      const aName = (a.name ?? "").toLowerCase();
      const bName = (b.name ?? "").toLowerCase();
      const aExact = aName === qLower ? 0 : aName.startsWith(qLower) ? 1 : 2;
      const bExact = bName === qLower ? 0 : bName.startsWith(qLower) ? 1 : 2;
      if (aExact !== bExact) return aExact - bExact;
      return (b.distance_km ?? 0) - (a.distance_km ?? 0);
    })
    .slice(0, limit);

  const validated = SearchTrailsResponse.safeParse({ results });
  if (!validated.success) {
    req.log.warn({ err: validated.error }, "trail search response validation failed");
  }
  res.json(validated.success ? validated.data : { results });
});

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
      logger.error({ err }, "[trails] gpx upload-url failed");
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
  // for safety. "group" privacy keeps the trail row itself private
  // (is_public=false) — group visibility is layered on top via rows in
  // `trail_shares` and surfaced to members through `/api/me/group-trails`.
  // When `group_ids` accompanies `privacy=group` we create the share rows
  // here in the same handler (and roll back the trail row on failure) so a
  // half-shared trail can never silently end up private. See
  // `insertTrailShares` below.
  const data = parsed.data;
  let isPublic = data.is_public ?? false;
  if (extras.data.privacy === "public") isPublic = true;
  else if (extras.data.privacy === "private") isPublic = false;
  else if (extras.data.privacy === "group") isPublic = false;

  // Only honour group_ids when privacy=group so a stray field on a public /
  // private trail can't accidentally fan it out to groups.
  const groupIds: string[] = (extras.data.privacy === "group" && extras.data.group_ids)
    ? Array.from(new Set(extras.data.group_ids))
    : [];

  // Validate group memberships BEFORE creating the trail so an invalid
  // request never leaves an orphan row behind.
  if (groupIds.length > 0) {
    const missing = await findMissingGroupMemberships(groupIds, auth.userId);
    if (missing.length > 0) {
      res.status(403).json({ error: "Cannot share into a group you don't belong to" });
      return;
    }
  }

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

    // Now that the trail row exists, fan out the group shares atomically:
    // if the share insert fails for any reason (network blip, race against
    // a group being deleted, FK constraint, etc.) we delete the trail row
    // we just created so the user never ends up with a private trail they
    // thought they shared with a group.
    const newTrailId = (row as { id?: string } | null)?.id ?? null;
    const ownerUserId = auth.userId;
    if (groupIds.length > 0 && newTrailId) {
      const { error: shareErr } = await insertTrailShares(
        newTrailId,
        groupIds,
        ownerUserId,
      );
      if (shareErr) {
        req.log.error(
          { err: shareErr, trailId: newTrailId },
          "createTrail shares insert failed — rolling back trail row",
        );
        const { error: rollbackErr } = await supa
          .from("trails")
          .delete()
          .eq("id", newTrailId)
          .eq("owner_user_id", auth.userId);
        if (rollbackErr) {
          req.log.error(
            { err: rollbackErr, trailId: newTrailId },
            "createTrail rollback failed — orphan trail row may remain",
          );
        }
        // Also clean up the GPX object we finalized for this aborted trail
        // so storage doesn't leak.
        await tryDeleteGpxObject(normalizedObjectPath, req.log);
        res.status(500).json({
          error: "Failed to share trail with selected groups — trail not created",
        });
        return;
      }
      // Best-effort push fan-out — kicked off after the response is queued
      // so it never blocks the request, never throws into the response, and
      // never poisons a successful create even if VAPID isn't configured.
      void notifyTrailShared(newTrailId, groupIds, ownerUserId, req.log);
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

    // See POST /trails for the privacy → is_public mapping. "group" privacy
    // keeps the trail row private and lets `group_ids` (when supplied) drive
    // the matching `trail_shares` rows. Shares are reconciled BEFORE the
    // metadata update so a share-write failure leaves the trail unchanged
    // (rather than flipping it to a privacy state that contradicts its
    // current shares).
    const update: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.privacy === "public") update.is_public = true;
    else if (parsed.data.privacy === "private") update.is_public = false;
    else if (parsed.data.privacy === "group") update.is_public = false;
    delete update.privacy;
    delete update.group_ids;

    const supa = getSupabaseAdmin();

    // Reconcile shares first if the caller passed an explicit `group_ids`
    // list (and / or moved away from privacy=group). Both POST and PATCH
    // accept group_ids so the client never has to fall back to a separate
    // `setTrailShares` follow-up call.
    if (parsed.data.group_ids != null || parsed.data.privacy != null) {
      // Resolve the desired share set:
      //   privacy=public or private  → always clears shares (visibility no
      //     longer needs them, and a stray `group_ids` array shouldn't
      //     contradict the privacy flip)
      //   privacy=group              → use the supplied `group_ids` (or [] when
      //     omitted, but `shouldReconcile` below will skip the no-op case)
      //   privacy unchanged          → use the supplied `group_ids` directly,
      //     so callers can edit just the share list without re-asserting
      //     privacy on every PATCH
      const targetIdsRaw =
        parsed.data.privacy === "public" || parsed.data.privacy === "private"
          ? []
          : (parsed.data.group_ids ?? []);
      const targetIds = Array.from(new Set(targetIdsRaw));

      // Skip the reconcile entirely when the caller didn't provide group_ids
      // AND isn't switching away from group privacy — there's nothing to do.
      const shouldReconcile = parsed.data.group_ids != null ||
        parsed.data.privacy === "private" ||
        parsed.data.privacy === "public";

      if (shouldReconcile) {
        if (targetIds.length > 0) {
          const missing = await findMissingGroupMemberships(targetIds, userId);
          if (missing.length > 0) {
            res.status(403).json({ error: "Cannot share into a group you don't belong to" });
            return;
          }
        }

        const { data: existingShares, error: existingErr } = await supa
          .from("trail_shares")
          .select("group_id")
          .eq("trail_id", trailId);
        if (existingErr && !isMissingTableError(existingErr)) {
          req.log.error({ err: existingErr }, "patch trail load shares failed");
          res.status(500).json({ error: "Failed to update trail shares" });
          return;
        }
        const existingSet = new Set(
          ((existingShares ?? []) as Array<{ group_id: string }>).map((r) => r.group_id),
        );
        const targetSet = new Set(targetIds);
        const toAdd = targetIds.filter((g) => !existingSet.has(g));
        const toRemove = [...existingSet].filter((g) => !targetSet.has(g));

        if (toAdd.length > 0) {
          const { error: addErr } = await insertTrailShares(trailId, toAdd, userId);
          if (addErr) {
            req.log.error({ err: addErr }, "patch trail add shares failed");
            res.status(500).json({ error: "Failed to update trail shares" });
            return;
          }
          // Fire-and-forget push fan-out for the newly-added groups only.
          // Removed groups don't need a notification (and would be confusing).
          void notifyTrailShared(trailId, toAdd, userId, req.log);
        }
        if (toRemove.length > 0) {
          const { error: delErr } = await supa
            .from("trail_shares")
            .delete()
            .eq("trail_id", trailId)
            .in("group_id", toRemove);
          if (delErr) {
            req.log.error({ err: delErr }, "patch trail remove shares failed");
            res.status(500).json({ error: "Failed to update trail shares" });
            return;
          }
          // Best-effort: log a trail_unshared activity event per removed
          // group so the in-app feed surfaces the unshare. The trail row
          // is still present here, so we can snapshot the live name.
          {
            const { data: trailRow } = await supa
              .from("trails")
              .select("name")
              .eq("id", trailId)
              .maybeSingle();
            const trailName =
              (trailRow as { name?: string | null } | null)?.name ?? null;
            const { error: evErr } = await supa
              .from("group_activity_events")
              .insert(
                toRemove.map((gid) => ({
                  type: "trail_unshared",
                  group_id: gid,
                  actor_user_id: userId,
                  trail_id: trailId,
                  trail_name_snapshot: trailName,
                })),
              );
            if (evErr && !isMissingTableError(evErr)) {
              req.log.warn(
                { err: evErr },
                "log trail_unshared events failed",
              );
            }
          }
          void notifyTrailUnshared(trailId, toRemove, userId, req.log);
        }
      }
    }

    // If the only thing the caller sent was `group_ids` (already applied
    // above), there's no metadata to write — just echo back the trail row.
    if (Object.keys(update).length === 0) {
      const { data: row, error: selErr } = await supa
        .from("trails")
        .select()
        .eq("id", trailId)
        .eq("owner_user_id", userId)
        .single();
      if (selErr) {
        req.log.error({ err: selErr }, "patch trail (shares-only) re-read failed");
        res.status(500).json({ error: "Failed to update trail" });
        return;
      }
      res.json(row);
      return;
    }

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
