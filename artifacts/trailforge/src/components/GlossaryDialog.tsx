import { useEffect, useRef } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Optional anchor to scroll the panel to on open. Lets callers deep-link
   * a specific section (e.g. the Discover filter "?" jumps to "trail-types").
   */
  initialSection?: "trail-types" | "riding-styles" | "difficulty";
}

const DIFFICULTY_BANDS: Array<{
  range: string;
  label: string;
  color: string;
  body: string;
}> = [
  {
    range: "1–2",
    label: "Beginner",
    color: "#4ade80",
    body: "Smooth gravel and well-graded forestry roads. Comfortable on any dual-sport, no off-road experience needed.",
  },
  {
    range: "3–4",
    label: "Easy",
    color: "#bef264",
    body: "Hard-pack dirt, mild ruts, the occasional puddle. Fine for a first proper green-lane day on a stock bike.",
  },
  {
    range: "5–6",
    label: "Moderate",
    color: "#fbbf24",
    body: "Loose surfaces, real ruts, modest climbs and rocky sections. Knobblies and basic standing-up technique help a lot.",
  },
  {
    range: "7–8",
    label: "Hard",
    color: "#f97316",
    body: "Sustained technical riding — deep mud, big rocks, off-camber and step-ups. A proper enduro bike and confident skills are expected.",
  },
  {
    range: "9–10",
    label: "Expert",
    color: "#dc2626",
    body: "Extreme terrain. Boulder gardens, severe ruts, river crossings, hike-a-bike sections. Experienced riders only — and rarely solo.",
  },
];

const TRAIL_TYPES: Array<{ name: string; body: string; tag?: string }> = [
  {
    name: "BOAT",
    tag: "Byway Open to All Traffic",
    body: "A public right of way you can legally ride on a road-registered motorcycle. The strongest legal status for off-road bikes in the UK — same rights as a regular road.",
  },
  {
    name: "Green Lane",
    body: "An informal term for an unsealed track that's still a public road. Usually a BOAT or unclassified county road (UCR). Always check the legal status before you ride — not every grassy track is open to motorbikes.",
  },
  {
    name: "Restricted Byway",
    body: "Open to walkers, cyclists, horses and horse-drawn carriages — but NOT motor vehicles. Riding a motorbike here is illegal even if the track looks identical to a BOAT.",
  },
  {
    name: "UCR",
    tag: "Unclassified County Road",
    body: "A public road that isn't on the main highway map but still carries vehicular rights. Status varies by county — check the local definitive map before riding.",
  },
  {
    name: "Bridleway / Footpath",
    body: "Bridleways are for horses, cyclists and walkers. Footpaths are walkers only. Motor vehicles are banned on both — listed here only so you can recognise them and stay off them.",
  },
  {
    name: "Private / Permission",
    body: "Tracks on private land that the owner has opened to riders, often via a club or pay-to-ride scheme. Always confirm permission is current before you go.",
  },
];

const RIDING_STYLES: Array<{ name: string; body: string }> = [
  {
    name: "Trail",
    body: "The everyday off-road style — green lanes, forest tracks, mixed surfaces. Comfortable pace, road-legal bike, often a full day's loop with road sections in between.",
  },
  {
    name: "Enduro",
    body: "Aggressive, technical riding on tighter, rougher terrain. Steeper climbs, bigger obstacles, more standing up than sitting down. Usually a dedicated enduro bike with knobblies.",
  },
  {
    name: "Adventure",
    body: "Long-distance trail riding on bigger, heavier bikes (think 800cc+ ADV). Mostly gravel and graded tracks, multi-day routes, luggage on the back. The motorcycle equivalent of overlanding.",
  },
];

