# TrailForge API — Fly.io deployment checklist

Deploy from `artifacts/api-server` after running `pnpm run build` (output: `dist/index.mjs`).

## Required Fly.io secrets / environment variables

Set these on the Fly app before or after the first deploy:

| Variable | Description |
| --- | --- |
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key (same instance as mobile/web). |
| `CLERK_SECRET_KEY` | Clerk secret key for JWT verification. |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only). |
| `SKIP_SCHEMA_PREFLIGHT` | Set to `true` in production (also set in `fly.toml`). |
| `NODE_ENV` | Set to `production`. |

`PORT=8080` is configured in `fly.toml` and does not need a separate secret.

## Example: set secrets via Fly CLI

```bash
cd artifacts/api-server
fly secrets set \
  CLERK_PUBLISHABLE_KEY="pk_live_..." \
  CLERK_SECRET_KEY="sk_live_..." \
  SUPABASE_URL="https://your-project.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="your-service-role-key" \
  NODE_ENV="production"
```

## Deploy steps

1. Build the server bundle: `pnpm run build` (writes `dist/index.mjs`).
2. Deploy: `fly deploy` (from `artifacts/api-server`).
3. Verify health: `curl https://trailforge-api.fly.dev/api/health` (adjust host to your Fly app name).

## Optional environment variables

See `.env.example` for optional push (VAPID), admin allowlist, and AI scheduler settings. These are not required for a minimal production deploy.
