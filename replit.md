# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/api-server test` — run backend integration tests (vitest + supertest, in-memory Supabase mock)
- `pnpm --filter @workspace/trailforge test` — run trailforge UI tests (vitest + jsdom + @testing-library/react)
- `pnpm --filter @workspace/trailforge run db:migrate <file>` — apply one Supabase migration to the live project (see "Applying Supabase migrations" below)
- `pnpm --filter @workspace/trailforge run db:migrate:status` — show which migrations are applied vs pending
- `pnpm --filter @workspace/trailforge run db:migrate:all` — apply every pending Supabase migration in order

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Applying Supabase migrations

The TrailForge live database is a Supabase project (ref `qgzbppzlwydammxxjyct`,
EU-West-2 / London). New SQL migrations dropped into
`artifacts/trailforge/supabase/migrations/` are applied to it with the
`db:migrate` script in that artifact, which uses `psql --single-transaction
-v ON_ERROR_STOP=1` and records every successful run in a
`schema_migrations(filename text PK, applied_at timestamptz)` ledger table on
the live database. The ledger is locked down with RLS (anon and authenticated
keys see nothing — only the direct DB connection / service role can read or
write it), so re-running the script is safe and idempotent.

**Prerequisite**: the script shells out to `psql`. The Replit container
already has it on PATH (PostgreSQL 16 from nix); if you ever run this
elsewhere, install the `postgresql-client` package first.

**Setup** (one time): the script reads `SUPABASE_DB_PASSWORD` from secrets
(plus `SUPABASE_URL` to derive the project ref) and builds the pooler URL
`postgresql://postgres.<ref>:<password>@aws-1-eu-west-2.pooler.supabase.com:5432/postgres`.
The direct `db.<ref>.supabase.co:5432` host is IPv6-only and not reachable
from the Replit container — the pooler is required. Override the host or
region with `SUPABASE_DB_HOST` / `SUPABASE_DB_REGION` if the project ever
moves; or set `SUPABASE_DB_URL` to a full connection string to bypass the
builder entirely.

**Typical flow:**

```bash
# What's pending?
pnpm --filter @workspace/trailforge run db:migrate:status

# Apply a single new file (basename, path, or just the prefix all work):
pnpm --filter @workspace/trailforge run db:migrate 0011_trail_elevation_profile.sql

# Apply every pending migration in order:
pnpm --filter @workspace/trailforge run db:migrate:all

# Re-apply (only when you really mean it — the migration must be idempotent):
pnpm --filter @workspace/trailforge run db:migrate 0007_ai_discovery.sql --force
```

If the `psql` step fails the transaction is rolled back and the ledger is
not updated, so the script can be safely re-run after fixing the migration.
The `supabase/migrations/APPLIED.md` log is the historical record from
before the ledger existed; new migrations no longer need to be appended
there — `db:migrate:status` is the source of truth.

## Artifacts

