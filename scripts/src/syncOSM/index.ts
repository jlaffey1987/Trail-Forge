/**
 * OSM Legal Trail Weekly Sync
 * ============================
 * Queries Overpass for ways changed since the last sync date, updates legal
 * status, auto-hides removed access, imports new legal trails.
 *
 * USAGE:
 *   pnpm --filter @workspace/scripts sync:osm
 *
 * Stores last_sync_date in system_config table.
 * Full audit log of all changes written to system_config key osm_sync_log.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------

function loadEnv() {
  const candidates = [
    join(__dirname, "..", "..", "..", "artifacts", "api-server", ".env.local"),
    join(process.cwd(), "artifacts", "api-server", ".env.local"),
    join(process.cwd(), ".env.local"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
    console.log(`Loaded env: ${p}`);
    break;
  }
}

// ---------------------------------------------------------------------------
// Overpass
// ---------------------------------------------------------------------------

function buildChangedSinceQuery(sinceIso: string, bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  const b = `${s},${w},${n},${e}`;
  return `
[out:json][timeout:120][adiff:"${sinceIso}"];
(
  way["highway"="track"]["motor_vehicle"~"^(yes|permissive)$"](${b});
  way["highway"="track"]["designation"="byway_open_to_all_traffic"](${b});
  way["highway"="byway"](${b});
  way["highway"="track"]["tracktype"~"^grade[2-5]$"](${b});
);
out geom;
`.trim();
}

async function fetchOverpass(query: string): Promise<{ elements: OsmWay[] }> {
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return res.json() as Promise<{ elements: OsmWay[] }>;
}

interface OsmWay {
  type: string;
  id: number;
  action?: string; // "delete" | "modify" in adiff mode
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

async function getLastSyncDate(supa: SupabaseClient): Promise<string> {
  const { data } = await supa.from("system_config").select("value").eq("key", "osm_last_sync").maybeSingle();
  if (data?.value) return data.value as string;
  // Default to 30 days ago
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString();
}

async function setLastSyncDate(supa: SupabaseClient, iso: string) {
  await supa.from("system_config").upsert({ key: "osm_last_sync", value: iso, updated_at: new Date().toISOString() });
}

async function appendAuditLog(supa: SupabaseClient, entry: object) {
  const { data } = await supa.from("system_config").select("value").eq("key", "osm_sync_log").maybeSingle();
  const existing: object[] = [];
  try { if (data?.value) existing.push(...(JSON.parse(data.value as string) as object[])); } catch { /* ignore */ }
  existing.push(entry);
  // Keep last 500 entries
  const trimmed = existing.slice(-500);
  await supa.from("system_config").upsert({
    key: "osm_sync_log",
    value: JSON.stringify(trimmed),
    updated_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Legal status helpers
// ---------------------------------------------------------------------------

function legalAccessRemoved(tags: Record<string, string>): boolean {
  const mv = tags["motor_vehicle"] ?? "";
  const noAccess = ["no", "private", "destination", "agricultural", "forestry"];
  return noAccess.includes(mv);
}

function legalStatusFromTags(tags: Record<string, string>): string {
  if (tags["designation"] === "byway_open_to_all_traffic") return "BOAT";
  if (tags["motor_vehicle"] === "yes") return "legal";
  if (tags["motor_vehicle"] === "permissive") return "permissive";
  return "unverified";
}

// ---------------------------------------------------------------------------
// Region bboxes
// ---------------------------------------------------------------------------

const UK_BBOX: [number, number, number, number] = [49.8, -8.0, 61.0, 2.0];

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();
  const supabaseUrl = process.env["SUPABASE_URL"];
  const supabaseKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supa = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  const syncStart = new Date().toISOString();
  const lastSync = await getLastSyncDate(supa);
  console.log(`=== OSM Sync ===`);
  console.log(`Last sync: ${lastSync}`);
  console.log(`Querying changes since ${lastSync}...`);

  const changes = { updated: 0, hidden: 0, newlyImported: 0, errors: 0 };
  const auditEntries: object[] = [];

  try {
    const query = buildChangedSinceQuery(lastSync, UK_BBOX);
    const response = await fetchOverpass(query);
    const ways = response.elements.filter(e => e.type === "way");
    console.log(`${ways.length} changed ways received`);

    for (const way of ways) {
      const tags = way.tags ?? {};
      const wayIdStr = String(way.id);
      const action = way.action; // "delete", "modify", or undefined (new)

      // Find existing trail(s) with this OSM way ID
      const { data: existing } = await supa
        .from("trails")
        .select("id, name, legal_status, is_public, path_geojson, bbox_min_lat")
        .contains("osm_way_ids", [wayIdStr]);

      const existingList = (existing ?? []) as Array<{
        id: string;
        name: string;
        legal_status: string | null;
        is_public: boolean;
        path_geojson: unknown;
        bbox_min_lat: number | null;
      }>;

      if (action === "delete" || legalAccessRemoved(tags)) {
        // Auto-hide: motor vehicle access removed
        for (const trail of existingList) {
          await supa.from("trails").update({
            is_public: false,
            legal_status: "rejected",
            legal_confidence: "rejected",
            legal_notes: `OSM access removed ${syncStart}`,
          }).eq("id", trail.id);
          changes.hidden++;
          auditEntries.push({ type: "hidden", trail_id: trail.id, name: trail.name, reason: "OSM access removed", ts: syncStart });
        }
        continue;
      }

      if (existingList.length > 0) {
        const newStatus = legalStatusFromTags(tags);
        for (const trail of existingList) {
          if (way.geometry && way.geometry.length >= 2 && !trail.path_geojson && trail.bbox_min_lat == null) {
            const pts = way.geometry;
            const lats = pts.map(p => p.lat);
            const lons = pts.map(p => p.lon);
            let dist = 0;
            for (let i = 1; i < pts.length; i++) {
              const dLat = (pts[i].lat - pts[i - 1].lat) * Math.PI / 180;
              const dLon = (pts[i].lon - pts[i - 1].lon) * Math.PI / 180;
              const a = Math.sin(dLat / 2) ** 2 + Math.cos(pts[i - 1].lat * Math.PI / 180) * Math.cos(pts[i].lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
              dist += 6371 * 2 * Math.asin(Math.sqrt(a));
            }
            await supa.from("trails").update({
              path_geojson: { type: "LineString", coordinates: pts.map(p => [p.lon, p.lat]) },
              bbox_min_lat: Math.min(...lats),
              bbox_max_lat: Math.max(...lats),
              bbox_min_lng: Math.min(...lons),
              bbox_max_lng: Math.max(...lons),
              centroid_lat: (Math.min(...lats) + Math.max(...lats)) / 2,
              centroid_lon: (Math.min(...lons) + Math.max(...lons)) / 2,
              distance_km: Math.round(dist * 100) / 100,
              legal_status: newStatus,
              legal_confidence: "osm_legal",
              legal_notes: `Geometry backfilled by OSM sync ${syncStart}`,
            }).eq("id", trail.id);
            changes.updated++;
            continue;
          }
          if (trail.legal_status !== newStatus) {
            await supa.from("trails").update({
              legal_status: newStatus,
              legal_confidence: "osm_legal",
              legal_notes: `Status updated by OSM sync ${syncStart}`,
            }).eq("id", trail.id);
            changes.updated++;
            auditEntries.push({ type: "updated", trail_id: trail.id, name: trail.name, old_status: trail.legal_status, new_status: newStatus, ts: syncStart });
          }
        }
      } else if (way.geometry && way.geometry.length >= 2) {
        // New legal trail — basic import (full grading deferred to next full import run)
        const pts = way.geometry;
        let dist = 0;
        for (let i = 1; i < pts.length; i++) {
          const dLat = (pts[i].lat - pts[i - 1].lat) * Math.PI / 180;
          const dLon = (pts[i].lon - pts[i - 1].lon) * Math.PI / 180;
          const a = Math.sin(dLat / 2) ** 2 + Math.cos(pts[i - 1].lat * Math.PI / 180) * Math.cos(pts[i].lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
          dist += 6371 * 2 * Math.asin(Math.sqrt(a));
        }
        if (dist < 1.0) continue; // skip sub-1km ways

        const lats = pts.map(p => p.lat);
        const lons = pts.map(p => p.lon);
        const { error } = await supa.from("trails").insert({
          name: tags["name"] ?? tags["ref"] ?? `OSM Way ${way.id}`,
          source: "OSM-UK",
          terrain: "trail",
          difficulty: 4,
          distance_km: Math.round(dist * 100) / 100,
          path_geojson: { type: "LineString", coordinates: pts.map(p => [p.lon, p.lat]) },
          is_public: true,
          bbox_min_lat: Math.min(...lats),
          bbox_max_lat: Math.max(...lats),
          bbox_min_lng: Math.min(...lons),
          bbox_max_lng: Math.max(...lons),
          centroid_lat: (Math.min(...lats) + Math.max(...lats)) / 2,
          centroid_lon: (Math.min(...lons) + Math.max(...lons)) / 2,
          legal_status: legalStatusFromTags(tags),
          legal_confidence: "osm_legal",
          legal_source: "OpenStreetMap",
          osm_way_ids: [wayIdStr],
          source_url: `osm://way/${way.id}`,
          verification_status: "approved",
        });
        if (error) {
          changes.errors++;
          auditEntries.push({ type: "error", way_id: way.id, message: error.message, ts: syncStart });
        } else {
          changes.newlyImported++;
          auditEntries.push({ type: "new", way_id: way.id, name: tags["name"] ?? `OSM Way ${way.id}`, ts: syncStart });
        }
      }
    }
  } catch (err) {
    console.error("Sync failed:", err);
    changes.errors++;
  }

  // Persist audit log and update sync date
  if (auditEntries.length > 0) await appendAuditLog(supa, { run: syncStart, changes, entries: auditEntries });
  await setLastSyncDate(supa, syncStart);

  console.log("\n=== Sync Complete ===");
  console.log(`Updated:         ${changes.updated}`);
  console.log(`Auto-hidden:     ${changes.hidden}`);
  console.log(`Newly imported:  ${changes.newlyImported}`);
  console.log(`Errors:          ${changes.errors}`);
}

main().catch(err => { console.error(err); process.exit(1); });
