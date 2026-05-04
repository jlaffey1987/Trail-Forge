import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const PUBLIC = resolve(__dirname, "..", "public");

describe("PWA manifest", () => {
  const manifestPath = resolve(PUBLIC, "manifest.webmanifest");

  it("manifest.webmanifest file exists", () => {
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("is valid JSON with required fields", () => {
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);
    expect(manifest.name).toBe("TrailForge");
    expect(manifest.short_name).toBe("TrailForge");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.icons).toBeInstanceOf(Array);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
  });

  it("has icons of at least 192 and 512 sizes", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  it("has a maskable icon", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const maskable = manifest.icons.filter(
      (i: { purpose?: string }) => i.purpose === "maskable",
    );
    expect(maskable.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Service worker (sw.js)", () => {
  const swPath = resolve(PUBLIC, "sw.js");

  it("sw.js file exists", () => {
    expect(existsSync(swPath)).toBe(true);
  });

  it("defines tile cache name matching offlineStore constant", () => {
    const sw = readFileSync(swPath, "utf-8");
    expect(sw).toContain('trailforge-tiles-v1');
  });

  it("intercepts Esri tile requests (server.arcgisonline.com)", () => {
    const sw = readFileSync(swPath, "utf-8");
    expect(sw).toContain("server.arcgisonline.com");
    expect(sw).toContain("MapServer/tile");
  });

  it("returns an SVG placeholder on tile fetch failure", () => {
    const sw = readFileSync(swPath, "utf-8");
    expect(sw).toContain("image/svg+xml");
    expect(sw).toMatch(/fill=["']#2a2520["']/);
  });

  it("pre-caches the app shell", () => {
    const sw = readFileSync(swPath, "utf-8");
    expect(sw).toContain('APP_SHELL');
    expect(sw).toContain('cache.addAll');
  });

  it("calls skipWaiting and clients.claim for immediate activation", () => {
    const sw = readFileSync(swPath, "utf-8");
    expect(sw).toContain("self.skipWaiting()");
    expect(sw).toContain("self.clients.claim()");
  });

  it("does not pass through API requests to the cache", () => {
    const sw = readFileSync(swPath, "utf-8");
    expect(sw).toContain("API_PREFIX");
    expect(sw).toMatch(/pathname\.startsWith\(API_PREFIX\)/);
  });
});

describe("SW registration in main.tsx", () => {
  it("main.tsx imports and calls registerServiceWorker", () => {
    const mainPath = resolve(__dirname, "..", "src", "main.tsx");
    const content = readFileSync(mainPath, "utf-8");
    expect(content).toContain("registerServiceWorker");
    expect(content).toContain('from "./lib/registerSW"');
  });

  it("registerSW.ts calls navigator.serviceWorker.register", () => {
    const swPath = resolve(__dirname, "..", "src", "lib", "registerSW.ts");
    const content = readFileSync(swPath, "utf-8");
    expect(content).toContain("navigator.serviceWorker.register");
    expect(content).toContain("sw.js");
    expect(content).toContain("scope");
  });
});