- **trailforge** (`artifacts/trailforge`) — Off-road navigator web app (React + Vite, Supabase, Mapbox/Leaflet).
  - Auth: Clerk (`@clerk/react`) — see `src/App.tsx` for `<ClerkProvider>` + wouter routing, `src/components/UserMenu.tsx`, `src/hooks/useCurrentUser.ts`.
  - **Offline support (PWA)**: trails can be downloaded for fully offline use. Core modules: `src/lib/offlineStore.ts` (IndexedDB wrapper for trail data + Cache API for Esri tiles; `OfflineTrail` stores `tileUrls: string[]` per trail for per-trail tile cleanup; centralised change notifications via `subscribeOfflineStoreChanges` so hooks update on save/remove/clear), `src/lib/downloadManager.ts` (orchestrates GPX + photos + map tiles download with true item-level progress — total = 1 gpx + N photos + M tiles; `estimateDownloadSize()` warns >100MB before download; cancel support), `src/lib/offlineQueue.ts` (queues actions taken offline — mark-ridden / unmark-ridden — replays on reconnect with concurrency guard; unknown action types expire after 5 retries; replay failures surfaced in OfflineReplayBridge toast with retry/dismiss). SW (`public/sw.js`) intercepts Esri tile requests with cache-first strategy and serves a grey placeholder when offline+uncached. **Install prompt**: `useInstallPrompt` hook captures `beforeinstallprompt`, `InstallBanner` component in MainShell header shows install CTA with dismiss; tracks `appinstalled` and `display-mode: standalone` for installed state. **Connectivity detection**: `useOnlineStatus` hook combines `navigator.onLine` events with periodic `/api/healthz` HEAD ping (30s interval, 5s timeout) so stale Wi-Fi or captive portals are detected. UI: "↓ Offline" button on saved trail cards (MyTrailsTab, aborts on unmount; large download confirm dialog >100MB), "Offline · 4 May" badge with downloaded-at date on trail cards, "Available offline" green badge with date in TrailDetailSheet, "Offline" badge in header when `navigator.onLine` is false, "Manage offline storage" section in SettingsDialog (error-guarded remove/clear). Per-trail tile removal: `removeOfflineTrail` reads `tileUrls` before deletion and removes only tiles not shared by other offline trails. Offline-first trail list: MyTrailsTab falls back to `listOfflineTrails()` on cold-start offline (checks `navigator.onLine` when API returns empty). TrailDetailSheet hydrates offline GPX into the global `trailGpxCache` via `populateTrailGpxCache()` so planner/navigation flows work offline. TrailPhotosPanel falls back to offline-stored photo blobs (via `offlinePhotos` prop from TrailDetailSheet) when offline, creating blob URLs for `<img>` and PhotoLightbox. Hooks: `useOnlineStatus`, `useInstallPrompt`, `useOfflineTrails`, `useIsTrailOffline` (subscribe to offlineStore, not downloadManager). `completionsStore.ts` queues mark/unmark-ridden actions via `offlineQueue` when the network fetch fails while offline.
  - Data: Supabase tables `trails`, `saved_trails`, `users`. Migrations live in `supabase/migrations/` and are applied with the one-step `db:migrate` command (see "Applying Supabase migrations" below). The legacy "paste into the SQL editor" flow is no longer required.
  - User-account migration `0002_users_and_owner.sql` adds the `users` table (Clerk-keyed), `trails.owner_user_id`, and `saved_trails.user_id`. Apply this before users sign in for the first time.
  - RLS migration `0003_rls_policies.sql` locks down anon access: anon may only `SELECT` public trails. All ownership-sensitive reads/writes go through the API server (service-role key, Clerk-authenticated). Apply after 0002.
  - Saved trails are session-bound for guests and user-bound after sign-in. `SavedTrailsMergePrompt` offers a one-time merge of session bookmarks into a freshly signed-in account.
  - Browser writes flow through `/api/me/*`, `/api/trails`, and `/api/storage/uploads/*` — never directly via the supabase anon client. The anon client (`src/lib/supabase.ts`) is used only for public trail reads.
  - **AI grading + external discovery (migration 0007)**: trails carry `source` (`user` / `tet` / `act` / `ai-forum` / `ai-approx`), `source_url`, `verification_status` (`verified` / `ai-approximated` / `unverified`), `ai_grade`, `ai_grade_rationale`, `ai_grade_model`, `ai_graded_at`. Admin-only endpoints under `/api/admin/*` (forum scan, harvest TET/ACT, review queue, grade backfill) are gated by `isSystemAdmin()` (`artifacts/api-server/src/lib/admin.ts`), which checks the `system_admins` table (Clerk `user_id` PK, RLS-locked to service role only). **Bootstrap order**: the env-var fallback `SYSTEM_ADMIN_USER_IDS` (comma-separated Clerk user ids, set on the API server in the `shared` environment) is honoured first and lets you unlock `/admin` *before* any row exists in `system_admins` — useful immediately after applying 0007 to a fresh project. Once you can reach `/admin`, persist additional admins by inserting rows into `system_admins` (any service-role caller can do this; e.g. `POST /rest/v1/system_admins` with the service-role key, or via the Supabase SQL editor). The seed row for the workspace owner Clerk user (`jlaffey1987@gmail.com` → `user_3CyzjHG396eeQ26BuOnuZY9y1hc`) was inserted as part of task 23. Admin dashboard lives at `/admin`. The AI tab calls `POST /api/ai/chat` with the current map bbox to ground replies in nearby and saved trails. Re-grade button on trail detail calls `POST /api/trails/:id/grade-ai`. TET/ACT licensing decision (link-out only — no GPX rehost) is documented in `artifacts/trailforge/docs/tet-act-licensing-spike.md`.
  - **Groups + group-shared trails (migration 0006)**: tables `groups`, `group_members`, `group_invites`, `trail_shares`. Groups are private — `groups`/`group_members`/`group_invites`/`trail_shares` reject all anon/authenticated access; reads/writes flow through the API server (`/api/groups*`, `/api/me/invites*`, `/api/trails/:id/shares`) using the service-role key with Clerk-authenticated owner/role checks. The `trails_public_read` anon policy is intentionally unchanged: anon still only sees `is_public = true AND deleted_at IS NULL`. Group privacy on a trail keeps the row private (`is_public=false`); members see those trails through `GET /api/me/group-trails` (returns owner-private + group-shared trails decorated with `shared_groups: [{id, name}]`). The Save/Edit Trail forms (`SaveTrailForm.tsx`, `EditTrailDialog.tsx`) expose the "Group" privacy option with a multi-select; callers create the trail then call `setTrailShares(trailId, ids)` to persist `trail_shares` rows.
  - **Group activity notifications (migration 0010)**: adds `users.notifications_read_at timestamptz` cutoff column. The feed itself is computed on demand by `GET /api/me/notifications?limit=&before=` from the existing append-only `trail_shares` and `group_members` tables (no separate event log) — returns `{ items, unreadCount, lastReadAt, nextBefore }`. `POST /api/me/notifications/read` bumps the cutoff to `now()`. UI: `<NotificationsBell />` in the header polls every 60s, listens for `GROUPS_MEMBERSHIP_CHANGED_EVENT`, opens an inline panel with paginated entries; `member_joined` entries open `<GroupDetailDialog>`, `trail_shared` entries dispatch `trailforge:open-trail` (handled in `App.tsx` → switches to Discover tab + `?trail=<id>` → `DiscoverTab` opens `<TrailDetailSheet>`). Both endpoints gracefully 503 with a "migration not provisioned" message when the column is missing.
  - **OS-level push notifications (migration 0014)**: Web Push (VAPID) fan-out for the same two events as the bell — trail shared into a group + new member joined. Migration adds `users.push_notifications_enabled bool default true` and `push_subscriptions(id, user_id FK→users on cascade, endpoint UNIQUE, p256dh, auth, user_agent, last_seen_at)`. Server: `lib/pushNotifications.ts` wraps `web-push` with `notifyTrailShared(trailId, groupIds, actor, log)` + `notifyMemberJoined(groupId, joiner, log)`; both are fire-and-forget (`void`-called from `routes/trails.ts` POST/PATCH and `routes/groups.ts` PUT shares + 3 join handlers — token accept, id accept, auto-accept, join-request approve), prune 404/410 stale subs, respect the opt-out flag, and no-op when VAPID env vars are missing. Routes (`routes/push.ts`): `GET /api/me/push/public-key` (503 when unconfigured), `POST/DELETE /api/me/push/subscribe`, `GET/PUT /api/me/push/preferences`. Env vars: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (default `mailto:notifications@trailforge.app`). Frontend: `src/lib/push.ts` (subscribe/unsubscribe/prefs), `<SettingsDialog>` mounted from the new "Settings" entry in `<UserMenu>`, service worker (`public/sw.js`) handles `push` + `notificationclick` and deep-links to `/?trail=<id>` or `/?group=<id>`. `App.tsx` consumes both query params on mount and dispatches `trailforge:open-trail` / `trailforge:open-group`; `<GroupsSection>` reads `?group=` to auto-open the matching `<GroupDetailDialog>`.
  - **Trail adoption + amendment categories (migration 0024)**: adds `trails.adopted_at timestamptz`, `trail_adoptions` audit table, and `trail_amendments.reason_category` (`route_change` / `difficulty_change` / `request_removal` / `other`). `POST /api/trails/:trailId/adopt` lets any signed-in user claim an unowned trail (sets `owner_user_id`, logs to `trail_adoptions`). Amendments now carry an optional `reason_category`; the propose-edit form shows a 4-option category selector. `request_removal` hides the field editors and sets `proposed_changes.action = "remove"`. Approving a removal amendment soft-deletes the trail (`deleted_at` + `is_public=false`). The moderation panel shows coloured category tags per amendment and a confirmation dialog before approving removals. The Overview tab has a prominent "Propose an Edit" button (switches to Edits tab) and an "Adopt this trail" button on unowned trails with "Adopted by" attribution after adoption.
  - **Cloud-synced planner route (migration 0012)**: adds `planner_routes (user_id text PK → users.id, trail_ids jsonb, updated_at timestamptz)`. The Map-tab Route panel + Planner share `src/lib/plannerRouteStore.ts`, which still writes to localStorage (so guests work) but, when signed in, debounces a `PUT /api/me/planner-route` after every change and fetches `GET /api/me/planner-route` on sign-in to restore the route across devices. `App.tsx`'s `ClerkUserSync` calls `setPlannerRouteUserId(user.id|null)` whenever Clerk's signed-in state changes. Both endpoints tolerate the table being missing (table-not-provisioned → no-op so the UI keeps working). Trail rows are hydrated server-side using the same slim column projection the Map tab uses; soft-deleted or now-private trails come back as "Unavailable trail" stubs so the route UI doesn't crash.
  - **In-app chat (migration 0025)**: tables `chat_rooms` (kind: group/dm, FK to groups), `chat_room_members` (user_id, role, last_read_at, archived_at), `chat_messages` (sender, body, deleted_at/by), `user_blocks` (blocker/blocked). Triggers auto-create a group chat room on group insert and mirror group_members inserts/deletes to chat_room_members. Backfill creates rooms for pre-existing groups. Server routes (`routes/chat.ts`): GET /chat/rooms (inbox with per-room last message + unread count), GET /chat/rooms/:id/messages (paginated, returns userRole for admin-delete UI), POST send, DELETE message (own or admin), POST /chat/dm/:userId/open (shared-group check), POST mark-read, POST archive, GET /chat/stream (SSE with new_message/message_deleted/room_read events), POST/DELETE block, GET block-list, GET unread-count. Rate limiting: 30 msgs/min per user. Frontend: `lib/chat.ts` (fetch wrappers + SSE/polling fallback), `ChatInboxPage` (room list, archive toggle, block list), `ChatThreadPage` (bubbles, composer, delete with role-based visibility, URL auto-linking, blocked/deleted placeholders, infinite scroll), `ChatMessagesBadge` (unread count in header).
  - **Google Maps-style navigation**: The NavigationView has heading-up map rotation, a top-down motorbike SVG marker, and a compass widget. Key modules: `src/lib/useHeading.ts` (device orientation + GPS heading with low-pass smoothing), `src/lib/navigationReroute.ts` (off-route detection, auto re-route logic for road sections via OSRM with 10s cooldown and 3-failure give-up; trail sections never auto-reroute). The map container is oversized (130%) and CSS-rotated for heading-up mode; the compass widget in the corner toggles heading-up / north-up (persisted in localStorage). Off-route on trail sections shows "Return to the marked path. Trail sections aren't recalculated." Off-route on road sections triggers automatic OSRM re-routing with "Recalculating…" → "Re-routed" toasts.
  - **Anthropic AI integration**: `lib/integrations-anthropic-ai` exposes `anthropic` (provisioned via `setupReplitAIIntegrations`). Uses `claude-sonnet-4-6` with `max_tokens: 8192`. Env vars: `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`, `AI_INTEGRATIONS_ANTHROPIC_API_KEY`.
- **api-server** (`artifacts/api-server`) — Express API. Mounts a Clerk reverse proxy at `/clerk-fapi` (see `src/middlewares/clerkProxyMiddleware.ts`), an object-storage signed-URL + finalize endpoint under `/api/storage/*`, ownership-enforced trail/user/saved-trail endpoints under `/api/me/*` and `/api/trails`. Uses `SUPABASE_SERVICE_ROLE_KEY` (`src/lib/supabaseAdmin.ts`) to bypass RLS while stamping `owner_user_id` / `user_id` from the verified Clerk session.
- **mockup-sandbox** (`artifacts/mockup-sandbox`) — Design canvas.
