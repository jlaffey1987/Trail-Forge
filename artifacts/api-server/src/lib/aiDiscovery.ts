import { anthropic } from "@workspace/integrations-anthropic-ai";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { computeRouteStats, type GpxPoint } from "./aiGrading";

const MODEL = "claude-sonnet-4-6";
const MAX_POST_BYTES = 250_000; // forum threads can balloon — cap fetch size
const FETCH_TIMEOUT_MS = 12_000;
// Cache parsed robots rules per origin (NOT a single allow/deny per origin —
// that would be wrong because the first probed path's outcome would silently
// dictate the verdict for every other path on the host until TTL expiry).
const ROBOTS_CACHE = new Map<string, { rules: RobotsRules; expires: number }>();
const ROBOTS_TTL_MS = 60 * 60 * 1000;

const USER_AGENT =
  "TrailForgeBot/1.0 (+https://trailforge.app/bot — respects robots.txt; admin-triggered)";

interface RobotsRules {
  /** Disallow path prefixes that apply to our UA (most-specific first). */
  disallow: string[];
  /** Allow path prefixes that apply to our UA (used to override Disallow). */
  allow: string[];
}

/**
 * SSRF guard. Rejects any URL that:
 *   - is not http: or https:
 *   - resolves to a private / loopback / link-local / multicast IP
 *   - is a literal private/loopback IP host
 *
 * We resolve the hostname here and compare it ourselves. Node's fetch
 * does its own DNS lookup, so there is a small TOCTOU window — for
 * defence in depth we also block redirects (`redirect: "manual"`) at the
 * call sites and re-validate any Location response header.
 */
async function assertSafeOutboundUrl(input: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("invalid-url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsafe-protocol:${parsed.protocol}`);
  }
  const host = parsed.hostname;
  if (!host) throw new Error("missing-host");
  // Reject userinfo (could trick legacy parsers).
  if (parsed.username || parsed.password) throw new Error("userinfo-not-allowed");
  // Hostname is sometimes a literal IP. Otherwise resolve it.
  let ips: string[];
  const ipKind = isIP(host);
  if (ipKind) {
    ips = [host];
  } else {
    try {
      const records = await dnsLookup(host, { all: true });
      ips = records.map((r) => r.address);
    } catch {
      throw new Error("dns-failure");
    }
  }
  for (const ip of ips) {
    if (isPrivateOrLocalIp(ip)) {
      throw new Error(`blocked-private-ip:${ip}`);
    }
  }
  return parsed;
}

function isPrivateOrLocalIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 127) return true;                         // 127.0.0.0/8 loopback
    if (a === 0) return true;                           // 0.0.0.0/8
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local (incl. AWS/GCP metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 192 && b === 0) return true;              // 192.0.0.0/24
    if (a >= 224) return true;                          // multicast + reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("fe80")) return true;                          // link-local
    if (lower.startsWith("ff")) return true;                            // multicast
    if (lower.startsWith("::ffff:")) {
      // IPv4-mapped — re-check the embedded IPv4
      const v4 = lower.slice("::ffff:".length);
      if (isIP(v4) === 4) return isPrivateOrLocalIp(v4);
    }
    return false;
  }
  return true; // unknown family — refuse
}

/**
 * SSRF-safe wrapper around fetch. Validates the URL, blocks redirects,
 * and re-validates any Location header before following it (one hop max).
 * Callers still own size-capping of the response body.
 */
