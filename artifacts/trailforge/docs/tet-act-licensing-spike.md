# TET / ACT Licensing Spike

**Status:** decided 2026-04-28 — link-out mode for both sources, no GPX
re-hosting.

This note captures what we found about the Trans Euro Trail (TET) and
Adventure Country Tracks (ACT) terms of use, and what that means for the
TrailForge harvest pipeline.

## TL;DR

- **TET**: free to ride, but routes are released only to riders who register
  on the TET site and download per-country GPX bundles. The published terms
  forbid public mirroring or commercial redistribution of the GPX files.
  Attribution alone is not sufficient — a downstream user must still go to
  the TET site and accept the terms.
- **ACT**: routes are published as paid country-pack downloads (small fee).
  Redistribution of the underlying GPX is **not** permitted.

## What this means for the harvest pipeline

The harvest job runs in **link-out mode** for both sources. We do **not**
host the GPX. For each route we ingest:

1. **Metadata only** — name, country / region, claimed difficulty,
   approximate bbox, and a deep link back to the source download page.
2. The trail row is inserted with:
   - `source = 'tet'` or `'act'`
   - `verification_status = 'unverified'`
   - `gpx_data = NULL`
   - `source_url = <deep link>`
3. The Map / Trail Detail UI shows an **External** badge and a "Get GPX from
   {source}" button that opens `source_url` in a new tab. Navigation is
   disabled because we have no route geometry.
4. If a member subsequently uploads a GPX for the same route, the dedupe
   step links the upload to the existing system trail (preserving
   attribution) and flips `verification_status` to `verified`.

If TET / ACT later publish under a permissive license (e.g. CC-BY-SA), we
flip the flag in `HARVEST_MODE` and start re-hosting the GPX. The pipeline
is written so this is a single-line change in
`artifacts/api-server/src/lib/aiDiscovery.ts`.

## Robots.txt + scraping

The forum scanner respects `robots.txt` — see `respectsRobotsTxt()` in
`aiDiscovery.ts`. The configured forum source list is data-driven (read
from `forum_sources` table) so site admins can adjust it without a code
change.
