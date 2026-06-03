/**
 * Shared auth-gating middleware for Express route handlers.
 *
 * All six route files previously contained identical `AuthedHandler` +
 * `requireAuth` implementations.  This module is the single source of truth.
 *
 * Usage:
 *   import { requireAuth, type AuthedHandler } from "../middlewares/requireAuth";
 *
 *   router.post("/some/route", requireAuth(async (req, res, userId) => {
 *     // userId is guaranteed to be a non-empty Clerk user id
 *   }));
 */

import { type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { logger } from "../lib/logger";

/** A route handler that receives the authenticated Clerk user id. */
export interface AuthedHandler {
  (req: Request, res: Response, userId: string): Promise<void>;
}

/**
 * Wraps a handler so it only runs when the caller has a valid Clerk session.
 * Returns `401 { error: "Unauthorized" }` otherwise, and forwards thrown
 * errors to Express's error-handling middleware via `next(err)`.
 */
export function requireAuth(handler: AuthedHandler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const auth = getAuth(req);
    const hasHeader = Boolean(req.headers.authorization);
    const headerPrefix = req.headers.authorization
      ? req.headers.authorization.slice(0, 30) + "…"
      : "(none)";

    if (!auth.userId) {
      logger.warn(
        { path: req.path, method: req.method, hasHeader, headerPrefix },
        "[requireAuth] 401 — no userId. Token sent but Clerk did not verify it.",
      );
      res.status(401).json({
        error: "Unauthorized",
        debug: process.env.NODE_ENV !== "production"
          ? { hasHeader, headerPrefix, hint: "Token received but Clerk could not verify it" }
          : undefined,
      });
      return;
    }

    logger.debug({ path: req.path, userId: auth.userId }, "[requireAuth] ✅ authenticated");
    try {
      await handler(req, res, auth.userId);
    } catch (err) {
      next(err);
    }
  };
}
