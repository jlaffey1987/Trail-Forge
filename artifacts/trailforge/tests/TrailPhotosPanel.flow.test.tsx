import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { randomUUID } from "crypto";

const TRAIL_ID = "22222222-2222-4222-8222-222222222222";
const VIEWER_ID = "user_viewer_photos";

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

// jsdom doesn't ship `createImageBitmap` / a working canvas-to-blob path, so
// stub the prep helper. The real fn is unit-tested elsewhere — here we care
// about the upload + delete UI journey.
vi.mock("@/lib/photoUpload", () => ({
  preparePhotoForUpload: vi.fn().mockResolvedValue({
    blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }),
    width: 1200,
    height: 800,
  }),
  MAX_PHOTOS_PER_UPLOAD: 5,
}));

interface PhotoRow {
  id: string;
  trail_id: string;
  author_user_id: string;
  storage_key: string;
  width: number | null;
  height: number | null;
  caption: string | null;
  created_at: string;
  hidden_at: string | null;
  users: { id: string; display_name: string; avatar_url: string | null } | null;
}

interface FakeBackend {
  photos: PhotoRow[];
  uploads: { url: string; method: string; contentType: string | null; bytes: number }[];
}

let backend: FakeBackend;
let fetchSpy: ReturnType<typeof vi.spyOn>;

function viewer() {
  return { id: VIEWER_ID, display_name: "View Er", avatar_url: null };
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

  // Presigned-URL PUT to "object storage" — anything that isn't an /api/...
  // path is treated as the upload bucket.
  if (!path.startsWith("/api/")) {
    let bytes = 0;
    if (init?.body instanceof Blob) {
      bytes = init.body.size;
    } else if (init?.body && typeof (init.body as ArrayBuffer).byteLength === "number") {
      bytes = (init.body as ArrayBuffer).byteLength;
    }
    backend.uploads.push({
      url,
      method,
      contentType:
        (init?.headers && (init.headers as Record<string, string>)["Content-Type"]) ?? null,
      bytes,
    });
    return new Response(null, { status: 200 });
  }

  const m = /^\/api\/trails\/([^/]+)\/photos(\/.*)?$/.exec(path);
  if (m) {
    const trailId = m[1]!;
    const sub = m[2] ?? "";

    if (sub === "" && method === "GET") {
      return jsonResponse({
        items: backend.photos
          .filter((p) => p.trail_id === trailId && !p.hidden_at)
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      });
    }

    if (sub === "/upload-url" && method === "POST") {
      const photoId = randomUUID();
      const storageKey = `trails/${trailId}/photos/${photoId}.jpg`;
      return jsonResponse({
        uploadURL: `https://fake-bucket.local/${storageKey}?sig=abc`,
        storageKey,
        objectPath: `/api/storage/objects/${storageKey}`,
      });
    }

    if (sub === "" && method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const row: PhotoRow = {
        id: randomUUID(),
        trail_id: trailId,
        author_user_id: VIEWER_ID,
        storage_key: String(body.storageKey),
        width: typeof body.width === "number" ? body.width : null,
        height: typeof body.height === "number" ? body.height : null,
        caption: typeof body.caption === "string" ? body.caption : null,
        created_at: new Date().toISOString(),
        hidden_at: null,
        users: viewer(),
      };
      backend.photos.push(row);
      return jsonResponse(row);
    }

    const delMatch = /^\/([0-9a-f-]+)$/.exec(sub);
    if (delMatch && method === "DELETE") {
      const photoId = delMatch[1]!;
      const idx = backend.photos.findIndex(
        (p) => p.id === photoId && p.trail_id === trailId,
      );
      if (idx === -1) return new Response(null, { status: 404 });
      backend.photos.splice(idx, 1);
      return new Response(null, { status: 204 });
    }
  }

  return jsonResponse({ error: `unmocked ${method} ${path}` }, { status: 500 });
}

beforeEach(() => {
  backend = { photos: [], uploads: [] };
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
  return (await import("@/components/trail-content/TrailPhotosPanel")).default;
}

describe("TrailPhotosPanel — upload + delete UI journey", () => {
  it("uploads a chosen file end-to-end and shows the thumbnail, then deletes it via the X button", async () => {
    const TrailPhotosPanel = await importPanel();
    const user = userEvent.setup();
    const onCountsChanged = vi.fn();

    render(<TrailPhotosPanel trailId={TRAIL_ID} onCountsChanged={onCountsChanged} />);

    // Initial empty state once the GET /photos response is processed.
    await waitFor(() => expect(screen.getByText("0 photos")).toBeInTheDocument());
    expect(
      screen.getByText("No photos yet — be the first to share what this trail looks like."),
    ).toBeInTheDocument();

    // Choose a file. The component listens via onChange on a hidden <input
    // type="file"> with data-testid="photo-file-input".
    const fileInput = screen.getByTestId("photo-file-input") as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], "ride.jpg", { type: "image/jpeg" });
    await user.upload(fileInput, file);

    // After the three-step round-trip (upload-url → PUT → finalize POST) the
    // thumbnail should render.
    await waitFor(() => expect(backend.photos).toHaveLength(1));
    const created = backend.photos[0]!;
    const thumb = await screen.findByTestId(`photo-${created.id}`);
    expect(thumb).toBeInTheDocument();
    const img = thumb.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(`/api/storage/objects/${created.storage_key}`);

    // Photo count chip updates and the parent is notified.
    await waitFor(() => expect(screen.getByText("1 photo")).toBeInTheDocument());
    expect(onCountsChanged).toHaveBeenCalled();

    // The presigned PUT actually fired with the prepared JPEG bytes.
    expect(backend.uploads).toHaveLength(1);
    expect(backend.uploads[0]!.method).toBe("PUT");
    expect(backend.uploads[0]!.contentType).toBe("image/jpeg");
    expect(backend.uploads[0]!.bytes).toBeGreaterThan(0);

    // Finalize call carried the storage key + decoded dimensions from prep.
    expect(created.storage_key).toMatch(/^trails\/.+\/photos\/.+\.jpg$/);
    expect(created.width).toBe(1200);
    expect(created.height).toBe(800);
    expect(created.author_user_id).toBe(VIEWER_ID);

    // Author gets the X button — click it and confirm the row disappears.
    // jsdom's window.confirm is a no-op that returns undefined, so force it
    // to return true for the duration of the click.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const deleteBtn = screen.getByTestId(`photo-delete-${created.id}`);
    onCountsChanged.mockClear();
    await user.click(deleteBtn);
    confirmSpy.mockRestore();

    await waitFor(() =>
      expect(screen.queryByTestId(`photo-${created.id}`)).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByText("0 photos")).toBeInTheDocument());
    expect(backend.photos).toHaveLength(0);
    expect(onCountsChanged).toHaveBeenCalled();
  });
});
