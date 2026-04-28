import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom doesn't ship `confirm` / `alert` / `prompt` by default in some
// configurations — stub them so component code that calls them doesn't crash.
if (typeof globalThis.confirm !== "function") {
  Object.defineProperty(globalThis, "confirm", { value: () => true, writable: true });
}
if (typeof globalThis.alert !== "function") {
  Object.defineProperty(globalThis, "alert", { value: () => {}, writable: true });
}
if (typeof globalThis.prompt !== "function") {
  Object.defineProperty(globalThis, "prompt", { value: () => "", writable: true });
}

// IntersectionObserver — used by some shadcn primitives we transitively
// import. jsdom doesn't have it.
class IO {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}
if (typeof globalThis.IntersectionObserver === "undefined") {
  // @ts-expect-error -- assigning a polyfill onto the test global is fine.
  globalThis.IntersectionObserver = IO;
}

// matchMedia stub.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
