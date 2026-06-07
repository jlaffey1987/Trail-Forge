import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`❌ Missing environment variable: ${key}`);
    console.error("   Set it in artifacts/api-server/.env.local");
    process.exit(1);
  }
  return val;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function assertServiceRoleKey(key: string): void {
  if (key.startsWith("sb_secret_") || key.startsWith("sbp_")) {
    console.log("✅ Key type: service_role secret (RLS bypass confirmed)");
    return;
  }
  const payload = decodeJwtPayload(key);
  if (!payload) {
    console.warn("⚠️  SUPABASE_SERVICE_ROLE_KEY format not recognised — proceeding.");
    return;
  }
  if (payload["role"] === "anon") {
    console.error("❌ SUPABASE_SERVICE_ROLE_KEY is an anon key — use service_role.");
    process.exit(1);
  }
  if (payload["role"] === "service_role") {
    console.log("✅ Key type: service_role (RLS bypass confirmed)");
  }
}

export function loadEnvLocal(): void {
  const candidates = [
    path.join(process.cwd(), ".env.local"),
    path.join(process.cwd(), "artifacts", "api-server", ".env.local"),
    path.join(__dirname, "..", "..", "..", ".env.local"),
    path.join(__dirname, "..", "..", "..", "artifacts", "api-server", ".env.local"),
  ];
  let loaded = false;
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
    console.log(`✅ Loaded env from: ${envPath}`);
    loaded = true;
  }
  if (!loaded) console.warn("⚠️  No .env.local found — using environment variables only.");
}
