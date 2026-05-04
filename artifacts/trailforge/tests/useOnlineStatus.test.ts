import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/lib/supabase", () => ({
  supabase: {},
}));

const fetchSpy = vi.fn();

describe("useOnlineStatus", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalOnLine: boolean;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalOnLine = navigator.onLine;
    globalThis.fetch = fetchSpy.mockResolvedValue({ ok: true });
    Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(navigator, "onLine", { value: originalOnLine, writable: true, configurable: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns true when navigator.onLine is true", async () => {
    const { useOnlineStatus } = await import("@/hooks/useOnlineStatus");
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
  });

  it("returns false when navigator.onLine is false", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    vi.resetModules();
    const { useOnlineStatus } = await import("@/hooks/useOnlineStatus");
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);
  });

  it("reacts to offline event", async () => {
    const { useOnlineStatus } = await import("@/hooks/useOnlineStatus");
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);

    await act(async () => {
      Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current).toBe(false);
  });
});
