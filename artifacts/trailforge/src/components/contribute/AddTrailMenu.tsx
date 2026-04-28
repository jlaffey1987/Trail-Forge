import type { ComponentType } from "react";

export type AddTrailChoice = "upload" | "record" | "draw";

interface Props {
  open: boolean;
  onClose: () => void;
  onChoose: (choice: AddTrailChoice) => void;
  /** Disable the "Record" choice (e.g. when not on the Map tab so the user
   * can't accidentally start a recording from My Trails). */
  disableRecord?: boolean;
  /** Disable the "Draw" choice for the same reason. */
  disableDraw?: boolean;
}

export default function AddTrailMenu({
  open, onClose, onChoose, disableRecord, disableDraw,
}: Props) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[2500] flex flex-col"
      style={{ background: "rgba(0,0,0,0.78)", backdropFilter: "blur(2px)" }}
      onClick={onClose}
      data-testid="add-trail-menu"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="mt-auto rounded-t-2xl overflow-hidden"
        style={{ background: "hsl(22,15%,9%)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-stone-700"></div>
        </div>

        <div className="px-4 pt-2 pb-1">
          <h3 className="text-sm font-bold text-amber-400 uppercase tracking-widest">
            Add a Trail
          </h3>
          <p className="text-[11px] text-stone-500 mt-0.5">
            Choose how you want to capture this trail.
          </p>
        </div>

        <div className="p-3 space-y-2">
          <Tile
            icon={UploadIcon}
            title="Upload GPX"
            subtitle="From a .gpx file on your device"
            onClick={() => onChoose("upload")}
            testId="add-trail-upload"
          />
          <Tile
            icon={RecordIcon}
            title="Record a Ride"
            subtitle="Use GPS to capture as you ride"
            onClick={() => onChoose("record")}
            disabled={disableRecord}
            testId="add-trail-record"
          />
          <Tile
            icon={DrawIcon}
            title="Draw on Map"
            subtitle="Tap to place waypoints"
            onClick={() => onChoose("draw")}
            disabled={disableDraw}
            testId="add-trail-draw"
          />
        </div>

        <div className="px-4 pb-4 pt-1">
          <button
            onClick={onClose}
            className="w-full py-3 rounded-xl text-sm font-bold uppercase tracking-wider text-stone-400 border border-stone-700"
            data-testid="add-trail-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

interface TileProps {
  icon: React.ComponentType;
  title: string;
  subtitle: string;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
}

function Tile({ icon: Icon, title, subtitle, onClick, testId, disabled }: TileProps) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-left ${
        disabled
          ? "border-stone-800 bg-[hsl(22,15%,11%)] text-stone-600 cursor-not-allowed"
          : "border-[hsl(30,12%,22%)] bg-[hsl(22,15%,12%)] hover:border-amber-500/60 hover:bg-amber-500/5"
      }`}
      data-testid={testId}
    >
      <span
        className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
          disabled ? "bg-stone-800 text-stone-600" : "text-stone-900"
        }`}
        style={
          disabled
            ? undefined
            : { background: "linear-gradient(135deg, #d4870c, #f0a832)" }
        }
      >
        <Icon />
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-bold ${disabled ? "text-stone-500" : "text-stone-100"}`}>
          {title}
        </div>
        <div className="text-[11px] text-stone-500 mt-0.5">{subtitle}</div>
      </div>
      {!disabled && (
        <svg viewBox="0 0 24 24" className="w-4 h-4 text-stone-500" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      )}
    </button>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function RecordIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}

function DrawIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}
