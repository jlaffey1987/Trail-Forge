/**
 * Trans Northern Trail (TNT) KML import.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run import:tnt -- [--dry-run] [path/to/file.kml]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

import { assertServiceRoleKey, getEnv, loadEnvLocal } from "./env.js";
import { buildGpx, processRoutePoints, type ParsedSection } from "./geometry.js";
import { parseKmlFile, selectRoutePoints, summarizePlacemarks } from "./kml.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KML = path.resolve(__dirname, "..", "..", "..", "Trans Northern Trail March.kml");

const COLLECTION_NAME = "Trans Northern Trail";
const COLLECTION_DESCRIPTION =
  "An epic route through the north of England and southern Scotland linking trails associated with northern trail riding";
const COLLECTION_REGION = "England North / Scotland";

interface CliArgs {
  dryRun: boolean;
  kmlPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let kmlPath = DEFAULT_KML;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--")) {
      console.warn(`⚠️  Unknown flag: ${arg}`);
    } else {
      kmlPath = path.resolve(arg);
    }
  }
  return { dryRun, kmlPath };
}

function printDryRunReport(sections: ParsedSection[], routeSource: string): void {
  const trailSections = sections.filter((s) => s.terrain === "trail");
  const roadSections = sections.filter((s) => s.terrain === "road");
  const trailKm = trailSections.reduce((s, x) => s + x.distanceKm, 0);
  const roadKm = roadSections.reduce((s, x) => s + x.distanceKm, 0);
  const avgLen = sections.length
    ? sections.reduce((s, x) => s + x.distanceKm, 0) / sections.length
    : 0;

  console.log("\n📊 DRY RUN SUMMARY");
  console.log("==================");
  console.log(`Route source:        ${routeSource}`);
  console.log(`Total sections:      ${sections.length}`);
  console.log(`Trail sections:      ${trailSections.length} (${trailKm.toFixed(1)} km)`);
  console.log(`Road sections:       ${roadSections.length} (${roadKm.toFixed(1)} km)`);
  console.log(`Average section len: ${avgLen.toFixed(2)} km`);
  console.log("\nSample section names:");
  for (const s of sections.slice(0, 8)) {
    console.log(`  • ${s.name} (${s.distanceKm} km, ${s.terrain})`);
  }
  if (sections.length > 8) {
    console.log(`  … and ${sections.length - 8} more`);
  }
}

async function insertSections(
  sections: ParsedSection[],
): Promise<string[]> {
  const supabase = createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const ids: string[] = [];

  for (const sec of sections) {
    const coords = sec.points.map((p) => [p.lon, p.lat]);
    const row = {
      name: sec.name,
      gpx_data: buildGpx(sec.name, sec.points),
      path_geojson: { type: "LineString" as const, coordinates: coords },
      is_public: true,
      owner_user_id: null,
      distance_km: sec.distanceKm,
      terrain: sec.terrain,
      difficulty: 5,
      legal_status: sec.terrain === "trail" ? "Green Lane" : "Road Liaison",
      legal_confidence: "osm_legal",
      legal_source: "Community mapping",
      source: "TNT",
      verification_status: "approved",
      bbox_min_lat: sec.bboxMinLat,
      bbox_max_lat: sec.bboxMaxLat,
      bbox_min_lng: sec.bboxMinLon,
      bbox_max_lng: sec.bboxMaxLon,
      centroid_lat: sec.centroidLat,
      centroid_lon: sec.centroidLon,
      start_lat: sec.startLat,
      start_lon: sec.startLon,
      end_lat: sec.endLat,
      end_lon: sec.endLon,
      elevation_gain_m: sec.elevationGainM > 0 ? sec.elevationGainM : null,
      elevation_loss_m: sec.elevationLossM > 0 ? sec.elevationLossM : null,
    };

    const { data, error } = await supabase.from("trails").insert(row).select("id").single();
    if (error) {
      console.error(`  ❌ Failed "${sec.name}": ${error.message}`);
      continue;
    }
    ids.push(data.id as string);
    const icon = sec.terrain === "trail" ? "🏍️" : "🛣️";
    console.log(`  ${icon} ${sec.name} (${sec.distanceKm} km)`);
  }
  return ids;
}

async function upsertCollection(trailIds: string[], sections: ParsedSection[]): Promise<void> {
  const supabase = createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"));

  const trailKm = sections.filter((s) => s.terrain === "trail").reduce((a, s) => a + s.distanceKm, 0);
  const grades = sections.filter((s) => s.terrain === "trail").map(() => 5);
  const difficultyMin = grades.length ? Math.min(...grades) : null;
  const difficultyMax = grades.length ? Math.max(...grades) : null;

  const { data: existing } = await supabase
    .from("trail_collections")
    .select("id")
    .eq("name", COLLECTION_NAME)
    .maybeSingle();

  let collectionId: string;
  if (existing?.id) {
    collectionId = existing.id as string;
    await supabase.from("trail_collections").update({
      description: COLLECTION_DESCRIPTION,
      region: COLLECTION_REGION,
      is_featured: true,
      is_official: false,
      total_distance_km: Math.round(trailKm * 10) / 10,
      difficulty_min: difficultyMin,
      difficulty_max: difficultyMax,
    }).eq("id", collectionId);
    await supabase.from("trail_collection_sections").delete().eq("collection_id", collectionId);
    console.log(`♻️  Updated existing collection (${collectionId})`);
  } else {
    const { data, error } = await supabase.from("trail_collections").insert({
      name: COLLECTION_NAME,
      description: COLLECTION_DESCRIPTION,
      region: COLLECTION_REGION,
      is_featured: true,
      is_official: false,
      total_distance_km: Math.round(trailKm * 10) / 10,
      difficulty_min: difficultyMin,
      difficulty_max: difficultyMax,
    }).select("id").single();
    if (error) throw new Error(`Collection insert failed: ${error.message}`);
    collectionId = data.id as string;
    console.log(`✅ Created collection (${collectionId})`);
  }

  const links = trailIds.map((trailId, order_index) => ({
    collection_id: collectionId,
    trail_id: trailId,
    order_index,
  }));
  const { error: linkErr } = await supabase.from("trail_collection_sections").insert(links);
  if (linkErr) throw new Error(`Collection link failed: ${linkErr.message}`);
  console.log(`🔗 Linked ${links.length} sections to collection`);
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { dryRun, kmlPath } = parseArgs(process.argv.slice(2));

  console.log("🗺️  TrailForge — Trans Northern Trail KML Import");
  console.log("===============================================");
  if (dryRun) console.log("🔍 DRY RUN — no database writes");

  if (!fs.existsSync(kmlPath)) {
    console.error(`❌ KML file not found: ${kmlPath}`);
    process.exit(1);
  }
  console.log(`📄 KML: ${kmlPath}`);

  const placemarks = parseKmlFile(kmlPath);
  const summary = summarizePlacemarks(placemarks);
  console.log(
    `📍 Placemarks: ${summary.total} total (${summary.lineStrings} LineStrings, ${summary.points} Points)`,
  );

  const { points, source } = selectRoutePoints(placemarks);
  console.log(`🧭 Route points: ${points.length} (source: ${source})`);

  const { sections, stats } = processRoutePoints(points);
  console.log(
    `✂️  Gaps: ${stats.gapsFound}, merged: ${stats.mergeCount}, discarded: ${stats.discardCount}, deduped: ${stats.duplicatePointsRemoved}`,
  );

  printDryRunReport(sections, source);

  if (dryRun) {
    console.log("\n✅ Dry run complete — no data imported.");
    return;
  }

  assertServiceRoleKey(getEnv("SUPABASE_SERVICE_ROLE_KEY"));
  console.log("\n💾 Importing sections…");
  const trailIds = await insertSections(sections);
  if (trailIds.length === 0) {
    console.error("❌ No trails inserted — aborting collection link");
    process.exit(1);
  }
  await upsertCollection(trailIds, sections);
  console.log("\n✅ Import complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
