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
import groupsRouter from "../../src/routes/groups";
import pushRouter from "../../src/routes/push";
import aiRouter from "../../src/routes/ai";
import meRouter from "../../src/routes/me";
import trailsRouter from "../../src/routes/trails";

export function makeApp(authUserId: string | null = null): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { __auth?: { userId: string | null } }).__auth = {
      userId: authUserId,
    };
    (req as express.Request & { log?: unknown }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    };
    next();
  });
  app.use("/api", trailContentRouter);
  app.use("/api", groupsRouter);
  app.use("/api", pushRouter);
  app.use("/api", aiRouter);
  app.use("/api", meRouter);
  app.use("/api", trailsRouter);
  return app;
}
