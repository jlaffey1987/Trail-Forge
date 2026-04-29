import { defineConfig, devices } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_PORT = process.env.E2E_API_PORT ?? "8080";
const WEB_PORT = process.env.E2E_WEB_PORT ?? "21414";

const PROXY_BASE_URL =
  process.env.E2E_PROXY_BASE_URL ?? "http://localhost:80";

export default defineConfig({
  testDir: path.join(__dirname, "tests/e2e"),
  testMatch: /.*\.e2e\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: path.join(__dirname, "tests/e2e/global-setup.ts"),
  use: {
    baseURL: PROXY_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      // The API server's `dev` script does `build && start`, so it can take a
      // few seconds to come up on a cold checkout.
      command: "pnpm --filter @workspace/api-server run dev",
      url: `http://localhost:${API_PORT}/api/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      cwd: path.resolve(__dirname, "..", ".."),
      env: {
        PORT: API_PORT,
        NODE_ENV: "development",
      },
    },
    {
      command: "pnpm --filter @workspace/trailforge run dev",
      url: `http://localhost:${WEB_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: path.resolve(__dirname, "..", ".."),
      env: {
        PORT: WEB_PORT,
        BASE_PATH: "/",
      },
    },
  ],
});
