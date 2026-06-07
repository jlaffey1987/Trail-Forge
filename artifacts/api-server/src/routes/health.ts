import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { resolveUserId } from "../lib/clerkAuth";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Alias used by the mobile app's connectivity check.
router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * Dev-only endpoint — returns what the Clerk middleware extracted from the
 * incoming request.  Useful for diagnosing 401 issues without adding server
 * log access.  Only active when NODE_ENV !== "production".
 */
router.get("/auth-check", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const auth = getAuth(req);
  res.json({
    hasAuthHeader:   Boolean(req.headers.authorization),
    authHeaderPrefix: req.headers.authorization
      ? req.headers.authorization.slice(0, 20) + "…"
      : null,
    userId:          auth.userId ?? null,
    sessionId:       auth.sessionId ?? null,
    clerkSecretKey:  process.env.CLERK_SECRET_KEY
      ? "present (" + process.env.CLERK_SECRET_KEY.slice(0, 10) + "…)"
      : "MISSING",
    clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY
      ? "present (" + process.env.CLERK_PUBLISHABLE_KEY.slice(0, 15) + "…)"
      : "MISSING",
  });
});

/**
 * Auth test — requires a valid Bearer token.
 * Returns the authenticated userId so the mobile app can confirm
 * the full auth round-trip is working.
 */
router.get("/auth-test", async (req, res) => {
  const authHeader = req.headers.authorization;
  const hasHeader = Boolean(authHeader);
  const headerPrefix = authHeader ? authHeader.slice(0, 40) + "…" : null;

  const result = await resolveUserId(req);

  if (!result.userId) {
    res.status(401).json({
      error:        "Not authenticated",
      hasHeader,
      headerPrefix,
      code:         result.mismatch?.code,
      hint:         result.mismatch?.hint
        ?? (hasHeader
          ? "Token received but Clerk could not verify it."
          : "No Authorization header received."),
      clerkPublishableKeyPrefix: process.env.CLERK_PUBLISHABLE_KEY?.slice(0, 30) ?? "MISSING",
      secretKeyPresent: Boolean(process.env.CLERK_SECRET_KEY),
      ...(result.mismatch && {
        tokenKid:  result.mismatch.tokenKid,
        serverKid: result.mismatch.serverKid,
      }),
      ...(process.env.NODE_ENV !== "production" && result.verifyError && {
        verifyError: result.verifyError,
      }),
    });
    return;
  }
  res.json({ status: "authenticated", userId: result.userId });
});

export default router;
