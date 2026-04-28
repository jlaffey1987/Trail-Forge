# ACT / TET bundle importer

Importer for **Adventure Country Tracks (ACT)** and **Trans Euro Trail
(TET)** GPX route bundles. Currently wired for the **UK** bundles only;
the same code path works for any other region or source-family bundle
once it's added to `fixtures/bundles.json`.

The importer:
1. Parses each multi-track bundle (one `<trk>` per ride day / route
   section).
2. Walks every track and classifies the riding surface as
   `tarmac` / `offroad` / `unknown` against OpenStreetMap.
3. Slices each track at tarmac↔off-road boundaries with a 200 m hysteresis
   filter — only the **off-road** sub-segments are kept.
4. Names each sub-segment from the nearest waypoint.
5. AI-grades each sub-segment (1–10) using the same rubric as the API
   server's `gradeTrailWithAI`.
6. Persists each sub-segment as a row in the `trails` table with
   `source = 'act'` or `source = 'tet'`, owned by no user (community
   trail), with an idempotent unique key on
   `(source, source_url, segment_hash)`.

---

## 1 — Licensing

The Adventure Country Tracks bundles are sold under the ACT Software
Licence Agreement (see <https://adventurecountrytracks.com/>); the Trans
Euro Trail bundles are released under TET's own redistribution rules
(see <https://transeurotrail.org/>). Per the project's licensing review
(recorded in `replit.md` and surfaced as
`Link-out mode (TET/ACT terms forbid GPX rehosting)` in the admin
queue), **we do not redistribute the original .gpx file**. Instead:

| What we store                                         | Why it's OK                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Per-segment GPX XML in `trails.gpx_data` (drives map rendering only) | Geometry is uncopyrightable factual data. We split / reshape per-segment so it isn't a verbatim copy of the source bundle. |
| Trail names + AI grade rationale                      | Our derived metadata, not redistributed source material.                                               |
| `source_url = https://adventurecountrytracks.com/` (or `https://transeurotrail.org/`) | Link-out, so users get the original bundle from the source site.                     |

What we **do not** do:
- We never set `trails.gpx_object_path` for ACT / TET rows, so the
  GPX-download endpoint (`/objects/trails/source/<uuid>.gpx`) never
  returns a downloadable file for them. The XML in `gpx_data` is read
  by the SQL trigger from migration 0008 (to populate
  `simplified_path` / `path_geojson`) and by the frontend's `parseGPX`
  (to draw the trail line) — it isn't re-emitted as a downloadable
  .gpx artifact anywhere in the API.
- We never upload the source bundle to object storage.
- We never persist the **whole** day-track — only the per-segment
  off-road slices we produced ourselves (the road sections are dropped
  on the floor before storage).

If licensing changes, drop the imported rows with
`DELETE FROM trails WHERE source IN ('act', 'tet')`.

---

## 2 — Bundle dedup

`fixtures/bundles.json` is the manifest of bundles to import. Each entry
records the file's SHA-256 so a re-run with a different bundle version
fails loudly.

| Source | Bundle             | SHA-256 (first 12)   | Bytes      |
| ------ | ------------------ | -------------------- | ---------- |
| act    | act-uk-v05.gpx     | `a36780a39a1c…`      | 2 259 015  |
| tet    | tet-uk.gpx         | `c0dc06a26437…`      | 6 796 619  |

Italy V08 and Pyrenees V07 ACT bundles are intentionally **not**
shipped in this fixture set yet — see `bundles.json/notes`. The
original attached `ACT_It_V08_*349.gpx` and `*365.gpx` were
byte-identical (same SHA-256) and only one was kept during initial
dedup.

---

## 3 — Segmentation parameters

Defined in `segmentation.ts`; all are tunable per call.

| Parameter           | Default | Meaning                                                                                                        |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `sampleEveryMeters` | `100`   | Distance between OSM classification samples along the day-track.                                               |
| `snapMeters`        | `60`    | Max distance from a sample point to the nearest OSM `highway=*` way before the sample is treated as `unknown`. |
| `hysteresisMeters`  | `200`   | A class change is only emitted once the new class has held for ≥ this many meters — the spec'd default.        |
| `minOffroadMeters`  | `500`   | Off-road runs shorter than this are dropped (junctions / driveways).                                           |

Tarmac ways = `motorway / trunk / primary / secondary / tertiary /
unclassified / residential / living_street / service` plus any way with
an explicitly paved `surface=*` tag. Off-road = `track / path / bridleway
/ cycleway / footway` plus any way with an explicitly unpaved
`surface=*` tag. **Tarmac sub-segments are never persisted** — the road
sections of each day are dropped on the floor.

OSM tile responses are cached in `.local/act-osm-cache/` (key:
lat/lng tile rounded to 0.05° ≈ 5 km) so re-runs are free and Overpass
sees minimal traffic. Override with `ACT_OSM_CACHE_DIR=…` if you want a
shared cache across machines.

---

## 4 — AI grading

`grade.ts` calls Anthropic (`claude-sonnet-4-6`) with a 1–10 rubric
identical to the existing `gradeTrailWithAI` in
`artifacts/api-server/src/lib/aiGrading.ts`. Every result is cached on
disk in `.local/act-ai-cache/<segment_hash>.json` so re-runs and retries
are zero-cost. The prompt is parameterised by source — TET bundles are
introduced as "TET (Trans Euro Trail)" and ACT bundles as "ACT
(Adventure Country Tracks)".

If Anthropic is unavailable (no API key, rate limit, network error) or
the response is unparseable, the importer falls back to a deterministic
heuristic based on distance + elevation gain. The rationale always notes
when a heuristic was used so a moderator can re-grade it later via the
existing `POST /api/admin/trails/:id/regrade` endpoint.

---

## 5 — How to run

### Prerequisites

| Env var                        | Required for           | Notes                                                       |
| ------------------------------ | ---------------------- | ----------------------------------------------------------- |
| `SUPABASE_URL`                 | Persisting trails      | Same value the API server uses.                             |
| `SUPABASE_SERVICE_ROLE_KEY`    | Persisting trails      | Service-role key — bypasses RLS for the importer.           |
| `ANTHROPIC_API_KEY` *or* the integrations-anthropic-ai env | AI grading | Optional; falls back to heuristic when absent.              |
| `OVERPASS_URL`                 | OSM segmentation       | Optional; defaults to `https://overpass-api.de/api/interpreter`. |
| `ACT_OSM_CACHE_DIR`            | OSM tile cache         | Optional; defaults to `.local/act-osm-cache`.               |
| `ACT_AI_CACHE_DIR`             | AI grade cache         | Optional; defaults to `.local/act-ai-cache`.                |

### Apply the migration once

The importer needs the `source_region` and `segment_hash` columns plus
the `(source, source_url, segment_hash)` unique index added in
migration 0009. Apply via the Supabase SQL editor (the project
convention used for every migration):

```sh
# In the Supabase dashboard → SQL editor, paste:
artifacts/trailforge/supabase/migrations/0009_act_imports.sql
```

The importer will refuse to write trails until those columns exist; it
prints the exact missing columns when the schema check fails.

### Smoke test (no DB writes, no external APIs)

```sh
pnpm --filter @workspace/scripts run import:act -- \
  --dry-run --skip-osm --skip-ai --max-days 2 --max-segments-per-day 2
```

### Smoke test with real OSM but no DB writes

```sh
pnpm --filter @workspace/scripts run import:act -- \
  --dry-run --max-days 1
```

### Full UK import — ACT only

```sh
pnpm --filter @workspace/scripts run import:act -- --source act --region uk
```

### Full UK import — TET only

```sh
pnpm --filter @workspace/scripts run import:act -- --source tet --region uk
```

### Full UK import — both ACT + TET

```sh
pnpm --filter @workspace/scripts run import:act -- --region uk
```

The importer is **idempotent** — running it again with the same bundle
file is a no-op (the unique index on `(source, source_url, segment_hash)`
absorbs the upsert). A full real-OSM run is a slow maintenance step
(~20+ min per bundle for the first run, instant on cached re-runs)
because it queries Overpass for every ~100 m sample along every track.

---

## 6 — Output / verification

Each run prints a per-bundle summary like:

```
=== TET UK :: tet-uk.gpx (6796619 bytes) ===
  parsed: 21 tracks, 1142 waypoints, total points=48796
  [trk 1/21] "TET_UK-01-Borderlands_…": 4 off-road segment(s)
    ✓ inserted "TET UK-01-Borderlands · Cumbrian Byway (segment 1)" (id=…, grade=4)
    …
=== Import summary ===
  ACT  uk       act-uk-v05.gpx              tracks=8   days=8   candidates=…  inserted=…  skipped=…  errors=…
  TET  uk       tet-uk.gpx                  tracks=21  days=21  candidates=…  inserted=…  skipped=…  errors=…
```

Imported trails are surfaced in the UI by:
1. The trail detail sheet showing an **ACT** or **TET** badge and a
   `Get GPX from <source>` link back to the source site
   (`TrailDetailSheet.tsx`).
2. The planner search returning them like any other public trail.

Imported rows are written with `verification_status = 'verified'`
(curated source — they appear immediately rather than landing in the
moderation queue) and `owner_user_id = NULL` (community trail; no
single owner since the geometry is derived from the source bundle).
