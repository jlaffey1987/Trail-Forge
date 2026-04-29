#!/usr/bin/env tsx
/**
 * One-step Supabase migration runner for TrailForge.
 *
 * Replaces the old "paste the SQL into the Supabase editor and update
 * APPLIED.md by hand" flow. Applies a single migration file (or all
 * pending migrations) inside one psql `--single-transaction
 * -v ON_ERROR_STOP=1` invocation, and records the result in a
 * `schema_migrations(filename text PK, applied_at timestamptz)` ledger
 * table on the live database so the script can refuse to re-run an
 * already-applied migration.
 *
 * Usage:
 *   pnpm --filter @workspace/trailforge run db:migrate <file>     # apply one
 *   pnpm --filter @workspace/trailforge run db:migrate --all      # apply all pending
 *   pnpm --filter @workspace/trailforge run db:migrate --status   # show applied vs. pending
 *   pnpm --filter @workspace/trailforge run db:migrate <file> --force   # re-apply
 *   pnpm --filter @workspace/trailforge run db:migrate <file> --dry-run # print URL/file, do nothing
 *
 * Connection lookup (in order):
 *   1. SUPABASE_DB_URL                   — full postgres:// URL, used as-is.
 *   2. SUPABASE_DB_PASSWORD (+ SUPABASE_URL or SUPABASE_DB_HOST/SUPABASE_DB_REGION)
 *      — the URL is built from the project ref and the eu-west-2 session pooler
 *      by default. Override host/region/port via SUPABASE_DB_HOST / SUPABASE_DB_REGION
 *      / SUPABASE_DB_PORT if your project lives in a different AWS region.
 *
 * The script always uses psql's session pooler endpoint (port 5432) because
 * the direct `db.<ref>.supabase.co` host is IPv6-only and not reachable from
 * the Replit container.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "..", "supabase", "migrations");

interface Args {
  file?: string;
  all: boolean;
  status: boolean;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, status: false, force: false, dryRun: false };
  for (const a of argv) {
    if (a === "--all") args.all = true;
    else if (a === "--status" || a === "--list") args.status = true;
    else if (a === "--force") args.force = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if (a.startsWith("--")) {
      die(`Unknown flag: ${a}. Run with --help.`);
    } else if (!args.file) {
      args.file = a;
    } else {
      die(`Unexpected positional argument: ${a}`);
    }
  }
  if (!args.file && !args.all && !args.status) {
    printHelp();
    process.exit(1);
  }
  return args;
}

function printHelp(): void {
  console.log(`Apply Supabase migrations to the live TrailForge project.

Usage:
  db:migrate <file>            Apply one migration (basename or path).
  db:migrate --all             Apply every pending migration in order.
  db:migrate --status          Show applied vs pending migrations and exit.

Flags:
  --force      Re-apply a migration even if the ledger says it is applied.
  --dry-run    Resolve connection + file, but do not connect or run SQL.
  --help       Show this help.

Environment:
  SUPABASE_DB_URL        Full postgres:// URL (overrides everything else).
  SUPABASE_DB_PASSWORD   Database password (used with SUPABASE_URL to build URL).
  SUPABASE_URL           Used to derive the project ref (e.g. https://<ref>.supabase.co).
  SUPABASE_DB_HOST       Override pooler host (default aws-1-<region>.pooler.supabase.com).
  SUPABASE_DB_REGION     Default: eu-west-2.
  SUPABASE_DB_PORT       Default: 5432 (session pooler).`);
}

function die(message: string): never {
  console.error(`db-migrate: ${message}`);
  process.exit(1);
}

function buildConnectionString(): { url: string; redacted: string } {
  const direct = process.env.SUPABASE_DB_URL;
  if (direct) {
    return { url: direct, redacted: redact(direct) };
  }
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!password) {
    die(
      "No connection info: set SUPABASE_DB_URL, or SUPABASE_DB_PASSWORD plus SUPABASE_URL.",
    );
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    die("SUPABASE_URL is required to derive the project ref when SUPABASE_DB_URL is not set.");
  }
  const ref = projectRefFromUrl(supabaseUrl);
  if (!ref) die(`Could not parse a project ref out of SUPABASE_URL=${supabaseUrl}`);
  const region = process.env.SUPABASE_DB_REGION ?? "eu-west-2";
  const host = process.env.SUPABASE_DB_HOST ?? `aws-1-${region}.pooler.supabase.com`;
  const port = process.env.SUPABASE_DB_PORT ?? "5432";
  const user = `postgres.${ref}`;
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/postgres`;
  return { url, redacted: `postgresql://${user}:***@${host}:${port}/postgres` };
}

function projectRefFromUrl(supabaseUrl: string): string | null {
  try {
    const u = new URL(supabaseUrl);
    const m = u.host.match(/^([^.]+)\.supabase\.co$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function redact(connStr: string): string {
  return connStr.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");
}

function listMigrationFiles(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    die(`Migrations dir not found: ${MIGRATIONS_DIR}`);
  }
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function resolveMigration(arg: string): string {
  const candidates = [arg, basename(arg), `${arg}.sql`, `${basename(arg)}.sql`];
  for (const c of candidates) {
    const full = c.includes("/") ? resolve(c) : join(MIGRATIONS_DIR, c);
    if (existsSync(full) && full.endsWith(".sql")) return full;
  }
  die(
    `Migration file not found: ${arg}. Looked in ${MIGRATIONS_DIR}. Available:\n  ${listMigrationFiles().join("\n  ")}`,
  );
}

interface PsqlResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runPsql(url: string, args: string[], opts: { stdin?: string } = {}): PsqlResult {
  const result = spawnSync("psql", [url, "-X", "-q", ...args], {
    input: opts.stdin,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) die(`psql failed to start: ${result.error.message}`);
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function ensureLedger(url: string): void {
  // The ledger lives in the public schema (so we can manage it with normal
  // SQL through the Supabase pooler), but we lock it down with RLS so the
  // anon and authenticated keys can never see or change it. Only the
  // service-role / direct DB connections (which is what this script uses)
  // can read or write.
  const sql = `CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schema_migrations_no_anon ON public.schema_migrations;
CREATE POLICY schema_migrations_no_anon ON public.schema_migrations
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);`;
  const r = runPsql(url, ["-v", "ON_ERROR_STOP=1", "-c", sql]);
  if (r.status !== 0) {
    process.stderr.write(r.stderr);
    die("Failed to create schema_migrations ledger table.");
  }
}

function fetchAppliedSet(url: string): Set<string> {
  const r = runPsql(url, [
    "-v",
    "ON_ERROR_STOP=1",
    "-tAc",
    "SELECT filename FROM public.schema_migrations ORDER BY filename;",
  ]);
  if (r.status !== 0) {
    process.stderr.write(r.stderr);
    die("Failed to read schema_migrations ledger.");
  }
  return new Set(
    r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function applyOne(url: string, file: string, force: boolean): void {
  const fname = basename(file);
  const applied = fetchAppliedSet(url);
  if (applied.has(fname) && !force) {
    console.log(`✓ ${fname}: already applied (use --force to re-run).`);
    return;
  }

  const sql = readFileSync(file, "utf8");
  // Build a temp file with the migration body followed by a ledger UPSERT.
  // psql --single-transaction wraps everything in BEGIN/COMMIT so the
  // ledger row is only persisted if the migration itself succeeds.
  const tmp = mkdtempSync(join(tmpdir(), "trailforge-migrate-"));
  const sqlPath = join(tmp, fname);
  const wrapped = `${sql}\n\n-- recorded by db:migrate --\nINSERT INTO public.schema_migrations (filename, applied_at)\nVALUES (${quote(fname)}, now())\nON CONFLICT (filename) DO UPDATE SET applied_at = excluded.applied_at;\n`;
  writeFileSync(sqlPath, wrapped);

  const action = applied.has(fname) ? "Re-applying" : "Applying";
  console.log(`→ ${action} ${fname} ...`);
  try {
    const r = runPsql(url, ["--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", sqlPath]);
    if (r.stdout.trim()) process.stdout.write(r.stdout);
    if (r.status !== 0) {
      if (r.stderr.trim()) process.stderr.write(r.stderr);
      die(`${fname} failed (psql exit ${r.status}). The transaction was rolled back; ledger unchanged.`);
    }
    if (r.stderr.trim()) process.stderr.write(r.stderr);
    console.log(`✓ ${fname}: applied and recorded in schema_migrations.`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function showStatus(url: string): void {
  const applied = fetchAppliedSet(url);
  const all = listMigrationFiles();
  const known = new Set(all);
  console.log(`Migrations directory: ${MIGRATIONS_DIR}`);
  console.log(`Ledger entries:        ${applied.size}`);
  console.log("");
  for (const f of all) {
    console.log(`  ${applied.has(f) ? "[x]" : "[ ]"} ${f}`);
  }
  const orphaned = [...applied].filter((f) => !known.has(f));
  if (orphaned.length) {
    console.log("\nLedger entries with no matching file (consider archiving):");
    for (const f of orphaned) console.log(`  [?] ${f}`);
  }
  const pending = all.filter((f) => !applied.has(f));
  console.log(`\nPending: ${pending.length}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const conn = buildConnectionString();
  console.log(`db-migrate: connecting to ${conn.redacted}`);

  if (args.dryRun) {
    if (args.file) {
      const f = resolveMigration(args.file);
      console.log(`db-migrate: dry-run — would apply ${f}`);
    } else if (args.all) {
      console.log("db-migrate: dry-run — would apply every pending migration in order");
    } else if (args.status) {
      console.log("db-migrate: dry-run — would print ledger status");
    }
    return;
  }

  ensureLedger(conn.url);

  if (args.status) {
    showStatus(conn.url);
    return;
  }

  if (args.all) {
    const files = listMigrationFiles();
    let appliedCount = 0;
    let skipped = 0;
    const before = fetchAppliedSet(conn.url);
    for (const f of files) {
      if (before.has(f) && !args.force) {
        console.log(`✓ ${f}: already applied (skipping; use --force to re-run all).`);
        skipped += 1;
        continue;
      }
      applyOne(conn.url, join(MIGRATIONS_DIR, f), args.force);
      appliedCount += 1;
    }
    console.log(`\nDone. Applied ${appliedCount}, skipped ${skipped}.`);
    return;
  }

  if (args.file) {
    applyOne(conn.url, resolveMigration(args.file), args.force);
  }
}

main();
