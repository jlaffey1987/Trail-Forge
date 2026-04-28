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

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

- **trailforge** (`artifacts/trailforge`) — Off-road navigator web app (React + Vite, Supabase, Mapbox/Leaflet).
  - Auth: Clerk (`@clerk/react`) — see `src/App.tsx` for `<ClerkProvider>` + wouter routing, `src/components/UserMenu.tsx`, `src/hooks/useCurrentUser.ts`.
  - Data: Supabase tables `trails`, `saved_trails`, `users`. Migrations live in `supabase/migrations/` and are applied manually via the Supabase SQL editor.
  - User-account migration `0002_users_and_owner.sql` adds the `users` table (Clerk-keyed), `trails.owner_user_id`, and `saved_trails.user_id`. Apply this before users sign in for the first time.
  - RLS migration `0003_rls_policies.sql` locks down anon access: anon may only `SELECT` public trails. All ownership-sensitive reads/writes go through the API server (service-role key, Clerk-authenticated). Apply after 0002.
  - Saved trails are session-bound for guests and user-bound after sign-in. `SavedTrailsMergePrompt` offers a one-time merge of session bookmarks into a freshly signed-in account.
  - Browser writes flow through `/api/me/*`, `/api/trails`, and `/api/storage/uploads/*` — never directly via the supabase anon client. The anon client (`src/lib/supabase.ts`) is used only for public trail reads.
  - **AI grading + external discovery (migration 0007)**: trails carry `source` (`user` / `tet` / `act` / `ai-forum` / `ai-approx`), `source_url`, `verification_status` (`verified` / `ai-approximated` / `unverified`), `ai_grade`, `ai_grade_rationale`, `ai_grade_model`, `ai_graded_at`. Admin-only endpoints under `/api/admin/*` (forum scan, harvest TET/ACT, review queue, grade backfill) are gated by `isSystemAdmin()` (`artifacts/api-server/src/lib/admin.ts`), which checks the `system_admins` table (Clerk `user_id` PK, RLS-locked to service role only). **Bootstrap order**: the env-var fallback `SYSTEM_ADMIN_USER_IDS` (comma-separated Clerk user ids, set on the API server in the `shared` environment) is honoured first and lets you unlock `/admin` *before* any row exists in `system_admins` — useful immediately after applying 0007 to a fresh project. Once you can reach `/admin`, persist additional admins by inserting rows into `system_admins` (any service-role caller can do this; e.g. `POST /rest/v1/system_admins` with the service-role key, or via the Supabase SQL editor). The seed row for the workspace owner Clerk user (`jlaffey1987@gmail.com` → `user_3CyzjHG396eeQ26BuOnuZY9y1hc`) was inserted as part of task 23. Admin dashboard lives at `/admin`. The AI tab calls `POST /api/ai/chat` with the current map bbox to ground replies in nearby and saved trails. Re-grade button on trail detail calls `POST /api/trails/:id/grade-ai`. TET/ACT licensing decision (link-out only — no GPX rehost) is documented in `artifacts/trailforge/docs/tet-act-licensing-spike.md`.
  - **Groups + group-shared trails (migration 0006)**: tables `groups`, `group_members`, `group_invites`, `trail_shares`. Groups are private — `groups`/`group_members`/`group_invites`/`trail_shares` reject all anon/authenticated access; reads/writes flow through the API server (`/api/groups*`, `/api/me/invites*`, `/api/trails/:id/shares`) using the service-role key with Clerk-authenticated owner/role checks. The `trails_public_read` anon policy is intentionally unchanged: anon still only sees `is_public = true AND deleted_at IS NULL`. Group privacy on a trail keeps the row private (`is_public=false`); members see those trails through `GET /api/me/group-trails` (returns owner-private + group-shared trails decorated with `shared_groups: [{id, name}]`). The Save/Edit Trail forms (`SaveTrailForm.tsx`, `EditTrailDialog.tsx`) expose the "Group" privacy option with a multi-select; callers create the trail then call `setTrailShares(trailId, ids)` to persist `trail_shares` rows.
  - **Group activity notifications (migration 0010)**: adds `users.notifications_read_at timestamptz` cutoff column. The feed itself is computed on demand by `GET /api/me/notifications?limit=&before=` from the existing append-only `trail_shares` and `group_members` tables (no separate event log) — returns `{ items, unreadCount, lastReadAt, nextBefore }`. `POST /api/me/notifications/read` bumps the cutoff to `now()`. UI: `<NotificationsBell />` in the header polls every 60s, listens for `GROUPS_MEMBERSHIP_CHANGED_EVENT`, opens an inline panel with paginated entries; `member_joined` entries open `<GroupDetailDialog>`, `trail_shared` entries dispatch `trailforge:open-trail` (handled in `App.tsx` → switches to Discover tab + `?trail=<id>` → `DiscoverTab` opens `<TrailDetailSheet>`). Both endpoints gracefully 503 with a "migration not provisioned" message when the column is missing.
  - **Anthropic AI integration**: `lib/integrations-anthropic-ai` exposes `anthropic` (provisioned via `setupReplitAIIntegrations`). Uses `claude-sonnet-4-6` with `max_tokens: 8192`. Env vars: `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`, `AI_INTEGRATIONS_ANTHROPIC_API_KEY`.
- **api-server** (`artifacts/api-server`) — Express API. Mounts a Clerk reverse proxy at `/clerk-fapi` (see `src/middlewares/clerkProxyMiddleware.ts`), an object-storage signed-URL + finalize endpoint under `/api/storage/*`, ownership-enforced trail/user/saved-trail endpoints under `/api/me/*` and `/api/trails`. Uses `SUPABASE_SERVICE_ROLE_KEY` (`src/lib/supabaseAdmin.ts`) to bypass RLS while stamping `owner_user_id` / `user_id` from the verified Clerk session.
- **mockup-sandbox** (`artifacts/mockup-sandbox`) — Design canvas.
