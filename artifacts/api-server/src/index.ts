import app from "./app";
import { logger } from "./lib/logger";
import { runPreflightCheck } from "./lib/preflightCheck";
import { startAiScheduler } from "./lib/scheduler";

const rawPort = process.env["PORT"] ?? "8080";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  void runPreflightCheck().catch((e) => {
    logger.warn(
      { err: e instanceof Error ? e.message : e },
      "Schema preflight check failed — server continues running",
    );
  });

  startAiScheduler();
});
