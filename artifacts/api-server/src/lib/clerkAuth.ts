/**
 * Shared Clerk token verification helpers.
 */
import { getAuth, verifyToken } from "@clerk/express";
import { logger } from "./logger";

export interface VerifyResult {
  userId: string | null;
  /** Structured error when verification fails. */
  mismatch?: {
    code: "CLERK_INSTANCE_MISMATCH";
    tokenKid: string | null;
    serverKid: string | null;
    hint: string;
  };
  verifyError?: string;
}

const KID_MISMATCH_RE = /kid='([^']+)'[\s\S]*following kid is available:\s*(\S+)/;

function parseKidMismatch(msg: string): { tokenKid: string | null; serverKid: string | null } {
  const m = msg.match(KID_MISMATCH_RE);
  if (!m) {
    const tokenKid = msg.match(/kid='([^']+)'/)?.[1] ?? null;
    const serverKid = msg.match(/following kid is available:\s*(\S+)/)?.[1] ?? null;
    return { tokenKid, serverKid };
  }
  return { tokenKid: m[1], serverKid: m[2] };
}

function isKidMismatch(msg: string): boolean {
  return msg.includes("Unable to find a signing key in JWKS");
}

/** Resolve authenticated userId from middleware or direct token verification. */
export async function resolveUserId(req: {
  headers: { authorization?: string };
}): Promise<VerifyResult> {
  const fromMiddleware = getAuth(req as Parameters<typeof getAuth>[0]).userId;
  if (fromMiddleware) return { userId: fromMiddleware };

  const rawHeader = req.headers.authorization ?? "";
  const rawToken = rawHeader.startsWith("Bearer ")
    ? rawHeader.slice(7).trim()
    : rawHeader.trim();

  if (!rawToken) return { userId: null };

  try {
    const payload = await verifyToken(rawToken, {
      secretKey:         process.env.CLERK_SECRET_KEY,
      authorizedParties: [],
      ...(process.env.CLERK_JWT_KEY ? { jwtKey: process.env.CLERK_JWT_KEY } : {}),
    });
    return { userId: payload.sub ?? null };
  } catch (verifyErr) {
    const errMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
    logger.warn({ error: errMsg }, "[clerkAuth] verifyToken failed");

    if (isKidMismatch(errMsg)) {
      const { tokenKid, serverKid } = parseKidMismatch(errMsg);
      return {
        userId: null,
        mismatch: {
          code:     "CLERK_INSTANCE_MISMATCH",
          tokenKid,
          serverKid,
          hint:     "Session token is from a different Clerk app. Sign out on the device and sign in again.",
        },
        verifyError: errMsg,
      };
    }

    return { userId: null, verifyError: errMsg };
  }
}
