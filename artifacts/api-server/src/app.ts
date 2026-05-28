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

app.use(clerkMiddleware());

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
