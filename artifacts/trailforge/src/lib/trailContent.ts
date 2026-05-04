/**
 * Frontend data layer for trail notes, photos and amendments.
 *
 * All requests go through the API server (`/api/trails/...`) which
 * enforces auth via Clerk and uses the Supabase service-role key.
 * Public reads are still routed via the API server (instead of the anon
 * Supabase client) so the same join-with-author shape is returned to the UI.
 */

export type NoteKind = "info" | "warning" | "condition";
export type AmendmentStatus = "pending" | "approved" | "rejected" | "archived";
export type ReasonCategory = "route_change" | "difficulty_change" | "request_removal" | "other";

interface AuthorMini {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface TrailNote {
  id: string;
  trail_id: string;
  author_user_id: string;
  body: string;
  kind: NoteKind;
  created_at: string;
  updated_at: string;
  hidden_at: string | null;
  users: AuthorMini | null;
}

export interface TrailPhoto {
  id: string;
  trail_id: string;
  author_user_id: string;
  storage_key: string;
  width: number | null;
  height: number | null;
  caption: string | null;
  created_at: string;
  hidden_at: string | null;
  users: AuthorMini | null;
}

export interface AmendmentChanges {
  name?: string;
  difficulty?: number | null;
  type?: string | null;
  legal_status?: string | null;
  terrain?: string | null;
  action?: "remove";
}

export interface TrailAmendment {
  id: string;
  trail_id: string;
  author_user_id: string;
  proposed_changes: AmendmentChanges;
  replacement_gpx_storage_key: string | null;
  reason: string;
  reason_category: ReasonCategory | null;
  status: AmendmentStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  created_at: string;
  users: AuthorMini | null;
}

export interface TrailActivityCounts {
  notes: number;
  photos: number;
  pending: number;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface TrailPermissions {
  isOwner: boolean;
  isModerator: boolean;
  canModerate: boolean;
  isUnowned: boolean;
  adoptedAt: string | null;
  adopter: { id: string; display_name: string | null; avatar_url: string | null } | null;
}

export async function fetchTrailPermissions(trailId: string): Promise<TrailPermissions> {
  try {
    const res = await fetch(`/api/trails/${trailId}/permissions`, {
      credentials: "include",
    });
    if (!res.ok) return { isOwner: false, isModerator: false, canModerate: false, isUnowned: false, adoptedAt: null, adopter: null };
    return (await res.json()) as TrailPermissions;
  } catch {
    return { isOwner: false, isModerator: false, canModerate: false, isUnowned: false, adoptedAt: null, adopter: null };
  }
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function fetchTrailNotes(trailId: string): Promise<TrailNote[]> {
  try {
    const res = await fetch(`/api/trails/${trailId}/notes`, { credentials: "include" });
    if (!res.ok) return [];
    const json = (await res.json()) as { items: TrailNote[] };
    return json.items ?? [];
  } catch (err) {
    console.error("fetchTrailNotes failed:", err);
    return [];
  }
}

export async function createTrailNote(
  trailId: string,
  input: { body: string; kind?: NoteKind },
): Promise<TrailNote | null> {
  try {
    const res = await fetch(`/api/trails/${trailId}/notes`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: input.body, kind: input.kind ?? "info" }),
    });
    if (!res.ok) {
      console.error("createTrailNote failed:", res.status, await res.text());
      return null;
    }
    return (await res.json()) as TrailNote;
  } catch (err) {
    console.error("createTrailNote failed:", err);
    return null;
  }
}

export async function deleteTrailNote(trailId: string, noteId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/trails/${trailId}/notes/${noteId}`, {
      method: "DELETE",
      credentials: "include",
    });
    return res.ok;
  } catch (err) {
    console.error("deleteTrailNote failed:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

export async function fetchTrailPhotos(trailId: string): Promise<TrailPhoto[]> {
  try {
    const res = await fetch(`/api/trails/${trailId}/photos`, { credentials: "include" });
    if (!res.ok) return [];
    const json = (await res.json()) as { items: TrailPhoto[] };
    return json.items ?? [];
  } catch (err) {
    console.error("fetchTrailPhotos failed:", err);
    return [];
  }
}

export interface PhotoUploadTicket {
  uploadURL: string;
  storageKey: string;
  objectPath: string;
}

export async function requestPhotoUploadUrl(
  trailId: string,
  contentType: string,
): Promise<PhotoUploadTicket | null> {
  try {
    const res = await fetch(`/api/trails/${trailId}/photos/upload-url`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType }),
    });
    if (!res.ok) {
      console.error("requestPhotoUploadUrl failed:", res.status);
      return null;
    }
    return (await res.json()) as PhotoUploadTicket;
  } catch (err) {
    console.error("requestPhotoUploadUrl failed:", err);
    return null;
  }
}

export async function createTrailPhoto(
  trailId: string,
  input: { storageKey: string; width?: number; height?: number; caption?: string },
): Promise<TrailPhoto | null> {
  try {
    const res = await fetch(`/api/trails/${trailId}/photos`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      console.error("createTrailPhoto failed:", res.status, await res.text());
      return null;
    }
    return (await res.json()) as TrailPhoto;
  } catch (err) {
    console.error("createTrailPhoto failed:", err);
    return null;
  }
}

export async function deleteTrailPhoto(trailId: string, photoId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/trails/${trailId}/photos/${photoId}`, {
      method: "DELETE",
      credentials: "include",
    });
    return res.ok;
  } catch (err) {
    console.error("deleteTrailPhoto failed:", err);
    return false;
  }
}

