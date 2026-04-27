import { DIFFICULTY_COLORS } from "@/lib/trailLayer";

export interface MapTrailFilterState {
  difficulties: number[];     // empty = all
  trailTypes: string[];       // empty = all
}

interface Props {
  open: boolean;
  filters: MapTrailFilterState;
  onChange: (next: MapTrailFilterState) => void;
  onClose: () => void;
  visibleCount: number;
}

const TRAIL_TYPES = ["BOAT", "Green Lane", "UCR", "RUPP", "Bridleway"];

export default function MapTrailFilters({ open, filters, onChange, onClose, visibleCount }: Props) {
  if (!open) return null;

  const toggleDiff = (d: number) => {
    const next = filters.difficulties.includes(d)
      ? filters.difficulties.filter((x) => x !== d)
      : [...filters.difficulties, d];
    onChange({ ...filters, difficulties: next });
  };

  const toggleType = (t: string) => {
    const next = filters.trailTypes.includes(t)
      ? filters.trailTypes.filter((x) => x !== t)
      : [...filters.trailTypes, t];
    onChange({ ...filters, trailTypes: next });
  };

  const reset = () => onChange({ difficulties: [], trailTypes: [] });

  return (
    <div
      className="fixed inset-0 z-[1500] flex flex-col"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="mt-auto rounded-t-2xl overflow-hidden shadow-2xl"
        style={{ background: "hsl(22,15%,9%)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-stone-700"></div>
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-b border-[hsl(30,12%,16%)]">
          <h2 className="text-sm font-bold text-amber-400 uppercase tracking-widest">Filter Trails</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-stone-800 flex items-center justify-center text-stone-400"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="px-4 py-3 space-y-4">
          {/* Difficulty */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[10px] font-bold text-stone-500 uppercase tracking-widest">Difficulty</h3>
              {filters.difficulties.length > 0 && (
                <span className="text-[10px] text-amber-400">{filters.difficulties.length} selected</span>
              )}
            </div>
            <div className="flex gap-1.5">
              {Array.from({ length: 10 }, (_, i) => i + 1).map((d) => (
                <button
                  key={d}
                  onClick={() => toggleDiff(d)}
                  className="flex-1 aspect-square rounded flex items-center justify-center text-xs font-bold transition-all"
                  style={{
                    backgroundColor: filters.difficulties.includes(d) ? DIFFICULTY_COLORS[d] : "hsl(22,15%,16%)",
                    color: filters.difficulties.includes(d) ? "#000" : DIFFICULTY_COLORS[d],
                    border: `1px solid ${DIFFICULTY_COLORS[d]}40`,
                    transform: filters.difficulties.includes(d) ? "scale(1.08)" : "scale(1)",
                  }}
                  data-testid={`map-filter-diff-${d}`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          {/* Trail types */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[10px] font-bold text-stone-500 uppercase tracking-widest">Trail Types</h3>
              {filters.trailTypes.length > 0 && (
                <span className="text-[10px] text-amber-400">{filters.trailTypes.length} selected</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {TRAIL_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                    filters.trailTypes.includes(t)
                      ? "bg-amber-500/20 border-amber-500 text-amber-300"
                      : "bg-transparent border-stone-700 text-stone-400 hover:border-stone-500"
                  }`}
                  data-testid={`map-filter-type-${t.replace(/\s+/g, "-").toLowerCase()}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center gap-2 pt-2 border-t border-[hsl(30,12%,16%)]">
            <button
              onClick={reset}
              className="flex-1 py-2.5 rounded-lg text-xs font-bold border border-stone-700 text-stone-400 hover:border-stone-500 hover:text-stone-200 transition-all"
            >
              Clear All
            </button>
            <button
              onClick={onClose}
              className="flex-[2] py-2.5 rounded-lg text-xs font-black uppercase tracking-wider text-stone-900"
              style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
            >
              Show {visibleCount} Trail{visibleCount !== 1 ? "s" : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
