import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { randomUUID } from "crypto";

const TRAIL_ID = "11111111-1111-4111-8111-111111111111";
const VIEWER_ID = "user_viewer";

vi.mock("@clerk/react", () => ({
  useUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: {
      id: VIEWER_ID,
      primaryEmailAddress: { emailAddress: "viewer@example.com" },
      emailAddresses: [{ emailAddress: "viewer@example.com" }],
      firstName: "View",
      lastName: "Er",
      fullName: "View Er",
      username: "viewer",
      imageUrl: null,
    },
  }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/", () => {}],
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {},
  saveTrail: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/users", () => ({
  syncCurrentUser: vi.fn().mockResolvedValue({
    id: VIEWER_ID,
    email: "viewer@example.com",
    display_name: "View Er",
    avatar_url: null,
    created_at: new Date().toISOString(),
  }),
}));

vi.mock("@/lib/plannerRouteStore", () => ({
  isInRoute: () => false,
  addRouteTrail: vi.fn(),
  removeRouteTrail: vi.fn(),
  subscribeRouteTrails: () => () => {},
  getRouteTrails: () => [],
  PLANNER_MAX_TRAILS: 20,
}));

interface NoteRow {
  id: string;
  trail_id: string;
  author_user_id: string;
  body: string;
  kind: string;
  created_at: string;
  updated_at: string;
  hidden_at: string | null;
  users: { id: string; display_name: string; avatar_url: string | null } | null;
}

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
  notes: NoteRow[];
  photos: { id: string; trail_id: string; hidden_at: string | null }[];
  amendments: AmendmentRow[];
}

let backend: FakeBackend;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let canModerate = false;

function viewer(): { id: string; display_name: string; avatar_url: null } {
  return { id: VIEWER_ID, display_name: "View Er", avatar_url: null };
}

