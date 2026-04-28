import {
  classifyWay,
  fetchNeighbourhoodWays,
  nearestHighwayWay,
  type OsmHighwayWay,
  type SurfaceClass,
} from "./osm.js";
import { haversineMeters, type GpxPoint } from "./parseBundle.js";

/**
 * Segment a single day-track into off-road sub-segments by classifying
 * sample points against OpenStreetMap and applying a hysteresis threshold.
 *
 * Algorithm (per task spec):
 *   1. Walk the track point-by-point keeping a running odometer in meters.
 *   2. Every `sampleEveryMeters` (default 100 m), classify the current
 *      point against the nearest OSM `highway=*` way within `snapMeters`.
 *      Cache the OSM tile that contains the sample so re-runs are free.
 *   3. Maintain a hysteresis buffer: the *current emitted class* only
 *      switches once the *new* class has persisted for ≥
 *      `hysteresisMeters` (default 200 m). Anything shorter is treated as
 *      a brief surface artefact and rolls into the surrounding class.
 *   4. After the walk, slice the track into runs of identical emitted
 *      class. **Only off-road runs are returned** — tarmac runs are
 *      dropped entirely so road sections never become trails.
 *   5. Off-road runs shorter than `minOffroadMeters` (default 500 m) are
 *      also dropped (probably a junction / driveway, not a real trail).
 *
 * `--skip-osm` mode (offline smoke): treats the entire track as a single
 * `offroad` run — useful for verifying the parse / persist pipeline
 * without external API calls.
 */

export interface SegmentationOptions {
  sampleEveryMeters?: number;
  snapMeters?: number;
  hysteresisMeters?: number;
  minOffroadMeters?: number;
  skipOsm?: boolean;
  log?: (msg: string) => void;
}

export interface OffroadSubSegment {
  index: number;
  points: GpxPoint[];
  distanceMeters: number;
  /** Index of the source point in the original track at which this segment starts. */
  startPointIndex: number;
  endPointIndex: number;
}

interface SamplePoint {
  pointIndex: number;
  point: GpxPoint;
  cumulativeMeters: number;
  classification: SurfaceClass;
}

/**
 * Walk the track and classify every point against OSM. Returns
 * per-original-point classifications (length === track.length).
 */
async function classifyTrack(
  track: GpxPoint[],
  options: Required<Omit<SegmentationOptions, "log" | "skipOsm">> & {
    skipOsm: boolean;
    log: (msg: string) => void;
  },
): Promise<SurfaceClass[]> {
  const result: SurfaceClass[] = new Array(track.length).fill("unknown");

  if (options.skipOsm) {
    return result.map(() => "offroad");
  }

  // Walk the track, sampling at fixed intervals.
  const samples: SamplePoint[] = [];
  let cum = 0;
  let nextSampleAt = 0;
  for (let i = 0; i < track.length; i += 1) {
    if (i > 0) {
      cum += haversineMeters(track[i - 1], track[i]);
    }
    if (cum >= nextSampleAt || i === track.length - 1) {
      samples.push({ pointIndex: i, point: track[i], cumulativeMeters: cum, classification: "unknown" });
      nextSampleAt = cum + options.sampleEveryMeters;
    }
  }

  // Cache OSM neighbourhood ways per sample (tile cache deduplicates the
  // actual Overpass calls).
  let lastWays: OsmHighwayWay[] = [];
  let lastWaysAtIndex = -1;
  let tileFetches = 0;
  const totalSamples = samples.length;
  const progressEvery = Math.max(10, Math.floor(totalSamples / 10));
  for (let s = 0; s < samples.length; s += 1) {
    const sample = samples[s];
    // Refresh neighbourhood ways every ~5 km of progress (tiles are 0.05° ≈ 5 km wide).
    if (lastWaysAtIndex < 0 || sample.cumulativeMeters - samples[lastWaysAtIndex].cumulativeMeters > 4500) {
      try {
        const t0 = Date.now();
        lastWays = await fetchNeighbourhoodWays(sample.point);
        const dt = Date.now() - t0;
        tileFetches += 1;
        options.log(
          `[osm] sample ${s + 1}/${totalSamples} @ ${(sample.cumulativeMeters / 1000).toFixed(1)} km — fetched ${lastWays.length} ways in ${dt} ms (cumulative tile fetches: ${tileFetches})`,
        );
        lastWaysAtIndex = s;
      } catch (err) {
        options.log(
          `[osm] tile fetch failed near (${sample.point.lat.toFixed(4)}, ${sample.point.lon.toFixed(4)}): ${(err as Error).message}`,
        );
        sample.classification = "unknown";
        continue;
      }
    } else if (s > 0 && s % progressEvery === 0) {
      options.log(
        `[osm] sample ${s + 1}/${totalSamples} (${((s / totalSamples) * 100).toFixed(0)}%)`,
      );
    }
    const nearest = nearestHighwayWay(sample.point, lastWays, options.snapMeters);
    sample.classification = classifyWay(nearest?.way ?? null);
  }

  // Forward-fill sample classifications onto every original point between
  // adjacent samples (each original point inherits the class of the sample
  // whose pointIndex is closest in the track direction).
  let nextSample = 0;
  for (let i = 0; i < track.length; i += 1) {
    while (nextSample + 1 < samples.length && samples[nextSample + 1].pointIndex <= i) {
      nextSample += 1;
    }
    result[i] = samples[nextSample]?.classification ?? "unknown";
  }
  return result;
}

