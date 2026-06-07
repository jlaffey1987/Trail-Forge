import * as fs from "node:fs";
import { XMLParser } from "fast-xml-parser";

import { type TrackPoint } from "./geometry.js";

export interface KmlPlacemark {
  name: string;
  folderPath: string[];
  linePoints: TrackPoint[] | null;
  isPoint: boolean;
}

const EXCLUDE_FOLDER = /county boundaries|pins|TrailVid|One minute/i;
const TRAIL_FOLDER = /TNT.*trails|TNT - checked/i;

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function textVal(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && v !== null && "#text" in v) {
    return String((v as Record<string, unknown>)["#text"] ?? "");
  }
  return String(v);
}

export function parseCoordinates(raw: string): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    if (!token) continue;
    const parts = token.split(",").map((s) => s.trim());
    if (parts.length < 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    const ele = parts.length >= 3 ? Number(parts[2]) : undefined;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      lat,
      lon,
      ele: Number.isFinite(ele) ? ele : undefined,
    });
  }
  return out;
}

function parsePlacemark(node: Record<string, unknown>, folderPath: string[]): KmlPlacemark {
  const name = textVal(node.name) || "Unnamed";
  const line = node.LineString as Record<string, unknown> | undefined;
  const point = node.Point as Record<string, unknown> | undefined;
  let linePoints: TrackPoint[] | null = null;
  if (line?.coordinates != null) {
    linePoints = parseCoordinates(textVal(line.coordinates));
    if (linePoints.length < 2) linePoints = null;
  }
  return {
    name,
    folderPath,
    linePoints,
    isPoint: point != null && linePoints == null,
  };
}

function walkNode(node: Record<string, unknown>, folderPath: string[]): KmlPlacemark[] {
  const out: KmlPlacemark[] = [];
  for (const pm of asArray(node.Placemark as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    out.push(parsePlacemark(pm, folderPath));
  }
  for (const folder of asArray(node.Folder as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    const fname = textVal(folder.name);
    out.push(...walkNode(folder, [...folderPath, fname]));
  }
  return out;
}

export function parseKmlFile(filePath: string): KmlPlacemark[] {
  const xml = fs.readFileSync(filePath, "utf8");
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    trimValues: true,
    isArray: (name) => ["Placemark", "Folder"].includes(name),
  });
  const doc = parser.parse(xml) as Record<string, unknown>;
  const kml = doc.kml as Record<string, unknown> | undefined;
  const document = (kml?.Document ?? kml) as Record<string, unknown> | undefined;
  if (!document) {
    throw new Error("Invalid KML — no Document element found");
  }
  return walkNode(document, []);
}

export function selectRoutePoints(placemarks: KmlPlacemark[]): {
  points: TrackPoint[];
  source: "master" | "trail-folders";
} {
  const master = placemarks.find(
    (p) => p.linePoints && p.name.toLowerCase().includes("master copy"),
  );
  if (master?.linePoints && master.linePoints.length >= 2) {
    return { points: master.linePoints, source: "master" };
  }

  const lines = placemarks.filter((p) => {
    if (!p.linePoints || p.linePoints.length < 2) return false;
    if (p.folderPath.some((f) => EXCLUDE_FOLDER.test(f))) return false;
    return p.folderPath.some((f) => TRAIL_FOLDER.test(f));
  });

  const points: TrackPoint[] = [];
  for (const line of lines) {
    points.push(...line.linePoints!);
  }
  if (points.length < 2) {
    throw new Error(
      "No route LineString found — expected Master Copy line or TNT trail folders",
    );
  }
  return { points, source: "trail-folders" };
}

export function summarizePlacemarks(placemarks: KmlPlacemark[]): {
  total: number;
  lineStrings: number;
  points: number;
} {
  const lineStrings = placemarks.filter((p) => p.linePoints != null).length;
  const points = placemarks.filter((p) => p.isPoint).length;
  return { total: placemarks.length, lineStrings, points };
}
