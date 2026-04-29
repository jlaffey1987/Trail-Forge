import { type Trail } from "@/lib/supabase";
import { getDifficultyColor } from "@/lib/trailLayer";

const DIFFICULTY_LABELS: Record<number, string> = {
  1: "Novice", 2: "Easy", 3: "Easy+", 4: "Moderate", 5: "Medium",
  6: "Hard", 7: "Expert", 8: "Extreme", 9: "Pro", 10: "Elite",
};

interface Props {
  trails: Trail[];
  onSelectTrail: (trail: Trail) => void;
  onZoomToArea: () => void;
  onClose: () => void;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function difficultyLabel(d: number | null | undefined): string {
  if (d == null) return "Unrated";
  const rounded = Math.max(1, Math.min(10, Math.round(d)));
  return `${DIFFICULTY_LABELS[rounded] ?? ""} (${rounded})`.trim();
}

export default function ClusterTrailListSheet({
  trails,
  onSelectTrail,
  onZoomToArea,
  onClose,
}: Props) {
  const sorted = [...trails].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      className="absolute inset-0 z-[1400] flex items-end justify-center pointer-events-auto"
      data-testid="cluster-trail-list-sheet"
    >
      <button
        type="button"
        aria-label="Close cluster list"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <div className="relative w-full max-w-md mx-2 mb-2 bg-stone-900 border border-stone-700 rounded-2xl shadow-2xl flex flex-col"
        style={{ maxHeight: "70vh" }}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-stone-800">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500">
              Trails in this cluster
            </div>
            <div className="text-sm font-bold text-stone-100" data-testid="cluster-trail-list-count">
              {sorted.length} trail{sorted.length !== 1 ? "s" : ""}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-stone-400 hover:text-stone-200 text-xl leading-none px-2"
            data-testid="cluster-trail-list-close"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto flex-1" data-testid="cluster-trail-list-rows">
          {sorted.length === 0 ? (
            <div className="px-4 py-6 text-xs text-stone-500 text-center">
              No trails to show.
            </div>
          ) : (
            <ul className="divide-y divide-stone-800">
              {sorted.map((trail) => {
                const diffColor = getDifficultyColor(trail.difficulty ?? undefined);
                const km = toNum(trail.distance_km);
                return (
                  <li key={trail.id}>
                    <button
                      type="button"
                      onClick={() => onSelectTrail(trail)}
                      className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-stone-800/60 active:bg-stone-800 transition-colors"
                      data-testid={`cluster-trail-row-${trail.id}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-stone-100 truncate">
                          {trail.name}
                        </div>
                        <div className="text-[10px] text-stone-500 mt-0.5 flex items-center gap-2">
                          {km != null && <span>{km.toFixed(1)} km</span>}
                          {trail.legal_status && (
                            <span className="uppercase tracking-wider">{trail.legal_status}</span>
                          )}
                        </div>
                      </div>
                      <span
                        className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold text-stone-900"
                        style={{ background: diffColor }}
                        data-testid={`cluster-trail-difficulty-${trail.id}`}
                      >
                        {difficultyLabel(trail.difficulty)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-3 py-2.5 border-t border-stone-800 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-300 hover:text-stone-100"
          >
            Cancel
          </button>
          <button
            onClick={onZoomToArea}
            className="px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900"
            style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
            data-testid="cluster-zoom-to-area"
          >
            Zoom to area
          </button>
        </div>
      </div>
    </div>
  );
}
