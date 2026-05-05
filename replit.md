# Overview

This project is a pnpm workspace monorepo using TypeScript, focused on developing "TrailForge," an off-road navigator web application. TrailForge aims to provide a comprehensive platform for users to discover, plan, and navigate off-road trails, with a strong emphasis on offline capabilities, community features, and AI-driven trail discovery. The project leverages modern web technologies and a microservices-like architecture to deliver a robust and scalable application.

## User Preferences

I prefer iterative development and welcome questions for clarification. Please ensure all changes are thoroughly tested.

## System Architecture

The project is structured as a pnpm monorepo.

**Technology Stack:**
- **Monorepo:** pnpm workspaces
- **Node.js:** 24
- **TypeScript:** 5.9
- **API:** Express 5
- **Database:** PostgreSQL + Drizzle ORM
- **Validation:** Zod (`zod/v4`), `drizzle-zod`
- **API Codegen:** Orval (from OpenAPI spec)
- **Build:** esbuild (CJS bundle)

**UI/UX and Frontend (TrailForge):**
- Built with React and Vite.
- **Authentication:** Clerk (`@clerk/react`).
- **Mapping:** Mapbox/Leaflet.
- **Offline Support (PWA):**
    - Trails can be downloaded for full offline use.
    - `offlineStore.ts` for IndexedDB and Cache API management.
    - `downloadManager.ts` orchestrates GPX, photos, and map tile downloads with progress tracking and cancellation.
    - `offlineQueue.ts` for replaying offline actions on reconnect.
    - Service Worker (`public/sw.js`) intercepts Esri tile requests and provides offline placeholders.
    - Install prompt via `useInstallPrompt` hook and `InstallBanner` component.
    - Connectivity detection using `useOnlineStatus` (navigator.onLine + periodic API pings).
    - UI elements for managing offline content.
- **Navigation:**
    - `NavigationView` features heading-up map rotation, motorbike SVG marker, and a compass widget. Uses CARTO Dark Matter road-focused tiles (not satellite). Smooth following with 5m threshold, 0.6s pan animation, forward-look bias in heading-up mode.
    - `useHeading.ts` for device orientation and GPS heading with heavy low-pass smoothing (α=0.05), 3° dead zone, render-gated setState.
    - `navigationReroute.ts` for off-route detection, with auto re-routing on road sections via OSRM.
    - **Trails-only routing:** End destination is optional when trails are in the route. `AssembledRoute.end` is `GeoPoint | null`; when null, no final road leg is built and NavigationView omits the B marker.
    - **Auto-order:** `orderTrailsNearestNeighbour` in `routing.ts` reorders trails using a greedy nearest-neighbour algorithm, evaluating both endpoints of each trail for bidirectional access. Waypoint positions are preserved during reordering.
    - **Bidirectional trail access:** `assembleMultiModalRoute` evaluates distance from current point to both ends of each trail and reverses waypoints if entering from the far end is shorter.
- **Draw Trail Point Editing:**
    - In draw mode, waypoint markers are numbered (A, 2, 3…B). Tap a marker to select it (turns blue); the bottom bar shows coordinates and a red "Remove" button that deletes just that point (polyline reconnects through remaining points). A blue ⊗ button also appears in the top toolbar.
    - Long-press (400ms, 10px movement threshold) a marker to enter drag mode and reposition it — the polyline updates on drop.
    - "Done" deselects. Undo removes last point; clear removes all.
