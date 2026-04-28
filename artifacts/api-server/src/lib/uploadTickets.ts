/**
 * In-memory upload-ticket store for GPX uploads.
 *
 * When a client requests a signed upload URL via `POST /trails/gpx/upload-url`
 * we mint a ticket bound to the authenticated user, the storage key, and a
 * short expiry. When the client later finalizes the upload (POST/PATCH/PUT
 * trails with `gpx_object_path`), we look up the ticket by its storage key
 * and reject the request unless the caller is the original uploader and the
 * ticket has not expired. This prevents an attacker who learns another
 * user's object path from reassigning ACL ownership to themselves.
 *
 * Ticket lifecycle:
 *   - mintGpxUploadTicket(userId)       → returns { storageKey, ticketId }
 *   - consumeGpxUploadTicket(key, uid)  → returns true if owner+unexpired
 *
 * NOTE: This is process-local state. In a multi-instance deployment this
 * should be backed by a shared store (Redis/DB). A follow-up task tracks the
 * persistent-store migration.
 */

import { randomUUID } from "node:crypto";

interface Ticket {
  ownerId: string;
  /** Epoch ms; ticket is invalid after this time. */
  expiresAt: number;
}

const TICKET_TTL_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const tickets: Map<string, Ticket> = new Map();

let sweepTimer: NodeJS.Timeout | null = null;
function ensureSweeper() {
  if (sweepTimer != null) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, t] of tickets.entries()) {
      if (t.expiresAt <= now) tickets.delete(key);
    }
  }, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive solely for housekeeping.
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}

/**
 * Mint a new GPX upload ticket for `ownerId`. Returns the storage subPath
 * (e.g. `trails/source/<uuid>.gpx`). The caller is expected to combine this
 * with `getObjectEntityUploadURL(subPath)` to produce the signed URL.
 */
export function mintGpxUploadTicket(ownerId: string): { storageKey: string } {
  ensureSweeper();
  const storageKey = `trails/source/${randomUUID()}.gpx`;
  tickets.set(storageKey, {
    ownerId,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  return { storageKey };
}

/**
 * Normalize an object path or storage key to the canonical storage key
 * (the part after `trails/`).
 *
 *   /objects/trails/source/abc.gpx  → trails/source/abc.gpx
 *   trails/source/abc.gpx           → trails/source/abc.gpx
 */
export function objectPathToStorageKey(rawPath: string): string | null {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  let p = rawPath.trim();
  if (p.startsWith("/objects/")) p = p.slice("/objects/".length);
  if (!p.startsWith("trails/source/")) return null;
  // Reject anything weird (path traversal, double slashes).
  if (p.includes("..") || p.includes("//")) return null;
  return p;
}

/**
 * Verify that `userId` is the original uploader for `rawPath` and consume
 * the ticket (one-shot). Returns true on success, false otherwise.
 */
export function consumeGpxUploadTicket(rawPath: string, userId: string): boolean {
  const key = objectPathToStorageKey(rawPath);
  if (!key) return false;
  const ticket = tickets.get(key);
  if (!ticket) return false;
  if (ticket.expiresAt <= Date.now()) {
    tickets.delete(key);
    return false;
  }
  if (ticket.ownerId !== userId) return false;
  tickets.delete(key);
  return true;
}

/**
 * Test-only: clears the in-memory ticket map. Not exported from any public
 * barrel; only meant for unit tests if/when added.
 */
export function __clearGpxUploadTicketsForTests() {
  tickets.clear();
}
