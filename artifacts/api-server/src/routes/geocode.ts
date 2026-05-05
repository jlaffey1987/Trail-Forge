/**
 * Geocoding proxy. Mobile clients route through here so we control the
 * Nominatim User-Agent and rate-limiting from the server, instead of
 * exposing on-device IPs to the OSM service. Both `/search` and `/reverse`
 * mirror the Nominatim params the web planner already uses.
 */
import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";

const router: IRouter = Router();

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT = "TrailForge/1.0 (https://trailforge.app)";

router.get("/geocode/search", async (req, res) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.json({ results: [] });
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit ?? 5) || 5, 1), 10);
  const url =
    `${NOMINATIM_BASE}/search?format=jsonv2&limit=${limit}` +
    `&q=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
    if (!r.ok) {
      res.status(502).json({ error: "Geocoder unavailable", results: [] });
      return;
    }
    const json = (await r.json()) as Array<Record<string, unknown>>;
    res.json({ results: json });
  } catch (err) {
    req.log?.warn?.({ err }, "geocode/search failed");
    res.status(502).json({ error: "Geocoder unreachable", results: [] });
  }
});

router.get("/geocode/reverse", async (req, res) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: "Bad lat/lon" });
    return;
  }
  const url =
    `${NOMINATIM_BASE}/reverse?format=jsonv2` +
    `&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;
  try {
    const r = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
    if (!r.ok) {
      res.status(502).json({ error: "Geocoder unavailable" });
      return;
    }
    const json = await r.json();
    res.json(json);
  } catch (err) {
    req.log?.warn?.({ err }, "geocode/reverse failed");
    res.status(502).json({ error: "Geocoder unreachable" });
  }
});

export default router;