function counts(trailId: string) {
  return {
    notes: backend.notes.filter((n) => n.trail_id === trailId && !n.hidden_at).length,
    photos: backend.photos.filter((p) => p.trail_id === trailId && !p.hidden_at).length,
    pending: backend.amendments.filter((a) => a.trail_id === trailId && a.status === "pending")
      .length,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

async function handleRequest(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url, "http://test.local");
  const path = u.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : null;

  if (path === "/api/admin/whoami") {
    return jsonResponse({ isAdmin: false });
  }

  if (path === "/api/trails/activity-counts") {
    const ids = (u.searchParams.get("ids") ?? "").split(",").filter(Boolean);
    const out: Record<string, ReturnType<typeof counts>> = {};
    for (const id of ids) out[id] = counts(id);
    return jsonResponse({ counts: out });
  }

  const m = /^\/api\/trails\/([^/]+)(\/.*)?$/.exec(path);
  if (m) {
    const trailId = m[1]!;
    const sub = m[2] ?? "";

    if (sub === "/permissions" && method === "GET") {
      return jsonResponse({
        isOwner: false,
        isModerator: canModerate,
        canModerate,
      });
    }

    const decisionMatch = /^\/amendments\/([^/]+)\/(approve|reject)$/.exec(sub);
    if (decisionMatch && method === "POST") {
      const amendmentId = decisionMatch[1]!;
      const decision = decisionMatch[2] as "approve" | "reject";
      const am = backend.amendments.find(
        (a) => a.id === amendmentId && a.trail_id === trailId,
      );
      if (!am) return jsonResponse({ error: "not found" }, { status: 404 });
      if (am.status !== "pending")
        return jsonResponse({ error: "already decided" }, { status: 409 });
      am.status = decision === "approve" ? "approved" : "rejected";
      am.decided_by = VIEWER_ID;
      am.decided_at = new Date().toISOString();
      am.decision_reason = body?.decisionReason ?? null;
      return jsonResponse({ ok: true });
    }

    if (sub === "/notes" && method === "GET") {
      return jsonResponse({
        items: backend.notes
          .filter((n) => n.trail_id === trailId && !n.hidden_at)
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      });
    }
    if (sub === "/notes" && method === "POST") {
      const now = new Date().toISOString();
      const note: NoteRow = {
        id: randomUUID(),
        trail_id: trailId,
        author_user_id: VIEWER_ID,
        body: String(body.body),
        kind: String(body.kind ?? "info"),
        created_at: now,
        updated_at: now,
        hidden_at: null,
        users: viewer(),
      };
      backend.notes.push(note);
      return jsonResponse(note);
    }

    if (sub === "/amendments" && method === "GET") {
      return jsonResponse({
        items: backend.amendments
          .filter((a) => a.trail_id === trailId)
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      });
    }
    if (sub === "/amendments" && method === "POST") {
      const am: AmendmentRow = {
        id: randomUUID(),
        trail_id: trailId,
        author_user_id: VIEWER_ID,
        proposed_changes: (body.proposedChanges ?? {}) as Record<string, unknown>,
        replacement_gpx_storage_key: body.replacementGpxStorageKey ?? null,
        reason: String(body.reason ?? ""),
        status: "pending",
        decided_by: null,
        decided_at: null,
        decision_reason: null,
        created_at: new Date().toISOString(),
        users: viewer(),
      };
      backend.amendments.push(am);
      return jsonResponse(am);
    }
  }

  return jsonResponse({ error: `unmocked ${method} ${path}` }, { status: 500 });
}

beforeEach(() => {
  backend = { notes: [], photos: [], amendments: [] };
  canModerate = false;
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

async function importSheet() {
  return (await import("@/components/TrailDetailSheet")).default;
}

function fakeTrail(): {
  id: string;
  user_id: null;
  owner_user_id: string;
  name: string;
  type: string | null;
  difficulty: number;
  distance_km: number;
  terrain: string | null;
  legal_status: string | null;
  gpx_data: null;
  is_public: boolean;
  created_at: string;
  source: string;
  verification_status: string;
} {
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

describe("TrailDetailSheet — signed-in user trail-content journey", () => {
  it("adds a note, submits an amendment, and the header counts and tab badges reflect both", async () => {
    const TrailDetailSheet = await importSheet();
    const user = userEvent.setup();

    render(<TrailDetailSheet trail={fakeTrail() as never} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId("trail-detail-counts")).toHaveTextContent(
        "0 notes · 0 photos · 0 pending edits",
      ),
    );

    await user.click(screen.getByTestId("trail-tab-notes"));
    const notesPanel = await screen.findByTestId("trail-notes-panel");

    const input = screen.getByTestId("note-input") as HTMLTextAreaElement;
    await user.type(input, "Bridge out at km 3");
    await user.click(screen.getByTestId("note-submit"));

    await waitFor(() =>
      expect(within(notesPanel).getByText("Bridge out at km 3")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("trail-detail-counts")).toHaveTextContent(
        "1 notes · 0 photos · 0 pending edits",
      ),
    );
    await waitFor(() =>
      expect(within(screen.getByTestId("trail-tab-notes")).getByText("1")).toBeInTheDocument(),
    );

    expect(backend.notes).toHaveLength(1);
    expect(backend.notes[0]!.body).toBe("Bridge out at km 3");
    expect(backend.notes[0]!.author_user_id).toBe(VIEWER_ID);

    await user.click(screen.getByTestId("trail-tab-amendments"));
    const amendmentsPanel = await screen.findByTestId("trail-amendments-panel");

    await user.click(within(amendmentsPanel).getByTestId("amendment-toggle-form"));

    const diffInput = screen.getByTestId("amendment-difficulty") as HTMLInputElement;
    await user.clear(diffInput);
    await user.type(diffInput, "7");

    const reason = screen.getByTestId("amendment-reason") as HTMLTextAreaElement;
    await user.type(reason, "Re-rated harder after recent rain");

    await user.click(screen.getByTestId("amendment-submit"));

    await waitFor(() => {
      const rows = screen.getAllByTestId(/^amendment-[0-9a-f-]+$/);
      expect(rows).toHaveLength(1);
    });
    const statusEl = await screen.findByTestId(/^amendment-status-/);
    expect(statusEl.textContent?.toLowerCase()).toContain("pending");

    await waitFor(() =>
      expect(screen.getByTestId("trail-detail-counts")).toHaveTextContent(
        "1 notes · 0 photos · 1 pending edits",
      ),
    );
    await waitFor(() =>
      expect(within(screen.getByTestId("trail-tab-amendments")).getByText("1")).toBeInTheDocument(),
    );

    expect(backend.amendments).toHaveLength(1);
    expect(backend.amendments[0]!.status).toBe("pending");
    expect(backend.amendments[0]!.proposed_changes).toMatchObject({ difficulty: 7 });
    expect(backend.amendments[0]!.author_user_id).toBe(VIEWER_ID);
  });

  it("drops the header's pending-edits count after a moderator approves a seeded pending amendment", async () => {
    canModerate = true;
    const seededId = randomUUID();
    backend.amendments.push({
      id: seededId,
      trail_id: TRAIL_ID,
      author_user_id: "user_other_author",
      proposed_changes: { name: "Renamed by author" },
      replacement_gpx_storage_key: null,
      reason: "Trail is signed differently on the ground",
      status: "pending",
      decided_by: null,
      decided_at: null,
      decision_reason: null,
      created_at: new Date().toISOString(),
      users: { id: "user_other_author", display_name: "Author", avatar_url: null },
    });

    const TrailDetailSheet = await importSheet();
    const user = userEvent.setup();

    render(<TrailDetailSheet trail={fakeTrail() as never} onClose={() => {}} />);

    // Header reflects the seeded pending amendment.
    await waitFor(() =>
      expect(screen.getByTestId("trail-detail-counts")).toHaveTextContent(
        "0 notes · 0 photos · 1 pending edits",
      ),
    );

    await user.click(screen.getByTestId("trail-tab-amendments"));
    const amendmentsPanel = await screen.findByTestId("trail-amendments-panel");

    const approveBtn = await within(amendmentsPanel).findByTestId(
      `amendment-approve-${seededId}`,
    );
    await user.click(approveBtn);

    // The row's status flips from pending → approved.
    await waitFor(() =>
      expect(
        within(screen.getByTestId(`amendment-${seededId}`))
          .getByTestId(`amendment-status-${seededId}`)
          .textContent?.toLowerCase(),
      ).toContain("approved"),
    );

    // Header pending count drops to 0 — this is the user-visible signal
    // the task acceptance criteria call out.
    await waitFor(() =>
      expect(screen.getByTestId("trail-detail-counts")).toHaveTextContent(
        "0 notes · 0 photos · 0 pending edits",
      ),
    );

    expect(backend.amendments[0]!.status).toBe("approved");
    expect(backend.amendments[0]!.decided_by).toBe(VIEWER_ID);
  });
});
