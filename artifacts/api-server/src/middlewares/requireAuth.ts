/**
 * Shared auth-gating middleware for Express route handlers.
 */

import { type Request, type Response, type NextFunction } from "express";
import { resolveUserId } from "../lib/clerkAuth";
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
    const result = await resolveUserId(req);

    if (!result.userId) {
      if (result.mismatch) {
        logger.warn(
          {
            path: req.path,
            method: req.method,
            tokenKid: result.mismatch.tokenKid,
            serverKid: result.mismatch.serverKid,
          },
          "[requireAuth] ❌ Clerk instance mismatch — stale session token from wrong Clerk app",
        );
        res.status(401).json({
          error: "Unauthorized",
          code:  result.mismatch.code,
          hint:  result.mismatch.hint,
          ...(IS_DEV && {
            debug: {
              tokenKid:  result.mismatch.tokenKid,
              serverKid: result.mismatch.serverKid,
              verifyError: result.verifyError,
            },
          }),
        });
        return;
      }

      const hasHeader = Boolean(req.headers.authorization);
      logger.warn(
        {
          path: req.path,
          method: req.method,
          hasHeader,
          verifyError: result.verifyError,
        },
        hasHeader
          ? "[requireAuth] 401 — token present but not verified"
          : "[requireAuth] 401 — no token",
      );
      res.status(401).json({
        error: "Unauthorized",
        ...(IS_DEV && result.verifyError && { debug: { verifyError: result.verifyError } }),
      });
      return;
    }

    logger.debug({ path: req.path, userId: result.userId }, "[requireAuth] ✅ authenticated");

    try {
      await handler(req, res, result.userId);
    } catch (err) {
      next(err);
    }
  };
}