async function safeFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response | null> {
  const timeoutMs = init.timeoutMs ?? FETCH_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let parsed: URL;
    try {
      parsed = await assertSafeOutboundUrl(url);
    } catch {
      return null;
    }
    let res: Response;
    try {
      res = await fetch(parsed.toString(), {
        ...init,
        signal: ctrl.signal,
        redirect: "manual",
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      let next: URL;
      try {
        next = new URL(loc, parsed);
        await assertSafeOutboundUrl(next.toString());
      } catch {
        return null;
      }
      try {
        res = await fetch(next.toString(), {
          ...init,
          signal: ctrl.signal,
          redirect: "manual",
        });
      } catch {
        return null;
      }
      // Don't follow a second hop — keep the safety budget tight.
      if (res.status >= 300 && res.status < 400) return null;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export interface ForumExtractResult {
  trailName: string | null;
  location: string | null;
  summary: string;
  difficulty: number | null;
  surface: string | null;
  /** Direct URL to a downloadable .gpx file mentioned in the post (if any). */
  gpxUrl: string | null;
}

/**
 * Light, polite HTML fetch — caps at MAX_POST_BYTES, sets a TrailForge UA,
 * and times out. Returns null if the URL is disallowed by robots.txt or
 * fetch fails.
 */
export async function fetchForumPost(url: string): Promise<string | null> {
  if (!(await respectsRobotsTxt(url))) return null;
  const res = await safeFetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html, application/xhtml+xml" },
  });
  if (!res || !res.ok) return null;
  try {
    const reader = res.body?.getReader();
    if (!reader) return null;
    let total = 0;
    const chunks: Uint8Array[] = [];
    while (total < MAX_POST_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(concat(chunks));
  } catch {
    return null;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Returns true if `url` is allowed by the site's robots.txt for our UA.
 * Robots rules are parsed once per origin and cached for ROBOTS_TTL_MS;
 * the path is evaluated per-call against the cached rules. If robots.txt
 * is unreachable we conservatively allow (most forum hosts return 404
 * rather than 200 with a deny rule), and we cache an empty ruleset so
 * we don't re-fetch on every URL.
 */
export async function respectsRobotsTxt(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  const now = Date.now();
  let entry = ROBOTS_CACHE.get(origin);
  if (!entry || entry.expires <= now) {
    let rules: RobotsRules = { disallow: [], allow: [] };
    try {
      const res = await safeFetch(`${origin}/robots.txt`, {
        headers: { "User-Agent": USER_AGENT },
        timeoutMs: 5_000,
      });
      if (res?.ok) {
        // Cap robots.txt size — pathological hosts can serve giant ones.
        const text = (await res.text()).slice(0, 100_000);
        rules = parseRobots(text);
      }
    } catch {
      /* network blip — keep empty rules (conservatively permit). */
    }
    entry = { rules, expires: now + ROBOTS_TTL_MS };
    ROBOTS_CACHE.set(origin, entry);
  }
  return !robotsDisallowsPath(entry.rules, parsed.pathname + parsed.search);
}

/**
 * Tiny robots.txt parser — extracts rules from sections matching our UA
 * or `*`. Records both Allow and Disallow prefixes.
 *
 * We intentionally implement the most common subset: longest-match wins
 * between Allow and Disallow on the same path. We do not implement
 * Crawl-delay, Sitemap, or wildcard `*`/`$` patterns; those are rare on
 * the forum hosts we target and erring on the side of NOT crawling is
 * the safe default.
 */
function parseRobots(text: string): RobotsRules {
  const lines = text.split(/\r?\n/);
  // Two passes: first locate every UA group and what paths it owns; then
  // merge the rules from groups that match us (`*` or our UA).
  type Group = { uas: string[]; allow: string[]; disallow: string[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasUserAgent = false;
  for (const raw of lines) {
    const line = raw.split("#")[0].trim();
    if (!line) {
      lastWasUserAgent = false;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!cur || !lastWasUserAgent) {
        cur = { uas: [val.toLowerCase()], allow: [], disallow: [] };
        groups.push(cur);
      } else {
        cur.uas.push(val.toLowerCase());
      }
      lastWasUserAgent = true;
    } else if (key === "allow" && cur) {
      if (val) cur.allow.push(val);
      lastWasUserAgent = false;
    } else if (key === "disallow" && cur) {
      // An empty Disallow value means "allow everything" — skip it.
      if (val) cur.disallow.push(val);
      lastWasUserAgent = false;
    } else {
      lastWasUserAgent = false;
    }
  }
  const rules: RobotsRules = { disallow: [], allow: [] };
  for (const g of groups) {
    const matches = g.uas.some(
      (ua) => ua === "*" || ua === "trailforgebot" || ua.includes("trailforgebot"),
    );
    if (matches) {
      rules.disallow.push(...g.disallow);
      rules.allow.push(...g.allow);
    }
  }
  return rules;
}

function robotsDisallowsPath(rules: RobotsRules, path: string): boolean {
  // Longest matching prefix wins between Allow and Disallow.
  let bestDisallow = -1;
  let bestAllow = -1;
  for (const dp of rules.disallow) {
    if (dp === "/") {
      if (bestDisallow < 1) bestDisallow = 1;
      continue;
    }
    if (path.startsWith(dp) && dp.length > bestDisallow) bestDisallow = dp.length;
  }
  for (const ap of rules.allow) {
    if (path.startsWith(ap) && ap.length > bestAllow) bestAllow = ap.length;
  }
  if (bestDisallow < 0) return false;
  // If both match, the longer one wins; ties go to allow (per spec).
  if (bestAllow >= bestDisallow) return false;
  return true;
}

/**
 * Use Anthropic to pull structured trail-mention data out of a forum thread
 * (or RSS-rendered page). Returns a single ForumExtractResult — the most
 * prominently mentioned trail. The model is asked to return JSON.
 */
export async function extractTrailFromForumPost(
  rawHtml: string,
  pageUrl: string,
): Promise<ForumExtractResult | null> {
  const text = stripHtmlForLLM(rawHtml).slice(0, 18_000);
  if (text.length < 50) return null;
  const prompt = [
    `You are reading a single off-road motorcycle / 4x4 forum post or thread page and extracting one trail mention from it.`,
    `If multiple trails are discussed, pick the most prominently described one.`,
    `If no trail is described in concrete terms (a route, a place, riding it), return {"none": true}.`,
    ``,
    `Return ONLY a single-line JSON object. Do not include markdown.`,
    `Schema:`,
    `{"trail_name": <string|null>, "location": <string|null>, "summary": <string max 500 chars>, "difficulty": <integer 1-10|null>, "surface": <string|null>, "gpx_url": <string|null>}`,
    ``,
    `If a downloadable .gpx URL is mentioned, set "gpx_url" to the absolute URL. Otherwise null.`,
    ``,
    `Source URL (for context): ${pageUrl}`,
    ``,
    `--- POST CONTENT ---`,
    text,
    `--- END POST ---`,
  ].join("\n");

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });
    const out = pickText(message);
    return parseForumExtract(out);
  } catch {
    return null;
  }
}

function pickText(message: { content: Array<{ type: string; text?: string }> }): string {
  for (const b of message.content) if (b.type === "text" && typeof b.text === "string") return b.text;
  return "";
}

function parseForumExtract(text: string): ForumExtractResult | null {
  const trimmed = text.trim();
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (obj.none === true) return null;
  const summary = typeof obj.summary === "string" ? obj.summary.slice(0, 500) : "";
  if (!summary && !obj.trail_name) return null;
  let difficulty: number | null = null;
  if (typeof obj.difficulty === "number" && obj.difficulty >= 1 && obj.difficulty <= 10) {
    difficulty = Math.round(obj.difficulty);
  }
  return {
    trailName: typeof obj.trail_name === "string" ? obj.trail_name.slice(0, 200) : null,
    location: typeof obj.location === "string" ? obj.location.slice(0, 200) : null,
    summary,
    difficulty,
    surface: typeof obj.surface === "string" ? obj.surface.slice(0, 100) : null,
    gpxUrl: typeof obj.gpx_url === "string" ? obj.gpx_url.slice(0, 1000) : null,
  };
}

function stripHtmlForLLM(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch a GPX URL discovered in a forum post and return the raw text +
 * decoded waypoints. Caps download size; returns null on failure.
 */
export async function fetchAndParseGpxUrl(url: string): Promise<{ gpxText: string; waypoints: GpxPoint[] } | null> {
  if (!(await respectsRobotsTxt(url))) return null;
  const res = await safeFetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/gpx+xml, application/xml, */*" },
  });
  if (!res || !res.ok) return null;
  try {
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_POST_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    const gpxText = new TextDecoder("utf-8", { fatal: false }).decode(concat(chunks));
    const waypoints = parseGpxText(gpxText);
    if (waypoints.length < 2) return null;
    return { gpxText, waypoints };
  } catch {
    return null;
  }
}

/**
 * Server-side GPX parser — mirrors the browser-side parser in
 * artifacts/trailforge/src/lib/gpx.ts, but uses a regex pass since
 * Node has no DOMParser.
 */
export function parseGpxText(gpxText: string): GpxPoint[] {
  const points: GpxPoint[] = [];
  const ptRegex = /<(?:trkpt|rtept)\s[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>([\s\S]*?)<\/(?:trkpt|rtept)>|<(?:trkpt|rtept)\s[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = ptRegex.exec(gpxText)) != null) {
    const lat = parseFloat(m[1] ?? m[4] ?? "");
    const lon = parseFloat(m[2] ?? m[5] ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    let ele: number | null = null;
    const inner = m[3] ?? "";
    const eleMatch = inner.match(/<ele>([^<]+)<\/ele>/);
    if (eleMatch) {
      const e = parseFloat(eleMatch[1]);
      if (Number.isFinite(e)) ele = e;
    }
    points.push({ lat, lon, ele });
  }
  return points;
}

export function bboxFromPoints(points: GpxPoint[]): { minLat: number; maxLat: number; minLng: number; maxLng: number } | null {
  if (points.length === 0) return null;
  let minLat = Infinity,
    maxLat = -Infinity,
    minLng = Infinity,
    maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLng) minLng = p.lon;
    if (p.lon > maxLng) maxLng = p.lon;
  }
  return { minLat, maxLat, minLng, maxLng };
}

export function distanceKmFromPoints(points: GpxPoint[]): number {
  return computeRouteStats(points).distanceKm;
}

/**
 * For an AI-discovered post that has no linked GPX, geocode the named
 * location via Nominatim and snap the result to the nearest OpenStreetMap
 * off-road track. Returns the snapped waypoints + bbox so the row can be
 * persisted with a real (if approximated) geometry. The caller marks the
 * resulting trail as `verification_status='ai-approximated'` and excludes
 * it from navigation.
 *
 * Returns `null` when:
 *   - the location is blank,
 *   - Nominatim cannot geocode the place,
 *   - or no real OSM track exists within the snap radius.
 *
 * In the third case the caller MUST skip the post entirely. We deliberately
 * do not synthesise a 2-point pseudo-track as a fallback any more —
 * historically that produced straight-line "phantom trails" cutting across
 * the countryside that polluted the map even with the ai-approximated
 * badge.
 */
export async function approximateTrackFromLocation(
  location: string,
): Promise<{ waypoints: GpxPoint[]; bbox: ReturnType<typeof bboxFromPoints> } | null> {
  if (!location.trim()) return null;
  // Step 1: geocode the named place via Nominatim.
  let lat: number;
  let lon: number;
  try {
    const res = await safeFetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}&limit=1`,
      { headers: { "User-Agent": USER_AGENT } },
    );
    if (!res || !res.ok) return null;
    const data = (await res.json()) as Array<{ lat: string; lon: string; boundingbox?: string[] }>;
    if (!data.length) return null;
    lat = parseFloat(data[0].lat);
    lon = parseFloat(data[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  } catch {
    return null;
  }

  // Step 2: snap to the OSM track network within ~750m of the geocoded
  // centre. We pick the longest matching way and use its real geometry,
  // which gives moderators a track shape to inspect. The published trail
  // still carries verification_status='ai-approximated' so it stays out of
  // navigation.
  //
  // If Overpass has nothing nearby (or is down), we return null — the
  // caller will skip the post rather than persist a fake straight line.
  const snapped = await snapToNearestOsmTrack(lat, lon, 750);
  if (snapped && snapped.length >= 2) {
    return { waypoints: snapped, bbox: bboxFromPoints(snapped) };
  }
  return null;
}

/**
 * Query Overpass for trail-network ways within `radiusM` of (lat, lon)
 * and return the geometry of the longest match. We only consider ways
 * that look like off-road trails — path/track/footway/bridleway/cycleway
 * — and we cap the response and timeout aggressively.
 *
 * Returns null when:
 *   - Overpass is unreachable or returns an error
 *   - no qualifying ways are found
 *   - the longest way has < 2 points
 */
async function snapToNearestOsmTrack(
  lat: number,
  lon: number,
  radiusM: number,
): Promise<GpxPoint[] | null> {
  const query = `
    [out:json][timeout:8];
    (
      way["highway"~"^(path|track|footway|bridleway|cycleway)$"](around:${radiusM},${lat},${lon});
    );
    out geom 50;
  `.trim();
  try {
    const res = await safeFetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: `data=${encodeURIComponent(query)}`,
      timeoutMs: 12_000,
    });
    if (!res || !res.ok) return null;
    const json = (await res.json()) as {
      elements?: Array<{
        type?: string;
        geometry?: Array<{ lat: number; lon: number }>;
      }>;
    };
    const ways = (json.elements ?? []).filter(
      (e) => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length >= 2,
    );
    if (ways.length === 0) return null;
    let best: GpxPoint[] | null = null;
    let bestLenKm = 0;
    for (const w of ways) {
      const pts: GpxPoint[] = (w.geometry ?? []).map((p) => ({
        lat: p.lat,
        lon: p.lon,
        ele: null,
      }));
      if (pts.length < 2) continue;
      const lenKm = computeRouteStats(pts).distanceKm;
      if (lenKm > bestLenKm) {
        bestLenKm = lenKm;
        best = pts;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Serialize waypoints back into a minimal GPX string we can store in the
 * `gpx_data` column for an approximated / scanned trail.
 */
export function buildGpxFromWaypoints(name: string, points: GpxPoint[]): string {
  const trkpts = points
    .map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : ""}</trkpt>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailForge AI" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeXml(name)}</name><time>${new Date().toISOString()}</time></metadata>
  <trk>
    <name>${escapeXml(name)}</name>
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

// ---------------------------------------------------------------------------
// Per-post link discovery
// ---------------------------------------------------------------------------
// A forum source URL usually points to an *index* (subforum index, search
// result, RSS feed) — we walk that page and pull individual post / thread
// URLs out of it, then process each post separately. This is how the
// "for each post" requirement is satisfied.

const MAX_POST_LINKS_PER_SOURCE = 12;

/**
 * Pull a list of unique post / thread URLs from an index page or RSS feed.
 * Heuristics:
 *   - RSS / Atom (`<item><link>` or `<entry><link href=...>`) — used when
 *     `kind === "rss"` or the body looks like XML.
 *   - HTML — every absolute or relative `<a href>` whose path looks like a
 *     forum thread (contains `/thread`, `/topic`, `/posts`, `/showthread`,
 *     `/t/`, `/p/`, `/discussion/`, or `?t=`/`?topic=`/`?p=`).
 *
 * Self-links and external links are excluded. Returns up to
 * `MAX_POST_LINKS_PER_SOURCE` deduped absolute URLs.
 */
export function extractPostLinks(
  body: string,
  baseUrl: string,
  kind: "rss" | "html",
): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const looksXml = body.trimStart().startsWith("<?xml") || /<rss\b|<feed\b/i.test(body.slice(0, 500));
  const useRss = kind === "rss" || looksXml;

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    let abs: string;
    try {
      abs = new URL(raw, base).toString();
    } catch {
      return;
    }
    // Strip fragment.
    const hashIdx = abs.indexOf("#");
    if (hashIdx >= 0) abs = abs.slice(0, hashIdx);
    if (abs === baseUrl) return;
    if (seen.has(abs)) return;
    let parsed: URL;
    try {
      parsed = new URL(abs);
    } catch {
      return;
    }
    if (parsed.host !== base.host) return;
    seen.add(abs);
    out.push(abs);
  };

  if (useRss) {
    // <link>https://...</link> from RSS items
    const rss = /<item\b[\s\S]*?<link>([^<]+)<\/link>[\s\S]*?<\/item>/gi;
    let m: RegExpExecArray | null;
    while ((m = rss.exec(body)) != null && out.length < MAX_POST_LINKS_PER_SOURCE) {
      push(m[1].trim());
    }
    // <entry><link href="..."/> from Atom feeds
    const atom = /<entry\b[\s\S]*?<link[^>]+href="([^"]+)"[\s\S]*?<\/entry>/gi;
    while ((m = atom.exec(body)) != null && out.length < MAX_POST_LINKS_PER_SOURCE) {
      push(m[1].trim());
    }
    if (out.length > 0) return out;
    // fall through to HTML extraction if no RSS items matched
  }

  const threadHints = /(\/thread[s]?\/|\/topic[s]?\/|\/posts?\/|\/showthread|\/t\/|\/p\/|\/discussion\/|[?&](t|topic|p|threadid|topicid)=)/i;
  const aTag = /<a\b[^>]*\bhref="([^"]+)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = aTag.exec(body)) != null && out.length < MAX_POST_LINKS_PER_SOURCE) {
    const href = m[1].trim();
    if (!href || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    if (!threadHints.test(href)) continue;
    push(href);
  }

  return out;
}

/**
 * Convenience: fetch the index page (`fetchForumPost` already handles UA,
 * timeout, robots.txt, size cap) and return its post links.
 */
export async function fetchAndExtractPostLinks(
  indexUrl: string,
  kind: "rss" | "html",
): Promise<string[]> {
  const body = await fetchForumPost(indexUrl);
  if (!body) return [];
  // If the index itself looks like a single post (has a long body of prose
  // and no thread links), fall back to treating it as a single post.
  const links = extractPostLinks(body, indexUrl, kind);
  if (links.length > 0) return links;
  return [indexUrl];
}

// ---------------------------------------------------------------------------
// Dedupe — find an existing trail that already covers this name + bbox
// ---------------------------------------------------------------------------
export interface DedupeMatch {
  trailId: string;
  name: string;
  source: string | null;
  ownerUserId: string | null;
  /** True when the existing trail was uploaded by a real member (or a
   *  human-attributed source). Such trails must never be overwritten. */
  isHumanOrMember: boolean;
}

interface DedupeBbox {
  minLat: number | null;
  maxLat: number | null;
  minLng: number | null;
  maxLng: number | null;
}

/**
 * Find an existing trail that overlaps a candidate's bbox AND has a similar
 * name (case-insensitive substring). Returns the best match (member-uploaded
 * trails preferred). The caller should refuse to publish/queue a duplicate
 * and prompt the moderator to merge instead.
 *
 * `supabase` is the service-role client — typed loosely to avoid coupling
 * this lib to the supabase-js generated types.
 */
export async function findExistingTrailMatch(
  supabase: {
    from: (table: string) => {
      select: (cols: string) => {
        ilike: (col: string, val: string) => {
          limit: (n: number) => Promise<{ data: unknown[] | null; error: unknown }>;
        };
      };
    };
  },
  candidate: { name: string | null; bbox: DedupeBbox | null },
): Promise<DedupeMatch | null> {
  const name = (candidate.name ?? "").trim();
  if (name.length < 3) return null;

  // Normalise name: take the most distinctive word(s) for ilike. Strip
  // common filler words so "Black Mountain Pass" matches "the black mtn
  // pass route".
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = normalized.split(" ").filter((w) => w.length > 3 && !STOPWORDS.has(w));
  const probe = (tokens.slice(0, 2).join(" ") || normalized).slice(0, 60);
  if (!probe) return null;

  const { data, error } = await supabase
    .from("trails")
    .select("id, name, source, owner_user_id, bbox_min_lat, bbox_max_lat, bbox_min_lng, bbox_max_lng")
    .ilike("name", `%${probe}%`)
    .limit(20);
  if (error || !data) return null;

  const candBbox = candidate.bbox;
  const matches: DedupeMatch[] = [];
  for (const row of data as Array<{
    id: string;
    name: string;
    source: string | null;
    owner_user_id: string | null;
    bbox_min_lat: number | null;
    bbox_max_lat: number | null;
    bbox_min_lng: number | null;
    bbox_max_lng: number | null;
  }>) {
    if (candBbox && bothBoxesPresent(candBbox, row)) {
      if (!bboxesOverlap(candBbox, row)) continue;
    }
    matches.push({
      trailId: row.id,
      name: row.name,
      source: row.source ?? null,
      ownerUserId: row.owner_user_id ?? null,
      isHumanOrMember:
        Boolean(row.owner_user_id) ||
        row.source == null ||
        row.source === "user" ||
        row.source === "tet" ||
        row.source === "act",
    });
  }

  if (matches.length === 0) return null;
  // Prefer member-uploaded / human-attributed trails on dedupe.
  matches.sort((a, b) => Number(b.isHumanOrMember) - Number(a.isHumanOrMember));
  return matches[0];
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "trail", "trails", "route",
  "track", "lane", "road", "byway", "near", "around", "ride",
]);

function bothBoxesPresent(a: DedupeBbox, b: {
  bbox_min_lat: number | null;
  bbox_max_lat: number | null;
  bbox_min_lng: number | null;
  bbox_max_lng: number | null;
}): boolean {
  return (
    a.minLat != null && a.maxLat != null && a.minLng != null && a.maxLng != null &&
    b.bbox_min_lat != null && b.bbox_max_lat != null && b.bbox_min_lng != null && b.bbox_max_lng != null
  );
}

function bboxesOverlap(a: DedupeBbox, b: {
  bbox_min_lat: number | null;
  bbox_max_lat: number | null;
  bbox_min_lng: number | null;
  bbox_max_lng: number | null;
}): boolean {
  return (
    (a.minLat ?? -90) <= (b.bbox_max_lat ?? 90) &&
    (a.maxLat ?? 90) >= (b.bbox_min_lat ?? -90) &&
    (a.minLng ?? -180) <= (b.bbox_max_lng ?? 180) &&
    (a.maxLng ?? 180) >= (b.bbox_min_lng ?? -180)
  );
}
