import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { randomUUID } from "crypto";

const GROUP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CALLER_ID = "user_caller";

vi.mock("@clerk/react", () => ({
  useUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: {
      id: CALLER_ID,
      primaryEmailAddress: { emailAddress: "caller@example.com" },
      emailAddresses: [{ emailAddress: "caller@example.com" }],
      firstName: "Cal",
      lastName: "Ler",
      fullName: "Cal Ler",
      username: "caller",
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
    id: CALLER_ID,
    email: "caller@example.com",
    display_name: "Cal Ler",
    avatar_url: null,
    created_at: new Date().toISOString(),
  }),
}));

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
  group_id: string;
  uploader_user_id: string;
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
  deletedIds: string[];
}

let backend: FakeBackend;
let fetchSpy: ReturnType<typeof vi.spyOn>;

function caller() {
  return { id: CALLER_ID, display_name: "Cal Ler", avatar_url: null };
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

  const m = /^\/api\/groups\/([^/]+)\/photos(\/.*)?$/.exec(path);
  if (m) {
    const groupId = m[1]!;
    const sub = m[2] ?? "";

    if (sub === "" && method === "GET") {
      return jsonResponse({
        items: backend.photos
          .filter((p) => p.group_id === groupId && !p.hidden_at)
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      });
    }

    if (sub === "/upload-url" && method === "POST") {
      const photoId = randomUUID();
      const storageKey = `groups/${groupId}/photos/${photoId}.jpg`;
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
        group_id: groupId,
        uploader_user_id: CALLER_ID,
        storage_key: String(body.storageKey),
        width: typeof body.width === "number" ? body.width : null,
        height: typeof body.height === "number" ? body.height : null,
        caption: typeof body.caption === "string" ? body.caption : null,
        created_at: new Date().toISOString(),
        hidden_at: null,
        users: caller(),
      };
      backend.photos.push(row);
      return jsonResponse(row);
    }

    const delMatch = /^\/([0-9a-f-]+)$/.exec(sub);
    if (delMatch && method === "DELETE") {
      const photoId = delMatch[1]!;
      const idx = backend.photos.findIndex(
        (p) => p.id === photoId && p.group_id === groupId,
      );
      if (idx === -1) return jsonResponse({ error: "not found" }, { status: 404 });
      backend.photos.splice(idx, 1);
      backend.deletedIds.push(photoId);
      return jsonResponse({ ok: true });
    }
  }

  return jsonResponse({ error: `unmocked ${method} ${path}` }, { status: 500 });
}

beforeEach(() => {
  backend = { photos: [], uploads: [], deletedIds: [] };
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

async function importComponent() {
  return (await import("@/components/groups/GroupGallerySection")).default;
}

describe("GroupGallerySection — empty state, upload, and delete", () => {
  it("shows the empty state when there are no photos", async () => {
    const GroupGallerySection = await importComponent();
    render(
      <GroupGallerySection
        groupId={GROUP_ID}
        callerUserId={CALLER_ID}
        canModerate={false}
      />,
    );

    const empty = await screen.findByTestId("group-gallery-empty");
    expect(empty).toBeInTheDocument();
    expect(empty.textContent).toMatch(/no photos yet/i);
  });

  it("uploads a file and shows the thumbnail, then deletes it", async () => {
    const GroupGallerySection = await importComponent();
    const user = userEvent.setup();

    render(
      <GroupGallerySection
        groupId={GROUP_ID}
        callerUserId={CALLER_ID}
        canModerate={false}
      />,
    );

    await screen.findByTestId("group-gallery-empty");

    const fileInput = screen.getByTestId("group-gallery-input") as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], "ride.jpg", { type: "image/jpeg" });
    await user.upload(fileInput, file);

    await waitFor(() => expect(backend.photos).toHaveLength(1));
    const created = backend.photos[0]!;

    const thumb = await screen.findByTestId(`group-gallery-photo-${created.id}`);
    expect(thumb).toBeInTheDocument();
    const img = thumb.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(`/api/storage/objects/${created.storage_key}`);

    expect(backend.uploads).toHaveLength(1);
    expect(backend.uploads[0]!.method).toBe("PUT");
    expect(backend.uploads[0]!.contentType).toBe("image/jpeg");

    expect(created.width).toBe(1200);
    expect(created.height).toBe(800);
    expect(created.uploader_user_id).toBe(CALLER_ID);

    const deleteBtn = screen.getByTestId(`group-gallery-delete-${created.id}`);
    expect(deleteBtn.textContent).toBe("Delete");
    await user.click(deleteBtn);

    await waitFor(() =>
      expect(screen.queryByTestId(`group-gallery-photo-${created.id}`)).not.toBeInTheDocument(),
    );
    expect(backend.deletedIds).toContain(created.id);

    const empty = await screen.findByTestId("group-gallery-empty");
    expect(empty).toBeInTheDocument();
  });

  it("shows 'Hide' instead of 'Delete' when a moderator views someone else's photo", async () => {
    const seeded: PhotoRow = {
      id: "11111111-1111-4111-8111-111111111111",
      group_id: GROUP_ID,
      uploader_user_id: "someone_else",
      storage_key: `groups/${GROUP_ID}/photos/other.jpg`,
      width: 800,
      height: 600,
      caption: null,
      created_at: new Date().toISOString(),
      hidden_at: null,
      users: { id: "someone_else", display_name: "Other Rider", avatar_url: null },
    };
    backend.photos.push(seeded);

    const GroupGallerySection = await importComponent();
    render(
      <GroupGallerySection
        groupId={GROUP_ID}
        callerUserId={CALLER_ID}
        canModerate={true}
      />,
    );

    const deleteBtn = await screen.findByTestId(`group-gallery-delete-${seeded.id}`);
    expect(deleteBtn.textContent).toBe("Hide");
  });

  it("does not show delete button for non-moderator viewing someone else's photo", async () => {
    const seeded: PhotoRow = {
      id: "22222222-2222-4222-8222-222222222222",
      group_id: GROUP_ID,
      uploader_user_id: "someone_else",
      storage_key: `groups/${GROUP_ID}/photos/other2.jpg`,
      width: 800,
      height: 600,
      caption: null,
      created_at: new Date().toISOString(),
      hidden_at: null,
      users: { id: "someone_else", display_name: "Other Rider", avatar_url: null },
    };
    backend.photos.push(seeded);

    const GroupGallerySection = await importComponent();
    render(
      <GroupGallerySection
        groupId={GROUP_ID}
        callerUserId={CALLER_ID}
        canModerate={false}
      />,
    );

    await screen.findByTestId(`group-gallery-photo-${seeded.id}`);
    expect(screen.queryByTestId(`group-gallery-delete-${seeded.id}`)).not.toBeInTheDocument();
  });
});
