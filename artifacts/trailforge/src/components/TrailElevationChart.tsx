import { useMemo } from "react";
import type { Trail } from "@/lib/supabase";

interface Props {
  trail: Pick<Trail, "elevation_profile" | "elevation_gain_m" | "elevation_loss_m" | "distance_km">;
  height?: number;
  className?: string;
}

/**
 * Tiny dependency-free elevation chart. Renders the pre-computed
 * `elevation_profile` (array of integer metres + nulls) populated by the
 * migration 0011 trigger. Returns `null` when the trail has no profile yet
 * (older row that hasn't been re-saved, or GPX with no <ele> tags), so the
 * detail sheet can hide the section gracefully.
 */
export default function TrailElevationChart({
  trail,
  height = 80,
  className,
}: Props) {
  const samples = useMemo(() => sanitize(trail.elevation_profile), [trail.elevation_profile]);

  if (!samples || samples.length < 2) {
    return null;
  }

  const minE = Math.min(...samples);
  const maxE = Math.max(...samples);
  const range = Math.max(1, maxE - minE);

  const width = 320;
  const padTop = 4;
  const padBottom = 2;
  const drawableHeight = height - padTop - padBottom;

  const xFor = (i: number) =>
    samples.length === 1 ? width / 2 : (i / (samples.length - 1)) * width;
  const yFor = (e: number) =>
    padTop + (1 - (e - minE) / range) * drawableHeight;

  const linePoints = samples
    .map((e, i) => `${xFor(i).toFixed(2)},${yFor(e).toFixed(2)}`)
    .join(" ");

  const areaPath = `M0,${height} L${linePoints
    .split(" ")
    .map((p) => `L${p}`)
    .join(" ")
    .slice(1)} L${width},${height} Z`;

  const gain = trail.elevation_gain_m ?? null;
  const loss = trail.elevation_loss_m ?? null;
  const distance = trail.distance_km ?? null;

  return (
    <div
      className={className ?? "px-4 pb-3"}
      data-testid="trail-elevation-chart"
    >
      <div className="rounded-lg border border-[hsl(30,12%,18%)] bg-[hsl(22,15%,12%)] px-3 py-2">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="text-[10px] uppercase tracking-wider text-stone-500">
            Elevation
          </div>
          <div className="flex items-center gap-2 text-[10px] font-bold">
            {gain != null ? (
              <span
                className="text-emerald-400"
                title="Total ascent"
                data-testid="trail-elevation-gain"
              >
                ↑ {gain.toLocaleString()} m
              </span>
            ) : null}
            {loss != null ? (
              <span
                className="text-sky-400"
                title="Total descent"
                data-testid="trail-elevation-loss"
              >
                ↓ {loss.toLocaleString()} m
              </span>
            ) : null}
          </div>
        </div>

        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="block w-full"
          style={{ height }}
          aria-label="Elevation profile"
          role="img"
        >
          <defs>
            <linearGradient id="trailforge-elevation-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f0a832" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#f0a832" stopOpacity="0.05" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill="url(#trailforge-elevation-fill)" stroke="none" />
          <polyline
            points={linePoints}
            fill="none"
            stroke="#f0a832"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        <div className="flex items-center justify-between text-[9px] text-stone-500 mt-0.5">
          <span>0{distance != null ? " km" : ""}</span>
          <span>
            {Math.round(minE)}–{Math.round(maxE)} m
          </span>
          <span>
            {distance != null ? `${distance.toFixed(1)} km` : `${samples.length} pts`}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Replace null entries in the profile with linear interpolations from
 * neighbouring samples so the SVG path stays continuous. Returns `null`
 * when the input has fewer than two non-null samples.
 */
function sanitize(profile: Array<number | null> | null | undefined): number[] | null {
  if (!profile || !Array.isArray(profile) || profile.length === 0) return null;

  const filled: number[] = new Array(profile.length).fill(NaN);
  let firstReal = -1;
  let lastReal = -1;
  for (let i = 0; i < profile.length; i++) {
    const v = profile[i];
    if (typeof v === "number" && Number.isFinite(v)) {
      filled[i] = v;
      if (firstReal === -1) firstReal = i;
      lastReal = i;
    }
  }
  if (firstReal === -1 || lastReal === firstReal) return null;

  // Forward / backward fill the edges.
  for (let i = 0; i < firstReal; i++) filled[i] = filled[firstReal];
  for (let i = lastReal + 1; i < filled.length; i++) filled[i] = filled[lastReal];

  // Linearly interpolate interior gaps.
  let i = firstReal + 1;
  while (i <= lastReal) {
    if (Number.isFinite(filled[i])) {
      i++;
      continue;
    }
    const start = i - 1;
    let end = i;
    while (end <= lastReal && !Number.isFinite(filled[end])) end++;
    const a = filled[start];
    const b = filled[end];
    const span = end - start;
    for (let j = start + 1; j < end; j++) {
      filled[j] = a + ((b - a) * (j - start)) / span;
    }
    i = end + 1;
  }

  return filled;
}
