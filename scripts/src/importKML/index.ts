/**
 * Trans Northern Trail (TNT) KML import.
 *
 * Imports each named trail LineString from TNT folders as its own section,
 * preserving original KML names. The Enduro master line is stored as a
 * collection overview polyline only — not imported as trail sections.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run import:tnt -- [--dry-run] [path/to/file.kml]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

import { assertServiceRoleKey, getEnv, loadEnvLocal } from "./env.js";
import {
  buildGpx,
  polylineDistanceKm,
  processAllTrailLines,
  type ParsedSection,
  type TrackPoint,
} from "./geometry.js";
import {
  parseKmlFile,
  selectMasterOverview,
  selectTrailLineStrings,
  summarizePlacemarks,
} from "./kml.js";

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

interface InsertResult {
  trailIds: string[];
  /** Trail-section IDs only, in import order — for collection linking. */
  collectionTrailIds: string[];
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

function overviewGeojson(points: TrackPoint[]) {
  return {
    type: "LineString" as const,
    coordinates: points.map((p) => [p.lon, p.lat]),
  };
}

function printDryRunReport(
  sections: ParsedSection[],
  namedTrailLines: number,
  overviewPoints: number | null,
): void {
  const trailSections = sections.filter((s) => s.terrain === "trail");
  const roadSections = sections.filter((s) => s.terrain === "road");
  const trailKm = trailSections.reduce((s, x) => s + x.distanceKm, 0);
  const roadKm = roadSections.reduce((s, x) => s + x.distanceKm, 0);
  const avgLen = trailSections.length
    ? trailKm / trailSections.length
    : 0;
  const maxTrailKm = trailSections.reduce((m, s) => Math.max(m, s.distanceKm), 0);
  const over15 = trailSections.filter((s) => s.distanceKm > 15).length;

  console.log("\n📊 DRY RUN SUMMARY");
  console.log("==================");
  console.log(`Named trail lines:   ${namedTrailLines}`);
  console.log(`Overview polyline:   ${overviewPoints ?? 0} points (master line, not imported as sections)`);
  console.log(`Total sections:      ${sections.length}`);
  console.log(`Trail sections:      ${trailSections.length} (${trailKm.toFixed(1)} km)`);
  console.log(`Road sections:       ${roadSections.length} (${roadKm.toFixed(1)} km)`);
  console.log(`Average trail len:   ${avgLen.toFixed(2)} km`);
  console.log(`Longest trail sect:  ${maxTrailKm.toFixed(1)} km`);
  console.log(`Sections over 15 km: ${over15}`);

  const samples = [
    ...trailSections.filter((s) => /Rudland Rigg|Cam Rd/i.test(s.name)),
    ...trailSections.filter((s) => !/Rudland Rigg|Cam Rd/i.test(s.name)),
  ].slice(0, 12);

  console.log("\nSample section names:");
  for (const s of samples) {
    console.log(`  • ${s.name} (${s.distanceKm} km, ${s.terrain})`);
  }
  if (trailSections.length > samples.length) {
    console.log(`  … and ${trailSections.length - samples.length} more trail sections`);
  }

  const okCount = trailSections.length >= 350 && trailSections.length <= 430;
  const okMax = over15 === 0;
  console.log("\n✅ Checks:");
  console.log(`  Section count ~387:  ${okCount ? "PASS" : "REVIEW"} (${trailSections.length} trail sections)`);
  console.log(`  None over 15 km:     ${okMax ? "PASS" : "FAIL"}`);
  console.log(`  Named trails kept:   ${samples.some((s) => s.name.includes("Rudland Rigg")) ? "PASS" : "REVIEW"}`);
}

async function insertSections(sections: ParsedSection[]): Promise<InsertResult> {
  const supabase = createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const trailIds: string[] = [];
  const collectionTrailIds: string[] = [];

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
    const id = data.id as string;
    trailIds.push(id);
    if (sec.terrain === "trail") collectionTrailIds.push(id);
    const icon = sec.terrain === "trail" ? "🏍️" : "🛣️";
    console.log(`  ${icon} ${sec.name} (${sec.distanceKm} km)`);
  }
  return { trailIds, collectionTrailIds };
}

