import { existsSync, unlinkSync } from "node:fs";

const ua = process.env.npm_config_user_agent ?? "";

for (const lockFile of ["package-lock.json", "yarn.lock"]) {
  if (existsSync(lockFile)) {
    try {
      unlinkSync(lockFile);
      console.log(`[preinstall] removed ${lockFile}`);
    } catch (error) {
      console.warn(`[preinstall] could not remove ${lockFile}: ${String(error)}`);
    }
  }
}

const loweredUa = ua.toLowerCase();
const looksLikeWrongPm =
  (loweredUa.includes("npm/") || loweredUa.includes("yarn/")) &&
  !loweredUa.includes("pnpm/");

if (looksLikeWrongPm) {
  console.error("Use pnpm instead of npm/yarn for this workspace.");
  process.exit(1);
}
