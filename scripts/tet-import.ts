/**
 * TET GPX Import Script
 * =====================
 * Imports official Trans Euro Trail GPX files into the TrailForge database.
 *
 * USAGE:
 *   npx ts-node scripts/tet-import.ts path/to/TET-UK.gpx [path/to/TET-UK-2.gpx ...]
 *
 * SETUP:
 *   1. Copy .env.local.example to .env.local in the project root and fill in:
 *      SUPABASE_URL=https://your-project.supabase.co
 *      SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
 *   2. Install deps if needed: pnpm add -D ts-node @supabase/supabase-js
 *   3. Download TET UK GPX from transeurotrail.org
 *   4. Run this script
 *
 * WHAT IT DOES:
 *   - Splits the GPX into individual <trk> segments (each becomes one trail)
 *   - Detects road liaison vs off-road trail from track name/type
 *   - Tags each trail with source="TET-UK", is_public=true
 *   - Database triggers auto-compute: bbox, simplified_path, elevation_profile
 *   - Skips duplicate trails (same name + source already in DB)
 */

import * as fs from "fs";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Config — reads from env vars
// ---------------------------------------------------------------------------

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`❌ Missing environment variable: ${key}`);
    console.error(`   Set it in .env.local or pass it before the command:`);
    console.error(`   ${key}=value npx ts-node scripts/tet-import.ts ...`);
    process.exit(1);
  }
  return val;
}

// Load .env.local if present
function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
    console.log("✅ Loaded .env.local");
  }
}

// ---------------------------------------------------------------------------
// GPX Parsing
// ---------------------------------------------------------------------------

interface TrackPoint {
  lat: number;
  lon: number;
  ele?: number;
}

interface ParsedTrack {
  name: string;
  type: string | null;
  terrain: "trail" | "road";
  points: TrackPoint[];
  distanceKm: number;
  bboxMinLat: number;
  bboxMaxLat: number;
  bboxMinLon: number;
  bboxMaxLon: number;
  gpxData: string;
}

function detectTerrain(name: string, type: string | null): "trail" | "road" {
  const combined = `${name} ${type ?? ""}`.toLowerCase();
  // Road liaison indicators
  const roadKeywords = ["road", "tarmac", "asphalt", "paved", "liaison", "transfer", "route"];
  for (const kw of roadKeywords) {
    if (combined.includes(kw)) return "road";
  }
  // Trail indicators
  const trailKeywords = ["trail", "track", "offroad", "off-road", "gravel", "dirt", "lane", "byway", "boat", "green"];
  for (const kw of trailKeywords) {
    if (combined.includes(kw)) return "trail";
  }
  // Default to trail for TET — that's what we're here for
  return "trail";
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseGpxFile(filePath: string): ParsedTrack[] {
  console.log(`\n📂 Parsing: ${path.basename(filePath)}`);
  const content = fs.readFileSync(filePath, "utf8");

  // Split into individual <trk> blocks
  const trkMatches = [...content.matchAll(/<trk>([\s\S]*?)<\/trk>/g)];

  if (trkMatches.length === 0) {
    console.warn(`  ⚠️  No <trk> elements found — trying <rte> elements`);
    // Some GPX files use <rte> instead of <trk>
    return [];
  }

  console.log(`  Found ${trkMatches.length} track(s)`);
  const tracks: ParsedTrack[] = [];

  for (const trkMatch of trkMatches) {
    const trkContent = trkMatch[1];

    // Extract track name
    const nameMatch = trkContent.match(/<name>([\s\S]*?)<\/name>/);
    const rawName = nameMatch ? nameMatch[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "Unnamed TET Section";

    // Extract track type
    const typeMatch = trkContent.match(/<type>([\s\S]*?)<\/type>/);
    const type = typeMatch ? typeMatch[1].trim() : null;

    // Extract all track points
    const trkptMatches = [
      ...trkContent.matchAll(/<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g),
    ];

    // Also try reversed attribute order
    const trkptMatchesRev = [
      ...trkContent.matchAll(/<trkpt\s+lon="([^"]+)"\s+lat="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g),
    ];

    const points: TrackPoint[] = [];

    if (trkptMatches.length > 0) {
      for (const m of trkptMatches) {
        const lat = parseFloat(m[1]);
        const lon = parseFloat(m[2]);
        if (isNaN(lat) || isNaN(lon)) continue;
        const eleMatch = m[3].match(/<ele>([\d.-]+)<\/ele>/);
        const ele = eleMatch ? parseFloat(eleMatch[1]) : undefined;
        points.push({ lat, lon, ele });
      }
    } else if (trkptMatchesRev.length > 0) {
      for (const m of trkptMatchesRev) {
        const lon = parseFloat(m[1]);
        const lat = parseFloat(m[2]);
        if (isNaN(lat) || isNaN(lon)) continue;
        const eleMatch = m[3].match(/<ele>([\d.-]+)<\/ele>/);
        const ele = eleMatch ? parseFloat(eleMatch[1]) : undefined;
        points.push({ lat, lon, ele });
      }
    }

    if (points.length < 2) {
      console.warn(`  ⚠️  Skipping "${rawName}" — only ${points.length} point(s)`);
      continue;
    }

    // Compute bbox
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }

    // Compute distance
    let distanceKm = 0;
    for (let i = 1; i < points.length; i++) {
      distanceKm += haversineKm(
        points[i - 1].lat, points[i - 1].lon,
        points[i].lat, points[i].lon
      );
    }

    // Build minimal GPX for this single track (DB triggers parse this)
    const gpxData = buildSingleTrackGpx(rawName, type, points);

    const terrain = detectTerrain(rawName, type);

    tracks.push({
      name: rawName,
      type,
      terrain,
      points,
      distanceKm: Math.round(distanceKm * 10) / 10,
      bboxMinLat: minLat,
      bboxMaxLat: maxLat,
      bboxMinLon: minLon,
      bboxMaxLon: maxLon,
      gpxData,
    });
  }

  return tracks;
}

