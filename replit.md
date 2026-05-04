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
    - `NavigationView` features heading-up map rotation, motorbike SVG marker, and a compass widget.
    - `useHeading.ts` for device orientation and GPS heading.
    - `navigationReroute.ts` for off-route detection, with auto re-routing on road sections via OSRM.
- **Groups and Sharing:** Private groups with memberships, invites, and trail sharing features.
- **Notifications:** In-app and OS-level push notifications for group activities (trail shares, new members).
- **Trail Adoption & Amendments:** Users can adopt unowned trails and propose edits with categorized reasons.
- **Cloud-synced Planner Route:** Planner route syncs across devices for signed-in users, with localStorage fallback for guests.
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
