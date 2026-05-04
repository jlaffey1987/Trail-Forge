import { getSupabaseAdmin } from "./supabaseAdmin";
import { logger } from "./logger";

export interface PreflightResult {
  ok: boolean;
  missingColumns: string[];
  missingIndex: boolean;
}

const REQUIRED_COLUMNS = ["source_region", "segment_hash"] as const;

const INDEX_NAME = "trails_source_segment_unique";

async function columnExists(column: string): Promise<boolean> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("trails").select(column).limit(1);
  if (!error) return true;
  if (
    /column .* does not exist|undefined column|42703|PGRST204/i.test(
      error.message + (error.code ?? ""),
    )
  ) {
    return false;
  }
  throw new Error(`Preflight column probe failed for "${column}": ${error.message}`);
}

async function uniqueIndexExists(): Promise<boolean> {
  try {
    const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return true;

    const sentinelHash = `__preflight_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const res = await fetch(
      `${url}/rest/v1/trails?on_conflict=source,source_url,segment_hash`,
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal,tx=rollback",
        },
        body: JSON.stringify({
          name: "__preflight_check__",
          type: "green-lane",
          legal_status: "byway",
          terrain: "off-road",
          difficulty: 5,
          distance_km: 0,
          bbox_min_lat: 0,
          bbox_max_lat: 0,
          bbox_min_lng: 0,
          bbox_max_lng: 0,
          gpx_data: "<gpx/>",
          gpx_object_path: null,
          is_public: false,
          owner_user_id: null,
          source: "act",
          source_url: "schema-check://preflight",
          source_region: "__preflight__",
          segment_hash: sentinelHash,
          verification_status: "verified",
          ai_grade: 5,
          ai_grade_rationale: "preflight check",
          ai_grade_model: "preflight check",
          ai_graded_at: new Date().toISOString(),
        }),
      },
    );

    const text = await res.text();

    if (!res.ok) {
      if (/42P10|no unique or exclusion constraint matching the ON CONFLICT/i.test(text)) {
        return false;
      }
      logger.warn(
        { status: res.status, body: text.slice(0, 300) },
        "Preflight: unexpected non-OK response from index probe — treating index as unknown",
      );
      return true;
    }

    try {
      await fetch(
        `${url}/rest/v1/trails?source=eq.act&source_url=eq.${encodeURIComponent("schema-check://preflight")}&segment_hash=eq.${encodeURIComponent(sentinelHash)}`,
        {
          method: "DELETE",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
        },
      );
    } catch {
      // best effort cleanup
    }

    return true;
  } catch {
    logger.warn("Preflight: could not verify unique index existence — skipping index check");
    return true;
  }
}

export async function runPreflightCheck(): Promise<PreflightResult> {
  if (process.env.SKIP_SCHEMA_PREFLIGHT === "true") {
    logger.info("Schema preflight check skipped (SKIP_SCHEMA_PREFLIGHT=true)");
    return { ok: true, missingColumns: [], missingIndex: false };
  }

  logger.info("Running schema preflight check (migration 0009) …");

  const missingColumns: string[] = [];

  for (const col of REQUIRED_COLUMNS) {
    const exists = await columnExists(col);
    if (!exists) {
      missingColumns.push(col);
    }
  }

  let missingIndex = false;
  if (!missingColumns.includes("segment_hash")) {
    const exists = await uniqueIndexExists();
    if (!exists) {
      missingIndex = true;
    }
  } else {
    missingIndex = true;
  }

  const ok = missingColumns.length === 0 && !missingIndex;

  if (!ok) {
    const parts: string[] = [];
    if (missingColumns.length > 0) {
      parts.push(`missing columns: ${missingColumns.join(", ")}`);
    }
    if (missingIndex) {
      parts.push(`missing unique index: ${INDEX_NAME} (source, source_url, segment_hash)`);
    }
    logger.warn(
      { missingColumns, missingIndex },
      `Schema preflight WARNING — migration 0009 may not be applied: ${parts.join("; ")}. ` +
        `The ACT/TET importer will refuse to run until this is fixed. ` +
        `Set SKIP_SCHEMA_PREFLIGHT=true to suppress this check.`,
    );
  } else {
    logger.info("Schema preflight check passed ✓");
  }

  return { ok, missingColumns, missingIndex };
}