export default function GlossaryDialog({ open, onClose, initialSection }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Jump to the requested section once the dialog mounts. Done in an
  // effect (not inline) so the scroll target exists in the DOM by the
  // time we call scrollIntoView. Re-runs when the section changes
  // (e.g. opened from a different entry point).
  useEffect(() => {
    if (!open || !initialSection) return;
    const id = `glossary-${initialSection}`;
    // Defer to the next frame so the dialog has actually painted.
    const handle = window.requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el && scrollRef.current) {
        el.scrollIntoView({ block: "start", behavior: "auto" });
      }
    });
    return () => window.cancelAnimationFrame(handle);
  }, [open, initialSection]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center"
      onClick={onClose}
      data-testid="glossary-dialog-backdrop"
    >
      <div
        className="w-full max-w-md bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl flex flex-col"
        style={{ maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}
        data-testid="glossary-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="glossary-dialog-title"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
          <div>
            <h2
              id="glossary-dialog-title"
              className="text-sm font-bold text-amber-400 uppercase tracking-widest"
            >
              Glossary
            </h2>
            <p className="text-[11px] text-stone-500 mt-0.5">
              Trail types, riding styles, and the difficulty scale.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-100 text-xl leading-none px-1"
            data-testid="glossary-dialog-close"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Anchor links — let the rider jump straight to the section
            they care about without scrolling through everything. */}
        <div
          className="flex gap-2 px-4 py-2 border-b border-[hsl(30,12%,16%)] shrink-0 overflow-x-auto"
          style={{ scrollbarWidth: "none" }}
        >
          {(
            [
              { id: "trail-types", label: "Trail types" },
              { id: "riding-styles", label: "Riding styles" },
              { id: "difficulty", label: "Difficulty 1–10" },
            ] as const
          ).map((s) => (
            <a
              key={s.id}
              href={`#glossary-${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                document
                  .getElementById(`glossary-${s.id}`)
                  ?.scrollIntoView({ block: "start", behavior: "smooth" });
              }}
              className="shrink-0 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-[hsl(22,15%,14%)] text-stone-300 border border-[hsl(30,12%,20%)] hover:border-amber-500/60 hover:text-amber-400 transition-colors"
              data-testid={`glossary-jump-${s.id}`}
            >
              {s.label}
            </a>
          ))}
        </div>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 space-y-6 tf-scroll"
        >
          {/* Trail types */}
          <section id="glossary-trail-types" data-testid="glossary-section-trail-types">
            <h3 className="text-xs font-bold uppercase tracking-widest text-stone-200 mb-2">
              Trail types
            </h3>
            <p className="text-[11px] text-stone-500 mb-3">
              The legal status of a track decides whether you can ride it. Always
              check the on-the-ground signage and the county's definitive map
              before you commit.
            </p>
            <div className="space-y-3">
              {TRAIL_TYPES.map((t) => (
                <div
                  key={t.name}
                  className="bg-[hsl(22,15%,13%)] border border-[hsl(30,12%,20%)] rounded-lg px-3 py-2.5"
                >
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs font-bold text-amber-400">
                      {t.name}
                    </span>
                    {t.tag && (
                      <span className="text-[10px] text-stone-500 italic">
                        {t.tag}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-stone-300 leading-snug mt-1">
                    {t.body}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Riding styles */}
          <section id="glossary-riding-styles" data-testid="glossary-section-riding-styles">
            <h3 className="text-xs font-bold uppercase tracking-widest text-stone-200 mb-2">
              Riding styles
            </h3>
            <p className="text-[11px] text-stone-500 mb-3">
              These describe how a route is ridden, not its legal status. The
              same lane can be a casual trail ride or a hard enduro depending
              on conditions and pace.
            </p>
            <div className="space-y-3">
              {RIDING_STYLES.map((s) => (
                <div
                  key={s.name}
                  className="bg-[hsl(22,15%,13%)] border border-[hsl(30,12%,20%)] rounded-lg px-3 py-2.5"
                >
                  <span className="text-xs font-bold text-amber-400">
                    {s.name}
                  </span>
                  <p className="text-[11px] text-stone-300 leading-snug mt-1">
                    {s.body}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Difficulty scale */}
          <section id="glossary-difficulty" data-testid="glossary-section-difficulty">
            <h3 className="text-xs font-bold uppercase tracking-widest text-stone-200 mb-2">
              Difficulty scale
            </h3>
            <p className="text-[11px] text-stone-500 mb-3">
              Every trail is rated 1–10 based on terrain, surface, and the
              skill level the route demands. Ratings are advisory — weather
              can move a 4 to a 7 overnight.
            </p>
            <div className="space-y-2">
              {DIFFICULTY_BANDS.map((b) => (
                <div
                  key={b.range}
                  className="bg-[hsl(22,15%,13%)] border border-[hsl(30,12%,20%)] rounded-lg px-3 py-2.5 flex gap-3"
                >
                  <div className="flex flex-col items-center gap-1 shrink-0 w-12">
                    <div
                      className="w-10 h-2 rounded-full"
                      style={{ background: b.color }}
                    />
                    <span className="text-[11px] font-black text-stone-100">
                      {b.range}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-bold text-amber-400">
                      {b.label}
                    </span>
                    <p className="text-[11px] text-stone-300 leading-snug mt-0.5">
                      {b.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <p className="text-[10px] text-stone-600 text-center pt-2 pb-1">
            Ride within the law. When in doubt, look it up on the local
            definitive map — or ask before you ride.
          </p>
        </div>
      </div>
    </div>
  );
}
