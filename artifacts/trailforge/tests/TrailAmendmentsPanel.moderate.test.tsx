import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

const TRAIL_ID = "33333333-3333-4333-8333-333333333333";
const AMENDMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTHOR_ID = "user_author";
const MODERATOR_ID = "user_moderator";

vi.mock("@clerk/react", () => ({
  useUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: {
      id: MODERATOR_ID,
      primaryEmailAddress: { emailAddress: "mod@example.com" },
      emailAddresses: [{ emailAddress: "mod@example.com" }],
      firstName: "Mod",
      lastName: "Erator",
      fullName: "Mod Erator",
      username: "mod",
      imageUrl: null,
    },
  }),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {},
  saveTrail: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/users", () => ({
  syncCurrentUser: vi.fn().mockResolvedValue({
    id: MODERATOR_ID,
    email: "mod@example.com",
    display_name: "Mod Erator",
    avatar_url: null,
    created_at: new Date().toISOString(),
  }),
}));

interface AmendmentRow {
  id: string;
  trail_id: string;
  author_user_id: string;
  proposed_changes: Record<string, unknown>;
  replacement_gpx_storage_key: string | null;
  reason: string;
  status: "pending" | "approved" | "rejected" | "archived";
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  created_at: string;
  users: { id: string; display_name: string; avatar_url: string | null } | null;
}

interface FakeBackend {
  amendments: AmendmentRow[];
  decisions: { amendmentId: string; decision: "approve" | "reject"; reason: string | null }[];
}

let backend: FakeBackend;
let fetchSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function seedPendingAmendment(): AmendmentRow {
  return {
    id: AMENDMENT_ID,
    trail_id: TRAIL_ID,
    author_user_id: AUTHOR_ID,
    proposed_changes: { difficulty: 7 },
    replacement_gpx_storage_key: null,
    reason: "Re-rated harder after recent rain",
    status: "pending",
    decided_by: null,
    decided_at: null,
    decision_reason: null,
    created_at: new Date().toISOString(),
    users: { id: AUTHOR_ID, display_name: "Trail Author", avatar_url: null },
  };
}

async function handleRequest(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url, "http://test.local");
  const path = u.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : null;

  const listMatch = /^\/api\/trails\/([^/]+)\/amendments$/.exec(path);
  if (listMatch && method === "GET") {
    const trailId = listMatch[1]!;
    return jsonResponse({
      items: backend.amendments
        .filter((a) => a.trail_id === trailId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    });
  }

  const decisionMatch = /^\/api\/trails\/([^/]+)\/amendments\/([^/]+)\/(approve|reject)$/.exec(
    path,
  );
  if (decisionMatch && method === "POST") {
    const trailId = decisionMatch[1]!;
    const amendmentId = decisionMatch[2]!;
    const decision = decisionMatch[3] as "approve" | "reject";
    const am = backend.amendments.find(
      (a) => a.id === amendmentId && a.trail_id === trailId,
    );
    if (!am) return jsonResponse({ error: "not found" }, { status: 404 });
    if (am.status !== "pending") return jsonResponse({ error: "already decided" }, { status: 409 });
    am.status = decision === "approve" ? "approved" : "rejected";
    am.decided_by = MODERATOR_ID;
    am.decided_at = new Date().toISOString();
    am.decision_reason = body?.decisionReason ?? null;
    backend.decisions.push({
      amendmentId,
      decision,
      reason: body?.decisionReason ?? null,
    });
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: `unmocked ${method} ${path}` }, { status: 500 });
}

beforeEach(() => {
  backend = { amendments: [seedPendingAmendment()], decisions: [] };
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return handleRequest(url, init);
    });
});

afterEach(() => {
  fetchSpy.mockRestore();
  cleanup();
});

async function importPanel() {
  return (await import("@/components/trail-content/TrailAmendmentsPanel")).default;
}

function fakeTrail() {
  return {
    id: TRAIL_ID,
    user_id: null,
    owner_user_id: "user_owner_other",
    name: "Test Trail",
    type: "singletrack",
    difficulty: 5,
    distance_km: 12.5,
    terrain: "dirt",
    legal_status: "open",
    gpx_data: null,
    is_public: true,
    created_at: new Date().toISOString(),
    source: "user",
    verification_status: "verified",
  };
}

