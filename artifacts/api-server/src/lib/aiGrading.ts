import { anthropic } from "@workspace/integrations-anthropic-ai";

const MODEL = "claude-sonnet-4-6";

export interface GpxPoint {
  lat: number;
  lon: number;
  ele?: number | null;
}

export interface AiGradeInput {
  name: string;
  legalStatus?: string | null;
  terrain?: string | null;
  description?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  /** Decoded GPX waypoints. May be empty for AI-approximated trails. */
  waypoints: GpxPoint[];
  /** OSM way-tag samples along the route, when available. */
  osmTags?: Array<{ tag: string; value: string; count: number }>;
}

export interface AiGradeResult {
  grade: number;
  rationale: string;
  model: string;
}

/**
 * Compute a difficulty grade (1-10) for a trail using Anthropic.
 *
 * The function does the geometric pre-work (distance, elevation gain,
 * average gradient) on the server so the LLM gets concrete numbers to
 * reason over rather than being asked to integrate a polyline itself.
 *
 * Returns a structured result. The model is asked to return JSON; if it
 * returns prose we extract the first integer 1-10 and use it.
 */
export async function gradeTrailWithAI(input: AiGradeInput): Promise<AiGradeResult> {
  const stats = computeRouteStats(input.waypoints);
  const tagSummary = (input.osmTags ?? [])
    .slice(0, 12)
    .map((t) => `${t.tag}=${t.value} (×${t.count})`)
    .join(", ") || "none collected";

  const prompt = [
    `You are grading the technical difficulty of an off-road motorcycle / 4x4 trail in the UK or Europe.`,
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
    `  legal_status: ${input.legalStatus ?? "unknown"}`,
    `  terrain: ${input.terrain ?? "unknown"}`,
    `  source: ${input.source ?? "user"}${input.sourceUrl ? ` (${input.sourceUrl})` : ""}`,
    input.description ? `  member_description: ${truncate(input.description, 600)}` : `  member_description: (none)`,
    ``,
    `Computed geometry:`,
    `  total_distance_km: ${stats.distanceKm.toFixed(2)}`,
    `  point_count: ${input.waypoints.length}`,
    `  elevation_gain_m: ${stats.gainM == null ? "unknown" : stats.gainM.toFixed(0)}`,
    `  elevation_loss_m: ${stats.lossM == null ? "unknown" : stats.lossM.toFixed(0)}`,
    `  max_gradient_pct: ${stats.maxGradient == null ? "unknown" : stats.maxGradient.toFixed(1)}`,
    `  avg_gradient_pct: ${stats.avgGradient == null ? "unknown" : stats.avgGradient.toFixed(1)}`,
    ``,
    `OSM way-tags sampled along the route: ${tagSummary}`,
    ``,
    `Return ONLY a JSON object on a single line, no markdown, with this exact shape:`,
    `{"grade": <integer 1-10>, "rationale": "<one short sentence, max 25 words>"}`,
  ].join("\n");

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const text = extractText(message);
  const parsed = parseGradeResponse(text);
  return {
    grade: parsed.grade,
    rationale: parsed.rationale,
    model: MODEL,
  };
}

function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function parseGradeResponse(text: string): { grade: number; rationale: string } {
  const trimmed = text.trim();
  // Try strict JSON first.
  try {
    const obj = JSON.parse(trimmed);
    const g = clampGrade(obj.grade);
    const r = typeof obj.rationale === "string" ? obj.rationale : "";
    if (g != null) return { grade: g, rationale: r || "(no rationale provided)" };
  } catch {
    /* fall through */
  }
  // Try to find an embedded JSON object.
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
  // Last-ditch: first standalone integer 1-10.
  const num = trimmed.match(/\b([1-9]|10)\b/);
  if (num) {
    return { grade: Number(num[1]), rationale: trimmed.slice(0, 200) };
  }
  // Default to 5 ("medium") if the model returned something unparseable —
  // we never want grading to throw for a single bad response.
  return { grade: 5, rationale: "AI grader response was unparseable; defaulted to 5/10." };
}

function clampGrade(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < 1 || i > 10) return null;
  return i;
}

interface RouteStats {
  distanceKm: number;
  gainM: number | null;
  lossM: number | null;
  maxGradient: number | null;
  avgGradient: number | null;
}

export function computeRouteStats(points: GpxPoint[]): RouteStats {
  if (points.length < 2) {
    return { distanceKm: 0, gainM: null, lossM: null, maxGradient: null, avgGradient: null };
  }
  let dist = 0;
  let gain = 0;
  let loss = 0;
  let maxGrad = 0;
  let gradSum = 0;
  let gradCount = 0;
  let hasEle = false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segM = haversineM(a, b);
    if (segM <= 0) continue;
    dist += segM;
    if (a.ele != null && b.ele != null && Number.isFinite(a.ele) && Number.isFinite(b.ele)) {
      hasEle = true;
      const dEle = b.ele - a.ele;
      if (dEle > 0) gain += dEle;
      else loss -= dEle;
      const grad = Math.abs(dEle / segM) * 100;
      if (segM > 5) {
        if (grad > maxGrad) maxGrad = grad;
        gradSum += grad;
        gradCount++;
      }
    }
  }
  return {
    distanceKm: dist / 1000,
    gainM: hasEle ? gain : null,
    lossM: hasEle ? loss : null,
    maxGradient: hasEle && maxGrad > 0 ? maxGrad : null,
    avgGradient: hasEle && gradCount > 0 ? gradSum / gradCount : null,
  };
}

function haversineM(a: GpxPoint, b: GpxPoint): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/**
 * Best-effort fetch of OSM way-tags overlapping a route bbox via Overpass.
 * Returns a frequency-sorted list of (tag, value, count) tuples covering
 * `highway`, `surface`, `tracktype` and `smoothness` — the four tags most
 * useful for difficulty grading. Returns [] if Overpass is unreachable or
 * the bbox is degenerate; the grader falls back to "none collected".
 */
export async function fetchOsmTagSummary(
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null,
): Promise<Array<{ tag: string; value: string; count: number }>> {
  if (!bbox) return [];
  const { minLat, maxLat, minLng, maxLng } = bbox;
  if (
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLat) ||
    !Number.isFinite(minLng) ||
    !Number.isFinite(maxLng)
  ) {
    return [];
  }
  // Cap absurd bboxes — Overpass is a shared resource.
  if (maxLat - minLat > 1 || maxLng - minLng > 1) return [];
  const query = `
    [out:json][timeout:15];
    (
      way["highway"~"track|path|unclassified|service"](${minLat},${minLng},${maxLat},${maxLng});
    );
    out tags 200;
  `;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: query,
      headers: { "Content-Type": "text/plain" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = (await res.json()) as { elements?: Array<{ tags?: Record<string, string> }> };
    const counts = new Map<string, number>();
    for (const el of json.elements ?? []) {
      const tags = el.tags ?? {};
      for (const t of ["highway", "surface", "tracktype", "smoothness"] as const) {
        const v = tags[t];
        if (v) {
          const key = `${t}=${v}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    return Array.from(counts.entries())
      .map(([k, count]) => {
        const [tag, value] = k.split("=");
        return { tag, value, count };
      })
      .sort((a, b) => b.count - a.count);
  } catch {
    return [];
  }
}
