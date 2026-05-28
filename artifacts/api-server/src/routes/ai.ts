import { Router, type IRouter, type Request, type Response } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { z } from "zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { logger } from "../lib/logger";
import { explainAdminAccess, getAdminAccessState, readEnvAdminList } from "../lib/admin";
import { requireAuth, type AuthedHandler } from "../middlewares/requireAuth";
import { isMissingTableError, isMissingColumnError } from "../lib/dbErrors";
import {
  computeRouteStats,
  fetchOsmTagSummary,
  gradeTrailWithAI,
  type GpxPoint,
} from "../lib/aiGrading";
import {
  approximateTrackFromLocation,
  bboxFromPoints,
  buildGpxFromWaypoints,
  distanceKmFromPoints,
  extractTrailFromForumPost,
  fetchAndExtractPostLinks,
  fetchAndParseGpxUrl,
  fetchForumPost,
  findExistingTrailMatch,
  parseGpxText,
} from "../lib/aiDiscovery";

const router: IRouter = Router();

const ASSISTANT_MODEL = "claude-sonnet-4-6";
const SYSTEM_PROMPT = [
  "You are TrailForge AI — a UK / Europe off-road motorcycle and 4x4 trail expert.",
  "You help riders pick legal, well-suited trails based on their skill level, location and the trails available in our database.",
  "When the user asks for a trail, ALWAYS prefer trails from the provided context list and reference them by name.",
  "Be honest about safety: BOATs are legal, restricted byways are not for motors, always check local restrictions.",
  "Reply in plain text, max 6 short paragraphs. Use bullet lists for trail recommendations. Never invent trail IDs.",
].join(" ");

// ---------------------------------------------------------------------------
// Helpers shared across routes
// ---------------------------------------------------------------------------

function requireAdmin(handler: AuthedHandler) {
  return requireAuth(async (req, res, userId) => {
    const state = await getAdminAccessState(userId);
    if (state.kind !== "admin") {
      const explainer = explainAdminAccess(state);
      res.status(explainer.status).json({
        error: explainer.message,
        code: explainer.code,
        state: state.kind,
      });
      return;
    }
    await handler(req, res, userId);
  });
}


function gpxJsonToPoints(gpxData: unknown): GpxPoint[] {
  if (typeof gpxData === "string") return parseGpxText(gpxData);
  if (Array.isArray(gpxData)) {
    const out: GpxPoint[] = [];
    for (const p of gpxData) {
      if (p && typeof p === "object") {
        const lat = (p as Record<string, unknown>).lat;
        const lon = (p as Record<string, unknown>).lon ?? (p as Record<string, unknown>).lng;
        const ele = (p as Record<string, unknown>).ele;
        if (typeof lat === "number" && typeof lon === "number") {
          out.push({ lat, lon, ele: typeof ele === "number" ? ele : null });
        }
      }
    }
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------------
// GET /api/admin/whoami — returns whether the caller is an admin
// (used by the admin page to decide whether to render the dashboard).
// ---------------------------------------------------------------------------
router.get("/admin/whoami", async (req, res) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.json({
      isAdmin: false,
      isModerator: false,
      signedIn: false,
      state: "signed-out",
      code: "ADMIN_FORBIDDEN",
      message: "Sign in to check admin access.",
    });
    return;
  }
  const state = await getAdminAccessState(auth.userId);
  const explainer = explainAdminAccess(state);
  const isAdmin = state.kind === "admin";
  res.json({
    isAdmin,
    // Mobile reads `isModerator`; keep both for web/mobile parity.
    isModerator: isAdmin,
    signedIn: true,
    userId: auth.userId,
    state: state.kind,
    code: explainer.code,
    message: explainer.message,
  });
});

// ---------------------------------------------------------------------------
// Self-service admin management — list / grant / revoke rows in
// `system_admins`. These endpoints only operate on the DB-backed list; the
// `SYSTEM_ADMIN_USER_IDS` env var continues to act as a parallel bootstrap
// path and is surfaced read-only on GET so the UI can warn about it.
//
// The "last admin can't revoke themselves" rule guards against a single
// admin accidentally locking the team out of the dashboard. We only count
// rows in `system_admins` for that check — env-var admins are an
// implementation detail of the bootstrap path.
// ---------------------------------------------------------------------------
router.get(
  "/admin/admins",
  requireAdmin(async (_req, res) => {
    const supa = getSupabaseAdmin();
    // NOTE: We deliberately do NOT use a PostgREST embedded `users(...)`
    // join here. `system_admins.user_id` has no foreign key to
    // `users.id` (see migration 0007 — the column is just `text PRIMARY
    // KEY`), so an embedded select would fail with a "relationship not
    // found" error in production. Fetch the rows, then enrich with a
    // bounded second query.
    const { data: adminRows, error } = await supa
      .from("system_admins")
      .select("user_id, granted_at, granted_by, note")
      .order("granted_at", { ascending: true });
    if (error) {
      if (isMissingTableError(error)) {
        res.json({
          items: [],
          envAdmins: readEnvAdminList(),
          note: "system_admins table missing — apply migration 0007",
        });
        return;
      }
      res.status(500).json({ error: "Failed to load admins" });
      return;
    }
    const rows = (adminRows ?? []) as Array<{
      user_id: string;
      granted_at: string;
      granted_by: string | null;
      note: string | null;
    }>;
    const userIds = rows.map((r) => r.user_id).filter(Boolean);
    type UserMeta = {
      id: string;
      email: string | null;
      display_name: string | null;
      avatar_url: string | null;
    };
    const userById = new Map<string, UserMeta>();
    if (userIds.length > 0) {
      const { data: usersData } = await supa
        .from("users")
        .select("id, email, display_name, avatar_url")
        .in("id", userIds);
      for (const u of (usersData ?? []) as UserMeta[]) {
        userById.set(u.id, u);
      }
    }
    const items = rows.map((r) => ({
      ...r,
      users: userById.get(r.user_id) ?? null,
    }));
    res.json({ items, envAdmins: readEnvAdminList() });
  }),
);

const NewAdminBody = z.object({
  userId: z.string().trim().min(1).max(200),
  note: z.string().max(500).optional().nullable(),
});