async function upsertCollection(
  collectionTrailIds: string[],
  sections: ParsedSection[],
  overviewPoints: TrackPoint[] | null,
): Promise<void> {
  const supabase = createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"));

  const trailKm = sections.filter((s) => s.terrain === "trail").reduce((a, s) => a + s.distanceKm, 0);
  const grades = sections.filter((s) => s.terrain === "trail").map(() => 5);
  const difficultyMin = grades.length ? Math.min(...grades) : null;
  const difficultyMax = grades.length ? Math.max(...grades) : null;
  const overviewPath = overviewPoints && overviewPoints.length >= 2
    ? overviewGeojson(overviewPoints)
    : null;

  const { data: existing } = await supabase
    .from("trail_collections")
    .select("id")
    .eq("name", COLLECTION_NAME)
    .maybeSingle();

  let collectionId: string;
  const collectionRow = {
    description: COLLECTION_DESCRIPTION,
    region: COLLECTION_REGION,
    is_featured: true,
    is_official: false,
    total_distance_km: Math.round(trailKm * 10) / 10,
    difficulty_min: difficultyMin,
    difficulty_max: difficultyMax,
    overview_path_geojson: overviewPath,
  };

  if (existing?.id) {
    collectionId = existing.id as string;
    await supabase.from("trail_collections").update(collectionRow).eq("id", collectionId);
    await supabase.from("trail_collection_sections").delete().eq("collection_id", collectionId);
    console.log(`♻️  Updated existing collection (${collectionId})`);
  } else {
    const { data, error } = await supabase.from("trail_collections").insert({
      name: COLLECTION_NAME,
      ...collectionRow,
    }).select("id").single();
    if (error) throw new Error(`Collection insert failed: ${error.message}`);
    collectionId = data.id as string;
    console.log(`✅ Created collection (${collectionId})`);
  }

  if (overviewPath) {
    const overviewKm = Math.round(polylineDistanceKm(overviewPoints!) * 10) / 10;
    console.log(`🗺️  Stored overview polyline (${overviewPoints!.length} pts, ${overviewKm} km)`);
  }

  const links = collectionTrailIds.map((trailId, order_index) => ({
    collection_id: collectionId,
    trail_id: trailId,
    order_index,
  }));
  const { error: linkErr } = await supabase.from("trail_collection_sections").insert(links);
  if (linkErr) throw new Error(`Collection link failed: ${linkErr.message}`);
  console.log(`🔗 Linked ${links.length} trail sections to collection`);
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

  const trailLines = selectTrailLineStrings(placemarks);
  const overviewPoints = selectMasterOverview(placemarks);
  console.log(`📂 Named trail lines: ${trailLines.length}`);
  if (overviewPoints) {
    console.log(`🗺️  Master overview: ${overviewPoints.length} points (stored on collection only)`);
  } else {
    console.warn("⚠️  No master overview line found — collection overview will be empty");
  }

  const { sections, stats } = processAllTrailLines(trailLines);
  console.log(
    `✂️  Gaps: ${stats.gapsFound}, merged: ${stats.mergeCount}, discarded: ${stats.discardCount}, deduped: ${stats.duplicatePointsRemoved}`,
  );

  printDryRunReport(sections, trailLines.length, overviewPoints?.length ?? null);

  if (dryRun) {
    console.log("\n✅ Dry run complete — no data imported.");
    return;
  }

  assertServiceRoleKey(getEnv("SUPABASE_SERVICE_ROLE_KEY"));
  console.log("\n💾 Importing sections…");
  const { trailIds, collectionTrailIds } = await insertSections(sections);
  if (collectionTrailIds.length === 0) {
    console.error("❌ No trail sections inserted — aborting collection link");
    process.exit(1);
  }
  await upsertCollection(collectionTrailIds, sections, overviewPoints);
  console.log(`\n✅ Import complete (${trailIds.length} rows, ${collectionTrailIds.length} in collection).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
