# TrailForge Manual Testing Checklist

Last updated: 2026-06-03  
Tester: _______________  Date: _______________

Mark each test: ✅ Pass | ❌ Fail | ⚠️ Partial | ⏭ Skipped

---

## 0. Pre-flight

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 0.1 | API server starts with `pnpm dev:mobile-api` | | |
| 0.2 | Expo Metro bundler starts and shows QR code | | |
| 0.3 | App loads in Expo Go on physical device | | |
| 0.4 | Startup diagnostics in Metro log show ✅ for API health | | |
| 0.5 | Startup diagnostics show correct Clerk environment (DEVELOPMENT) | | |
| 0.6 | Startup diagnostics show Supabase reachable | | |
| 0.7 | No red error screen on first launch | | |

---

## 1. Authentication

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1.1 | Sign-in screen shows TrailForge logo | | |
| 1.2 | Email OTP login completes without error | | |
| 1.3 | After login, app navigates to tabs (map or intro) | | |
| 1.4 | No "API sync failed 401" error after login | | |
| 1.5 | User profile syncs to Supabase (visible in DB) | | |
| 1.6 | Sign out works from profile menu | | |
| 1.7 | Re-login after sign-out works | | |
| 1.8 | Token persists across app restart (no re-login needed) | | |

---

## 2. Intro & Onboarding

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 2.1 | `intro.mp4` plays automatically on first launch | | |
| 2.2 | Video is silent (no audio) | | |
| 2.3 | "TrailForge" text slides in with amber underline | | |
| 2.4 | Fade-to-black occurs before advancing | | |
| 2.5 | Onboarding shows on first launch after sign-up | | |
| 2.6 | Swipe between onboarding screens works | | |
| 2.7 | Amber progress dots update correctly (5 screens) | | |
| 2.8 | Screen 5: bike type selection saves to profile | | |
| 2.9 | Screen 5: skill slider (1-10) saves to profile | | |
| 2.10 | "Start Riding" navigates to map tab | | |
| 2.11 | Intro/onboarding does NOT show on second launch | | |
| 2.12 | Redo onboarding from Settings works | | |

---

## 3. Map Screen

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 3.1 | Map loads centred on user location | | |
| 3.2 | TET trail sections appear as coloured polylines | | |
| 3.3 | Grade 1-3 trails are green | | |
| 3.4 | Grade 4-6 trails are blue | | |
| 3.5 | Grade 7-9 trails are orange | | |
| 3.6 | Grade 10 trails are red | | |
| 3.7 | Road liaison sections appear as grey dashed lines | | |
| 3.8 | Seasonal trails appear as dashed lines | | |
| 3.9 | Tap a trail opens detail bottom sheet | | |
| 3.10 | Trail bottom sheet shows name, grade, distance | | |
| 3.11 | Condition indicator shown on trail (if reported) | | |
| 3.12 | FILTERS button visible bottom-right | | |
| 3.13 | FILTERS sheet opens on tap | | |
| 3.14 | Difficulty slider filters trail grades | | |
| 3.15 | Bike type chip filters trails | | |
| 3.16 | Map layer toggles work (satellite, etc.) | | |
| 3.17 | Apply Filters button closes sheet and applies | | |
| 3.18 | Reset button clears filters | | |
| 3.19 | Active filter shown with indicator dot on button | | |
| 3.20 | 🗺️ PLAN A RIDE button visible, centred above tabs | | |
| 3.21 | PLAN A RIDE navigates to Planner tab | | |
| 3.22 | Re-centre button snaps map back to user location | | |
| 3.23 | Search bar accepts input and returns results | | |
| 3.24 | Free tier users see upgrade prompt when filtering | | |

---

