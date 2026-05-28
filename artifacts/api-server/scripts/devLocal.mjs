import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiServerDir = path.resolve(scriptDir, "..");
const envPath = path.join(apiServerDir, ".env.local");

function applyDotEnvFile(filePath) {
  if (!existsSync(filePath)) {
    console.warn(`[dev:local] ${filePath} not found. Continuing without it.`);
    return;
  }
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  console.log(`[dev:local] Loaded env from ${filePath}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: apiServerDir,
    env: process.env,
    stdio: "inherit",
  });
  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
  if (result.error) {
    throw result.error;
  }
}

const pnpmExec = process.env.npm_execpath;
if (pnpmExec && pnpmExec.endsWith(".mjs")) {
  run(process.execPath, [pnpmExec, "run", "build"]);
} else {
  run("pnpm", ["run", "build"]);
}
applyDotEnvFile(envPath);

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "development";
}
if (!process.env.SKIP_SCHEMA_PREFLIGHT) {
  process.env.SKIP_SCHEMA_PREFLIGHT = "true";
}

const hasSupabaseEnv =
  Boolean(process.env.SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log(
  `[dev:local] Supabase env ready: ${hasSupabaseEnv ? "yes" : "no"}`
);

run(process.execPath, ["--enable-source-maps", "./dist/index.mjs"]);
