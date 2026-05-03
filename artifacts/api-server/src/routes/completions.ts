import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { z } from "zod";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";

const router: IRouter = Router();

/**
 * Trail completions ("ridden" log) — one row per (user, trail).
 *
 * GET    /me/completions          — list the caller's completions, newest
 *                                   first, joined with the trail row so
 *                                   the My Trails "Ridden" section can
 *                                   render distance / difficulty without
 *                                   a second fetch.
 * POST   /me/completions          — mark a trail as ridden. Upsert on
 *                                   (user_id, trail_id) so re-marking
 *                                   updates the timestamp/note rather
 *                                   than failing.
 * DELETE /me/completions/:trailId — un-mark.
 *
 * Anonymous callers receive 401 — completions are per signed-in user.
 * The "missing table = empty" tolerance mirrors saved-trails so a
 * deploy where the migration hasn't been applied yet still renders
 * the rest of the app.
 */

const MarkCompletionBody = z.object({
  trailId: z.string().min(1),
  completedAt: z.string().datetime().optional(),
  note: z.string().max(500).optional(),
});

interface CompletionRow {
  id: string;
  trail_id: string;
  completed_at: string;
  note: string | null;
  trails: Record<string, unknown> | Record<string, unknown>[] | null;
}

router.get("/me/completions", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.json({ items: [] });
    return;
  }
  try {
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("trail_completions")
      .select("id, trail_id, completed_at, note, trails(*)")
      .eq("user_id", auth.userId)
      .order("completed_at", { ascending: false });
    if (error) {
      if (
        error.code === "42P01" ||
        error.code === "PGRST205" ||
        /relation .* does not exist/i.test(error.message ?? "")
      ) {
        res.json({ items: [] });
        return;
      }
      req.log.error({ err: error }, "list completions failed");
      res.status(500).json({ error: "Failed to fetch completions" });
      return;
    }
    const rows = (data ?? []) as CompletionRow[];
    const items = rows.map((row) => ({
      id: row.id,
      trail_id: row.trail_id,
      completed_at: row.completed_at,
      note: row.note,
      trail: Array.isArray(row.trails) ? (row.trails[0] ?? null) : row.trails,
    }));
    res.json({ items });
  } catch (err) {
    req.log.error({ err }, "completions GET failed");
    res.status(500).json({ error: "Failed to fetch completions" });
  }
});

router.post("/me/completions", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Sign in to mark trails as ridden" });
    return;
  }
  const parsed = MarkCompletionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { trailId, completedAt, note } = parsed.data;
  try {
    const supa = getSupabaseAdmin();

    // Verify the trail exists before recording a completion. Without this
    // a caller could persist an arbitrary uuid (or one belonging to a
    // soft-deleted/private trail) and then read its joined data back via
    // GET /me/completions. Trails in TrailForge are community-visible by
    // design so the existence check is sufficient — we don't need a
    // per-user visibility predicate, but we do need to refuse unknown ids.
    const { data: trailRow, error: trailErr } = await supa
      .from("trails")
      .select("id")
      .eq("id", trailId)
      .maybeSingle();
    if (trailErr) {
      req.log.error({ err: trailErr }, "completion trail-existence check failed");
      res.status(500).json({ error: "Failed to mark trail as ridden" });
      return;
    }
    if (!trailRow) {
      res.status(404).json({ error: "Trail not found" });
      return;
    }

    const row: Record<string, unknown> = {
      user_id: auth.userId,
      trail_id: trailId,
    };
    if (completedAt) row.completed_at = completedAt;
    if (note != null) row.note = note;

    let { error } = await supa
      .from("trail_completions")
      .upsert(row, { onConflict: "user_id,trail_id" });
    if (error) {
      // Older schema (no unique index) — fall back to plain insert.
      if (
        error.code === "42P10" ||
        /no.*unique.*constraint/i.test(error.message ?? "")
      ) {
        const { error: insErr } = await supa
          .from("trail_completions")
          .insert(row);
        if (insErr && insErr.code !== "23505") error = insErr;
        else error = null;
      }
    }
    if (error) {
      if (
        error.code === "42P01" ||
        /relation .* does not exist/i.test(error.message ?? "")
      ) {
        res.status(503).json({
          error: "Completions table not yet migrated. Run 0020_trail_completions.sql.",
          code: "MIGRATION_REQUIRED",
        });
        return;
      }
      req.log.error({ err: error }, "mark completion failed");
      res.status(500).json({ error: "Failed to mark trail as ridden" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "mark completion failed");
    res.status(500).json({ error: "Failed to mark trail as ridden" });
  }
});

router.delete(
  "/me/completions/:trailId",
  async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const trailId = req.params.trailId;
    if (!trailId) {
      res.status(400).json({ error: "trailId required" });
      return;
    }
    try {
      const supa = getSupabaseAdmin();
      const { error } = await supa
        .from("trail_completions")
        .delete()
        .eq("user_id", auth.userId)
        .eq("trail_id", trailId);
      if (error) {
        if (
          error.code === "42P01" ||
          /relation .* does not exist/i.test(error.message ?? "")
        ) {
          res.json({ ok: true });
          return;
        }
        req.log.error({ err: error }, "unmark completion failed");
        res.status(500).json({ error: "Failed to remove completion" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "unmark completion failed");
      res.status(500).json({ error: "Failed to remove completion" });
    }
  },
);

export default router;