## 4. Trail Detail Screen

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 4.1 | Tapping a trail on map opens trail detail | | |
| 4.2 | Trail name displays correctly | | |
| 4.3 | Difficulty grade shown with correct colour badge | | |
| 4.4 | Distance shown in km | | |
| 4.5 | Elevation gain/loss shown (if data exists) | | |
| 4.6 | Elevation chart renders | | |
| 4.7 | Surface type shown (trail / road) | | |
| 4.8 | TET track name shown | | |
| 4.9 | Seasonal warning banner shown for seasonal trails | | |
| 4.10 | Community conditions shown | | |
| 4.11 | Community notes scrollable | | |
| 4.12 | Ratings section shows avg stars and count | | |
| 4.13 | Quality warning badge shown for flagged trails | | |
| 4.14 | Recent reviews list renders | | |
| 4.15 | Rate button opens rating screen | | |
| 4.16 | Save Offline button triggers download | | |
| 4.17 | Share to Groups opens group picker | | |
| 4.18 | Add to Route button works (when planner active) | | |
| 4.19 | Prev / Next navigation between sibling trails works | | |

---

## 5. Trail Rating

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 5.1 | Rate screen opens from trail detail | | |
| 5.2 | 5 large amber stars display | | |
| 5.3 | Tapping a star submits rating immediately | | |
| 5.4 | Confirmation shown after submit | | |
| 5.5 | Screen dismisses after 1.5s | | |
| 5.6 | "Add more detail" expands category section | | |
| 5.7 | Scenery / Surface / Accuracy / Fun stars work | | |
| 5.8 | Season picker works | | |
| 5.9 | Review text accepts up to 500 chars | | |
| 5.10 | Submit button in expanded mode works | | |
| 5.11 | Rider grade selector affects weighting (1-10) | | |
| 5.12 | Existing rating pre-fills when re-opening | | |
| 5.13 | Rating appears in trail detail after submit | | |
| 5.14 | Weighted avg_stars updates in DB after submit | | |

---

## 6. Route Planner

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 6.1 | Planner tab shows Step 1 on first open | | |
| 6.2 | GPS auto-fills start location with reverse geocoded name | | |
| 6.3 | "Getting your location…" spinner shows while GPS resolves | | |
| 6.4 | Tap start location field to search opens search box | | |
| 6.5 | Location search returns Nominatim results | | |
| 6.6 | Distance shown next to each search result | | |
| 6.7 | All 3 ride style cards display correctly | | |
| 6.8 | Easy card: Grade 1-4 shown | | |
| 6.9 | Good Day Out card: Grade 3-6 shown | | |
| 6.10 | Challenge Me card: Grade 5-8 shown | | |
| 6.11 | Tapping a style card advances to Step 2 | | |
| 6.12 | Selected card shows amber glow border | | |
| 6.13 | "Describe your ideal ride" text input works | | |
| 6.14 | AI interprets natural language and sets style | | |
| 6.15 | Bike type shown in small text below cards | | |
| 6.16 | FIND MY RIDE button triggers route calculation | | |
| **Step 2** | | | |
| 6.17 | Loading state shows "Finding your perfect ride…" | | |
| 6.18 | Route appears on map after calculation | | |
| 6.19 | Trail sections coloured by grade | | |
| 6.20 | Road connectors shown as white dashed lines | | |
| 6.21 | Start pin shown as green | | |
| 6.22 | Summary bar slides up from bottom | | |
| 6.23 | Summary shows: distance, time, grade range, avg stars | | |
| 6.24 | More trails adjustment button works | | |
| 6.25 | Less trails adjustment button works | | |
| 6.26 | Harder adjustment button works | | |
| 6.27 | Easier adjustment button works | | |
| 6.28 | Route updates smoothly during adjustment (old route stays visible) | | |
| 6.29 | "Edit sections" link navigates to section editor | | |
| **Step 3** | | | |
| 6.30 | Tap trail on map opens section bottom sheet | | |
| 6.31 | Section sheet shows trail name, grade, distance, rating | | |
| 6.32 | KEEP button keeps section and closes sheet | | |
| 6.33 | SKIP button removes section from route | | |
| 6.34 | Skipped sections shown as grey dashed | | |
| 6.35 | Tap skipped section offers ADD BACK option | | |
| 6.36 | Adding back restores section to route | | |
| 6.37 | Summary bar updates after skip/restore | | |
| **Step 4** | | | |
| 6.38 | SAVE & GO button navigates to Step 4 | | |
| 6.39 | Smart default route name generated | | |
| 6.40 | Route name editable | | |
| 6.41 | Stats cards show correct totals | | |
| 6.42 | Privacy toggle (private / groups / community) works | | |
| 6.43 | START NAVIGATING button launches navigation | | |
| 6.44 | SAVE action saves route to API | | |
| 6.45 | OFFLINE action shows download progress | | |
| 6.46 | OFFLINE completes successfully | | |
| 6.47 | EXPORT opens device selector modal | | |
| 6.48 | Garmin Edge GPX download works | | |
| 6.49 | Garmin inReach GPX download works | | |
| 6.50 | Generic GPX download works | | |
| 6.51 | Share sheet opens after GPX export | | |
| 6.52 | "Plan a new route" resets planner to Step 1 | | |
| 6.53 | Planner state persists across app restart | | |

