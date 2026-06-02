/**
 * Startup diagnostic checks — called once when the app mounts.
 *
 * Logs to console:
 *   - API base URL being used (and how it was resolved)
 *   - Clerk publishable key prefix (identifies which environment/instance)
 *   - Whether the API server is reachable (/api/health ping)
 *   - Whether Supabase is reachable (anon key present + URL set)
 *
 * This makes it trivial to diagnose connection failures on any device.
 * Only logs in __DEV__ mode; silent in production.
 */

import { apiBaseUrl } from "./api";

// ── Helpers ───────────────────────────────────────────────────────────────────

function maskKey(key: string): string {
  if (!key || key.length < 12) return "(not set)";
  return `${key.slice(0, 12)}…`;
}

async function pingUrl(url: string, timeoutMs = 5000): Promise<{ ok: boolean; status?: number; errorMsg?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, method: "GET" });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, errorMsg: e instanceof Error ? e.message : String(e) };
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runStartupChecks(): Promise<void> {
  if (!__DEV__) return;

  console.log("┌─────────────────────────────────────────");
  console.log("│ TrailForge Startup Diagnostics");
  console.log("├─────────────────────────────────────────");

  // ── API URL ────────────────────────────────────────────────────────────────
  let resolvedBase = "(error resolving)";
  let resolvedHow  = "";
  try {
    resolvedBase = apiBaseUrl();

    const explicit = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
    if (explicit) {
      resolvedHow = "from EXPO_PUBLIC_API_BASE_URL";
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Constants = require("expo-constants").default as {
          expoGoConfig?: { debuggerHost?: string };
          manifest?:     { debuggerHost?: string };
          expoConfig?:   { hostUri?: string };
        };
        const rawHost =
          Constants.expoGoConfig?.debuggerHost
          ?? (Constants.manifest as { debuggerHost?: string } | null)?.debuggerHost
          ?? Constants.expoConfig?.hostUri;
        resolvedHow = rawHost
          ? `derived from Expo manifest hostUri (${rawHost})`
          : "from EXPO_PUBLIC_DOMAIN";
      } catch {
        resolvedHow = "from EXPO_PUBLIC_DOMAIN";
      }
    }
  } catch (e) {
    resolvedBase = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
  console.log(`│ API URL   : ${resolvedBase}`);
  console.log(`│           : ${resolvedHow}`);

  // ── Clerk ──────────────────────────────────────────────────────────────────
  const clerkKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
  const clerkEnv = clerkKey.includes("_live_") ? "PRODUCTION"
    : clerkKey.includes("_test_") ? "DEVELOPMENT"
    : clerkKey ? "UNKNOWN"
    : "NOT SET";
  console.log(`│ Clerk key : ${maskKey(clerkKey)} [${clerkEnv}]`);

  // ── Supabase ───────────────────────────────────────────────────────────────
  const supabaseUrl  = process.env.EXPO_PUBLIC_SUPABASE_URL  ?? process.env.SUPABASE_URL  ?? "";
  const supabaseAnon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
  console.log(`│ Supabase  : ${supabaseUrl || "(not set)"}`);
  console.log(`│ Supa key  : ${maskKey(supabaseAnon)}`);

  console.log("├─────────────────────────────────────────");
  console.log("│ Pinging services…");

  // ── API health ping ────────────────────────────────────────────────────────
  if (resolvedBase && !resolvedBase.startsWith("ERROR")) {
    const healthUrl = `${resolvedBase}/api/health`;
    const apiResult = await pingUrl(healthUrl, 5000);
    if (apiResult.ok) {
      console.log(`│ API health: ✅ ${healthUrl} → HTTP ${apiResult.status}`);
    } else if (apiResult.status) {
      console.log(`│ API health: ⚠️  ${healthUrl} → HTTP ${apiResult.status}`);
    } else {
      console.log(`│ API health: ❌ ${healthUrl} → ${apiResult.errorMsg}`);
      console.log(`│           : Is the API server running on port 8080?`);
    }
  } else {
    console.log("│ API health: ⏭  Skipped (no URL)");
  }

  // ── Supabase reachability ──────────────────────────────────────────────────
  if (supabaseUrl) {
    const supaResult = await pingUrl(`${supabaseUrl}/rest/v1/`, 5000);
    if (supaResult.ok || supaResult.status === 401) {
      // 401 is fine — it means the server is up but needs a key
      console.log(`│ Supabase  : ✅ reachable (HTTP ${supaResult.status})`);
    } else if (supaResult.status) {
      console.log(`│ Supabase  : ⚠️  HTTP ${supaResult.status}`);
    } else {
      console.log(`│ Supabase  : ❌ ${supaResult.errorMsg}`);
    }
  } else {
    console.log("│ Supabase  : ⏭  Skipped (EXPO_PUBLIC_SUPABASE_URL not set)");
  }

  console.log("└─────────────────────────────────────────");
}
