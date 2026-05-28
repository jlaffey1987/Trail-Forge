import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getMockSupa, resetMockSupa } from "./helpers/setup";

const originalEnv = { ...process.env };

beforeEach(() => {
  resetMockSupa();
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("runPreflightCheck", () => {
  it("skips when SKIP_SCHEMA_PREFLIGHT=true", async () => {
    process.env.SKIP_SCHEMA_PREFLIGHT = "true";
    const { runPreflightCheck } = await import("../src/lib/preflightCheck");
    const result = await runPreflightCheck();
    expect(result.ok).toBe(true);
    expect(result.missingColumns).toEqual([]);
    expect(result.missingIndex).toBe(false);
  });

  it("skips in development by default", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.SKIP_SCHEMA_PREFLIGHT;
    const { runPreflightCheck } = await import("../src/lib/preflightCheck");
    const result = await runPreflightCheck();
    expect(result.ok).toBe(true);
    expect(result.missingColumns).toEqual([]);
    expect(result.missingIndex).toBe(false);
  });

  it("continues when Supabase is unreachable", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.SKIP_SCHEMA_PREFLIGHT;

    const supa = getMockSupa();
    supa.forcedErrors.set("trails:select", {
      message: "TypeError: fetch failed",
    });

    const mod = await import("../src/lib/preflightCheck");
    const result = await mod.runPreflightCheck();
    expect(result.ok).toBe(true);
    expect(result.missingColumns).toEqual([]);
    expect(result.missingIndex).toBe(false);
  });

  it("reports missing columns when trails table lacks them", async () => {
    process.env.NODE_ENV = "production";
    const supa = getMockSupa();
    supa.seed("trails", [{ id: "1", name: "test" }]);
    supa.forcedErrors.set("trails:select", {
      code: "42703",
      message: 'column "source_region" does not exist',
    });

    delete process.env.SKIP_SCHEMA_PREFLIGHT;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => "" })),
    );

    const mod = await import("../src/lib/preflightCheck");
    const result = await mod.runPreflightCheck();
    expect(result.ok).toBe(false);
    expect(result.missingColumns).toContain("source_region");
    expect(result.missingColumns).toContain("segment_hash");
  });

  it("reports ok when columns exist and index probe succeeds", async () => {
    process.env.NODE_ENV = "production";
    const supa = getMockSupa();
    supa.seed("trails", [
      {
        id: "1",
        name: "test",
        source_region: "uk",
        segment_hash: "abc",
        source: "act",
        source_url: "https://example.com",
      },
    ]);

    delete process.env.SKIP_SCHEMA_PREFLIGHT;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => "" })),
    );

    const mod = await import("../src/lib/preflightCheck");
    const result = await mod.runPreflightCheck();
    expect(result.ok).toBe(true);
    expect(result.missingColumns).toEqual([]);
    expect(result.missingIndex).toBe(false);
  });

  it("reports missing index when PostgREST returns 42P10", async () => {
    process.env.NODE_ENV = "production";
    const supa = getMockSupa();
    supa.seed("trails", [
      {
        id: "1",
        name: "test",
        source_region: "uk",
        segment_hash: "abc",
        source: "act",
        source_url: "https://example.com",
      },
    ]);

    delete process.env.SKIP_SCHEMA_PREFLIGHT;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (init?.method === "POST") {
          return {
            ok: false,
            text: async () =>
              '{"code":"42P10","message":"no unique or exclusion constraint matching the ON CONFLICT specification"}',
          };
        }
        return { ok: true, text: async () => "" };
      }),
    );

    const mod = await import("../src/lib/preflightCheck");
    const result = await mod.runPreflightCheck();
    expect(result.ok).toBe(false);
    expect(result.missingIndex).toBe(true);
  });

  it("treats unexpected non-OK probe response as unknown (index assumed present) and logs a warning", async () => {
    process.env.NODE_ENV = "production";
    const supa = getMockSupa();
    supa.seed("trails", [
      {
        id: "1",
        name: "test",
        source_region: "uk",
        segment_hash: "abc",
        source: "act",
        source_url: "https://example.com",
      },
    ]);

    delete process.env.SKIP_SCHEMA_PREFLIGHT;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) => {
        if (init?.method === "POST") {
          return {
            ok: false,
            text: async () => '{"message":"some unexpected auth error","code":"PGRST301"}',
          };
        }
        return { ok: true, text: async () => "" };
      }),
    );

    const mod = await import("../src/lib/preflightCheck");
    const result = await mod.runPreflightCheck();
    expect(result.ok).toBe(true);
    expect(result.missingIndex).toBe(false);
  });
});
