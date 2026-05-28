import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GpxPoint } from "./parseBundle.js";

/**
 * AI grading wrapper used by the ACT importer.
 *
 * - Reuses the same scoring rubric as the API server's `gradeTrailWithAI`
 *   so the user-facing grade is consistent across surfaces.
 * - Caches per-`segmentHash` results on disk so a re-run is free.
 * - Falls back to a deterministic heuristic (based on distance + elevation
 *   gain) when Anthropic is unavailable or rate-limited; the rationale
 *   makes the fallback explicit so a moderator can re-grade later.
 */

const MODEL = "claude-sonnet-4-6";
const CACHE_DIR = process.env.ACT_AI_CACHE_DIR ?? ".local/act-ai-cache";

export interface GradeInput {
  name: string;
  segmentHash: string;
  source: "act" | "tet";
  region: string;
  points: GpxPoint[];
  distanceKm: number;
  elevationGainM: number | null;
  skipAi?: boolean;
}

export interface GradeResult {
  grade: number;
  rationale: string;
  model: string;
  cached: boolean;
  fallback: boolean;
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function cachePath(segmentHash: string): string {
  return join(CACHE_DIR, `${segmentHash}.json`);
}

function loadCache(segmentHash: string): GradeResult | null {
  const path = cachePath(segmentHash);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GradeResult;
    return { ...parsed, cached: true };
  } catch {
    return null;
  }
}

function saveCache(segmentHash: string, result: GradeResult): void {
  ensureCacheDir();
  writeFileSync(cachePath(segmentHash), JSON.stringify(result));
}

/**
 * Heuristic fallback used when AI is unavailable or `--skip-ai` is set.
 * Maps distance + elevation-gain density to the same 1-10 scale.
 */
function heuristicGrade(input: GradeInput): { grade: number; rationale: string } {
  const distance = Math.max(0.5, input.distanceKm);
  const gain = input.elevationGainM ?? 0;
  const gainPerKm = gain / distance;

  let grade = 3;
  if (distance > 8) grade += 1;
  if (distance > 20) grade += 1;
  if (gainPerKm > 30) grade += 1;
  if (gainPerKm > 60) grade += 1;
  if (gainPerKm > 100) grade += 1;
  if (gainPerKm > 150) grade += 1;
  if (grade < 1) grade = 1;
  if (grade > 10) grade = 10;

  return {
    grade,
    rationale: `Heuristic grade based on ${distance.toFixed(1)} km, ${Math.round(gain)} m gain (${gainPerKm.toFixed(0)} m/km). Re-grade with AI for a finer score.`,
  };
}

function buildPrompt(input: GradeInput): string {
  const sourceFull =
    input.source === "tet"
      ? "TET (Trans Euro Trail)"
      : "ACT (Adventure Country Tracks)";
  return [
    `You are grading the technical difficulty of an off-road motorcycle / 4x4 trail in the UK.`,
    ``,
    `This trail is one off-road sub-segment extracted from a ${sourceFull} day-route — i.e. byway / green-lane riding linking villages, NOT public road.`,
    ``,
    `Use a 1-10 scale where:`,
    `  1-2 = easy gravel / hardpack, suitable for a road bike with off-road tyres`,
    `  3-4 = green-lane / unsealed track, mild ruts, occasional puddles`,
    `  5-6 = mixed terrain with rocky sections, modest gradients (8-15%), riding skill required`,
    `  7-8 = expert: large rocks, deep ruts, water crossings, sustained gradients > 15%`,
    `  9-10 = extreme: hike-a-bike sections, ledges, dangerous exposure, major water crossings`,
    ``,
    `Trail metadata:`,
    `  name: ${input.name}`,
    `  source: ${input.source} (${input.region})`,
    ``,
    `Computed geometry:`,
    `  total_distance_km: ${input.distanceKm.toFixed(2)}`,
    `  point_count: ${input.points.length}`,
    `  elevation_gain_m: ${input.elevationGainM == null ? "unknown" : input.elevationGainM.toFixed(0)}`,
    ``,
    `Return ONLY a JSON object on a single line, no markdown, with this exact shape:`,
    `{"grade": <integer 1-10>, "rationale": "<one short sentence, max 25 words>"}`,
  ].join("\n");
}

function parseGradeResponse(text: string): { grade: number; rationale: string } | null {
  const trimmed = text.trim();
  try {
    const obj = JSON.parse(trimmed);
    const g = clampGrade(obj.grade);
    const r = typeof obj.rationale === "string" ? obj.rationale : "";
    if (g != null) return { grade: g, rationale: r || "(no rationale provided)" };
  } catch {
    /* fall through */
  }
  const m = trimmed.match(/\{[^{}]*"grade"[^{}]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      const g = clampGrade(obj.grade);
      const r = typeof obj.rationale === "string" ? obj.rationale : "";
      if (g != null) return { grade: g, rationale: r || "(no rationale provided)" };
    } catch {
      /* fall through */
    }
  }
  const num = trimmed.match(/\b([1-9]|10)\b/);
  if (num) return { grade: Number(num[1]), rationale: trimmed.slice(0, 200) };
  return null;
}

function clampGrade(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < 1 || i > 10) return null;
  return i;
}

export async function gradeSegment(input: GradeInput): Promise<GradeResult> {
  const cached = loadCache(input.segmentHash);
  if (cached) return cached;

  if (input.skipAi) {
    const h = heuristicGrade(input);
    const result: GradeResult = {
      grade: h.grade,
      rationale: h.rationale,
      model: "heuristic",
      cached: false,
      fallback: true,
    };
    saveCache(input.segmentHash, result);
    return result;
  }

  try {
    const { anthropic } = await import("@workspace/integrations-anthropic-ai");
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: buildPrompt(input) }],
    });
    let text = "";
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") text = block.text;
    }
    const parsed = parseGradeResponse(text);
    if (parsed) {
      const result: GradeResult = {
        grade: parsed.grade,
        rationale: parsed.rationale,
        model: MODEL,
        cached: false,
        fallback: false,
      };
      saveCache(input.segmentHash, result);
      return result;
    }
  } catch (err) {
    // fall through to heuristic
    void err;
  }

  const h = heuristicGrade(input);
  const result: GradeResult = {
    grade: h.grade,
    rationale: `AI grading unavailable — ${h.rationale}`,
    model: "heuristic",
    cached: false,
    fallback: true,
  };
  saveCache(input.segmentHash, result);
  return result;
}

export function elevationGainMeters(points: GpxPoint[]): number | null {
  let gain = 0;
  let saw = false;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1].ele;
    const b = points[i].ele;
    if (a == null || b == null) continue;
    saw = true;
    if (b > a) gain += b - a;
  }
  return saw ? gain : null;
}