router.post(
  "/admin/admins",
  requireAdmin(async (req, res, callerUserId) => {
    const parsed = NewAdminBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid admin body" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data: existing, error: lookupErr } = await supa
      .from("system_admins")
      .select("user_id")
      .eq("user_id", parsed.data.userId)
      .maybeSingle();
    if (lookupErr && isMissingTableError(lookupErr)) {
      res.status(503).json({ error: "system_admins table missing — apply migration 0007" });
      return;
    }
    if (existing) {
      res.status(409).json({ error: "User is already an admin" });
      return;
    }
    const { data, error } = await supa
      .from("system_admins")
      .insert({
        user_id: parsed.data.userId,
        granted_by: callerUserId,
        note: parsed.data.note ?? null,
      })
      .select()
      .single();
    if (error) {
      if (isMissingTableError(error)) {
        res.status(503).json({ error: "system_admins table missing — apply migration 0007" });
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }
    res.json(data);
  }),
);

router.get(
  "/admin/users",
  requireAdmin(async (req, res) => {
    const query = String(req.query.query ?? "").trim();
    const limit = Math.min(
      Math.max(Number(req.query.limit ?? 25) || 25, 1),
      50,
    );
    try {
      const result = await clerkClient.users.getUserList({
        query: query || undefined,
        limit,
        orderBy: "-created_at",
      });
      const items = result.data.map((u) => ({
        user_id: u.id,
        email: u.primaryEmailAddress?.emailAddress ?? null,
        display_name:
          [u.firstName, u.lastName].filter(Boolean).join(" ") ||
          u.username ||
          u.primaryEmailAddress?.emailAddress ||
          null,
        avatar_url: u.imageUrl ?? null,
      }));
      res.json({ items, total: result.totalCount });
    } catch (err) {
      req.log?.warn?.({ err }, "admin/users: clerk lookup failed");
      res.status(502).json({ error: "User directory lookup failed" });
    }
  }),
);

router.delete(
  "/admin/admins/:userId",
  requireAdmin(async (req, res, callerUserId) => {
    const targetUserId = String(req.params.userId ?? "").trim();
    if (!targetUserId) {
      res.status(400).json({ error: "Missing user id" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data: rows, error: listErr } = await supa
      .from("system_admins")
      .select("user_id");
    if (listErr) {
      if (isMissingTableError(listErr)) {
        res.status(503).json({ error: "system_admins table missing — apply migration 0007" });
        return;
      }
      res.status(500).json({ error: "Failed to load admins" });
      return;
    }
    const allAdmins = (rows ?? []) as Array<{ user_id: string }>;
    const targetIsAdmin = allAdmins.some((r) => r.user_id === targetUserId);
    if (!targetIsAdmin) {
      // Idempotent — already gone.
      res.json({ ok: true, removed: false });
      return;
    }
    if (targetUserId === callerUserId && allAdmins.length <= 1) {
      res.status(409).json({
        error:
          "You are the only admin — add another admin before revoking your own access.",
      });
      return;
    }
    const { error } = await supa
      .from("system_admins")
      .delete()
      .eq("user_id", targetUserId);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ ok: true, removed: true });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/ai/chat — grounded chat for the AI tab
// ---------------------------------------------------------------------------
const ChatBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(20),
  // Caller-provided context: nearby viewport bbox + saved-trail ids.
  bbox: z
    .object({
      minLat: z.number(),
      maxLat: z.number(),
      minLng: z.number(),
      maxLng: z.number(),
    })
    .nullish(),
});

router.post("/ai/chat", async (req, res, next) => {
  // Require authentication — unauthenticated AI chat calls Anthropic and is
  // expensive to abuse. Returning 401 here also prevents guest data exposure.
  const _earlyAuth = getAuth(req);
  if (!_earlyAuth.userId) {
    res.status(401).json({ error: "Sign in to use the AI trail assistant" });
    return;
  }

  try {
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid chat body" });
      return;
    }
    const auth = getAuth(req);
    const supa = getSupabaseAdmin();

    // Pull a small set of grounding context: trails near the viewport, and
    // (if signed in) the user's saved trails. Both are best-effort.
    const contextTrails: Array<{
      id: string;
      name: string;
      difficulty: number | null;
      distance_km: number | null;
      legal_status: string | null;
      verification_status?: string | null;
      source?: string | null;
    }> = [];

    if (parsed.data.bbox) {
      const b = parsed.data.bbox;
      const { data } = await supa
        .from("trails")
        .select("id, name, difficulty, distance_km, legal_status, verification_status, source")
        .eq("is_public", true)
        .lte("bbox_min_lat", b.maxLat)
        .gte("bbox_max_lat", b.minLat)
        .lte("bbox_min_lng", b.maxLng)
        .gte("bbox_max_lng", b.minLng)
        .limit(40);
      if (data) contextTrails.push(...(data as typeof contextTrails));
    }

    if (auth.userId) {
      try {
        const { data } = await supa
          .from("saved_trails")
          .select("trail:trails(id, name, difficulty, distance_km, legal_status, verification_status, source)")
          .eq("user_id", auth.userId)
          .limit(20);
        if (data) {
          // Supabase types nested joins as arrays, but the FK is 1:1 — flatten.
          for (const row of data as unknown as Array<{
            trail:
              | typeof contextTrails[number]
              | typeof contextTrails[number][]
              | null;
          }>) {
            const t = Array.isArray(row.trail) ? row.trail[0] : row.trail;
            if (t) contextTrails.push(t);
          }
        }
      } catch {
        /* tolerate missing tables / columns */
      }
    }

    // Dedupe context trails by id, cap at 50.
    const seen = new Set<string>();
    const grounding = contextTrails
      .filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      })
      .slice(0, 50);

    const groundingText = grounding.length
      ? grounding
          .map((t) => {
            const verif = t.verification_status && t.verification_status !== "verified"
              ? ` [${t.verification_status}]`
              : "";
            return `- ${t.name} · difficulty ${t.difficulty ?? "?"}/10 · ${t.distance_km != null ? `${t.distance_km.toFixed(1)} km` : "?"} · ${t.legal_status ?? "trail"}${verif}`;
          })
          .join("\n")
      : "(no nearby or saved trails — answer using general off-road knowledge)";

    const systemPrompt = `${SYSTEM_PROMPT}\n\nNearby and saved trails the user might be interested in:\n${groundingText}`;

    const message = await anthropic.messages.create({
      model: ASSISTANT_MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: parsed.data.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    let reply = "";
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") reply += block.text;
    }

    res.json({
      reply: reply.trim() || "Sorry — I couldn't form a reply. Try asking a more specific question.",
      groundingCount: grounding.length,
      groundingTrails: grounding.slice(0, 8).map((t) => ({
        id: t.id,
        name: t.name,
        difficulty: t.difficulty,
        distance_km: t.distance_km,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/trails/:id/grade-ai — grade (or re-grade) a single trail.
// Owner OR admin only.
// ---------------------------------------------------------------------------
router.post(
  "/trails/:trailId/grade-ai",
  requireAuth(async (req, res, userId) => {
    const trailId = z.string().uuid().safeParse(req.params.trailId);
    if (!trailId.success) {
      res.status(400).json({ error: "Invalid trail id" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data: trail, error: loadErr } = await supa
      .from("trails")
      .select("*")
      .eq("id", trailId.data)
      .maybeSingle();
    if (loadErr) {
      req.log.error({ err: loadErr }, "grade-ai load failed");
      res.status(500).json({ error: "Failed to load trail" });
      return;
    }
    if (!trail) {
      res.status(404).json({ error: "Trail not found" });
      return;
    }
    const isOwner = trail.owner_user_id === userId;
    const adminState = await getAdminAccessState(userId);
    const isAdmin = adminState.kind === "admin";
    if (!isOwner && !isAdmin) {
      const explainer = explainAdminAccess(adminState);
      // Owner-or-admin endpoint: prefer the admin-explainer when admin
      // bootstrap is what's missing (so the message reads "apply migration"
      // / "set SYSTEM_ADMIN_USER_IDS" instead of a generic 403). For a
      // plain "not-admin" caller fall back to the owner-or-admin wording.
      const message =
        adminState.kind === "not-admin"
          ? "Only the trail owner or an admin can re-grade this trail"
          : explainer.message;
      res.status(explainer.status).json({
        error: message,
        code: explainer.code,
        state: adminState.kind,
      });
      return;
    }
    const result = await gradeOneTrail(trail);
    if (!result.ok) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.json({
      grade: result.grade,
      rationale: result.rationale,
      model: result.model,
    });
  }),
);

// Helper used by /grade-ai and /admin/grade-backfill.
async function gradeOneTrail(trail: Record<string, unknown>): Promise<
  | { ok: true; grade: number; rationale: string; model: string }
  | { ok: false; error: string }
> {
  const supa = getSupabaseAdmin();
  const points = gpxJsonToPoints(trail.gpx_data);
  const bbox = bboxFromPoints(points);
  const osmTags = await fetchOsmTagSummary(bbox);
  try {
    const { grade, rationale, model } = await gradeTrailWithAI({
      name: String(trail.name ?? ""),
      legalStatus: (trail.legal_status as string | null) ?? null,
      terrain: (trail.terrain as string | null) ?? null,
      description: (trail.description as string | null) ?? null,
      source: (trail.source as string | null) ?? null,
      sourceUrl: (trail.source_url as string | null) ?? null,
      waypoints: points,
      osmTags,
    });
    let { error } = await supa
      .from("trails")
      .update({
        ai_grade: grade,
        ai_grade_rationale: rationale,
        ai_grade_model: model,
        ai_graded_at: new Date().toISOString(),
        difficulty: (trail.difficulty as number | null) ?? grade,
      })
      .eq("id", trail.id as string);
    if (error && isMissingColumnError(error)) {
      // Migration 0007 not applied — store difficulty only.
      const retry = await supa
        .from("trails")
        .update({ difficulty: grade })
        .eq("id", trail.id as string);
      error = retry.error;
    }
    if (error) return { ok: false, error: error.message };
    return { ok: true, grade, rationale, model };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "AI grading failed" };
  }
}

// ---------------------------------------------------------------------------
// POST /api/admin/grade-backfill — re-grade every trail without an AI grade
// (or all of them when ?force=1). Returns counts. Iterative + bounded.
// ---------------------------------------------------------------------------
export interface BackfillResult {
  graded: number;
  failed: number;
  scanned: number;
  note?: string;
}

export async function runGradeBackfill(opts?: { force?: boolean; limit?: number }): Promise<BackfillResult> {
  const force = Boolean(opts?.force);
  const limit = Math.min(50, Math.max(1, opts?.limit ?? 20));
  const supa = getSupabaseAdmin();
  let q = supa
    .from("trails")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (!force) {
    q = q.is("ai_grade", null);
  }
  const { data, error } = await q;
  if (error) {
    if (isMissingColumnError(error) || isMissingTableError(error)) {
      return { graded: 0, failed: 0, scanned: 0, note: "ai_grade column missing — apply migration 0007" };
    }
    return { graded: 0, failed: 0, scanned: 0, note: error.message };
  }
  let graded = 0;
  let failed = 0;
  for (const trail of (data ?? []) as Record<string, unknown>[]) {
    const r = await gradeOneTrail(trail);
    if (r.ok) graded++;
    else failed++;
  }
  return { graded, failed, scanned: (data ?? []).length };
}

router.post(
  "/admin/grade-backfill",
  requireAdmin(async (req, res) => {
    const result = await runGradeBackfill({
      force: String(req.query.force ?? "") === "1",
      limit: Number(req.query.limit ?? 20) || 20,
    });
    res.json(result);
  }),
);

// ---------------------------------------------------------------------------
// Forum scan — admin-triggered (and scheduled): for each configured forum
// source, walk the index/feed, extract individual post URLs, and process
// each post separately. The previous implementation scanned each source
// URL as a single page (one trail per source max) — this version honours
// the "for each post" requirement.
//
// Optionally accept a one-off URL via ?url= for ad-hoc testing.
// ---------------------------------------------------------------------------
export interface ForumScanResult {
  scanned: number;        // index pages walked
  visitedPosts: number;   // individual posts fetched
  queued: number;         // new discovery rows inserted
  skipped: number;        // skipped because url already queued / dedupe
  errors: string[];
}

export async function runForumScan(opts?: { oneOffUrl?: string | null }): Promise<ForumScanResult> {
  const supa = getSupabaseAdmin();
  const sources: Array<{ id?: string; url: string; label: string; kind: "rss" | "html" }> = [];
  if (opts?.oneOffUrl) {
    sources.push({ url: opts.oneOffUrl, label: "ad-hoc", kind: "html" });
  } else {
    const { data, error } = await supa
      .from("forum_sources")
      .select("id, url, label, kind, disabled")
      .eq("disabled", false)
      .limit(20);
    if (error) {
      if (isMissingTableError(error)) {
        return { scanned: 0, visitedPosts: 0, queued: 0, skipped: 0, errors: ["forum_sources table missing — apply migration 0007"] };
      }
      return { scanned: 0, visitedPosts: 0, queued: 0, skipped: 0, errors: [error.message] };
    }
    for (const row of (data ?? []) as Array<{ id: string; url: string; label: string; kind: string }>) {
      sources.push({
        id: row.id,
        url: row.url,
        label: row.label,
        kind: row.kind === "rss" ? "rss" : "html",
      });
    }
  }

  let scanned = 0;
  let visitedPosts = 0;
  let queued = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const src of sources) {
    scanned++;
    try {
      const postUrls = await fetchAndExtractPostLinks(src.url, src.kind);
      if (postUrls.length === 0) {
        errors.push(`no posts discovered: ${src.url}`);
        if (src.id) {
          await supa
            .from("forum_sources")
            .update({ last_scanned_at: new Date().toISOString() })
            .eq("id", src.id);
        }
        continue;
      }

      for (const postUrl of postUrls) {
        visitedPosts++;
        try {
          // Per-post URL dedupe — never queue the same post twice.
          const { data: existing } = await supa
            .from("ai_discovered_trails")
            .select("id")
            .eq("source_url", postUrl)
            .maybeSingle();
          if (existing) {
            skipped++;
            continue;
          }

          const html = await fetchForumPost(postUrl);
          if (!html) continue;
          const extracted = await extractTrailFromForumPost(html, postUrl);
          if (!extracted) continue;

          let waypoints: GpxPoint[] = [];
          let bbox = null as ReturnType<typeof bboxFromPoints>;
          let aiSource: "ai-forum" | "ai-approx" = "ai-approx";
          let gpxData: unknown = null;
          if (extracted.gpxUrl) {
            const gpx = await fetchAndParseGpxUrl(extracted.gpxUrl);
            if (gpx) {
              waypoints = gpx.waypoints;
              bbox = bboxFromPoints(waypoints);
              gpxData = gpx.gpxText;
              aiSource = "ai-forum";
            }
          }
          if (waypoints.length === 0 && extracted.location) {
            const approx = await approximateTrackFromLocation(extracted.location);
            if (approx) {
              waypoints = approx.waypoints;
              bbox = approx.bbox;
              gpxData = buildGpxFromWaypoints(extracted.trailName ?? "AI-discovered trail", waypoints);
            }
          }

          // No real geometry could be obtained — neither a downloadable GPX
          // nor an OSM-track snap. Skip the post rather than persist a
          // straight-line "phantom trail" placeholder. (Historically we
          // wrote a 2-point ~500m offset here; that polluted the map.)
          if (waypoints.length < 2 || !bbox) {
            skipped++;
            const reason = `no GPX and no nearby OSM track to snap to`;
            errors.push(
              `skipped "${extracted.trailName ?? postUrl}": ${reason}`,
            );
            const recorded = await recordScanSkip(supa, {
              sourceUrl: postUrl,
              sourceLabel: src.label,
              extractedName: extracted.trailName ?? null,
              reason,
            });
            if (!recorded.ok && recorded.error) {
              errors.push(`failed to persist skip for ${postUrl}: ${recorded.error}`);
            }
            continue;
          }

          // Bbox-aware dedupe: skip if we already publish this trail.
          if (extracted.trailName && bbox) {
            const match = await findExistingTrailMatch(supa, {
              name: extracted.trailName,
              bbox,
            });
            if (match) {
              skipped++;
              continue;
            }
          }

          let aiGrade: number | null = extracted.difficulty;
          let aiRationale: string | null = null;
          if (waypoints.length >= 2) {
            try {
              const g = await gradeTrailWithAI({
                name: extracted.trailName ?? "AI-discovered trail",
                legalStatus: null,
                terrain: extracted.surface,
                description: extracted.summary,
                source: aiSource,
                sourceUrl: postUrl,
                waypoints,
              });
              aiGrade = g.grade;
              aiRationale = g.rationale;
            } catch {
              /* leave grade as the extracted one */
            }
          }

          const insert: Record<string, unknown> = {
            source: aiSource,
            source_url: postUrl,
            source_title: src.label,
            extracted_name: extracted.trailName,
            extracted_location: extracted.location,
            extracted_summary: extracted.summary,
            extracted_difficulty: extracted.difficulty,
            extracted_surface: extracted.surface,
            gpx_data: gpxData,
            bbox_min_lat: bbox?.minLat ?? null,
            bbox_max_lat: bbox?.maxLat ?? null,
            bbox_min_lng: bbox?.minLng ?? null,
            bbox_max_lng: bbox?.maxLng ?? null,
            ai_grade: aiGrade,
            ai_grade_rationale: aiRationale,
          };
          const { error: insErr } = await supa.from("ai_discovered_trails").insert(insert);
          if (insErr) {
            if (isMissingTableError(insErr)) {
              errors.push("ai_discovered_trails table missing — apply migration 0007");
              return { scanned, visitedPosts, queued, skipped, errors };
            }
            errors.push(insErr.message);
            continue;
          }
          queued++;
        } catch (err) {
          errors.push(err instanceof Error ? err.message : "post scan failed");
        }
      }

      if (src.id) {
        await supa
          .from("forum_sources")
          .update({ last_scanned_at: new Date().toISOString() })
          .eq("id", src.id);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "source scan failed");
    }
  }

  return { scanned, visitedPosts, queued, skipped, errors };
}

async function recordScanSkip(
  supa: ReturnType<typeof getSupabaseAdmin>,
  args: {
    sourceUrl: string;
    sourceLabel: string | null;
    extractedName: string | null;
    reason: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  const now = new Date().toISOString();
  // Upsert by source_url so repeated scans bump the counter rather than
  // duplicating rows. If the row was already resolved, surface it again
  // (status -> pending) because the underlying problem still exists.
  const { data: existing, error: selErr } = await supa
    .from("ai_scan_skips")
    .select("id, seen_count")
    .eq("source_url", args.sourceUrl)
    .maybeSingle();
  if (selErr) {
    if (isMissingTableError(selErr)) {
      logger.warn(
        { sourceUrl: args.sourceUrl },
        "ai_scan_skips table missing — apply migration 0020; skip not persisted",
      );
      return { ok: false, error: "ai_scan_skips table missing — apply migration 0020" };
    }
    logger.error(
      { err: selErr, sourceUrl: args.sourceUrl },
      "ai_scan_skips lookup failed; skip not persisted",
    );
    return { ok: false, error: selErr.message ?? "scan_skip lookup failed" };
  }
  if (existing) {
    const { error: updErr } = await supa
      .from("ai_scan_skips")
      .update({
        last_seen_at: now,
        seen_count: (existing.seen_count as number ?? 0) + 1,
        reason: args.reason,
        source_label: args.sourceLabel,
        extracted_name: args.extractedName,
        status: "pending",
        resolved_at: null,
        resolved_by: null,
        resolved_note: null,
      })
      .eq("id", existing.id as string);
    if (updErr) {
      logger.error(
        { err: updErr, sourceUrl: args.sourceUrl },
        "ai_scan_skips bump failed",
      );
      return { ok: false, error: updErr.message ?? "scan_skip update failed" };
    }
    return { ok: true };
  }
  const { error: insErr } = await supa.from("ai_scan_skips").insert({
    source_url: args.sourceUrl,
    source_label: args.sourceLabel,
    extracted_name: args.extractedName,
    reason: args.reason,
    status: "pending",
    first_seen_at: now,
    last_seen_at: now,
    seen_count: 1,
  });
  if (insErr) {
    logger.error(
      { err: insErr, sourceUrl: args.sourceUrl },
      "ai_scan_skips insert failed",
    );
    return { ok: false, error: insErr.message ?? "scan_skip insert failed" };
  }
  return { ok: true };
}

router.post(
  "/admin/forum-scan",
  requireAdmin(async (req, res) => {
    const oneOffUrl = typeof req.query.url === "string" ? req.query.url : null;
    const result = await runForumScan({ oneOffUrl });
    res.json(result);
  }),
);

// ---------------------------------------------------------------------------
// Scan-skip retry — re-attempt pending ai_scan_skips rows. As OSM coverage
// improves over time, posts the scanner previously gave up on may now snap to
// a real track. Each pending row is re-fetched, re-extracted, and (if the
// extraction now yields geometry) queued as an ai_discovered_trail and the
// skip is marked resolved with note "auto-resolved on rescan". Rows that
// still can't be resolved have their last_seen_at / seen_count bumped so
// moderators can see they were re-checked.
// ---------------------------------------------------------------------------
export interface ScanSkipRetryResult {
  scanned: number;
  resolved: number;
  stillSkipped: number;
  errors: string[];
  note?: string;
}

export async function runScanSkipRetry(opts?: { limit?: number }): Promise<ScanSkipRetryResult> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from("ai_scan_skips")
    .select("id, source_url, source_label, extracted_name, seen_count")
    .eq("status", "pending")
    .order("last_seen_at", { ascending: true })
    .limit(limit);
  if (error) {
    if (isMissingTableError(error)) {
      return {
        scanned: 0,
        resolved: 0,
        stillSkipped: 0,
        errors: [],
        note: "ai_scan_skips table missing — apply migration 0020",
      };
    }
    return { scanned: 0, resolved: 0, stillSkipped: 0, errors: [error.message] };
  }
  const rows = (data ?? []) as Array<{
    id: string;
    source_url: string;
    source_label: string | null;
    extracted_name: string | null;
    seen_count: number | null;
  }>;
  let resolved = 0;
  let stillSkipped = 0;
  const errors: string[] = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    try {
      const html = await fetchForumPost(row.source_url);
      if (!html) {
        await bumpSkipUnresolved(supa, row.id, row.seen_count, now, "post unreachable");
        stillSkipped++;
        continue;
      }
      const extracted = await extractTrailFromForumPost(html, row.source_url);
      if (!extracted) {
        await bumpSkipUnresolved(supa, row.id, row.seen_count, now, "no trail content extracted");
        stillSkipped++;
        continue;
      }

      let waypoints: GpxPoint[] = [];
      let bbox = null as ReturnType<typeof bboxFromPoints>;
      let aiSource: "ai-forum" | "ai-approx" = "ai-approx";
      let gpxData: unknown = null;
      if (extracted.gpxUrl) {
        const gpx = await fetchAndParseGpxUrl(extracted.gpxUrl);
        if (gpx) {
          waypoints = gpx.waypoints;
          bbox = bboxFromPoints(waypoints);
          gpxData = gpx.gpxText;
          aiSource = "ai-forum";
        }
      }
      if (waypoints.length === 0 && extracted.location) {
        const approx = await approximateTrackFromLocation(extracted.location);
        if (approx) {
          waypoints = approx.waypoints;
          bbox = approx.bbox;
          gpxData = buildGpxFromWaypoints(extracted.trailName ?? "AI-discovered trail", waypoints);
        }
      }

      if (waypoints.length < 2 || !bbox) {
        await bumpSkipUnresolved(
          supa,
          row.id,
          row.seen_count,
          now,
          "no GPX and no nearby OSM track to snap to",
        );
        stillSkipped++;
        continue;
      }

      // Avoid double-queuing if a discovery row was created in the meantime.
      const { data: existing } = await supa
        .from("ai_discovered_trails")
        .select("id")
        .eq("source_url", row.source_url)
        .maybeSingle();
      if (existing) {
        await markSkipResolved(supa, row.id, now, "auto-resolved on rescan");
        resolved++;
        continue;
      }

      // Bbox + name dedupe against existing live trails.
      if (extracted.trailName && bbox) {
        const match = await findExistingTrailMatch(supa, {
          name: extracted.trailName,
          bbox,
        });
        if (match) {
          await markSkipResolved(supa, row.id, now, "auto-resolved on rescan");
          resolved++;
          continue;
        }
      }

      let aiGrade: number | null = extracted.difficulty;
      let aiRationale: string | null = null;
      try {
        const g = await gradeTrailWithAI({
          name: extracted.trailName ?? "AI-discovered trail",
          legalStatus: null,
          terrain: extracted.surface,
          description: extracted.summary,
          source: aiSource,
          sourceUrl: row.source_url,
          waypoints,
        });
        aiGrade = g.grade;
        aiRationale = g.rationale;
      } catch {
        /* keep extracted grade */
      }

      const { error: insErr } = await supa.from("ai_discovered_trails").insert({
        source: aiSource,
        source_url: row.source_url,
        source_title: row.source_label,
        extracted_name: extracted.trailName,
        extracted_location: extracted.location,
        extracted_summary: extracted.summary,
        extracted_difficulty: extracted.difficulty,
        extracted_surface: extracted.surface,
        gpx_data: gpxData,
        bbox_min_lat: bbox.minLat,
        bbox_max_lat: bbox.maxLat,
        bbox_min_lng: bbox.minLng,
        bbox_max_lng: bbox.maxLng,
        ai_grade: aiGrade,
        ai_grade_rationale: aiRationale,
      });
      if (insErr) {
        if (isMissingTableError(insErr)) {
          errors.push("ai_discovered_trails table missing — apply migration 0007");
          break;
        }
        errors.push(`insert failed for ${row.source_url}: ${insErr.message}`);
        stillSkipped++;
        continue;
      }

      await markSkipResolved(supa, row.id, now, "auto-resolved on rescan");
      resolved++;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "skip retry failed");
      stillSkipped++;
    }
  }

  return { scanned: rows.length, resolved, stillSkipped, errors };
}

async function markSkipResolved(
  supa: ReturnType<typeof getSupabaseAdmin>,
  id: string,
  now: string,
  note: string,
): Promise<void> {
  const { error } = await supa
    .from("ai_scan_skips")
    .update({
      status: "resolved",
      resolved_at: now,
      resolved_by: "scheduler",
      resolved_note: note,
      last_seen_at: now,
    })
    .eq("id", id);
  if (error) {
    logger.error({ err: error, id }, "ai_scan_skips resolve failed");
  }
}

async function bumpSkipUnresolved(
  supa: ReturnType<typeof getSupabaseAdmin>,
  id: string,
  seenCount: number | null,
  now: string,
  reason: string,
): Promise<void> {
  const { error } = await supa
    .from("ai_scan_skips")
    .update({
      last_seen_at: now,
      seen_count: (seenCount ?? 0) + 1,
      reason,
    })
    .eq("id", id);
  if (error) {
    logger.error({ err: error, id }, "ai_scan_skips bump failed");
  }
}

router.post(
  "/admin/ai-scan-skips/retry",
  requireAdmin(async (req, res) => {
    const limit = Number(req.query.limit ?? 50) || 50;
    const result = await runScanSkipRetry({ limit });
    res.json(result);
  }),
);

// ---------------------------------------------------------------------------
// Forum source CRUD (admin)
// ---------------------------------------------------------------------------
router.get(
  "/admin/forum-sources",
  requireAdmin(async (_req, res) => {
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("forum_sources")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      if (isMissingTableError(error)) {
        res.json({ items: [], note: "forum_sources table missing — apply migration 0007" });
        return;
      }
      res.status(500).json({ error: "Failed to load forum sources" });
      return;
    }
    res.json({ items: data ?? [] });
  }),
);

const ForumSourceBody = z.object({
  label: z.string().min(1).max(200),
  url: z.string().url().max(1000),
  kind: z.enum(["rss", "html"]).default("html"),
  disabled: z.boolean().optional(),
});

router.post(
  "/admin/forum-sources",
  requireAdmin(async (req, res) => {
    const parsed = ForumSourceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid forum source body" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("forum_sources")
      .insert(parsed.data)
      .select()
      .single();
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json(data);
  }),
);

router.delete(
  "/admin/forum-sources/:id",
  requireAdmin(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { error } = await supa.from("forum_sources").delete().eq("id", id.data);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Harvest TET / ACT (link-out mode based on the licensing spike doc).
// Body: { entries: [{ name, country, sourceUrl, bbox?, location? }] }
// We accept the entries from the admin (e.g. pasted from the published list)
// rather than scraping — most TET/ACT pages are member-only after sign-in.
// ---------------------------------------------------------------------------
const HarvestBody = z.object({
  source: z.enum(["tet", "act"]),
  entries: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        country: z.string().max(100).nullish(),
        sourceUrl: z.string().url().max(1000),
        location: z.string().max(200).nullish(),
        bbox: z
          .object({
            minLat: z.number(),
            maxLat: z.number(),
            minLng: z.number(),
            maxLng: z.number(),
          })
          .nullish(),
      }),
    )
    .min(1)
    .max(200),
});

router.post(
  "/admin/harvest",
  requireAdmin(async (req, res) => {
    const parsed = HarvestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid harvest body" });
      return;
    }
    const supa = getSupabaseAdmin();
    let queued = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const e of parsed.data.entries) {
      try {
        const { data: existing } = await supa
          .from("ai_discovered_trails")
          .select("id")
          .eq("source_url", e.sourceUrl)
          .maybeSingle();
        if (existing) {
          skipped++;
          continue;
        }
        // Bbox + name dedupe against the live trails table — never queue
        // a duplicate of an existing member-uploaded trail.
        const dedupe = await findExistingTrailMatch(supa, {
          name: e.name,
          bbox: e.bbox ?? null,
        });
        if (dedupe?.isHumanOrMember) {
          skipped++;
          errors.push(`dedupe match for "${e.name}" → existing trail ${dedupe.trailId} (${dedupe.name})`);
          continue;
        }
        const insert: Record<string, unknown> = {
          source: parsed.data.source,
          source_url: e.sourceUrl,
          source_title: e.country ?? parsed.data.source.toUpperCase(),
          extracted_name: e.name,
          extracted_location: e.location ?? e.country ?? null,
          extracted_summary: `External route from ${parsed.data.source.toUpperCase()} — GPX hosted by source. Approve to publish as link-out trail.`,
          extracted_difficulty: null,
          extracted_surface: null,
          gpx_data: null,
          bbox_min_lat: e.bbox?.minLat ?? null,
          bbox_max_lat: e.bbox?.maxLat ?? null,
          bbox_min_lng: e.bbox?.minLng ?? null,
          bbox_max_lng: e.bbox?.maxLng ?? null,
          ai_grade: null,
          ai_grade_rationale: null,
        };
        const { error: insErr } = await supa.from("ai_discovered_trails").insert(insert);
        if (insErr) {
          if (isMissingTableError(insErr)) {
            res.status(500).json({ error: "ai_discovered_trails table missing — apply migration 0007" });
            return;
          }
          errors.push(insErr.message);
          continue;
        }
        queued++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : "harvest entry failed");
      }
    }
    res.json({ queued, skipped, errors });
  }),
);

// ---------------------------------------------------------------------------
// Moderator review queue
// ---------------------------------------------------------------------------
router.get(
  "/admin/discovered-trails",
  requireAdmin(async (req, res) => {
    const status = String(req.query.status ?? "pending");
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("ai_discovered_trails")
      .select("*")
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      if (isMissingTableError(error)) {
        res.json({ items: [], note: "ai_discovered_trails table missing — apply migration 0007" });
        return;
      }
      res.status(500).json({ error: "Failed to load discovered trails" });
      return;
    }
    res.json({ items: data ?? [] });
  }),
);

