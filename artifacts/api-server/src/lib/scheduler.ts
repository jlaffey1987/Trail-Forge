import { logger } from "./logger";
import { runForumScan, runGradeBackfill, runScanSkipRetry } from "../routes/ai";

/**
 * Background scheduler for AI discovery jobs (forum scan + grade backfill).
 *
 * Configuration (env):
 *   AI_SCAN_ENABLED            "true" to enable the scheduler. Default: off.
 *   AI_SCAN_INTERVAL_MS        Forum scan cadence. Default: 24h.
 *   AI_BACKFILL_INTERVAL_MS    Grade backfill cadence. Default: 1h.
 *   AI_SKIP_RETRY_INTERVAL_MS  Cadence for retrying pending ai_scan_skips
 *                              rows so they auto-resolve as OSM coverage
 *                              improves. Default: 7d.
 *   AI_SKIP_RETRY_LIMIT        Max skip rows to re-attempt per pass.
 *                              Default: 50.
 *   AI_SCAN_INITIAL_DELAY_MS   Wait this long after boot before the first
 *                              scan, so app startup isn't blocked by remote
 *                              fetches. Default: 60s.
 *
 * The scheduler is intentionally conservative: each job is self-bounded
 * (max URLs, max posts, max trails per pass), and a "running" guard
 * prevents overlapping invocations when a previous scan is still in
 * flight.
 */

const ENABLED = String(process.env["AI_SCAN_ENABLED"] ?? "").toLowerCase() === "true";
const SCAN_INTERVAL_MS = Number(process.env["AI_SCAN_INTERVAL_MS"]) || 24 * 60 * 60 * 1000;
const BACKFILL_INTERVAL_MS = Number(process.env["AI_BACKFILL_INTERVAL_MS"]) || 60 * 60 * 1000;
const SKIP_RETRY_INTERVAL_MS =
  Number(process.env["AI_SKIP_RETRY_INTERVAL_MS"]) || 7 * 24 * 60 * 60 * 1000;
const SKIP_RETRY_LIMIT = Number(process.env["AI_SKIP_RETRY_LIMIT"]) || 50;
const INITIAL_DELAY_MS = Number(process.env["AI_SCAN_INITIAL_DELAY_MS"]) || 60_000;

let scanTimer: NodeJS.Timeout | null = null;
let backfillTimer: NodeJS.Timeout | null = null;
let skipRetryTimer: NodeJS.Timeout | null = null;
let scanRunning = false;
let backfillRunning = false;
let skipRetryRunning = false;

async function safeScan(): Promise<void> {
  if (scanRunning) {
    logger.info("forum-scan already running; skip");
    return;
  }
  scanRunning = true;
  const started = Date.now();
  try {
    const result = await runForumScan();
    logger.info(
      {
        durationMs: Date.now() - started,
        scanned: result.scanned,
        visitedPosts: result.visitedPosts,
        queued: result.queued,
        skipped: result.skipped,
        errorCount: result.errors.length,
      },
      "scheduled forum-scan complete",
    );
  } catch (err) {
    logger.error({ err }, "scheduled forum-scan failed");
  } finally {
    scanRunning = false;
  }
}

async function safeBackfill(): Promise<void> {
  if (backfillRunning) {
    logger.info("grade-backfill already running; skip");
    return;
  }
  backfillRunning = true;
  const started = Date.now();
  try {
    const result = await runGradeBackfill({ limit: 20 });
    logger.info(
      {
        durationMs: Date.now() - started,
        scanned: result.scanned,
        graded: result.graded,
        failed: result.failed,
        note: result.note,
      },
      "scheduled grade-backfill complete",
    );
  } catch (err) {
    logger.error({ err }, "scheduled grade-backfill failed");
  } finally {
    backfillRunning = false;
  }
}

async function safeSkipRetry(): Promise<void> {
  if (skipRetryRunning) {
    logger.info("scan-skip-retry already running; skip");
    return;
  }
  skipRetryRunning = true;
  const started = Date.now();
  try {
    const result = await runScanSkipRetry({ limit: SKIP_RETRY_LIMIT });
    logger.info(
      {
        durationMs: Date.now() - started,
        scanned: result.scanned,
        resolved: result.resolved,
        stillSkipped: result.stillSkipped,
        errorCount: result.errors.length,
        note: result.note,
      },
      "scheduled scan-skip-retry complete",
    );
  } catch (err) {
    logger.error({ err }, "scheduled scan-skip-retry failed");
  } finally {
    skipRetryRunning = false;
  }
}

export function startAiScheduler(): void {
  if (!ENABLED) {
    logger.info(
      "AI scheduler disabled (set AI_SCAN_ENABLED=true to enable). Forum scan, grade backfill, and scan-skip retry remain available via /api/admin/* endpoints.",
    );
    return;
  }
  if (scanTimer || backfillTimer || skipRetryTimer) {
    logger.warn("AI scheduler already started; ignoring duplicate startAiScheduler() call");
    return;
  }
  logger.info(
    {
      scanIntervalMs: SCAN_INTERVAL_MS,
      backfillIntervalMs: BACKFILL_INTERVAL_MS,
      skipRetryIntervalMs: SKIP_RETRY_INTERVAL_MS,
      skipRetryLimit: SKIP_RETRY_LIMIT,
      initialDelayMs: INITIAL_DELAY_MS,
    },
    "AI scheduler enabled",
  );
  setTimeout(() => {
    void safeBackfill();
    backfillTimer = setInterval(() => void safeBackfill(), BACKFILL_INTERVAL_MS);
    void safeScan();
    scanTimer = setInterval(() => void safeScan(), SCAN_INTERVAL_MS);
    // Don't fire the skip-retry on boot; it's the slowest of the three jobs
    // (one HTTP fetch per pending row, plus optional OSM snap + AI grade).
    // Wait the configured interval before the first run.
    skipRetryTimer = setInterval(() => void safeSkipRetry(), SKIP_RETRY_INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}

export function stopAiScheduler(): void {
  if (scanTimer) clearInterval(scanTimer);
  if (backfillTimer) clearInterval(backfillTimer);
  if (skipRetryTimer) clearInterval(skipRetryTimer);
  scanTimer = null;
  backfillTimer = null;
  skipRetryTimer = null;
}
