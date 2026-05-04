import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("@clerk/react", () => ({
  useUser: () => ({
    isLoaded: true,
    isSignedIn: false,
    user: null,
  }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/admin", vi.fn()],
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {},
}));

vi.mock("@/lib/users", () => ({
  syncCurrentUser: vi.fn().mockResolvedValue(null),
}));

import AdminPage from "@/pages/AdminPage";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function whoamiPayload(state: string, signedIn: boolean) {
  return {
    isAdmin: false,
    signedIn,
    state,
    code: "ADMIN_FORBIDDEN",
    message: "test",
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/api/admin/whoami")) {
        return jsonResponse(whoamiPayload("not-admin", true));
      }
      return new Response("", { status: 404 });
    });
});

afterEach(() => {
  fetchSpy.mockRestore();
  cleanup();
});

interface GateCase {
  state: string;
  signedIn: boolean;
  expectedTitle: string;
  expectedKeywords: string[];
  isBootstrap: boolean;
}

const CASES: GateCase[] = [
  {
    state: "signed-out",
    signedIn: false,
    expectedTitle: "Sign in required",
    expectedKeywords: ["sign in"],
    isBootstrap: false,
  },
  {
    state: "not-admin",
    signedIn: true,
    expectedTitle: "Admin only",
    expectedKeywords: ["SYSTEM_ADMIN_USER_IDS", "system_admins"],
    isBootstrap: false,
  },
  {
    state: "no-admins",
    signedIn: true,
    expectedTitle: "Admin features waiting to be turned on",
    expectedKeywords: ["SYSTEM_ADMIN_USER_IDS", "system_admins"],
    isBootstrap: true,
  },
  {
    state: "migration-missing",
    signedIn: true,
    expectedTitle: "Admin features waiting to be turned on",
    expectedKeywords: ["0007", "SYSTEM_ADMIN_USER_IDS", "system_admins"],
    isBootstrap: true,
  },
];

describe("AdminPage gate", () => {
  for (const { state, signedIn, expectedTitle, expectedKeywords, isBootstrap } of CASES) {
    it(`renders the correct gate screen for "${state}"`, async () => {
      fetchSpy.mockImplementation(
        async (input: RequestInfo | URL, _init?: RequestInit) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          if (url.includes("/api/admin/whoami")) {
            return jsonResponse(whoamiPayload(state, signedIn));
          }
          return new Response("", { status: 404 });
        },
      );

      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByTestId("admin-gate")).toBeInTheDocument();
      });

      const gate = screen.getByTestId("admin-gate");

      expect(gate).toHaveAttribute("data-admin-state", state);

      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        expectedTitle,
      );

      const gateText = gate.textContent ?? "";
      for (const keyword of expectedKeywords) {
        expect(gateText).toContain(keyword);
      }

      if (isBootstrap) {
        expect(gateText).toContain(
          "Once one admin is configured",
        );
      } else {
        expect(gateText).not.toContain(
          "Once one admin is configured",
        );
      }
    });
  }
});
