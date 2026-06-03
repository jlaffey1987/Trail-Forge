/**
 * Shared auth-gating middleware for Express route handlers.
 *
 * Verification strategy (two-phase):
 *   1. Check getAuth(req).userId — set by clerkMiddleware() when it can
 *      reach Clerk's JWKS endpoint to verify the token.
 *   2. If that is null but a Bearer token is present, fall back to
 *      clerkClient.verifyToken() directly.  This path logs the EXACT
 *      Clerk error so we can diagnose network / key-mismatch issues.
 *
 * Usage:
 *   import { requireAuth, type AuthedHandler } from "../middlewares/requireAuth";
 *
 *   router.post("/some/route", requireAuth(async (req, res, userId) => {
 *     // userId is guaranteed to be a non-empty Clerk user id
 *   }));
 */

import { type Request, type Response, type NextFunction } from "express";
import { getAuth, verifyToken } from "@clerk/express";
import { logger } from "../lib/logger";

const IS_DEV = process.env.NODE_ENV !== "production";

/** A route handler that receives the authenticated Clerk user id. */
export interface AuthedHandler {
  (req: Request, res: Response, userId: string): Promise<void>;
}

/**
 * Wraps a handler so it only runs when the caller has a valid Clerk session.
 * Returns `401 { error: "Unauthorized" }` otherwise.
 */
export function requireAuth(handler: AuthedHandler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // ── Phase 1: standard clerkMiddleware path ──────────────────────────────
    let userId: string | null = getAuth(req).userId ?? null;

    // ── Phase 2: direct verifyToken fallback ────────────────────────────────
    // clerkMiddleware can return userId=null if:
    //   - It couldn't fetch the JWKS from api.clerk.com (network issue)
    //   - The token azp failed validation (mobile / Expo Go tokens)
    //   - Any other verification error
    // We verify directly here so we get the EXACT error for diagnostics.
    if (!userId) {
      const rawHeader = req.headers.authorization ?? "";
      const rawToken = rawHeader.startsWith("Bearer ")
        ? rawHeader.slice(7).trim()
        : rawHeader.trim();

      if (rawToken) {
        try {
          const payload = await verifyToken(rawToken, {
            secretKey:         process.env.CLERK_SECRET_KEY,
            authorizedParties: [], // accept any azp (mobile / Expo tokens have no web origin)
            ...(process.env.CLERK_JWT_KEY ? { jwtKey: process.env.CLERK_JWT_KEY } : {}),
          });
          userId = payload.sub ?? null;
          if (userId) {
            logger.info(
              { path: req.path, method: req.method, userId },
              "[requireAuth] ✅ direct verifyToken succeeded",
            );
          }
        } catch (verifyErr) {
          const errMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
          logger.warn(
            { path: req.path, method: req.method, error: errMsg, tokenPrefix: rawToken.slice(0, 30) },
            "[requireAuth] ❌ direct verifyToken FAILED — this is the root cause of 401s",
          );
          res.status(401).json({
            error: "Unauthorized",
            ...(IS_DEV && {
              debug: {
                verifyError:   errMsg,
                tokenReceived: true,
                tokenPrefix:   rawToken.slice(0, 30) + "…",
                hint:          "Set CLERK_JWT_KEY in api-server/.env.local (Clerk Dashboard → JWT Templates → Default → Signing key) for offline verification.",
              },
            }),
          });
          return;
        }
      }
    }

    // ── 401 when no token present ────────────────────────────────────────────
    if (!userId) {
      const hasHeader = Boolean(req.headers.authorization);
      logger.warn(
        { path: req.path, method: req.method, hasHeader },
        "[requireAuth] 401 — no token",
      );
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    logger.debug({ path: req.path, userId }, "[requireAuth] ✅ authenticated");

    try {
      await handler(req, res, userId);
    } catch (err) {
      next(err);
    }
  };
}
