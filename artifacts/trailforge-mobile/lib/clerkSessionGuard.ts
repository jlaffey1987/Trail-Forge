/**
 * Detect and recover from Clerk instance mismatches.
 *
 * When EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY changes (e.g. switching Clerk apps),
 * SecureStore may still hold a session JWT signed by the old instance. The API
 * server rejects it with a JWKS kid mismatch — not a token-format problem.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const CLERK_PK_STORAGE_KEY = "@trailforge/clerk_publishable_key";

/** Decode the Clerk frontend slug from a publishable key, e.g. "poetic-husky-31". */
export function clerkSlugFromPublishableKey(pk: string): string | null {
  const m = pk.match(/^pk_(?:test|live)_(.+)$/);
  if (!m) return null;
  try {
    const decoded = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    return decoded.split(".")[0] || null;
  } catch {
    return null;
  }
}

/** Read the JWT header `kid` without verifying the signature. */
export function jwtKid(token: string): string | null {
  try {
    const part = token.split(".")[0];
    if (!part) return null;
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
    const header = JSON.parse(json) as { kid?: string };
    return header.kid ?? null;
  } catch {
    return null;
  }
}

export function isClerkKidMismatchMessage(msg: string): boolean {
  return (
    msg.includes("Unable to find a signing key in JWKS") ||
    msg.includes("CLERK_INSTANCE_MISMATCH")
  );
}

export function parseKidMismatch(msg: string): { tokenKid: string | null; serverKid: string | null } {
  const tokenKid = msg.match(/kid='([^']+)'/)?.[1] ?? null;
  const serverKid = msg.match(/following kid is available:\s*(\S+)/)?.[1] ?? null;
  return { tokenKid, serverKid };
}

/** Returns true when the publishable key changed since last launch. */
export async function publishableKeyChanged(currentKey: string): Promise<boolean> {
  const stored = await AsyncStorage.getItem(CLERK_PK_STORAGE_KEY);
  return Boolean(stored && stored !== currentKey);
}

export async function rememberPublishableKey(currentKey: string): Promise<void> {
  await AsyncStorage.setItem(CLERK_PK_STORAGE_KEY, currentKey);
}

export async function clearPublishableKeyMemory(): Promise<void> {
  await AsyncStorage.removeItem(CLERK_PK_STORAGE_KEY);
}
