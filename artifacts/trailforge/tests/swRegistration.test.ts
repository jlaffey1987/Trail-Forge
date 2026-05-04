import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("registerServiceWorker — runtime unit tests", () => {
  let registerSpy: ReturnType<typeof vi.fn>;
  let originalSW: ServiceWorkerContainer | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    registerSpy = vi.fn().mockResolvedValue({});
    originalSW = navigator.serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerSpy },
      writable: true,
      configurable: true,
    });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalSW !== undefined) {
      Object.defineProperty(navigator, "serviceWorker", {
        value: originalSW,
        writable: true,
        configurable: true,
      });
    }
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("calls navigator.serviceWorker.register with correct sw.js URL and scope", async () => {
    const { registerServiceWorker } = await import("@/lib/registerSW");

    const result = await registerServiceWorker("/myapp/");

    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith("/myapp/sw.js", { scope: "/myapp/" });
    expect(result).toBe(true);
  });

  it("constructs URL from root base path correctly", async () => {
    vi.resetModules();
    const { registerServiceWorker } = await import("@/lib/registerSW");

    const result = await registerServiceWorker("/");

    expect(registerSpy).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(result).toBe(true);
  });

  it("returns false and does not throw when registration fails", async () => {
    registerSpy.mockRejectedValue(new Error("SW registration failed"));
    vi.resetModules();
    const { registerServiceWorker } = await import("@/lib/registerSW");

    const result = await registerServiceWorker("/");

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "[trailforge] service worker registration failed",
      expect.any(Error),
    );
  });

  it("returns false when serviceWorker is not available", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    vi.resetModules();
    const { registerServiceWorker } = await import("@/lib/registerSW");

    const result = await registerServiceWorker("/");

    expect(result).toBe(false);
    expect(registerSpy).not.toHaveBeenCalled();
  });
});

describe("main.tsx wiring", () => {
  it("imports and calls registerServiceWorker", () => {
    const mainSrc = readFileSync(resolve(__dirname, "..", "src", "main.tsx"), "utf-8");
    expect(mainSrc).toContain('import { registerServiceWorker } from "./lib/registerSW"');
    expect(mainSrc).toContain("registerServiceWorker(import.meta.env.BASE_URL)");
  });

  it("index.html includes manifest link", () => {
    const indexHtml = readFileSync(resolve(__dirname, "..", "index.html"), "utf-8");
    expect(indexHtml).toContain('rel="manifest"');
    expect(indexHtml).toContain("manifest.webmanifest");
  });
});
