/**
 * Build a minimal Express test app that mounts the trailContent router.
 * Auth is forced via a per-request shim that the mocked `getAuth` reads.
 *
 * NOTE: We don't import the real `app.ts` because we need to inject auth
 * BEFORE the router runs, and `app.ts` mounts `clerkMiddleware()` first
 * (which the setup file mocks to a no-op anyway).
 */

import express, { type Express } from "express";
import trailContentRouter from "../../src/routes/trailContent";

export function makeApp(authUserId: string | null = null): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { __auth?: { userId: string | null } }).__auth = {
      userId: authUserId,
    };
    // Stub a logger — pino-http isn't mounted here.
    (req as express.Request & { log?: unknown }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    };
    next();
  });
  app.use("/api", trailContentRouter);
  return app;
}
