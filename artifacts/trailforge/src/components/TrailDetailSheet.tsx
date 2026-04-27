import { useEffect, useState } from "react";
import { type Trail, getSessionId, saveTrail } from "@/lib/supabase";
import { getDifficultyColor } from "@/lib/trailLayer";
import { addRouteTrail, isInRoute, subscribeRouteTrails } from "@/lib/plannerRouteStore";

const DIFFICULTY_LABELS: Record<number, string> = {
  1: "Novice", 2: "Easy", 3: "Easy+", 4: "Moderate", 5: "Medium",
  6: "Hard", 7: "Expert", 8: "Extreme", 9: "Pro", 10: "Elite",
};

interface Props {
  trail: Trail;
  onClose: () => void;
  onAddedToPlanner?: (trail: Trail) => void;
}

export default function TrailDetailSheet({ trail, onClose, onAddedToPlanner }: Props) {
  const [inPlannerRoute, setInPlannerRoute] = useState(() => isInRoute(trail.id));
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    return subscribeRouteTrails(() => setInPlannerRoute(isInRoute(trail.id)));
  }, [trail.id]);

  const diff = trail.difficulty ?? 5;
  const diffColor = getDifficultyColor(diff);
  const diffLabel = DIFFICULTY_LABELS[diff] ?? "Medium";

  const handleAddToPlanner = () => {
    if (inPlannerRoute) return;
    addRouteTrail(trail);
    onAddedToPlanner?.(trail);
  };

  const handleSave = async () => {
    if (saveStatus === "saving" || saveStatus === "saved") return;
    setSaveStatus("saving");
    const ok = await saveTrail(trail.id, getSessionId());
    setSaveStatus(ok ? "saved" : "error");
  };

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
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-stone-700"></div>
        </div>

        {/* Header */}
        <div className="px-4 pt-2 pb-3">
          <div className="flex items-start gap-3">
            <span
              className="inline-flex items-center justify-center w-10 h-10 rounded-lg text-base font-black text-stone-900 shrink-0"
              style={{ backgroundColor: diffColor }}
            >
              {diff}
            </span>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-bold text-stone-100 leading-tight">{trail.name}</h2>
              <p className="text-[11px] text-stone-400 mt-0.5">
                <span style={{ color: diffColor }}>{diffLabel}</span>
                {trail.legal_status ? <> · {trail.legal_status}</> : null}
                {trail.distance_km != null ? <> · {trail.distance_km.toFixed(1)} km</> : null}
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-stone-800 flex items-center justify-center text-stone-400 hover:text-stone-200 transition-colors shrink-0"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Stats grid */}
        <div className="px-4 pb-3 grid grid-cols-2 gap-2">
          <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,18%)] rounded-lg px-3 py-2">
            <div className="text-[9px] text-stone-500 uppercase tracking-wider">Type</div>
            <div className="text-sm font-bold text-stone-200 truncate">{trail.legal_status || trail.type || "Trail"}</div>
          </div>
          <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,18%)] rounded-lg px-3 py-2">
            <div className="text-[9px] text-stone-500 uppercase tracking-wider">Distance</div>
            <div className="text-sm font-bold text-stone-200">
              {trail.distance_km != null ? `${trail.distance_km.toFixed(1)} km` : "—"}
            </div>
          </div>
          <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,18%)] rounded-lg px-3 py-2">
            <div className="text-[9px] text-stone-500 uppercase tracking-wider">Surface</div>
            <div className="text-sm font-bold text-stone-200 truncate">{trail.terrain || "Off-road"}</div>
          </div>
          <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,18%)] rounded-lg px-3 py-2">
            <div className="text-[9px] text-stone-500 uppercase tracking-wider">Difficulty</div>
            <div className="text-sm font-bold" style={{ color: diffColor }}>{diff}/10 · {diffLabel}</div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="px-4 pb-5 pt-1 grid grid-cols-2 gap-2">
          <button
            onClick={handleAddToPlanner}
            disabled={inPlannerRoute}
            className={`py-3 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 ${
              inPlannerRoute
                ? "bg-amber-500/15 border border-amber-500/40 text-amber-400 cursor-default"
                : "text-stone-900 shadow-lg shadow-amber-900/30"
            }`}
            style={
              inPlannerRoute
                ? undefined
                : { background: "linear-gradient(135deg, #d4870c 0%, #f0a832 50%, #d4870c 100%)" }
            }
            data-testid="trail-detail-add-planner"
          >
            {inPlannerRoute ? (
              <>
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                In Planner
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                Add to Planner
              </>
            )}
          </button>
          <button
            onClick={handleSave}
            disabled={saveStatus === "saving" || saveStatus === "saved"}
            className={`py-3 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 border ${
              saveStatus === "saved"
                ? "border-amber-500/40 bg-amber-500/15 text-amber-400 cursor-default"
                : saveStatus === "error"
                ? "border-red-500/50 text-red-400 bg-red-500/10"
                : "border-stone-700 text-stone-300 bg-stone-900/40 hover:border-amber-500/40 hover:text-amber-400"
            }`}
            data-testid="trail-detail-save"
          >
            {saveStatus === "saving" ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-stone-500/40 border-t-stone-200 rounded-full animate-spin"></span>
                Saving…
              </>
            ) : saveStatus === "saved" ? (
              <>
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="#f0a832" stroke="#f0a832" strokeWidth="2">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
                Saved
              </>
            ) : saveStatus === "error" ? (
              <>Try Again</>
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
                Save
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