router.post(
  "/admin/discovered-trails/:id/approve",
  requireAdmin(async (req, res, userId) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data: discovery, error: loadErr } = await supa
      .from("ai_discovered_trails")
      .select("*")
      .eq("id", id.data)
      .maybeSingle();
    if (loadErr || !discovery) {
      res.status(404).json({ error: "Discovery not found" });
      return;
    }
    if (discovery.status !== "pending") {
      res.status(409).json({ error: `Already ${discovery.status}` });
      return;
    }

    // Bbox + name dedupe against existing trails — refuse to publish over
    // a member/human-uploaded trail. Moderator should merge instead.
    const candBbox = (discovery.bbox_min_lat != null && discovery.bbox_max_lat != null && discovery.bbox_min_lng != null && discovery.bbox_max_lng != null)
      ? {
          minLat: discovery.bbox_min_lat as number,
          maxLat: discovery.bbox_max_lat as number,
          minLng: discovery.bbox_min_lng as number,
          maxLng: discovery.bbox_max_lng as number,
        }
      : null;
    const dedupe = await findExistingTrailMatch(supa, {
      name: (discovery.extracted_name as string | null) ?? null,
      bbox: candBbox,
    });
    if (dedupe?.isHumanOrMember) {
      res.status(409).json({
        error: "A member-uploaded trail already covers this name + area. Use Merge instead of Approve to preserve the human-uploaded record.",
        dedupeMatch: { trailId: dedupe.trailId, name: dedupe.name, source: dedupe.source },
      });
      return;
    }

    const points = gpxJsonToPoints(discovery.gpx_data);
    const distanceKm = points.length >= 2 ? distanceKmFromPoints(points) : null;

    // Verification status mapping. The provenance carried in
    // discovery.source dictates how trusted the published trail is:
    //
    //   ai-forum    A GPX file was discovered, downloaded, and parsed
    //               from a forum post. The GPX itself is the verification
    //               artifact, so the published trail is "verified" — but
    //               with source='ai-forum' so users can still see the
    //               provenance.
    //   ai-approx   No GPX was available; we snapped to the OSM track
    //               network or fell back to a Nominatim centroid. These
    //               are reference-only and excluded from navigation.
    //   tet / act   Link-out only; we never republish their GPX.
    //               Published as "unverified" so the user follows the
    //               source link to fetch the official route.
    let verification: string;
    if (discovery.source === "ai-forum") {
      verification = "verified";
    } else if (discovery.source === "ai-approx") {
      verification = "ai-approximated";
    } else if (discovery.source === "tet" || discovery.source === "act") {
      verification = "unverified";
    } else {
      verification = "unverified";
    }

    const trailInsert: Record<string, unknown> = {
      name: discovery.extracted_name ?? "Discovered trail",
      type: discovery.extracted_surface,
      difficulty: discovery.ai_grade ?? discovery.extracted_difficulty ?? null,
      distance_km: distanceKm,
      terrain: discovery.extracted_surface,
      legal_status: null,
      gpx_data: discovery.gpx_data,
      is_public: true,
      owner_user_id: null,
      bbox_min_lat: discovery.bbox_min_lat,
      bbox_max_lat: discovery.bbox_max_lat,
      bbox_min_lng: discovery.bbox_min_lng,
      bbox_max_lng: discovery.bbox_max_lng,
      description: discovery.extracted_summary,
      source: discovery.source,
      source_url: discovery.source_url,
      verification_status: verification,
      ai_grade: discovery.ai_grade,
      ai_grade_rationale: discovery.ai_grade_rationale,
      ai_graded_at: discovery.ai_grade != null ? new Date().toISOString() : null,
    };

    let { data: createdTrail, error: insErr } = await supa
      .from("trails")
      .insert(trailInsert)
      .select()
      .single();
    if (insErr && isMissingColumnError(insErr)) {
      // Strip new columns if migration 0007 isn't applied yet.
      const cleaned: Record<string, unknown> = { ...trailInsert };
      for (const k of [
        "source",
        "source_url",
        "verification_status",
        "ai_grade",
        "ai_grade_rationale",
        "ai_graded_at",
        "description",
      ]) {
        delete cleaned[k];
      }
      const retry = await supa.from("trails").insert(cleaned).select().single();
      createdTrail = retry.data;
      insErr = retry.error;
    }
    if (insErr) {
      res.status(500).json({ error: insErr.message });
      return;
    }
    const trailRow = createdTrail as { id?: string } | null;

    await supa
      .from("ai_discovered_trails")
      .update({
        status: "approved",
        trail_id: trailRow?.id ?? null,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
        review_note: typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : null,
      })
      .eq("id", id.data);

    res.json({ ok: true, trail: createdTrail });
  }),
);