---

## 7. Navigation

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 7.1 | Navigate screen opens with route loaded | | |
| 7.2 | Map rotates to heading-up mode | | |
| 7.3 | User position in lower third of map | | |
| 7.4 | Amber pulsing dot marks user position | | |
| 7.5 | Instruction banner shows at top (35% height) | | |
| 7.6 | Direction icon shown (straight/left/right) | | |
| 7.7 | Distance to next maneuver updates as user moves | | |
| 7.8 | Trail sections highlighted in grade colours | | |
| 7.9 | Completed sections grey out | | |
| 7.10 | Bottom bar shows: distance remaining, ETA, speed | | |
| 7.11 | "Entering trail section — Grade X" announced | | |
| 7.12 | "Returning to road" announced on trail exit | | |
| 7.13 | Voice prompts speak through speaker | | |
| 7.14 | Mute button silences voice | | |
| 7.15 | Recalculating banner appears when off route | | |
| 7.16 | Route recalculates after going off route | | |
| 7.17 | Exit navigation button works | | |
| 7.18 | Night mode activates (if implemented) | | |

---

## 8. Trail Recording

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 8.1 | Record tab accessible | | |
| 8.2 | GPS permissions requested on first use | | |
| 8.3 | Live track appears on map as user moves | | |
| 8.4 | Distance counter updates in real time | | |
| 8.5 | Elapsed time counter updates | | |
| 8.6 | Pause / Resume works | | |
| 8.7 | Stop recording shows save dialog | | |
| 8.8 | Name field pre-filled with date/time | | |
| 8.9 | Grade picker works | | |
| 8.10 | Surface type picker works | | |
| 8.11 | Save creates trail in DB (if service role configured) | | |
| 8.12 | Keep private option works | | |
| 8.13 | Share to community option works | | |

---

## 9. Groups

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 9.1 | Groups section visible in profile or explore tab | | |
| 9.2 | TET Official group visible with verified badge | | |
| 9.3 | Join group (public) works | | |
| 9.4 | Leave group works | | |
| 9.5 | Create group form works | | |
| 9.6 | Private group requires invite link | | |
| 9.7 | Invite link generation works | | |
| 9.8 | Joining via invite link works | | |
| 9.9 | Group trail map shows group trails | | |
| 9.10 | Map visibility filter (Groups only) shows group trails | | |

---

## 10. Offline Maps

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 10.1 | Save Offline button on trail detail works | | |
| 10.2 | Download progress shown | | |
| 10.3 | Offline trail accessible with no internet | | |
| 10.4 | Offline route accessible with no internet | | |
| 10.5 | Storage used shown in Settings | | |
| 10.6 | Remove offline trail works | | |
| 10.7 | Offline badge shown on saved route cards | | |

---

## 11. Linesman System (requires linesman_access = true)

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 11.1 | "Linesman Tools" button visible on profile | | |
| 11.2 | Linesman home screen shows 4 action cards | | |
| 11.3 | Recent edits list shows correctly | | |
| 11.4 | Edit Trail flow — map selection works | | |
| 11.5 | Edit Trail flow — metadata form saves | | |
| 11.6 | Replace Route flow — GPX upload works | | |
| 11.7 | Flag Problem flow — 6 flag types shown | | |
| 11.8 | Flag Problem — photo attachment works | | |
| 11.9 | Add New Trail flow — Record option works | | |
| 11.10 | Add New Trail — Upload GPX works | | |
| 11.11 | All edits logged to linesman_edits table | | |
| 11.12 | Undo edit within 24h works | | |
| 11.13 | Admin panel shows linesfolk list | | |
| 11.14 | Admin: grant/revoke access works | | |
| 11.15 | Admin: view edit history works | | |
| 11.16 | Linesman button NOT shown for regular users | | |