describe("TrailAmendmentsPanel — moderator approve/reject UI", () => {
  it("approves a pending amendment: status flips to 'approved' and pending count drops", async () => {
    const TrailAmendmentsPanel = await importPanel();
    const user = userEvent.setup();
    const onCountsChanged = vi.fn();

    render(
      <TrailAmendmentsPanel
        trail={fakeTrail() as never}
        onCountsChanged={onCountsChanged}
        canModerate={true}
      />,
    );

    const row = await screen.findByTestId(`amendment-${AMENDMENT_ID}`);
    expect(screen.getByText("1 amendment")).toBeInTheDocument();

    const statusBadge = within(row).getByTestId(`amendment-status-${AMENDMENT_ID}`);
    expect(statusBadge.textContent?.toLowerCase()).toContain("pending");

    const approveBtn = within(row).getByTestId(`amendment-approve-${AMENDMENT_ID}`);
    await user.click(approveBtn);

    await waitFor(() =>
      expect(
        within(screen.getByTestId(`amendment-${AMENDMENT_ID}`)).getByTestId(
          `amendment-status-${AMENDMENT_ID}`,
        ).textContent?.toLowerCase(),
      ).toContain("approved"),
    );

    // Approve / Reject buttons disappear once status is no longer pending.
    expect(
      within(screen.getByTestId(`amendment-${AMENDMENT_ID}`)).queryByTestId(
        `amendment-approve-${AMENDMENT_ID}`,
      ),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId(`amendment-${AMENDMENT_ID}`)).queryByTestId(
        `amendment-reject-${AMENDMENT_ID}`,
      ),
    ).not.toBeInTheDocument();

    expect(backend.decisions).toHaveLength(1);
    expect(backend.decisions[0]).toMatchObject({
      amendmentId: AMENDMENT_ID,
      decision: "approve",
    });
    expect(backend.amendments[0]!.status).toBe("approved");
    expect(onCountsChanged).toHaveBeenCalled();
  });

  it("rejects a pending amendment via the in-app dialog: status flips to 'rejected', the rejection reason is sent, and buttons disappear", async () => {
    const TrailAmendmentsPanel = await importPanel();
    const user = userEvent.setup();
    const onCountsChanged = vi.fn();

    // Native prompt() should no longer be used. Fail loudly if it is.
    const promptSpy = vi.spyOn(window, "prompt").mockImplementation(() => {
      throw new Error("window.prompt should not be called");
    });

    render(
      <TrailAmendmentsPanel
        trail={fakeTrail() as never}
        onCountsChanged={onCountsChanged}
        canModerate={true}
      />,
    );

    const row = await screen.findByTestId(`amendment-${AMENDMENT_ID}`);
    const statusBadge = within(row).getByTestId(`amendment-status-${AMENDMENT_ID}`);
    expect(statusBadge.textContent?.toLowerCase()).toContain("pending");

    await user.click(within(row).getByTestId(`amendment-reject-${AMENDMENT_ID}`));

    // The in-app rejection dialog opens.
    const dialog = await screen.findByTestId("amendment-reject-dialog");
    const reasonInput = within(dialog).getByTestId("amendment-reject-reason");
    await user.type(reasonInput, "Not enough evidence");
    await user.click(within(dialog).getByTestId("amendment-reject-confirm"));

    await waitFor(() =>
      expect(
        within(screen.getByTestId(`amendment-${AMENDMENT_ID}`)).getByTestId(
          `amendment-status-${AMENDMENT_ID}`,
        ).textContent?.toLowerCase(),
      ).toContain("rejected"),
    );

    // Dialog closes after a successful rejection.
    expect(screen.queryByTestId("amendment-reject-dialog")).not.toBeInTheDocument();

    // Buttons gone now that status is no longer pending.
    expect(
      within(screen.getByTestId(`amendment-${AMENDMENT_ID}`)).queryByTestId(
        `amendment-approve-${AMENDMENT_ID}`,
      ),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId(`amendment-${AMENDMENT_ID}`)).queryByTestId(
        `amendment-reject-${AMENDMENT_ID}`,
      ),
    ).not.toBeInTheDocument();

    // Decision note from the dialog is rendered.
    expect(screen.getByText(/Decision note: Not enough evidence/)).toBeInTheDocument();

    expect(backend.decisions).toHaveLength(1);
    expect(backend.decisions[0]).toMatchObject({
      amendmentId: AMENDMENT_ID,
      decision: "reject",
      reason: "Not enough evidence",
    });
    expect(backend.amendments[0]!.status).toBe("rejected");
    expect(onCountsChanged).toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();

    promptSpy.mockRestore();
  });

  it("shows an inline error inside the reject dialog (not a native alert) when rejection fails, and the dialog stays open", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const u = new URL(url, "http://test.local");
      if (/\/amendments\/[^/]+\/reject$/.test(u.pathname)) {
        return jsonResponse({ error: "boom" }, { status: 500 });
      }
      return handleRequest(url, init);
    });

    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {
      throw new Error("window.alert should not be called");
    });

    const TrailAmendmentsPanel = await importPanel();
    const user = userEvent.setup();

    render(
      <TrailAmendmentsPanel
        trail={fakeTrail() as never}
        onCountsChanged={() => {}}
        canModerate={true}
      />,
    );

    const row = await screen.findByTestId(`amendment-${AMENDMENT_ID}`);
    await user.click(within(row).getByTestId(`amendment-reject-${AMENDMENT_ID}`));

    const dialog = await screen.findByTestId("amendment-reject-dialog");
    await user.type(within(dialog).getByTestId("amendment-reject-reason"), "Nope");
    await user.click(within(dialog).getByTestId("amendment-reject-confirm"));

    // Dialog remains open with a visible error inside it.
    const dialogError = await within(
      await screen.findByTestId("amendment-reject-dialog"),
    ).findByTestId("amendment-reject-dialog-error");
    expect(dialogError.textContent ?? "").toMatch(/could not reject/i);
    expect(alertSpy).not.toHaveBeenCalled();

    // Amendment is still pending since the request failed.
    expect(
      within(screen.getByTestId(`amendment-${AMENDMENT_ID}`)).getByTestId(
        `amendment-status-${AMENDMENT_ID}`,
      ).textContent?.toLowerCase(),
    ).toContain("pending");
    expect(backend.amendments[0]!.status).toBe("pending");

    alertSpy.mockRestore();
  });

  it("cancelling the reject dialog leaves the amendment pending and does not call the backend", async () => {
    const TrailAmendmentsPanel = await importPanel();
    const user = userEvent.setup();

    render(
      <TrailAmendmentsPanel
        trail={fakeTrail() as never}
        onCountsChanged={() => {}}
        canModerate={true}
      />,
    );

    const row = await screen.findByTestId(`amendment-${AMENDMENT_ID}`);
    await user.click(within(row).getByTestId(`amendment-reject-${AMENDMENT_ID}`));

    const dialog = await screen.findByTestId("amendment-reject-dialog");
    await user.click(within(dialog).getByTestId("amendment-reject-dialog-cancel"));

    expect(screen.queryByTestId("amendment-reject-dialog")).not.toBeInTheDocument();
    expect(backend.decisions).toHaveLength(0);
    expect(backend.amendments[0]!.status).toBe("pending");
  });

  it("surfaces an inline error (not a native alert) when a decision request fails", async () => {
    // Force the decision endpoint to fail.
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const u = new URL(url, "http://test.local");
      if (/\/amendments\/[^/]+\/(approve|reject)$/.test(u.pathname)) {
        return jsonResponse({ error: "boom" }, { status: 500 });
      }
      return handleRequest(url, init);
    });

    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {
      throw new Error("window.alert should not be called");
    });

    const TrailAmendmentsPanel = await importPanel();
    const user = userEvent.setup();

    render(
      <TrailAmendmentsPanel
        trail={fakeTrail() as never}
        onCountsChanged={() => {}}
        canModerate={true}
      />,
    );

    const row = await screen.findByTestId(`amendment-${AMENDMENT_ID}`);
    await user.click(within(row).getByTestId(`amendment-approve-${AMENDMENT_ID}`));

    const banner = await screen.findByTestId("amendment-decide-error");
    expect(banner.textContent ?? "").toMatch(/could not approve/i);
    expect(alertSpy).not.toHaveBeenCalled();

    // Sanity: the rejection dialog is not open for an approve failure.
    expect(screen.queryByTestId("amendment-reject-dialog")).not.toBeInTheDocument();

    // Status is still pending since the request failed.
    expect(
      within(screen.getByTestId(`amendment-${AMENDMENT_ID}`)).getByTestId(
        `amendment-status-${AMENDMENT_ID}`,
      ).textContent?.toLowerCase(),
    ).toContain("pending");

    alertSpy.mockRestore();
  });

  it("does not show Approve/Reject buttons when canModerate is false", async () => {
    const TrailAmendmentsPanel = await importPanel();

    render(
      <TrailAmendmentsPanel
        trail={fakeTrail() as never}
        onCountsChanged={() => {}}
        canModerate={false}
      />,
    );

    const row = await screen.findByTestId(`amendment-${AMENDMENT_ID}`);
    expect(
      within(row).queryByTestId(`amendment-approve-${AMENDMENT_ID}`),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByTestId(`amendment-reject-${AMENDMENT_ID}`),
    ).not.toBeInTheDocument();

    // The pending badge is still visible.
    expect(
      within(row).getByTestId(`amendment-status-${AMENDMENT_ID}`).textContent?.toLowerCase(),
    ).toContain("pending");
    expect(backend.decisions).toHaveLength(0);
  });
});
