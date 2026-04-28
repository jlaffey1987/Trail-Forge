import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBundle, trackBbox, type GpxWaypoint } from "./parseBundle.js";
import { segmentTrack } from "./segmentation.js";
import { nameSubSegment } from "./naming.js";
import { elevationGainMeters, gradeSegment } from "./grade.js";
import { checkSchemaReady, closePool, computeSegmentHash, upsertTrail } from "./persist.js";

interface CliOptions {
  region: string;
  source: string;
  dryRun: boolean;
  skipOsm: boolean;
  skipAi: boolean;
  maxSegmentsPerDay: number;
  maxDays: number | null;
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {
    region: "all",
    source: "all",
    dryRun: false,
    skipOsm: false,
    skipAi: false,
    maxSegmentsPerDay: Infinity,
    maxDays: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--region") opts.region = argv[++i] ?? "all";
    else if (a === "--source") opts.source = argv[++i] ?? "all";
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--skip-osm") opts.skipOsm = true;
    else if (a === "--skip-ai") opts.skipAi = true;
    else if (a === "--max-segments-per-day") opts.maxSegmentsPerDay = Number(argv[++i]);
    else if (a === "--max-days") opts.maxDays = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(
    [
      "Usage: pnpm --filter @workspace/scripts import:act -- [options]",
      "",
      "Options:",
      "  --source <act|tet|all>        Source bundle family to import (default: all).",
      "  --region <uk|all>             Region to import (default: all).",
      "  --dry-run                     Skip database writes; print summary only.",
      "  --skip-osm                    Skip Overpass classification (treat tracks as offroad).",
      "  --skip-ai                     Skip Anthropic grading (use heuristic fallback).",
      "  --max-segments-per-day N      Cap sub-trails per day-track (smoke testing).",
      "  --max-days N                  Cap day-tracks processed per bundle (smoke testing).",
      "  -h, --help                    Show this help.",
    ].join("\n"),
  );
}

interface BundleSpec {
  file: string;
  sha256: string;
  bytes: number;
  source: "act" | "tet";
  region: string;
  sourceUrl: string;
}

interface BundlesManifest {
  bundles: BundleSpec[];
  notes: string[];
}

function loadManifest(fixturesDir: string): BundlesManifest {
  const path = join(fixturesDir, "bundles.json");
  return JSON.parse(readFileSync(path, "utf8")) as BundlesManifest;
}

interface RegionSummary {
  source: string;
  region: string;
  file: string;
  tracks: number;
  daysProcessed: number;
  candidates: number;
  inserted: number;
  updated: number;
  skippedExisting: number;
  errors: number;
}

async function importBundle(spec: BundleSpec, fixturesDir: string, opts: CliOptions): Promise<RegionSummary> {
  const filePath = join(fixturesDir, spec.file);
  if (!existsSync(filePath)) {
    throw new Error(`Bundle file missing: ${filePath}`);
  }
  console.log(`\n=== ${spec.source.toUpperCase()} ${spec.region.toUpperCase()} :: ${spec.file} (${spec.bytes} bytes) ===`);
  const bundle = parseBundle(filePath);
  if (bundle.sha256 !== spec.sha256) {
    console.warn(
      `[warn] sha256 mismatch for ${spec.file}: manifest=${spec.sha256.slice(0, 12)}…  actual=${bundle.sha256.slice(0, 12)}…`,
    );
  }
  console.log(
    `  parsed: ${bundle.tracks.length} tracks, ${bundle.waypoints.length} waypoints, total points=${bundle.tracks.reduce((s, t) => s + t.points.length, 0)}`,
  );

  const summary: RegionSummary = {
    source: spec.source,
    region: spec.region,
    file: spec.file,
    tracks: bundle.tracks.length,
    daysProcessed: 0,
    candidates: 0,
    inserted: 0,
    updated: 0,
    skippedExisting: 0,
    errors: 0,
  };

  const dayLimit = opts.maxDays ?? bundle.tracks.length;
  for (let trackIdx = 0; trackIdx < Math.min(bundle.tracks.length, dayLimit); trackIdx += 1) {
    const track = bundle.tracks[trackIdx];
    summary.daysProcessed += 1;
    let segments;
    try {
      segments = await segmentTrack(track.points, {
        skipOsm: opts.skipOsm,
        log: (m) => console.log(`  [trk ${trackIdx + 1}/${bundle.tracks.length}] ${m}`),
      });
    } catch (err) {
      console.warn(`  [trk ${trackIdx + 1}] segmentation error: ${(err as Error).message}`);
      summary.errors += 1;
      continue;
    }

    if (segments.length === 0) {
      console.log(`  [trk ${trackIdx + 1}/${bundle.tracks.length}] "${track.name}": no off-road sub-segments`);
      continue;
    }
    const usable = segments.slice(0, opts.maxSegmentsPerDay);
    console.log(
      `  [trk ${trackIdx + 1}/${bundle.tracks.length}] "${track.name}": ${segments.length} off-road segment(s)${usable.length < segments.length ? ` (capped to ${usable.length})` : ""}`,
    );

    for (const seg of usable) {
      summary.candidates += 1;
      const hash = computeSegmentHash({
        bundleSha256: bundle.sha256,
        trackIndex: track.index,
        segmentIndex: seg.index,
        startPointIndex: seg.startPointIndex,
        endPointIndex: seg.endPointIndex,
        points: seg.points,
      });
      const name = nameSubSegment(track.name, seg.index, seg.points, bundle.waypoints as GpxWaypoint[]);
      const distanceKm = seg.distanceMeters / 1000;
      const elevGain = elevationGainMeters(seg.points);
      const bbox = trackBbox(seg.points);

      try {
        const grade = await gradeSegment({
          name,
          segmentHash: hash,
          source: spec.source,
          region: spec.region,
          points: seg.points,
          distanceKm,
          elevationGainM: elevGain,
          skipAi: opts.skipAi,
        });

        if (opts.dryRun) {
          console.log(
            `    [dry] would insert "${name}" — ${distanceKm.toFixed(2)} km, grade ${grade.grade}/10${grade.fallback ? " (heuristic)" : ""}`,
          );
          continue;
        }

        const out = await upsertTrail({
          name,
          source: spec.source,
          sourceUrl: spec.sourceUrl,
          sourceRegion: spec.region,
          segmentHash: hash,
          points: seg.points,
          distanceKm,
          elevationGainM: elevGain,
          bbox,
          aiGrade: grade.grade,
          aiGradeRationale: grade.rationale,
          aiGradeModel: grade.model,
        });
        if (out.inserted) {
          summary.inserted += 1;
          console.log(`    ✓ inserted "${name}" (id=${out.trailId}, grade=${grade.grade})`);
        } else if (out.updated) {
          summary.updated += 1;
          console.log(`    ↻ updated "${name}" (id=${out.trailId}, grade=${grade.grade})`);
        } else {
          summary.skippedExisting += 1;
          console.log(`    · skipped "${name}" — ${out.reason}`);
        }
      } catch (err) {
        summary.errors += 1;
        console.warn(`    [error] "${name}": ${(err as Error).message}`);
      }
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  const __filename = fileURLToPath(import.meta.url);
  const fixturesDir = join(dirname(__filename), "fixtures");
  const manifest = loadManifest(fixturesDir);

  const bundles = manifest.bundles.filter(
    (b) =>
      (opts.region === "all" || b.region === opts.region) &&
      (opts.source === "all" || b.source === opts.source),
  );
  if (bundles.length === 0) {
    console.error(
      `No fixtures found for source="${opts.source}" region="${opts.region}". Available: ${manifest.bundles.map((b) => `${b.source}/${b.region}`).join(", ")}`,
    );
    process.exit(1);
  }

  if (!opts.dryRun) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set; either provision them or re-run with --dry-run.");
      process.exit(2);
    }
    const schema = await checkSchemaReady();
    if (!schema.ok) {
      console.error(
        `[schema] trails table is missing required columns: ${schema.missing.join(", ")}.\n` +
          `Apply artifacts/trailforge/supabase/migrations/0009_act_imports.sql before re-running.`,
      );
      process.exit(3);
    }
  }

  const summaries: RegionSummary[] = [];
  for (const b of bundles) {
    const s = await importBundle(b, fixturesDir, opts);
    summaries.push(s);
  }

  console.log("\n=== Import summary ===");
  for (const s of summaries) {
    console.log(
      `  ${s.source.toUpperCase().padEnd(4)} ${s.region.padEnd(8)} ${s.file.padEnd(28)} tracks=${s.tracks}  days=${s.daysProcessed}  candidates=${s.candidates}  inserted=${s.inserted}  updated=${s.updated}  skipped=${s.skippedExisting}  errors=${s.errors}`,
    );
  }
  await closePool();
}

main().catch((err) => {
  console.error("Fatal:", err);
  closePool().finally(() => process.exit(1));
});
