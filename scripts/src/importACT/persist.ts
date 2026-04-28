import { createHash } from "node:crypto";
import type { GpxPoint } from "./parseBundle.js";

/**
 * Persistence layer — uses the Supabase service-role REST endpoint
 * (PostgREST) directly via fetch so the importer does not need a
 * supabase-js / pg dependency.
 *
 * `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` must be set; these are the
 * same env vars the API server uses.
 */

function supabaseEnv(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to persist ACT trails.");
  }
  return { url: url.replace(/\/+$/, ""), key };
}

async function rest<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; prefer?: string; query?: Record<string, string> } = {},
): Promise<T> {
  const env = supabaseEnv();
  const qs = init.query
    ? "?" +
      Object.entries(init.query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")
    : "";
  const res = await fetch(`${env.url}/rest/v1${path}${qs}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: init.prefer ?? "return=representation",
    },
    body: init.body == null ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase REST ${init.method ?? "GET"} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export async function closePool(): Promise<void> {
  // No-op (HTTP — nothing to clean up).
}

export interface CandidateTrail {
  name: string;
  source: "act" | "tet";
  sourceUrl: string;
  sourceRegion: string;
  segmentHash: string;
  points: GpxPoint[];
  distanceKm: number;
  elevationGainM: number | null;
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  aiGrade: number;
  aiGradeRationale: string;
  aiGradeModel: string;
}

export interface PersistOutcome {
  inserted: boolean;
  updated?: boolean;
  trailId: string | null;
  reason?: string;
}

/**
 * Build a stable segment_hash that uniquely identifies a sub-segment
 * within a bundle. Re-running the importer on the same bundle yields the
 * same hash, so the unique index on (source, source_url, segment_hash)
 * makes the upsert idempotent.
 */
export function computeSegmentHash(parts: {
  bundleSha256: string;
  trackIndex: number;
  segmentIndex: number;
  startPointIndex: number;
  endPointIndex: number;
  points: GpxPoint[];
}): string {
  const h = createHash("sha256");
  h.update(parts.bundleSha256);
  h.update(`|trk=${parts.trackIndex}`);
  h.update(`|seg=${parts.segmentIndex}`);
  h.update(`|start=${parts.startPointIndex}`);
  h.update(`|end=${parts.endPointIndex}`);
  h.update(`|n=${parts.points.length}`);
  // Round to ~1 m precision to avoid spurious changes from float jitter.
  for (const p of parts.points) {
    h.update(`|${p.lat.toFixed(5)},${p.lon.toFixed(5)}`);
  }
  return h.digest("hex");
}

/**
 * Upsert a candidate trail keyed on `(source, source_url, segment_hash)`.
 *
 * Strategy:
 *   1. SELECT by the key. If a row exists, PATCH it with the latest
 *      AI grade + geometry so re-runs can correct earlier imports.
 *   2. Otherwise POST /trails to insert. If the insert races with
 *      another run and hits the unique index, fall through to an UPDATE.
 *
 * The geometry is stored as GPX XML in `trails.gpx_data` because the
 * map-rendering trigger (migration 0008) and the frontend's `parseGPX`
 * both expect a `<trkpt …>` XML body. There is no API route that re-emits
 * the GPX as a downloadable file for ACT/TET rows (`gpx_object_path` is
 * deliberately left NULL), so the link-out posture is preserved while
 * still letting the route render.
 */
export async function upsertTrail(candidate: CandidateTrail): Promise<PersistOutcome> {
  const existing = await rest<Array<{ id: string }>>(`/trails`, {
    query: {
      select: "id",
      source: `eq.${candidate.source}`,
      source_url: `eq.${candidate.sourceUrl}`,
      segment_hash: `eq.${candidate.segmentHash}`,
      limit: "1",
    },
  });

  const gpxXml = buildGpxXml(candidate.name, candidate.points);

  if (Array.isArray(existing) && existing.length > 0) {
    const id = existing[0].id;
    await rest(`/trails`, {
      method: "PATCH",
      query: { id: `eq.${id}` },
      prefer: "return=minimal",
      body: {
        name: candidate.name,
        difficulty: candidate.aiGrade,
        distance_km: Number(candidate.distanceKm.toFixed(3)),
        bbox_min_lat: candidate.bbox.minLat,
        bbox_max_lat: candidate.bbox.maxLat,
        bbox_min_lng: candidate.bbox.minLng,
        bbox_max_lng: candidate.bbox.maxLng,
        gpx_data: gpxXml,
        ai_grade: candidate.aiGrade,
        ai_grade_rationale: candidate.aiGradeRationale,
        ai_grade_model: candidate.aiGradeModel,
        ai_graded_at: new Date().toISOString(),
      },
    });
    return { inserted: false, updated: true, trailId: id, reason: "updated existing row" };
  }

  const row = {
    name: candidate.name,
    type: "off-road",
    legal_status: "byway",
    terrain: "off-road",
    difficulty: candidate.aiGrade,
    distance_km: Number(candidate.distanceKm.toFixed(3)),
    bbox_min_lat: candidate.bbox.minLat,
    bbox_max_lat: candidate.bbox.maxLat,
    bbox_min_lng: candidate.bbox.minLng,
    bbox_max_lng: candidate.bbox.maxLng,
    gpx_data: gpxXml,
    gpx_object_path: null,
    is_public: true,
    owner_user_id: null,
    source: candidate.source,
    source_url: candidate.sourceUrl,
    source_region: candidate.sourceRegion,
    segment_hash: candidate.segmentHash,
    // Imported from a trusted curated source (ACT / TET) — surfaces
    // immediately rather than landing in the moderation queue.
    verification_status: "verified",
    ai_grade: candidate.aiGrade,
    ai_grade_rationale: candidate.aiGradeRationale,
    ai_grade_model: candidate.aiGradeModel,
    ai_graded_at: new Date().toISOString(),
  };

  try {
    const inserted = await rest<Array<{ id: string }>>(`/trails`, {
      method: "POST",
      body: row,
    });
    if (Array.isArray(inserted) && inserted.length > 0) {
      return { inserted: true, trailId: inserted[0].id };
    }
    return { inserted: false, trailId: null, reason: "no row returned" };
  } catch (err) {
    const msg = (err as Error).message;
    if (/409|duplicate key|unique constraint/i.test(msg)) {
      // Lost a race with a parallel run — retry the update path.
      const second = await rest<Array<{ id: string }>>(`/trails`, {
        query: {
          select: "id",
          source: `eq.${candidate.source}`,
          source_url: `eq.${candidate.sourceUrl}`,
          segment_hash: `eq.${candidate.segmentHash}`,
          limit: "1",
        },
      });
      if (Array.isArray(second) && second.length > 0) {
        return { inserted: false, updated: false, trailId: second[0].id, reason: "race — duplicate (idempotent)" };
      }
      return { inserted: false, trailId: null, reason: "race — duplicate (idempotent)" };
    }
    throw err;
  }
}

function buildGpxXml(name: string, points: GpxPoint[]): string {
  const trkpts = points
    .map((p) => {
      const ele = p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : "";
      return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${ele}</trkpt>`;
    })
    .join("\n");
  const safe = escapeXml(name);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailForge ACT/TET Importer" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${safe}</name><time>${new Date().toISOString()}</time></metadata>
  <trk>
    <name>${safe}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Verify the trails table has the columns the importer writes to.
 * We probe by issuing a tiny SELECT against each new column; PostgREST
 * returns 400 with a helpful error message when the column is missing.
 */
export async function checkSchemaReady(): Promise<{ ok: boolean; missing: string[] }> {
  const required = ["source", "source_url", "source_region", "segment_hash", "verification_status", "ai_grade", "ai_grade_rationale"];
  const missing: string[] = [];
  for (const col of required) {
    try {
      await rest<unknown>(`/trails`, { query: { select: col, limit: "1" } });
    } catch (err) {
      const msg = (err as Error).message;
      if (/column .* does not exist|undefined column|42703|PGRST204/i.test(msg)) {
        missing.push(col);
      } else {
        // Re-throw unrelated errors (network, auth) so the caller stops.
        throw err;
      }
    }
  }
  return { ok: missing.length === 0, missing };
}
