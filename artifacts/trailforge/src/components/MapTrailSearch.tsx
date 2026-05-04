import { useState, useRef, useEffect, useCallback } from "react";
import { searchTrails, type TrailSearchResult } from "@workspace/api-client-react";
import { type Trail } from "@/lib/supabase";
import { getDifficultyColor } from "@/lib/trailLayer";

function toTrail(r: TrailSearchResult): Trail {
  return {
    id: r.id,
    user_id: null,
    name: r.name,
    type: r.type ?? null,
    difficulty: r.difficulty ?? null,
    distance_km: r.distance_km ?? null,
    terrain: r.terrain ?? null,
    legal_status: r.legal_status ?? null,
    is_public: r.is_public,
    created_at: "",
    verification_status: r.verification_status ?? null,
    bbox_min_lat: r.bbox_min_lat ?? null,
    bbox_max_lat: r.bbox_max_lat ?? null,
    bbox_min_lng: r.bbox_min_lng ?? null,
    bbox_max_lng: r.bbox_max_lng ?? null,
    simplified_path: r.simplified_path ?? null,
    path_geojson: r.path_geojson ?? null,
    source_region: r.source_region ?? null,
  } as Trail & { source_region: string | null };
}

interface Props {
  routeIdSet: Set<string>;
  onToggleTrail: (trail: Trail) => void;
  onFlyTo: (trail: Trail) => void;
}

export default function MapTrailSearch({ routeIdSet, onToggleTrail, onFlyTo }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Trail[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const resp = await searchTrails({ q: q.trim(), limit: 15 });
      setResults((resp.results ?? []).map(toTrail));
    } catch {
      setResults([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(() => void doSearch(query), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, doSearch]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute top-2 left-1/2 -translate-x-1/2 z-[1200] pointer-events-auto"
      style={{ width: "calc(100% - 24px)", maxWidth: "380px" }}
      data-testid="map-trail-search"
    >
      <div
        className="flex items-center gap-2 rounded-xl px-3 py-2 shadow-lg"
        style={{
          background: "hsl(22,15%,11%)",
          border: "1.5px solid rgba(212,135,12,0.5)",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          className="w-4 h-4 text-amber-400 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search trails by name…"
          className="flex-1 bg-transparent text-[13px] text-stone-100 placeholder:text-stone-500 outline-none min-w-0"
          data-testid="map-trail-search-input"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setResults([]);
              inputRef.current?.focus();
            }}
            className="w-5 h-5 rounded-full bg-stone-700/60 flex items-center justify-center text-stone-400 hover:text-stone-200 shrink-0"
            aria-label="Clear search"
          >
            <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {open && query.trim() && (
        <div
          className="mt-1 rounded-xl shadow-2xl overflow-hidden"
          style={{
            background: "hsl(22,15%,11%)",
            border: "1.5px solid rgba(212,135,12,0.35)",
          }}
          data-testid="map-trail-search-results"
        >
          {loading && results.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-stone-400">
              <span className="w-3 h-3 border border-amber-500/50 border-t-amber-500 rounded-full animate-spin" />
              Searching…
            </div>
          ) : results.length === 0 && !loading ? (
            <div className="px-3 py-4 text-[11px] text-stone-500 text-center">
              No trails found for "{query.trim()}"
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {results.map((trail) => {
                const inRoute = routeIdSet.has(trail.id);
                const diff = trail.difficulty ?? 5;
                const diffColor = getDifficultyColor(diff);
                const region = "source_region" in trail ? (trail as { source_region?: string | null }).source_region : null;
                return (
                  <div
                    key={trail.id}
                    className="flex items-center gap-2 px-3 py-2 border-b border-[hsl(30,12%,16%)] last:border-b-0 hover:bg-[hsl(22,15%,14%)] transition-colors"
                    data-testid={`map-search-result-${trail.id}`}
                  >
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: diffColor }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        onFlyTo(trail);
                        setOpen(false);
                      }}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="text-[12px] font-bold text-stone-100 truncate">
                        {trail.name}
                      </div>
                      <div className="text-[10px] text-stone-500">
                        {trail.distance_km != null
                          ? `${Number(trail.distance_km).toFixed(1)} km`
                          : "—"}
                        {region ? ` · ${region}` : ""}
                        {trail.legal_status ? ` · ${trail.legal_status}` : ""}
                        {trail.terrain ? ` · ${trail.terrain}` : ""}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleTrail(trail)}
                      className={`shrink-0 px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${
                        inRoute
                          ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                          : "bg-stone-700/50 text-stone-300 border border-stone-600/40 hover:border-amber-500/40 hover:text-amber-300"
                      }`}
                      data-testid={`map-search-toggle-${trail.id}`}
                    >
                      {inRoute ? (
                        <span className="flex items-center gap-1">
                          <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          Added
                        </span>
                      ) : (
                        "+ Add"
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