---

## 12. Profile & Settings

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 12.1 | Profile tab shows user name and avatar | | |
| 12.2 | Saved routes grid (2-column) shows saved routes | | |
| 12.3 | Route card shows: name, distance, grade range, stars | | |
| 12.4 | Offline badge shown on downloaded routes | | |
| 12.5 | Public badge shown on shared routes | | |
| 12.6 | Tap route card opens full route view | | |
| 12.7 | Navigate from saved route works | | |
| 12.8 | Edit from saved route opens planner Step 3 | | |
| 12.9 | Export from saved route works | | |
| 12.10 | Delete saved route works | | |
| 12.11 | Preferred bike type editable | | |
| 12.12 | Skill level editable | | |
| 12.13 | Push notification permissions prompt works | | |
| 12.14 | Redo onboarding option works | | |
| 12.15 | Dark theme consistent throughout | | |

---

## 13. TET Import Script

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 13.1 | `pnpm import:tet -- --dry-run` runs without crashing | | |
| 13.2 | Correct number of trail sections reported | | |
| 13.3 | Road sections counted separately | | |
| 13.4 | Section names match original TET GPX names | | |
| 13.5 | `--skip-ai` flag prevents AI grading calls | | |
| 13.6 | Real import writes trails to Supabase | | |
| 13.7 | No RLS violations with service role key | | |
| 13.8 | No `trails_source_check` constraint violation | | |
| 13.9 | Duplicate detection skips existing trails | | |
| 13.10 | Seasonal trail flag set correctly | | |

---

## 14. OSM Import Script

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 14.1 | `pnpm import:osm -- --region wales --dry-run` connects to Overpass | | |
| 14.2 | No HTTP 406 error | | |
| 14.3 | Wales dry run returns > 0 ways | | |
| 14.4 | `--simple` flag runs simplified single-clause query | | |
| 14.5 | Trails named from OSM tags | | |
| 14.6 | Grade heuristic applied from OSM tracktype/surface | | |
| 14.7 | Legal status correctly derived (BOAT / legal / permissive) | | |
| 14.8 | Real import does not duplicate existing trails | | |

---

## 15. API Server

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 15.1 | Server starts on port 8080 | | |
| 15.2 | `/api/health` returns 200 | | |
| 15.3 | `/api/auth-check` (dev) shows correct Clerk keys | | |
| 15.4 | Authenticated requests succeed (correct Bearer token) | | |
| 15.5 | Unauthenticated requests to protected routes return 401 | | |
| 15.6 | `/api/me/sync` succeeds after login | | |
| 15.7 | `/api/trails/search` returns TET trails | | |
| 15.8 | `/api/me/planner/suggestions` returns trail suggestions | | |
| 15.9 | Rating endpoints (POST/GET/DELETE) work | | |
| 15.10 | Linesman endpoints require `linesman_access = true` | | |
| 15.11 | CORS allows Expo Go requests | | |

---

## 16. Design System Compliance

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 16.1 | Background is `#0D0D0D` throughout | | |
| 16.2 | Primary accent `#F5A623` amber on all CTAs | | |
| 16.3 | All interactive elements ≥ 60×60px | | |
| 16.4 | Primary action buttons ≥ 80px tall | | |
| 16.5 | No light grey text on dark grey background | | |
| 16.6 | Safe area insets respected on all screens | | |
| 16.7 | No UI elements hidden behind Android nav bar | | |
| 16.8 | Loading states shown on all async actions | | |
| 16.9 | Empty states have helpful messages | | |
| 16.10 | Back navigation always visible | | |

---

## Known Issues / Deferred

| Issue | Severity | Assigned | Status |
|-------|----------|----------|--------|
| Push notification 2h rating delay not implemented | Low | — | Post-v1 |
| Garmin Connect direct app detection | Low | — | Post-v1 |
| Weekend duration option removed | — | — | By design |

---

*Update this file after every test session. Commit changes with: `git commit -m "testing: update TESTING.md [date]"`*
