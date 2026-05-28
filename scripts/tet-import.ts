import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const tetFixturePath = path.join(
  workspaceRoot,
  "scripts",
  "src",
  "importACT",
  "fixtures",
  "tet-uk.gpx",
);

if (!existsSync(tetFixturePath)) {
  console.error(
    [
      "TET GPX fixture not found.",
      `Expected file: ${tetFixturePath}`,
      "Place your TET GPX bundle at that path (or update fixtures/bundles.json) and run again.",
    ].join("\n"),
  );
  process.exit(1);
}

const args = [
  "--filter",
  "@workspace/scripts",
  "exec",
  "tsx",
  "./src/importACT/index.ts",
  "--source",
  "tet",
  "--region",
  "uk",
  ...process.argv.slice(2),
];

const pnpmExec = process.env.npm_execpath;
const command = pnpmExec && pnpmExec.endsWith(".mjs") ? process.execPath : "pnpm";
const commandArgs =
  pnpmExec && pnpmExec.endsWith(".mjs") ? [pnpmExec, ...args] : args;

const result = spawnSync(command, commandArgs, {
  cwd: workspaceRoot,
  stdio: "inherit",
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

if (result.error) {
  console.error(result.error.message);
}
process.exit(1);
