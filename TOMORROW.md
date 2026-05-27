# TrailForge — Session Handover
**Prepared by Cowork AI | Ready for your next session**

---

## ✅ What Was Done Tonight

### 1. Fixed Windows preinstall script
The root `package.json` had a Mac/Linux-only `preinstall` script that blocked `pnpm install` on your Windows laptop. **It's been removed.** `pnpm install` will now work cleanly on Windows.

### 2. Created environment variable templates
Two `.env.local.example` files have been created with clear instructions:
- `artifacts/trailforge-mobile/.env.local.example` — for the mobile app
- `artifacts/api-server/.env.local.example` — for the API server

### 3. Written the TET GPX import script
`scripts/tet-import.ts` is ready to go. It:
- Splits TET GPX files into individual trail sections
- Detects road liaison vs off-road sections automatically
- Handles all common GPX formats from transeurotrail.org
- Skips duplicates on re-run (safe to run multiple times)
- Database triggers auto-compute bbox, elevation, and simplified paths

---

## 🚨 Important Thing to Understand

The mobile app **talks to the API server** — it can't work without it running.
Previously the API server was hosted on Replit. Now you need to run it locally on your laptop.

**Your setup needs TWO things running at the same time:**
1. The API server (`artifacts/api-server`) — on your laptop
2. The mobile app (`artifacts/trailforge-mobile`) — connects to Expo Go on your phone

---

## 🎯 Your 1-Hour Session Plan for Tomorrow

### Step 1 — Get credentials from Replit (10 mins)
Open Replit → click the 🔒 Secrets (padlock) icon → copy these values:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY` (may be called `VITE_CLERK_PUBLISHABLE_KEY` in Replit)

Note: your Supabase URL is `https://qgzbppzlwydammxxjyct.supabase.co`
(this was visible in the committed `.env.local` in the web app)

### Step 2 — Set up env files on your laptop (5 mins)
In Git Bash on your laptop:
```bash
cd ~/Trail-Forge
git pull   # ← get tonight's changes first!
```

Then copy the example files:
```bash
cp artifacts/trailforge-mobile/.env.local.example artifacts/trailforge-mobile/.env.local
cp artifacts/api-server/.env.local.example artifacts/api-server/.env.local
```

Open each `.env.local` in VS Code and fill in your values from Replit Secrets.

For `EXPO_PUBLIC_DOMAIN`, run `ipconfig` in Windows terminal and use your
IPv4 Address + `:3000`, e.g. `192.168.1.85:3000`

### Step 3 — Start the API server (5 mins)
In Git Bash (Tab 1):
```bash
cd ~/Trail-Forge/artifacts/api-server
pnpm install
pnpm dev
```
You should see: `Server listening on port 3000`

### Step 4 — Start the mobile app (5 mins)
In Git Bash (Tab 2 — open a new tab):
```bash
cd ~/Trail-Forge
pnpm --filter trailforge-mobile exec expo start --lan
```
Scan the QR code with Expo Go. App should load and let you log in with Clerk.

### Step 5 — Download and import TET data (20 mins)
1. Download UK GPX from transeurotrail.org (save to your Trail-Forge folder)
2. In Git Bash:
```bash
cd ~/Trail-Forge
pnpm add -D ts-node @supabase/supabase-js --filter @workspace/scripts
npx ts-node scripts/tet-import.ts path/to/your-tet-file.gpx
```
The script shows a summary before importing — you'll have 3 seconds to cancel.

### Step 6 — Verify on the map (5 mins)
Open the app on your phone → Map tab → trails should now appear!

---

## 🗺️ Offline Maps — Current Status

**The web app** (`artifacts/trailforge`) has a complete offline system built:
- `offlineStore.ts` — IndexedDB storage
- `downloadManager.ts` — tile + GPX download
- Works via the browser's Cache API and tile caching

**The mobile app** (`artifacts/trailforge-mobile`) does NOT yet have offline maps.
The web offline system can't be used directly in React Native.

**What's needed for mobile offline:**
- Use `expo-file-system` to cache map tiles locally
- Store trail GPX data in `AsyncStorage`
- Intercept map tile requests to serve from cache when offline
- This is approximately 1-2 weeks of work

**For now:** The web app at `http://localhost:8080` has offline capability.
Mobile offline is the next major feature to build after TET data is working.

---

## 📁 Files Changed Tonight (pull these with `git pull`)

- `package.json` — preinstall script removed (Windows fix)
- `artifacts/trailforge-mobile/.env.local.example` — NEW
- `artifacts/api-server/.env.local.example` — NEW
- `scripts/tet-import.ts` — NEW (TET import script)
- `TOMORROW.md` — this file

---

## 💡 Notes for Future Sessions

**The big remaining features in priority order:**
1. ✅ TET data import (script ready — just needs running)
2. 🔲 Mobile offline maps (2 weeks work)
3. 🔲 Route planning — link trails + road navigation (1-2 weeks)
4. 🔲 Free vs paid tier access control (1 week)
5. 🔲 TET Linesman edit interface (1-2 weeks)
6. 🔲 Bike suitability filtering UI (a few days)

**Supabase project ref:** `qgzbppzlwydammxxjyct`
**GitHub repo:** https://github.com/jlaffey1987/Trail-Forge
**Clerk app:** dashboard.clerk.com (the "TrailForge" app you created)
