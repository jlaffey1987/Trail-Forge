# Migration application log

This file records when each Supabase migration in this directory was
applied to the live project (`qgzbppzlwydammxxjyct`). The convention for
this project is **"apply migrations manually via the Supabase SQL editor"**
(or equivalently via a service-role HTTP / `psql` round-trip), so this
log is the only audit trail we have. Append a new entry when you apply a
migration; do not rewrite history.

| Migration | Applied at (UTC) | Applied by | Notes |
| --- | --- | --- | --- |
| 0001_trail_bbox.sql | (pre-log) | — | applied before this log was started |
| 0001a_legacy_schema_cleanup.sql | (pre-log) | — | applied before this log was started |
| 0002_users_and_owner.sql | (pre-log) | — | applied before this log was started |
| 0002a_saved_trails_user_unique.sql | (pre-log) | — | applied before this log was started |
| 0003_rls_policies.sql | (pre-log) | — | applied before this log was started |
| 0004_trail_content.sql | (pre-log) | — | applied before this log was started |
| 0005_member_trails.sql | (pre-log) | — | applied before this log was started |
| 0006_groups.sql | (pre-log) | — | applied before this log was started |
| 0007_ai_discovery.sql | 2026-04-28 (verified) | task-23 / agent | DDL was already in place when task 23 ran; verification: `system_admins`, `ai_discovered_trails`, `forum_sources` exist, RLS denies anon, all `trails.ai_*` + `source` + `verification_status` columns present, `trails_source_check` / `trails_verification_status_check` / `trails_ai_grade_range` / `ai_discovered_status_check` / `ai_discovered_source_check` constraints + `ai_discovered_source_url_idx` unique index all firing as expected. Workspace owner (`user_3CyzjHG396eeQ26BuOnuZY9y1hc` / jlaffey1987@gmail.com) inserted into `system_admins` as bootstrap admin. |
| 0008_trail_simplified_path.sql | (status not verified by task 23) | — | re-check next time it matters |
| 0009_act_imports.sql | (status not verified by task 23) | — | re-check next time it matters |
| 0010_group_notifications.sql | (status not verified by task 23) | — | re-check next time it matters |
| 0011_trail_elevation_profile.sql | (pending — apply manually) | task-27 / agent | Adds `elevation_profile jsonb`, `elevation_gain_m int`, `elevation_loss_m int` to `trails`. Two new helper fns (`trailforge_extract_elevations`, `trailforge_build_elevation`), one new BEFORE INSERT/UPDATE OF gpx_data trigger (`trails_elevation_profile_trigger`), and a LATERAL backfill for existing rows. Same shape as 0008 — safe to re-run (uses `CREATE OR REPLACE` + `ADD COLUMN IF NOT EXISTS` + `DROP TRIGGER IF EXISTS`). The TrailDetailSheet hides the chart gracefully when columns are absent or `elevation_profile` is NULL, so the UI is forward-compatible with un-applied DBs. |

## How to apply a new migration

1. Open the Supabase SQL editor for project
   `qgzbppzlwydammxxjyct` (URL in `SUPABASE_URL`).
2. Paste the migration file contents in order; run it.
3. Append a new row above with the UTC timestamp, who applied it, and any
   notable side effects (e.g. backfills, env vars to set).
4. If the migration introduces a new admin / service-role-only table,
   verify RLS denies anon (use the anon key) before announcing it ready.

## Bootstrap notes for migration 0007

After 0007 is applied, the API server's `isSystemAdmin()` check
(`artifacts/api-server/src/lib/admin.ts`) gates every `/api/admin/*`
route. To unlock the `/admin` UI:

- **Fast path**: set `SYSTEM_ADMIN_USER_IDS` (comma-separated Clerk user
  ids) on the API server in the `shared` environment. Honoured before
  the DB lookup, so it works even if `system_admins` is empty.
- **Persistent path**: insert a row into `system_admins` (service-role
  only — RLS blocks anon and authenticated):

  ```sql
  INSERT INTO system_admins (user_id, granted_by, note)
  VALUES ('user_xxx', 'manual bootstrap', 'note about who/why')
  ON CONFLICT (user_id) DO NOTHING;
  ```