- **Groups and Sharing:** Private groups with memberships, invites, and trail sharing features.
- **Notifications:** In-app and OS-level push notifications for group activities (trail shares, new members). Per-group push preferences let users silence individual groups without disabling all notifications.
- **Trail Adoption & Amendments:** Users can adopt unowned trails and propose edits with categorized reasons.
- **Cloud-synced Planner Route:** Planner route syncs across devices for signed-in users, with localStorage fallback for guests. The shared `plannerRouteStore.ts` is the single source of truth for `routeTrails`, `routeEntries`, `routeStart`, and `routeEnd`. Cloud sync schema (`PUT /api/me/planner-route`) carries only `{trailIds, waypoints, entryOrder}` — `routeStart`/`routeEnd` are LOCAL-ONLY (per-device). PlannerTab mirrors local `geocodedStart`/`geocodedEnd` ⇄ store with loop-safe equality checks.
- **Live Map Route Editor:** The Map tab (Explore mode) acts as a live editor on the shared planner route. Tapping trails on the map adds/removes them from the same `plannerRouteStore` that the Planner tab uses (no copy step). A floating pill at the bottom-left exposes Set A / Set B drop-pin affordances — armed mode cursor turns crosshair, the next click captures lat/lng + best-effort `reverseGeocode` (fallback "Pinned location"). A/B markers and a cyan (#38bdf8) live road-routed polyline (via `assembleMultiModalRoute`, debounced 300ms with sequence-guard) render in step with the store. Map mutations NEVER auto-fit — the rider's pan/zoom is preserved; "Fit" is opt-in via the pill button. Dashed straight connectors hide whenever the live polyline is rendered.
- **Search, Select & Auto-Route Trails on Map:**
    - Server endpoint `GET /api/trails/search?q=...&limit=N` in `trails.ts` — visibility-aware: always searches public trails by name and `source_region`; for authenticated users also includes group-shared trails via `trail_shares` + `group_members` joins.
    - OpenAPI spec updated with `/trails/search` path, `TrailSearchResult`/`TrailSearchResponse` schemas, and `Trails` tag. Codegen produces `useSearchTrails` hook and `SearchTrailsQueryParams`/`SearchTrailsResponse` Zod schemas.
    - `MapTrailSearch` component: debounced search bar on Map tab (Explore mode) uses generated `searchTrails()` client. Results show difficulty dot, name, distance, region (`source_region`), and an Add/Added toggle. Fly-to on click.
    - Users add multiple trails to their route from search results or by tapping trails on the map.
    - "Build Route" button in `MapRoutePanel` (disabled when < 2 trails) opens a start chooser dialog: "Start from my location" (GPS) or "Start from first trail".
    - `doBuildFromSelection` in `MapTab.tsx` hydrates GPX data, auto-orders trails via `orderTrailsNearestNeighbour`, assembles the route with OSRM road connectors via `assembleMultiModalRoute`, then hands off to PlannerTab via `sessionStorage` + `?fromSelection=1` query param.
    - PlannerTab detects `?fromSelection=1`, reads the pre-assembled route from sessionStorage, and displays it in navigation view — no start/end address entry required.
    - Edge cases: geolocation denied falls back to first-trail start, missing geometry shows error, OSRM failure shows warning, column-missing DB schemas handled with `select("*")` fallback.
- **In-app Chat:** Group and direct messaging with real-time updates, read receipts, and user blocking.

**Backend (api-server):**
- Express API server.
- Mounts a Clerk reverse proxy at `/clerk-fapi`.
- Handles object storage signed URLs and finalization.
- Provides ownership-enforced endpoints for trails, users, and saved trails.
- Utilizes `SUPABASE_SERVICE_ROLE_KEY` to bypass RLS for specific operations.
- Implements schema preflight checks on startup.

**Data and AI:**
- **PostgreSQL Database:** Managed with Drizzle ORM.
- **Supabase:** Used for the live database, with migrations applied via a custom `db:migrate` script.
- **AI Integration:** Anthropic AI (Claude Sonnet 4.6) for AI grading and external discovery of trails. AI features include `ai_grade`, `ai_grade_rationale`, and admin-only endpoints for content harvesting and review.
- **RLS Policies:** Granular Row-Level Security policies are applied to protect data.

**Other Components:**
- **mockup-sandbox:** A design canvas for mockups.

## External Dependencies

- **Clerk:** For user authentication and management.
- **Supabase:** Live PostgreSQL database hosting, including RLS and storage.
- **Mapbox/Leaflet:** For interactive maps and navigation features.
- **Anthropic AI:** For AI-driven trail grading and discovery.
- **OSRM:** Used for road section re-routing in navigation.
- **web-push:** For sending OS-level push notifications.
