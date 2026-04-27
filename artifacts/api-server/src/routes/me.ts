import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import {
  SyncMeResponse,
  SaveTrailBody,
  ListMySavedTrailsResponse,
  CountSessionSavedTrailsResponse,
  MigrateSessionSavedTrailsBody,
  MigrateSessionSavedTrailsResponse,
} from "@workspace/api-zod";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";

const router: IRouter = Router();

router.post("/me/sync", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const user = await clerkClient.users.getUser(auth.userId);
    const email =
      user.primaryEmailAddress?.emailAddress ??
      user.emailAddresses[0]?.emailAddress ??
      null;
    const displayName =
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
      user.username ||
      null;
    const avatarUrl = user.imageUrl ?? null;

    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("users")
      .upsert(
        {
          id: auth.userId,
          email,
          display_name: displayName,
          avatar_url: avatarUrl,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      )
      .select()
      .single();

    if (error) {
      // Tolerate missing-table state (migration not yet applied) so the UI
      // does not break — return a synthetic shape.
      if (
        error.code === "42P01" ||
        error.code === "PGRST205" ||
        /relation .* does not exist/i.test(error.message ?? "")
      ) {
        req.log.warn(
          "users table missing — apply migration 0002_users_and_owner.sql",
        );
        res.json(
          SyncMeResponse.parse({
            id: auth.userId,
            email,
            display_name: displayName,
            avatar_url: avatarUrl,
            created_at: new Date().toISOString(),
          }),
        );
        return;
      }
      req.log.error({ err: error }, "users upsert failed");
      res.status(500).json({ error: "Failed to upsert user" });
      return;
    }

    res.json(SyncMeResponse.parse(data));
  } catch (err) {
    req.log.error({ err }, "syncMe failed");
    res.status(500).json({ error: "Failed to sync user" });
  }
});

router.get("/me/saved-trails", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const sessionId =
    typeof req.query.sessionId === "string" ? req.query.sessionId : null;

  if (!auth.userId && !sessionId) {
    res.json(ListMySavedTrailsResponse.parse({ items: [] }));
    return;
  }

  try {
    const supa = getSupabaseAdmin();
    let q = supa
      .from("saved_trails")
      .select("trail_id, status, saved_at, trails(*)")
      .order("saved_at", { ascending: false });

    if (auth.userId) {
      q = q.eq("user_id", auth.userId);
    } else if (sessionId) {
      q = q.eq("session_id", sessionId);
    }

    const { data, error } = await q;
    if (error) {
      if (
        error.code === "42P01" ||
        error.code === "PGRST205" ||
        /relation .* does not exist/i.test(error.message ?? "")
      ) {
        res.json(ListMySavedTrailsResponse.parse({ items: [] }));
        return;
      }
      req.log.error({ err: error }, "fetchSavedTrails failed");
      res.status(500).json({ error: "Failed to fetch saved trails" });
      return;
    }

    type TrailRel = Record<string, unknown>;
    interface SavedTrailRow {
      trail_id: string;
      status: string | null;
      saved_at: string | null;
      trails: TrailRel | TrailRel[] | null;
    }
    const rows = (data ?? []) as SavedTrailRow[];
    const items = rows.map((row) => ({
      trail_id: row.trail_id,
      status: row.status,
      saved_at: row.saved_at,
      trail: Array.isArray(row.trails) ? (row.trails[0] ?? null) : row.trails,
    }));

    res.json(ListMySavedTrailsResponse.parse({ items }));
  } catch (err) {
    req.log.error({ err }, "saved-trails GET failed");
    res.status(500).json({ error: "Failed to fetch saved trails" });
  }
});

