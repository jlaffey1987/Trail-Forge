import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import AddressAutocomplete from "@/components/AddressAutocomplete";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
  },
}));

const mockSearch = vi.fn();
vi.mock("@/lib/routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/routing")>();
  return {
    ...actual,
    searchSuggestions: (q: string) => mockSearch(q),
  };
});

beforeEach(() => {
  mockSearch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolveFn: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolveFn = r;
  });
  return { promise, resolve: resolveFn };
}

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

// Tiny stateful wrapper so the input behaves like a real controlled
// input — typing "ab" then "abc" actually shows up in the DOM and
// re-renders propagate. The bare component expects the parent to push
// `value` updates.
function Harness({ initial = "" }: { initial?: string }) {
  const [v, setV] = useState(initial);
  return (
    <AddressAutocomplete
      value={v}
      onChange={setV}
      onSelect={() => {}}
      data-testid="ac"
    />
  );
}

describe("AddressAutocomplete — debounce + sequence guard", () => {
  it("ignores a stale earlier response when a newer query lands first", async () => {
    const slow = deferred<unknown[]>();
    const fast = deferred<unknown[]>();
    mockSearch.mockImplementationOnce(() => slow.promise);
    mockSearch.mockImplementationOnce(() => fast.promise);

    render(<Harness />);
    const input = screen.getByTestId("ac") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "ab" } });
    await wait(320);
    expect(mockSearch).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: "abc" } });
    await wait(320);
    expect(mockSearch).toHaveBeenCalledTimes(2);

    // Newer (second) request resolves first.
    await act(async () => {
      fast.resolve([
        {
          id: "n2",
          label: "Manchester, UK",
          shortLabel: "Manchester",
          lat: 53.48,
          lng: -2.24,
        },
      ]);
    });
    expect(screen.getByText("Manchester")).toBeTruthy();

    // Older (first) request resolves AFTER — must NOT replace the dropdown.
    await act(async () => {
      slow.resolve([
        {
          id: "n1",
          label: "Aberdeen, UK",
          shortLabel: "Aberdeen",
          lat: 57.15,
          lng: -2.09,
        },
      ]);
    });
    expect(screen.queryByText("Aberdeen")).toBeNull();
    expect(screen.getByText("Manchester")).toBeTruthy();
  });

  it("treats an in-flight request as stale when the input shrinks below the threshold", async () => {
    const inflight = deferred<unknown[]>();
    mockSearch.mockImplementationOnce(() => inflight.promise);

    render(<Harness />);
    const input = screen.getByTestId("ac") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "abc" } });
    await wait(320);
    expect(mockSearch).toHaveBeenCalledTimes(1);

    // Rider deletes back to "a" — below the 2-char threshold. We MUST
    // bump the sequence so the in-flight "abc" response can no longer
    // re-populate the dropdown (the regression the architect flagged).
    fireEvent.change(input, { target: { value: "a" } });

    await act(async () => {
      inflight.resolve([
        {
          id: "n3",
          label: "Aberystwyth, Wales, UK",
          shortLabel: "Aberystwyth",
          lat: 52.41,
          lng: -4.08,
        },
      ]);
    });

    expect(screen.queryByText("Aberystwyth")).toBeNull();
  });
});
