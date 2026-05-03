#!/usr/bin/env tsx
/**
 * Asset-size budget check for the TrailForge launch intro and loading-backdrop media.
 *
 * Why this exists:
 *   The cinematic intro (intro.mp4 / intro.webm / intro-poster.jpg) and the
 *   ride-photo loading backdrops (ride*.jpg) are served on first launch, often
 *   over slow / metered connections. They were hand-trimmed in task #72 to fit
 *   comfortably under ~1 MB combined. Without a guard, the next person can
 *   silently drop a 6 MB hero photo into `artifacts/trailforge/public/` and
 *   regress first-launch performance.
 *
 * What it does:
 *   Checks each budgeted intro file by name, then discovers every `ride*.jpg`
 *   in the public folder so newly added ride backdrops can't bypass the guard
 *   just by inventing a new filename. Sums everything, prints a per-file
 *   table, and exits non-zero if any per-file or aggregate budget is
 *   exceeded. Run as part of `pnpm --filter @workspace/trailforge build`
 *   (wired up via the `prebuild` script) and available standalone as
 *   `pnpm --filter @workspace/scripts run check:trailforge-assets`.
 *
 * Adjusting the budgets:
 *   The numbers below are intentional. Raise them in a code change (with a
 *   note in the PR) rather than by accident — that is the whole point of the
 *   guardrail. Keep the totals in line with what feels OK on a 3G-class
 *   connection on first paint.
 */
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const KB = 1024;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC_DIR = join(REPO_ROOT, "artifacts", "trailforge", "public");

type Budget = {
  /** Path relative to artifacts/trailforge/public/ */
  file: string;
  /** Maximum allowed size in bytes for this individual file. */
  maxBytes: number;
};

// Per-file budgets for the intro media. These are addressed by name because
// the app references them directly.
const INTRO_BUDGETS: Budget[] = [
  { file: "intro.mp4", maxBytes: 600 * KB },
  { file: "intro.webm", maxBytes: 600 * KB },
  { file: "intro-poster.jpg", maxBytes: 80 * KB },
];

// Per-file cap that applies to every `ride*.jpg` we discover. 200 KB
// comfortably fits a tuned 1280-wide JPEG; tighter sizes (e.g. -640) are
// also well under it.
const RIDE_PER_FILE_BUDGET_BYTES = 200 * KB;
const RIDE_FILE_PATTERN = /^ride.*\.jpe?g$/i;

// Combined budget across every file checked. Keep at ~1 MB so first launch
// over a slow / metered connection stays snappy.
const TOTAL_BUDGET_BYTES = 1024 * KB;

function fmt(bytes: number): string {
  return `${(bytes / KB).toFixed(1)} KB`;
}

function discoverRideAssets(): Budget[] {
  let entries: string[];
  try {
    entries = readdirSync(PUBLIC_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((name) => RIDE_FILE_PATTERN.test(name))
    .sort()
    .map((file) => ({ file, maxBytes: RIDE_PER_FILE_BUDGET_BYTES }));
}

function main(): void {
  const failures: string[] = [];
  let total = 0;

  const rideBudgets = discoverRideAssets();
  if (rideBudgets.length === 0) {
    failures.push(
      `No ride*.jpg loading backdrops were found in ${relative(REPO_ROOT, PUBLIC_DIR)}. The check expects at least one to exist so the budget can be enforced.`,
    );
  }

  const allBudgets: Budget[] = [...INTRO_BUDGETS, ...rideBudgets];

  for (const { file, maxBytes } of allBudgets) {
    const abs = join(PUBLIC_DIR, file);
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      failures.push(
        `Missing budgeted asset: ${relative(REPO_ROOT, abs)} (expected to exist so the budget can be enforced).`,
      );
      continue;
    }
    total += size;
    const status = size <= maxBytes ? "ok" : "OVER";
    // eslint-disable-next-line no-console
    console.log(
      `  [${status}] ${file.padEnd(20)} ${fmt(size).padStart(10)} / ${fmt(maxBytes).padStart(10)}`,
    );
    if (size > maxBytes) {
      failures.push(
        `${file} is ${fmt(size)}, over its ${fmt(maxBytes)} budget. Re-encode / re-compress, or raise the budget intentionally in scripts/src/checkTrailforgeAssetBudget.ts.`,
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `  ----------------------------------------------------------\n` +
      `  total                ${fmt(total).padStart(10)} / ${fmt(TOTAL_BUDGET_BYTES).padStart(10)}`,
  );

  if (total > TOTAL_BUDGET_BYTES) {
    failures.push(
      `Combined intro + ride asset size is ${fmt(total)}, over the ${fmt(TOTAL_BUDGET_BYTES)} total budget. Trim assets or raise the budget intentionally in scripts/src/checkTrailforgeAssetBudget.ts.`,
    );
  }

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\nTrailForge asset budget check failed:\n` +
        failures.map((m) => `  - ${m}`).join("\n"),
    );
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log("\nTrailForge asset budget check passed.");
}

main();
