import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Clerk Frontend API proxy — must be mounted BEFORE express.json() because the
// proxy streams raw bytes through to Clerk.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: true }));
// Trails carry inline GPX XML (up to ~10 MB user upload, sometimes more after
// JSON-encoding). Default Express limit is 100 KB which would 413 every save.
app.use(express.json({ limit: "16mb" }));
app.use(express.urlencoded({ extended: true, limit: "16mb" }));

// ---------------------------------------------------------------------------
// Clerk middleware — Step 1/2 diagnostic logging
// ---------------------------------------------------------------------------
const CLERK_PUBLISHABLE_KEY =
  process.env.CLERK_PUBLISHABLE_KEY ??
  // Hard-coded fallback so the server works even if the env var is missing
  // at module-load time (devLocal.mjs sets it before spawning the process,
  // but esbuild may read it earlier in some build configs).
  "pk_test_cG9ldGljLWh1c2t5LTMxLmNsZXJrLmFjY291bnRzLmRldiQ";

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "";

// Log so we can verify the right values are in effect at startup.
logger.info(
  {
    publishableKeyPrefix: CLERK_PUBLISHABLE_KEY.slice(0, 30),
    secretKeyPresent: Boolean(CLERK_SECRET_KEY),
  },
  "[Clerk] middleware init",
);

// Pass keys explicitly.
// authorizedParties: [] → disable azp validation so React Native / Expo Go
// tokens (which carry azp="expo://…" or no azp) are accepted.
app.use(
  clerkMiddleware({
    secretKey:          CLERK_SECRET_KEY,
    publishableKey:     CLERK_PUBLISHABLE_KEY,
    authorizedParties:  [],   // allow any origin (mobile apps have no web origin)
  }),
);

// Dev-mode: log the resolved userId for every API request so we can see
// exactly which requests are missing auth without adding noise in prod.
if (process.env.NODE_ENV !== "production") {
  const { getAuth } = await import("@clerk/express");
  app.use("/api", (req, _res, next) => {
    const { userId } = getAuth(req);
    logger.debug({ method: req.method, path: req.path, userId: userId ?? "(anon)" }, "[Clerk] auth resolved");
    next();
  });
}

app.use("/api", router);

// ---------------------------------------------------------------------------
// Global error handler — catches anything forwarded via next(err) from route
// handlers, including errors thrown inside `requireAuth`-wrapped handlers.
// Must be declared AFTER all routes (Express recognises the 4-arg signature).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const id = (req as Request & { id?: string }).id;
  logger.error({ err, reqId: id }, "Unhandled route error");
  if (res.headersSent) return;
  const status =
    err instanceof Error && "status" in err && typeof (err as { status: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;
  res.status(status).json({ error: "Internal server error" });
});

export default app;
