import { clerkSetup } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The "+clerk_test" address pattern is recognised by Clerk in development as a
// test fixture: the static verification code "424242" satisfies the email_code
// factor, which lets us drive the password + email_code MFA flow this instance
// is configured for without ever needing a real inbox.
export const E2E_USER_EMAIL =
  process.env.E2E_USER_EMAIL ?? "trailforge-e2e+clerk_test@example.com";
export const E2E_USER_VERIFICATION_CODE = "424242";
export const E2E_USER_PASSWORD =
  process.env.E2E_USER_PASSWORD ?? "Trailforge-E2E-Pwd-2026!";

const STATE_FILE = path.join(__dirname, ".e2e-state.json");

export interface E2EState {
  userId: string;
  trailId: string;
  email: string;
}

function readState(): E2EState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as E2EState;
  } catch {
    return null;
  }
}

function writeState(state: E2EState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function ensureClerkUser(email: string, password: string): Promise<string> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY is required for e2e tests");
  }
  const clerk = createClerkClient({ secretKey });

  // Look up by email first — createUser would 422 on a duplicate.
  const existing = await clerk.users.getUserList({ emailAddress: [email] });
  if (existing.data.length > 0) {
    return existing.data[0]!.id;
  }

  const created = await clerk.users.createUser({
    emailAddress: [email],
    password,
    firstName: "Trail",
    lastName: "Tester",
    skipPasswordChecks: true,
  });
  return created.id;
}

async function ensureSupabaseUser(
  userId: string,
  email: string,
): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for e2e tests",
    );
  }
  const supa = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supa
    .from("users")
    .upsert(
      {
        id: userId,
        email,
        display_name: "Trail Tester",
      },
      { onConflict: "id" },
    );
  if (error) {
    throw new Error(`Failed to upsert e2e user row: ${error.message}`);
  }
}

async function ensureTrail(ownerUserId: string): Promise<string> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for e2e tests",
    );
  }
  const supa = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Reuse a previously-seeded e2e trail if it still exists. We tag it via the
  // (deterministic) name so reruns are idempotent without needing migrations.
  const tag = "[e2e] trail-detail flow";
  const { data: existing } = await supa
    .from("trails")
    .select("id")
    .eq("name", tag)
    .eq("owner_user_id", ownerUserId)
    .is("deleted_at", null)
    .limit(1);
  if (existing && existing.length > 0) {
    return existing[0]!.id as string;
  }

  const insert = {
    name: tag,
    type: "green-lane",
    difficulty: 5,
    distance_km: 12.5,
    terrain: "dirt",
    legal_status: "BOAT",
    is_public: true,
    owner_user_id: ownerUserId,
    source: "user",
    verification_status: "verified",
  };
  const { data, error } = await supa
    .from("trails")
    .insert(insert)
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`Failed to seed e2e trail: ${error?.message ?? "no data"}`);
  }
  return data.id as string;
}

async function cleanupContent(trailId: string): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const supa = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Best-effort: remove any notes/amendments left over from earlier runs so
  // the count assertions start from zero.
  await supa.from("trail_notes").delete().eq("trail_id", trailId);
  await supa.from("trail_amendments").delete().eq("trail_id", trailId);
}

export default async function globalSetup(): Promise<void> {
  // Validates the publishable + secret key envs and primes the testing-token
  // mechanism so signed-in pages aren't gated by Clerk's bot detection.
  await clerkSetup({
    publishableKey:
      process.env.VITE_CLERK_PUBLISHABLE_KEY ??
      process.env.CLERK_PUBLISHABLE_KEY,
  });

  const userId = await ensureClerkUser(E2E_USER_EMAIL, E2E_USER_PASSWORD);
  await ensureSupabaseUser(userId, E2E_USER_EMAIL);
  const trailId = await ensureTrail(userId);
  await cleanupContent(trailId);

  const state: E2EState = { userId, trailId, email: E2E_USER_EMAIL };
  writeState(state);
}

export function loadE2EState(): E2EState {
  const state = readState();
  if (!state) {
    throw new Error(
      "e2e state file missing — global-setup did not run successfully",
    );
  }
  return state;
}
