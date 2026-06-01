# TrailForge — Feature Reference

Last updated: June 2026

---

## Core Map

| Feature | Location | Notes |
|---|---|---|
| TET trail polylines | `app/(tabs)/map.tsx` | Coloured by difficulty (1-10 scale) |
| Road liaison connectors | `app/(tabs)/map.tsx` | Thin grey dashed lines, non-tappable |
| Seasonal trail dashing | `app/(tabs)/map.tsx` | `is_seasonal=true` renders as dashed polyline |
| Difficulty filter (1-10) | `app/(tabs)/map.tsx` | Easy/Inter/Hard/Extreme grade chips, Premium only |
| Bike suitability filter | `app/(tabs)/map.tsx` | Adventure/Trail/Enduro, Premium only |
| Visibility toggle | `app/(tabs)/map.tsx` | All / Public+Groups / Groups only |
| Layer panel (bottom-left) | `app/(tabs)/map.tsx` | Public/TET/TRF/My Trails/My Groups toggles, persisted in AsyncStorage |
| Trail detail sheet | `components/TrailDetailSheet.tsx` | Tapping a trail shows name, grade, distance, conditions |
| Geocode search | `lib/nominatim.ts` | Nominatim place search, flies to result |

## Legal Trail Layers

| Layer | Source Tag | Colour |
|---|---|---|
| Public Trails (OSM) | `OSM-UK` | Difficulty colour (green/blue/orange/red) |
| Trans Euro Trail | `TET-UK` | Amber `#D97706` |
| TRF Routes | `TRF` | Blue `#2563EB` |
| My Trails | owner_user_id | Purple `#7C3AED` |
| Group Trails | group-shared | Orange `#EA580C` |

## Import Scripts

| Script | Command | Description |
|---|---|---|
| TET import | `pnpm --filter @workspace/scripts import:tet` | Import GB.gpx from project root |
| OSM import | `pnpm --filter @workspace/scripts import:osm` | Import all UK regions from Overpass |
| OSM by region | `import:osm:scotland` / `:wales` / `:england-north` etc | Single region queries |
| OSM sync | `pnpm --filter @workspace/scripts sync:osm` | Weekly incremental legal status sync |
| ACT import | `pnpm --filter @workspace/scripts import:act` | Adventure Country Tracks import |

## Legal Confidence System

Values stored in `trails.legal_confidence`:

| Value | Meaning |
|---|---|
| `verified` | Manually verified by moderator |
| `osm_legal` | OSM tags confirm legal access (BOAT, motor_vehicle=yes/permissive) |
| `user_submitted` | User uploaded with declaration |
| `unverified` | Imported but not verified |
| `flagged` | Flagged by community reports |
| `rejected` | Legal access removed / denied |

Auto-transitions: OSM sync removes access → `rejected` + auto-hidden. 5 weighted community reports → auto-hidden for review.

## Condition Reporting

Riders can report trail conditions from the trail detail screen:

| Condition | Severity | Auto-action |
|---|---|---|
| Good | Info | Resets amber flag |
| Wet/Muddy | Warning | — |
| Overgrown | Warning | — |
| Damaged/Impassable | Danger | 3 reports → flag amber |
| Temporary Closure | Danger | 3 reports → flag amber |
| Legal Status Changed | Danger | Immediate moderator notification |
| Landowner Closed | Danger | Immediate moderator notification |
| Dangerous | Danger | 3 reports → flag amber |

Reports expire after 30 days. 5 weighted reports → auto-hide trail.

## Database Migrations

| Migration | Description |
|---|---|
| 0030 | Trail centroid, start/end coords, TET metadata columns |
| 0031 | `trail_conditions` table with 30-day TTL and RLS |
| 0032 | Fix `trails_source_check` constraint (allows `TET-UK`, `OSM-UK` etc) |
| 0033 | `legal_confidence`, `legal_source`, `osm_way_ids` columns; `system_config` table |
| 0034 | `trail_collections` and `trail_collection_sections` tables, 8 seed collections |
| 0035 | Gamification: rank columns on users, `achievements`, `leaderboard_snapshots` |
| 0036 | Partner/creator account types on users |

## Gamification

### Rank Tiers
| Level | Title | Points |
|---|---|---|
| 1 | Greenlaner | 0–99 |
| 2 | Trail Rider | 100–499 |
| 3 | Adventure Rider | 500–1,499 |
| 4 | Trail Veteran | 1,500–3,999 |
| 5 | Trail Master | 4,000–7,999 |
| 6 | Trail Legend | 8,000–14,999 |
| 7 | Trail God | 15,000+ |

### Points
| Action | Points |
|---|---|
| Per km ridden | 1 |
| Complete a named collection | 50 |
| Add a trail | 30 |
| Submit condition report | 10 |
| Forum post | 5 |
| Helpful vote received | 3 |
| First rider on new trail | 25 |

### Achievements (selected)
- Distance milestones: 1km, 10km, 50km, 100km, 500km, 1,000km, 5,000km
- Trail completion milestones: 1, 10, 50, 100 trails
- Community: First report, 10 reports, Trail Maker, Trail Builder, Helpful Rider, Community Legend
- Rank milestones: Trail Rider, Trail Veteran, Trail Master

## Featured Collections

Pre-seeded in migration 0034:
- Great Northern Trail (official)
- Cymru Trail (official)
- Borderlands (official)
- Yorkshire Dales Green Lanes
- Peak District Trails
- Dartmoor Green Lanes
- Scottish Highlands
- Snowdonia Trails

## Admin Endpoints

All require admin user (set via `ADMIN_LIST` env var):

| Endpoint | Description |
|---|---|
| `POST /api/admin/expire-conditions` | Remove expired condition reports |
| `POST /api/admin/rebuild-leaderboards` | Rebuild weekly/monthly snapshots |
| `POST /api/admin/sync-osm` | Queue OSM legal sync |
| `GET /api/admin/data-quality-report` | Trail counts by source and confidence |
| `POST /api/admin/check-achievements` | Award any earned achievements |

## Tabs

| Tab | Route | Description |
|---|---|---|
| Planner | `/(tabs)/index` | Route planning and saved routes |
| Map | `/(tabs)/map` | Full-screen interactive trail map |
| Trails | `/(tabs)/trails` | TET grouping + saved trails |
| Explore | `/(tabs)/explore` | Featured collections and nearby routes |
| Feed | `/(tabs)/feed` | Community activity + leaderboards |
| AI | `/(tabs)/ai` | AI trail assistant |
| Messages | `/(tabs)/messages` | Group messaging |
| Admin | `/(tabs)/admin` | Moderator tools (hidden unless admin) |

## Onboarding

5-screen animated onboarding on first launch:
1. Welcome — animated map, logo, tagline
2. Find Your Trails — grade chips animation
3. Plan Your Ride — route building animation
4. Navigate Like A Pro — rotating navigation view
5. Your Setup — bike type + experience slider

Stored in `AsyncStorage` key `@trailforge/onboarding_complete`. Redo from Settings → User Menu → "Redo onboarding".

## Partner System

Account types: `rider` (default), `club_partner`, `content_creator`, `moderator`, `admin`.

- Club partners can bulk-upload GPX; trails tagged with club name; verified badge on group page
- Creators: "As ridden by [Creator]" badge on trails; video link; follower count on profile