router.post("/me/saved-trails", async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const parsed = SaveTrailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing trail id" });
    return;
  }

  const trailId = parsed.data.trailId;
  const sessionId = parsed.data.sessionId ?? null;

  if (!auth.userId && !sessionId) {
    res.status(400).json({ error: "Either Clerk session or sessionId required" });
    return;
  }

  try {
    const supa = getSupabaseAdmin();
    const row: Record<string, unknown> = {
      trail_id: trailId,
      status: "planned",
    };
    if (auth.userId) {
      row.user_id = auth.userId;
      row.session_id = null;
    } else {
      row.session_id = sessionId;
    }

    const onConflict = auth.userId ? "user_id,trail_id" : "session_id,trail_id";
    let { error } = await supa
      .from("saved_trails")
      .upsert(row, { onConflict });
    if (error) {
      // Older schema (no unique index) — fall back to plain insert; ignore dupes.
      if (error.code === "42P10" || /no.*unique.*constraint/i.test(error.message ?? "")) {
        const { error: insErr } = await supa.from("saved_trails").insert(row);
        if (insErr && insErr.code !== "23505") error = insErr;
        else error = null;
      }
    }
    if (error) {
      req.log.error({ err: error }, "saveTrail failed");
      res.status(500).json({ error: "Failed to save trail" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "saveTrail failed");
    res.status(500).json({ error: "Failed to save trail" });
  }
});

router.get("/me/saved-trails/count", async (req: Request, res: Response) => {
  const sessionId =
    typeof req.query.sessionId === "string" ? req.query.sessionId : "";
  if (!sessionId) {
    res.status(400).json({ error: "sessionId required" });
    return;
  }
  try {
    const supa = getSupabaseAdmin();
    const { count, error } = await supa
      .from("saved_trails")
      .select("trail_id", { count: "exact", head: true })
      .eq("session_id", sessionId);
    if (error) {
      res.json(CountSessionSavedTrailsResponse.parse({ count: 0 }));
      return;
    }
    res.json(
      CountSessionSavedTrailsResponse.parse({ count: count ?? 0 }),
    );
  } catch (err) {
    req.log.error({ err }, "count saved-trails failed");
    res.json(CountSessionSavedTrailsResponse.parse({ count: 0 }));
  }
});

router.post(
  "/me/saved-trails/migrate",
  async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = MigrateSessionSavedTrailsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "sessionId required" });
      return;
    }

    try {
      const supa = getSupabaseAdmin();
      const { data: rows, error: findErr } = await supa
        .from("saved_trails")
        .select("trail_id")
        .eq("session_id", parsed.data.sessionId);
      if (findErr) {
        if (
          findErr.code === "42P01" ||
          findErr.code === "PGRST205" ||
          /relation .* does not exist/i.test(findErr.message ?? "")
        ) {
          res.json(MigrateSessionSavedTrailsResponse.parse({ migrated: 0 }));
          return;
        }
        req.log.error({ err: findErr }, "migrate find failed");
        res.status(500).json({ error: "Failed to find session rows" });
        return;
      }
      if (!rows || rows.length === 0) {
        res.json(MigrateSessionSavedTrailsResponse.parse({ migrated: 0 }));
        return;
      }

      let migrated = 0;
      for (const row of rows) {
        const { error: upErr } = await supa
          .from("saved_trails")
          .upsert(
            {
              trail_id: row.trail_id as string,
              user_id: auth.userId,
              session_id: null,
              status: "planned",
            },
            { onConflict: "user_id,trail_id" },
          );
        if (!upErr) {
          migrated += 1;
        } else {
          // Fallback: plain UPDATE for the matching session-bound row.
          const { error: updErr } = await supa
            .from("saved_trails")
            .update({ user_id: auth.userId, session_id: null })
            .eq("session_id", parsed.data.sessionId)
            .eq("trail_id", row.trail_id as string);
          if (!updErr) migrated += 1;
        }
      }
      res.json(
        MigrateSessionSavedTrailsResponse.parse({ migrated }),
      );
    } catch (err) {
      req.log.error({ err }, "migrate failed");
      res.status(500).json({ error: "Failed to migrate saved trails" });
    }
  },
);

export default router;