/**
 * Returns the URL the browser should hit to render a photo. Photos are
 * stored at `trails/{trailId}/photos/{uuid}.jpg` and exposed via the
 * existing `/api/storage/objects/<entityId>` endpoint (ACL set to public
 * during upload finalization).
 */
export function trailPhotoUrl(photo: TrailPhoto): string {
  return `/api/storage/objects/${photo.storage_key}`;
}

// ---------------------------------------------------------------------------
// Amendments
// ---------------------------------------------------------------------------

export async function fetchTrailAmendments(trailId: string): Promise<TrailAmendment[]> {
  try {
    const res = await fetch(`/api/trails/${trailId}/amendments`, { credentials: "include" });
    if (!res.ok) return [];
    const json = (await res.json()) as { items: TrailAmendment[] };
    return json.items ?? [];
  } catch (err) {
    console.error("fetchTrailAmendments failed:", err);
    return [];
  }
}

export interface AmendmentGpxTicket {
  uploadURL: string;
  storageKey: string;
  objectPath: string;
}

export async function requestAmendmentGpxUploadUrl(
  trailId: string,
): Promise<AmendmentGpxTicket | null> {
  try {
    const res = await fetch(`/api/trails/${trailId}/amendments/gpx-upload-url`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: "application/gpx+xml" }),
    });
    if (!res.ok) return null;
    return (await res.json()) as AmendmentGpxTicket;
  } catch (err) {
    console.error("requestAmendmentGpxUploadUrl failed:", err);
    return null;
  }
}

export async function createTrailAmendment(
  trailId: string,
  input: {
    proposedChanges: AmendmentChanges;
    reason: string;
    replacementGpxStorageKey?: string;
    reasonCategory?: ReasonCategory;
  },
): Promise<TrailAmendment | null> {
  try {
    const res = await fetch(`/api/trails/${trailId}/amendments`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      console.error("createTrailAmendment failed:", res.status, await res.text());
      return null;
    }
    return (await res.json()) as TrailAmendment;
  } catch (err) {
    console.error("createTrailAmendment failed:", err);
    return null;
  }
}

export async function decideAmendment(
  trailId: string,
  amendmentId: string,
  decision: "approve" | "reject",
  decisionReason?: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/trails/${trailId}/amendments/${amendmentId}/${decision}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          decisionReason ? { decisionReason } : {},
        ),
      },
    );
    return res.ok;
  } catch (err) {
    console.error("decideAmendment failed:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Adopt trail
// ---------------------------------------------------------------------------

export interface AdoptResult {
  ok: boolean;
  adoptedAt: string;
  adopter: { id: string; display_name: string | null; avatar_url: string | null };
}

export async function adoptTrail(trailId: string): Promise<AdoptResult | null> {
  try {
    const res = await fetch(`/api/trails/${trailId}/adopt`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      console.error("adoptTrail failed:", res.status, body?.error);
      return null;
    }
    return (await res.json()) as AdoptResult;
  } catch (err) {
    console.error("adoptTrail failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Activity counts
// ---------------------------------------------------------------------------

export async function fetchTrailActivityCounts(
  trailIds: string[],
): Promise<Record<string, TrailActivityCounts>> {
  if (trailIds.length === 0) return {};
  // Chunk to keep query strings under control.
  const chunks: string[][] = [];
  for (let i = 0; i < trailIds.length; i += 100) {
    chunks.push(trailIds.slice(i, i + 100));
  }
  const merged: Record<string, TrailActivityCounts> = {};
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const url = new URL("/api/trails/activity-counts", window.location.origin);
        url.searchParams.set("ids", chunk.join(","));
        const res = await fetch(url.toString(), { credentials: "include" });
        if (!res.ok) return;
        const json = (await res.json()) as {
          counts: Record<string, TrailActivityCounts>;
        };
        Object.assign(merged, json.counts);
      } catch (err) {
        console.error("fetchTrailActivityCounts failed:", err);
      }
    }),
  );
  return merged;
}