/**
 * Apply the hysteresis filter: only emit a class change once the new
 * class has held for at least `hysteresisMeters` consecutive meters. Any
 * shorter run keeps the previous emitted class.
 */
function applyHysteresis(
  track: GpxPoint[],
  perPointClass: SurfaceClass[],
  hysteresisMeters: number,
): SurfaceClass[] {
  const emitted: SurfaceClass[] = new Array(track.length);
  let currentClass: SurfaceClass = perPointClass[0] ?? "unknown";
  emitted[0] = currentClass;

  let pendingClass: SurfaceClass = currentClass;
  let pendingStart = 0;
  let pendingMeters = 0;

  for (let i = 1; i < track.length; i += 1) {
    const stepMeters = haversineMeters(track[i - 1], track[i]);
    const cls = perPointClass[i] ?? "unknown";
    if (cls === pendingClass) {
      pendingMeters += stepMeters;
    } else {
      pendingClass = cls;
      pendingStart = i;
      pendingMeters = stepMeters;
    }

    // Treat 'unknown' as if it were `currentClass` (we don't want unknown
    // patches to break a long off-road run).
    const candidate = pendingClass === "unknown" ? currentClass : pendingClass;
    if (candidate !== currentClass && pendingMeters >= hysteresisMeters) {
      // Switch retroactively from pendingStart onwards.
      for (let j = pendingStart; j <= i; j += 1) emitted[j] = candidate;
      currentClass = candidate;
    } else {
      emitted[i] = currentClass;
    }
  }
  return emitted;
}

export async function segmentTrack(
  track: GpxPoint[],
  options: SegmentationOptions = {},
): Promise<OffroadSubSegment[]> {
  const opts = {
    sampleEveryMeters: options.sampleEveryMeters ?? 100,
    snapMeters: options.snapMeters ?? 60,
    hysteresisMeters: options.hysteresisMeters ?? 200,
    minOffroadMeters: options.minOffroadMeters ?? 500,
    skipOsm: options.skipOsm ?? false,
    log: options.log ?? (() => {}),
  };

  if (track.length < 2) return [];

  const perPointClass = await classifyTrack(track, opts);
  const emitted = applyHysteresis(track, perPointClass, opts.hysteresisMeters);

  // Slice into runs of identical emitted class.
  const runs: Array<{ class: SurfaceClass; start: number; end: number }> = [];
  let runStart = 0;
  for (let i = 1; i <= emitted.length; i += 1) {
    if (i === emitted.length || emitted[i] !== emitted[runStart]) {
      runs.push({ class: emitted[runStart], start: runStart, end: i - 1 });
      runStart = i;
    }
  }

  // Keep only off-road runs above the minimum length.
  const out: OffroadSubSegment[] = [];
  let emittedIndex = 0;
  for (const run of runs) {
    if (run.class !== "offroad") continue;
    const slice = track.slice(run.start, run.end + 1);
    if (slice.length < 2) continue;
    let dist = 0;
    for (let i = 1; i < slice.length; i += 1) dist += haversineMeters(slice[i - 1], slice[i]);
    if (dist < opts.minOffroadMeters) continue;
    out.push({
      index: emittedIndex,
      points: slice,
      distanceMeters: dist,
      startPointIndex: run.start,
      endPointIndex: run.end,
    });
    emittedIndex += 1;
  }
  return out;
}