router.post(
  "/admin/discovered-trails/:id/reject",
  requireAdmin(async (req, res, userId) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const supa = getSupabaseAdmin();
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : null;
    const { error } = await supa
      .from("ai_discovered_trails")
      .update({
        status: "rejected",
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
        review_note: note,
      })
      .eq("id", id.data);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ ok: true });
  }),
);

// Merge an AI discovery into an existing trail (preserves the human source).
router.post(
  "/admin/discovered-trails/:id/merge",
  requireAdmin(async (req, res, userId) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const targetId = z.string().uuid().safeParse(req.body?.trailId);
    if (!id.success || !targetId.success) {
      res.status(400).json({ error: "Invalid ids" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { error } = await supa
      .from("ai_discovered_trails")
      .update({
        status: "merged",
        trail_id: targetId.data,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
        review_note: typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : null,
      })
      .eq("id", id.data);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// AI scan skips — posts the forum scanner couldn't turn into a trail. The
// scanner records them so a moderator can revisit the source thread, decide
// whether to chase a manual GPX upload, and then dismiss the entry.
// ---------------------------------------------------------------------------
router.get(
  "/admin/ai-scan-skips",
  requireAdmin(async (req, res) => {
    const status = String(req.query.status ?? "pending");
    if (status !== "pending" && status !== "resolved") {
      res.status(400).json({ error: "Invalid status filter" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("ai_scan_skips")
      .select("*")
      .eq("status", status)
      .order("last_seen_at", { ascending: false })
      .limit(200);
    if (error) {
      if (isMissingTableError(error)) {
        res.json({
          items: [],
          note: "ai_scan_skips table missing — apply migration 0020",
        });
        return;
      }
      res.status(500).json({ error: "Failed to load ai scan skips" });
      return;
    }
    res.json({ items: data ?? [] });
  }),
);

// Moderator uploaded a GPX file directly from a pending skip row. Parse it,
// pre-fill an `ai_discovered_trails` entry from the skip's metadata, and
// resolve the skip in one step. The discovery still goes through the normal
// review queue so a moderator can approve or reject it from there.
const UploadSkipGpxBody = z.object({
  gpxText: z.string().min(20).max(5_000_000),
  name: z.string().trim().min(1).max(200).optional(),
});

router.post(
  "/admin/ai-scan-skips/:id/upload-gpx",
  requireAdmin(async (req, res, userId) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = UploadSkipGpxBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid GPX upload body" });
      return;
    }
    const supa = getSupabaseAdmin();
    const { data: skip, error: loadErr } = await supa
      .from("ai_scan_skips")
      .select("*")
      .eq("id", id.data)
      .maybeSingle();
    if (loadErr) {
      if (isMissingTableError(loadErr)) {
        res.status(400).json({ error: "ai_scan_skips table missing — apply migration 0020" });
        return;
      }
      res.status(500).json({ error: "Failed to load scan skip" });
      return;
    }
    if (!skip) {
      res.status(404).json({ error: "Scan skip not found" });
      return;
    }
    if (skip.status !== "pending") {
      res.status(409).json({ error: `Skip is already ${skip.status}` });
      return;
    }

    const waypoints = parseGpxText(parsed.data.gpxText);
    if (waypoints.length < 2) {
      res.status(400).json({
        error: "GPX has fewer than 2 valid track points — can't queue as a discovery.",
      });
      return;
    }
    const bbox = bboxFromPoints(waypoints);
    if (!bbox) {
      res.status(400).json({ error: "Could not compute a bounding box from the GPX." });
      return;
    }
    const trailName =
      parsed.data.name?.trim() ||
      ((skip.extracted_name as string | null) ?? "")?.trim() ||
      "Moderator-uploaded trail";
    const sourceUrl = String(skip.source_url ?? "");

    // If a discovery for the same source URL already exists, refuse rather
    // than create a duplicate row in the review queue.
    const { data: existingDiscovery } = await supa
      .from("ai_discovered_trails")
      .select("id, status")
      .eq("source_url", sourceUrl)
      .maybeSingle();
    if (existingDiscovery) {
      res.status(409).json({
        error: `A discovery already exists for this post (status: ${existingDiscovery.status}).`,
        discoveryId: existingDiscovery.id,
      });
      return;
    }

    const insert: Record<string, unknown> = {
      source: "ai-forum",
      source_url: sourceUrl,
      source_title: skip.source_label ?? null,
      extracted_name: trailName,
      extracted_location: null,
      extracted_summary: `Moderator-uploaded GPX from a forum post the scanner skipped (${skip.reason ?? "no reason recorded"}).`,
      extracted_difficulty: null,
      extracted_surface: null,
      gpx_data: parsed.data.gpxText,
      bbox_min_lat: bbox.minLat,
      bbox_max_lat: bbox.maxLat,
      bbox_min_lng: bbox.minLng,
      bbox_max_lng: bbox.maxLng,
      ai_grade: null,
      ai_grade_rationale: null,
    };
    const { data: discovery, error: insErr } = await supa
      .from("ai_discovered_trails")
      .insert(insert)
      .select("id")
      .single();
    if (insErr) {
      if (isMissingTableError(insErr)) {
        res.status(400).json({ error: "ai_discovered_trails table missing — apply migration 0007" });
        return;
      }
      res.status(500).json({ error: insErr.message });
      return;
    }
    const discoveryId = (discovery as { id?: string } | null)?.id ?? null;

    const { error: updErr } = await supa
      .from("ai_scan_skips")
      .update({
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolved_by: userId,
        resolved_note: discoveryId
          ? `Uploaded GPX → discovery ${discoveryId}`
          : "Uploaded GPX (discovery id unavailable)",
      })
      .eq("id", id.data);
    if (updErr) {
      req.log?.warn?.(
        { err: updErr, skipId: id.data, discoveryId },
        "ai_scan_skips: discovery created but skip update failed",
      );
    }

    res.json({ ok: true, discoveryId });
  }),
);

router.post(
  "/admin/ai-scan-skips/:id/resolve",
  requireAdmin(async (req, res, userId) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const note =
      typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : null;
    const supa = getSupabaseAdmin();
    const { error } = await supa
      .from("ai_scan_skips")
      .update({
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolved_by: userId,
        resolved_note: note,
      })
      .eq("id", id.data);
    if (error) {
      if (isMissingTableError(error)) {
        res.status(400).json({ error: "ai_scan_skips table missing — apply migration 0020" });
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Admin activity feed — recent moderation decisions on AI-discovered trails.
// Server-side merge of approved + rejected so clients (web + mobile) receive
// a single ordered audit-log feed without duplicating sort/dedup logic.
// ---------------------------------------------------------------------------
router.get(
  "/admin/activity",
  requireAdmin(async (req, res) => {
    const limit = Math.min(
      Math.max(Number(req.query.limit ?? 50) || 50, 1),
      200,
    );
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from("ai_discovered_trails")
      .select(
        "id, status, extracted_name, region, ai_grade, source_url, source, created_at, updated_at",
      )
      .in("status", ["approved", "rejected"])
      .order("updated_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      if (isMissingTableError(error)) {
        res.json({
          items: [],
          note: "ai_discovered_trails table missing — apply migration 0007",
        });
        return;
      }
      res.status(500).json({ error: "Failed to load admin activity" });
      return;
    }
    const items = (data ?? []).map((row: Record<string, unknown>) => ({
      id: String(row.id),
      status: String(row.status) as "approved" | "rejected",
      name: (row.extracted_name as string | null) ?? null,
      region: (row.region as string | null) ?? null,
      difficulty: (row.ai_grade as string | null) ?? null,
      source: (row.source as string | null) ?? null,
      source_url: (row.source_url as string | null) ?? null,
      created_at: String(row.updated_at ?? row.created_at),
    }));
    res.json({ items });
  }),
);

// silence the never-used helper warning when migration 0007 isn't applied yet
void computeRouteStats;

export default router;
