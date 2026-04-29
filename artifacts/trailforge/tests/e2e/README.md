# Trailforge end-to-end tests (Playwright)

Real-browser coverage for the trail-detail journey (notes, amendments,
trail-card counts) that the jsdom integration test
(`tests/TrailDetailSheet.flow.test.tsx`) only exercises with mocks. This
suite drives the live api-server + trailforge dev server through the
shared Replit proxy at `http://localhost:80`, signs in via Clerk testing
tokens, and writes/reads through the real Supabase + object-storage
backends.

See task #36 (`.local/tasks/task-36.md`) for the original requirement.

## What it covers

### `group-cover.e2e.spec.ts`

Covers the full group cover-photo flow (task #55):

1. Signs in as the e2e user.
2. Creates a fresh group via the UI (`+ New` → name → submit). The
   detail dialog auto-opens.
3. Uploads a cover (`ride-640.jpg`) via `setInputFiles` on the cover
   `<input type=file>`, asserts the cover image renders and that
   `naturalWidth > 0` (the storage proxy + ACL stamp actually worked).
4. Closes the dialog and asserts the cover thumbnail also appears on
   the corresponding `group-card-<id>` on the Groups list.
5. Reopens, replaces with `ride2-640.jpg`, asserts the image src
   changes and the new image decodes.
6. Reopens, clicks **Remove**, asserts the empty placeholder returns
   on both the dialog and the card.

A second test seeds a "stranger" group via service-role Supabase
(synthetic owner + caller-as-member row) and asserts the three cover
endpoints all return 403 for the non-admin caller via
`page.request.{post,delete}`. Cleanup wipes both the owner-flow group
and the stranger group via name + owner id, so reruns stay
deterministic.

### `trail-detail.e2e.spec.ts`

1. Programmatically signs the test user in. The Clerk dev instance
   enforces password + email_code MFA, so the spec drives both factors
   directly through `window.Clerk` using the static `+clerk_test`
   verification code (`424242`).
2. Opens a seeded public trail's detail sheet
   (`/discover?trail=<id>`).
3. Posts a note → asserts the note row, the header counts, and the
   notes-tab badge all reflect the new note.
4. Submits an amendment → asserts a row exists and the pending count
   increments in both the header and the amendments-tab badge.
5. Closes the sheet, reloads Discover, and asserts the trail card's
   `1 notes · 0 photos · 1 pending` counter matches.

## Required environment

The Playwright config assumes the same env the api-server already uses.
All of these must be present in the shell that launches the suite:

| Variable | Why |
| --- | --- |
| `VITE_CLERK_PUBLISHABLE_KEY` | Browser-side Clerk init |
| `CLERK_SECRET_KEY` | Server-side Clerk for `clerkSetup` + creating the test user |
| `SUPABASE_URL` | Service-role inserts in global setup |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role inserts in global setup |

In the Replit dev environment these are all set on the workspace.

Optional overrides:

- `E2E_USER_EMAIL`, `E2E_USER_PASSWORD` — credentials of the persistent
  Clerk test user (defaults:
  `trailforge-e2e+clerk_test@example.com` / `Trailforge-E2E-Pwd-2026!`).
  Global-setup creates the user if absent. The `+clerk_test` segment is
  required for the static MFA verification code to work.
- `E2E_API_PORT` (default `8080`), `E2E_WEB_PORT` (default `21414`),
  `E2E_PROXY_BASE_URL` (default `http://localhost:80`).

## Database prerequisites

These migrations must already be applied to the Supabase project the
tests run against (see `artifacts/trailforge/supabase/migrations/APPLIED.md`):

- `0001_trail_bbox.sql`
- `0002_users_and_owner.sql`
- `0003_rls_policies.sql`
- `0004_trail_content.sql` ← required for `trail_notes` / `trail_amendments`

The global-setup hook seeds an idempotent `[e2e] trail-detail flow`
public trail owned by the test user, and clears any leftover notes /
amendments on it before each run so the count assertions start at zero.

## Running locally

```bash
# One-time
pnpm install
pnpm --filter @workspace/trailforge exec playwright install chromium

# Run the suite (boots api-server + trailforge dev servers automatically)
pnpm test:e2e

# Or, equivalently
pnpm --filter @workspace/trailforge run test:e2e
```

By default `webServer.reuseExistingServer` is on outside CI, so if you
already have the workflows running the suite reuses them instead of
booting new ones. Inside CI (`CI=1`), Playwright owns the lifecycle.

## Running in CI

`pnpm test:e2e` is the single entry point. Make sure the runner:

1. Has the env vars listed above (same as a real Supabase / Clerk
   project).
2. Allows outbound HTTPS to `*.clerk.accounts.dev` and `*.supabase.co`.
3. Has the chromium download (`pnpm --filter @workspace/trailforge exec
   playwright install --with-deps chromium`) cached.

The suite is single-worker on purpose so the seeded trail and per-run
content cleanup stay deterministic.
