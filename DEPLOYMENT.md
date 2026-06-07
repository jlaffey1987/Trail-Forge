# TrailForge Deployment Guide

## API Server (Fly.io)

### First time setup:
1. Install Fly CLI: https://fly.io/docs/hands-on/install-flyctl/
2. Login: `flyctl auth login`
3. Build: `cd artifacts/api-server && pnpm run build`
4. Deploy: `cd artifacts/api-server && flyctl deploy`

### Environment variables to set on Fly.io:
```bash
cd artifacts/api-server
flyctl secrets set CLERK_PUBLISHABLE_KEY=pk_test_cG9ldGljLWh1c2t5LTMxLmNsZXJrLmFjY291bnRzLmRldiQ
flyctl secrets set CLERK_SECRET_KEY=<your_clerk_secret>
flyctl secrets set SUPABASE_URL=https://qgzbppzlwydammxxjyct.supabase.co
flyctl secrets set SUPABASE_SERVICE_ROLE_KEY=<your_service_role_key>
flyctl secrets set SKIP_SCHEMA_PREFLIGHT=true
flyctl secrets set NODE_ENV=production
```

### After deployment:
Update `EXPO_PUBLIC_API_BASE_URL` in the mobile app `.env.local` to the Fly.io URL:
`https://trailforge-api.fly.dev`

### Monitoring:
```bash
flyctl logs --app trailforge-api
flyctl status --app trailforge-api
```

## Mobile App
Currently tested via Expo Go on local WiFi.
Next step: EAS build for proper device testing.
