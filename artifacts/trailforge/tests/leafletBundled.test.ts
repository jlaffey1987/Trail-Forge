import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const filesToCheck = [
  "src/lib/useLeaflet.ts",
  "src/components/NavigationView.tsx",
  "src/components/PlannerMap.tsx",
];

describe("Leaflet is bundled locally (no CDN)", () => {
  for (const file of filesToCheck) {
    it(`${file} does not reference unpkg.com`, () => {
      const content = readFileSync(resolve(__dirname, "..", file), "utf-8");
      expect(content).not.toContain("unpkg.com");
    });

    it(`${file} does not inject a <script> tag for leaflet`, () => {
      const content = readFileSync(resolve(__dirname, "..", file), "utf-8");
      expect(content).not.toMatch(/createElement\s*\(\s*["']script["']/);
    });
  }

  it("useLeaflet.ts imports leaflet from npm", () => {
    const content = readFileSync(resolve(__dirname, "..", "src/lib/useLeaflet.ts"), "utf-8");
    expect(content).toContain('import("leaflet');
  });
});