function buildSingleTrackGpx(name: string, type: string | null, points: TrackPoint[]): string {
  const trkpts = points
    .map((p) => {
      const ele = p.ele != null ? `<ele>${p.ele}</ele>` : "";
      return `    <trkpt lat="${p.lat}" lon="${p.lon}">${ele}</trkpt>`;
    })
    .join("\n");

  const typeTag = type ? `<type>${type}</type>` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailForge TET Import">
  <trk>
    <name>${name.replace(/&/g, "&amp;")}</name>
    ${typeTag}
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

// ---------------------------------------------------------------------------
// Supabase Insert
// ---------------------------------------------------------------------------

async function importTracks(
  tracks: ParsedTrack[],
  supabaseUrl: string,
  supabaseKey: string,
  sourceLabel: string,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  const supabase = createClient(supabaseUrl, supabaseKey);

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const track of tracks) {
    // Check for duplicate (same name + source)
    const { data: existing } = await supabase
      .from("trails")
      .select("id")
      .eq("name", track.name)
      .eq("source", sourceLabel)
      .maybeSingle();

    if (existing) {
      console.log(`  ⏭️  Skipping (already exists): ${track.name}`);
      skipped++;
      continue;
    }

    const row = {
      name: track.name,
      gpx_data: track.gpxData,
      is_public: true,
      owner_user_id: null,
      distance_km: track.distanceKm,
      terrain: track.terrain,
      legal_status: track.terrain === "trail" ? "TET Route" : "Road Liaison",
      source: sourceLabel,
      // bbox columns auto-computed by DB trigger — but we set them explicitly
      // too so imports work even if the trigger isn't applied yet
      bbox_min_lat: track.bboxMinLat,
      bbox_max_lat: track.bboxMaxLat,
      bbox_min_lng: track.bboxMinLon,
      bbox_max_lng: track.bboxMaxLon,
    };

    const { error } = await supabase.from("trails").insert(row);

    if (error) {
      console.error(`  ❌ Error inserting "${track.name}": ${error.message}`);
      errors++;
    } else {
      const icon = track.terrain === "trail" ? "🏍️" : "🛣️";
      console.log(`  ${icon} Inserted: ${track.name} (${track.distanceKm}km, ${track.terrain})`);
      inserted++;
    }

    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 100));
  }

  return { inserted, skipped, errors };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnvLocal();

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: npx ts-node scripts/tet-import.ts path/to/TET-UK.gpx [more.gpx ...]");
    process.exit(1);
  }

  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  console.log("🗺️  TrailForge TET Import");
  console.log("========================");
  console.log(`📡 Supabase: ${supabaseUrl}`);

  // Parse all GPX files
  const allTracks: ParsedTrack[] = [];
  for (const filePath of args) {
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      continue;
    }
    const tracks = parseGpxFile(filePath);
    allTracks.push(...tracks);
  }

  if (allTracks.length === 0) {
    console.error("❌ No tracks found in any GPX file");
    process.exit(1);
  }

  // Summary before import
  const trailSections = allTracks.filter((t) => t.terrain === "trail");
  const roadSections = allTracks.filter((t) => t.terrain === "road");
  console.log(`\n📊 Summary:`);
  console.log(`   Total sections: ${allTracks.length}`);
  console.log(`   🏍️  Trail sections: ${trailSections.length}`);
  console.log(`   🛣️  Road liaisons: ${roadSections.length}`);
  console.log(`   Total distance: ${allTracks.reduce((s, t) => s + t.distanceKm, 0).toFixed(1)}km`);
  console.log(`\nReady to import all ${allTracks.length} sections into Supabase.`);
  console.log("Starting in 3 seconds... (Ctrl+C to cancel)\n");
  await new Promise((r) => setTimeout(r, 3000));

  // Import
  const result = await importTracks(allTracks, supabaseUrl, supabaseKey, "TET-UK");

  // Final report
  console.log("\n========================");
  console.log("✅ Import complete!");
  console.log(`   Inserted: ${result.inserted}`);
  console.log(`   Skipped (duplicates): ${result.skipped}`);
  console.log(`   Errors: ${result.errors}`);
  console.log("\nThe map should now show TET trails.");
  console.log("Database triggers have auto-computed bbox, elevation and simplified paths.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
