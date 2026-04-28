import { useEffect, useMemo, useState } from "react";
import type { Waypoint } from "@/lib/gpx";
import { distanceKmFromWaypoints, bboxFromWaypoints } from "@/lib/gpx";
import { uploadGpxToStorage, type CreateTrailInput, type TrailPrivacy } from "@/lib/supabase";

const TRAIL_TYPES: { value: string; label: string }[] = [
  { value: "BOAT", label: "BOAT" },
  { value: "Green Lane", label: "Green Lane" },
  { value: "UCR", label: "UCR" },
  { value: "Other", label: "Other" },
];

const SURFACE_OPTIONS = [
  "Mixed",
  "Gravel",
  "Dirt",
  "Mud",
  "Rocky",
  "Sand",
  "Grass",
  "Tarmac",
];

export interface SaveTrailFormResult {
  /** Final input ready to send to `addTrail()`. */
  input: CreateTrailInput;
}

export interface SaveTrailFormPrefill {
  name?: string;
  difficulty?: number;
  legal_status?: string;
  terrain?: string;
  description?: string;
  /** Auto-computed distance — overridden if the user edits the field. */
  distanceKm?: number;
}

interface Props {
  open: boolean;
  /** Title for the bottom sheet (e.g. "Save Drawn Trail"). */
  title: string;
  /** Geometry the trail will be saved with. */
  waypoints: Waypoint[];
  /** GPX XML to persist (caller-supplied so the original XML is preserved when uploading). */
  gpxData: string;
  /** Optional pre-fill values from the source flow. */
  prefill?: SaveTrailFormPrefill;
  onCancel: () => void;
  /**
   * Called with the validated input. The caller persists it (typically via
   * `addTrail`) and reports success/failure back via the returned promise.
   */
  onSave: (result: SaveTrailFormResult) => Promise<{ ok: boolean; error?: string }>;
}

export default function SaveTrailForm({
  open,
  title,
  waypoints,
  gpxData,
  prefill,
  onCancel,
  onSave,
}: Props) {
  const autoDistanceKm = useMemo(
    () => (prefill?.distanceKm != null ? prefill.distanceKm : distanceKmFromWaypoints(waypoints)),
    [waypoints, prefill?.distanceKm],
  );

  const [name, setName] = useState(prefill?.name ?? "");
  const [difficulty, setDifficulty] = useState<number>(prefill?.difficulty ?? 5);
  const [legalStatus, setLegalStatus] = useState<string>(prefill?.legal_status ?? "BOAT");
  const [terrain, setTerrain] = useState<string>(prefill?.terrain ?? "Mixed");
  const [distanceKm, setDistanceKm] = useState<string>(autoDistanceKm.toFixed(2));
  const [description, setDescription] = useState<string>(prefill?.description ?? "");
  // Privacy defaults to PRIVATE for safety (per task spec).
  const [privacy, setPrivacy] = useState<TrailPrivacy>("private");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-prefill when the modal is re-opened with different data.
  useEffect(() => {
    if (!open) return;
    setName(prefill?.name ?? "");
    setDifficulty(prefill?.difficulty ?? 5);
    setLegalStatus(prefill?.legal_status ?? "BOAT");
    setTerrain(prefill?.terrain ?? "Mixed");
    setDistanceKm(autoDistanceKm.toFixed(2));
    setDescription(prefill?.description ?? "");
    setPrivacy("private");
    setError(null);
    setSubmitting(false);
    // We intentionally re-key on `open` (not prefill) so user edits aren't
    // wiped while the form is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const handleSubmit = async () => {
    setError(null);
    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      setError("Trail name must be at least 2 characters");
      return;
    }
    if (waypoints.length < 2) {
      setError("Trail needs at least 2 waypoints");
      return;
    }
    const distNum = parseFloat(distanceKm);
    if (isNaN(distNum) || distNum <= 0) {
      setError("Distance must be a positive number");
      return;
    }

    const bbox = bboxFromWaypoints(waypoints);

    setSubmitting(true);

    // Upload the canonical GPX XML to object storage so it lives outside the
    // database (as required by the storage architecture). The server keeps a
    // reference via `gpx_object_path` and finalizes the ACL on save.
    const ticket = await uploadGpxToStorage(gpxData);
    if (!ticket) {
      setSubmitting(false);
      setError("Could not upload GPX to storage. Please try again.");
      return;
    }

    const input: CreateTrailInput = {
      name: trimmedName,
      type: legalStatus,
      legal_status: legalStatus,
      difficulty,
      terrain,
      distance_km: parseFloat(distNum.toFixed(2)),
      gpx_data: gpxData,
      gpx_object_path: ticket.objectPath,
      description: description.trim() || null,
      privacy,
      bbox_min_lat: bbox?.minLat ?? null,
      bbox_max_lat: bbox?.maxLat ?? null,
      bbox_min_lng: bbox?.minLng ?? null,
      bbox_max_lng: bbox?.maxLng ?? null,
    };

    const result = await onSave({ input });
    if (!result.ok) {
      setSubmitting(false);
      setError(result.error ?? "Could not save trail");
      return;
    }
    setSubmitting(false);
  };

  return (
    <div
      className="fixed inset-0 z-[3000] flex flex-col"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)" }}
      role="dialog"
      aria-modal="true"
      data-testid="save-trail-form"
    >
      <div
        className="flex flex-col mt-auto rounded-t-2xl overflow-hidden"
        style={{ background: "hsl(22,15%,9%)", maxHeight: "92vh" }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-stone-700"></div>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
          <div>
            <h2 className="text-base font-bold text-amber-400 uppercase tracking-widest">
              {title}
            </h2>
            <p className="text-[11px] text-stone-500 mt-0.5">
              {waypoints.length} points · {autoDistanceKm.toFixed(2)} km
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-xs text-stone-500 hover:text-red-400 transition-colors"
            data-testid="save-trail-cancel"
          >
            Cancel
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">
              Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Rivington BOAT loop"
              className="w-full px-3 py-2.5 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-sm text-stone-100 focus:border-amber-500 focus:outline-none"
              data-testid="save-trail-name"
              maxLength={200}
            />
          </div>

          {/* Difficulty slider */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500">
                Difficulty
              </label>
              <span className="text-sm font-bold text-amber-400" data-testid="save-trail-difficulty-value">
                {difficulty}/10
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={difficulty}
              onChange={(e) => setDifficulty(parseInt(e.target.value, 10))}
              className="w-full accent-amber-500"
              data-testid="save-trail-difficulty"
            />
            <div className="flex justify-between text-[9px] text-stone-600 mt-0.5 px-0.5">
              <span>Easy</span>
              <span>Moderate</span>
              <span>Hard</span>
              <span>Extreme</span>
            </div>
          </div>

          {/* Type + Surface */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">
                Type
              </label>
              <select
                value={legalStatus}
                onChange={(e) => setLegalStatus(e.target.value)}
                className="w-full px-2 py-2 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-sm text-stone-100"
                data-testid="save-trail-type"
              >
                {TRAIL_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">
                Surface
              </label>
              <select
                value={terrain}
                onChange={(e) => setTerrain(e.target.value)}
                className="w-full px-2 py-2 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-sm text-stone-100"
                data-testid="save-trail-surface"
              >
                {SURFACE_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Distance */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">
              Distance (km)
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              value={distanceKm}
              onChange={(e) => setDistanceKm(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-sm text-stone-100 focus:border-amber-500 focus:outline-none"
              data-testid="save-trail-distance"
            />
            <p className="text-[10px] text-stone-600 mt-1">
              Auto-computed from track ({autoDistanceKm.toFixed(2)} km) — adjust if needed.
            </p>
          </div>

          {/* Description */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">
              Notes (optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Surface conditions, gates, parking, etc."
              rows={3}
              maxLength={5000}
              className="w-full px-3 py-2 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-sm text-stone-100 focus:border-amber-500 focus:outline-none resize-none"
              data-testid="save-trail-description"
            />
          </div>

          {/* Privacy */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">
              Visibility
            </label>
            <div className="grid grid-cols-3 gap-2">
              <PrivacyOption
                value="private"
                current={privacy}
                onSelect={setPrivacy}
                title="Private"
                subtitle="Only me"
                testId="save-trail-privacy-private"
              />
              <PrivacyOption
                value="public"
                current={privacy}
                onSelect={setPrivacy}
                title="Public"
                subtitle="Visible to all"
                testId="save-trail-privacy-public"
              />
              <PrivacyOption
                value="group"
                current={privacy}
                onSelect={setPrivacy}
                title="Group"
                subtitle="Coming soon"
                testId="save-trail-privacy-group"
                disabled
              />
            </div>
            <p className="text-[10px] text-stone-600 mt-1.5">
              Private trails are stored only on your account. Public trails appear in Discover and the Map for everyone.
            </p>
          </div>

          {error && (
            <div className="bg-red-900/40 border border-red-500/40 rounded-lg px-3 py-2">
              <p className="text-xs text-red-300" data-testid="save-trail-error">{error}</p>
            </div>
          )}
        </div>

        {/* Sticky footer */}
        <div className="shrink-0 border-t border-[hsl(30,12%,16%)] px-4 py-3 flex gap-2">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="flex-1 py-3 rounded-xl text-sm font-bold uppercase tracking-wider text-stone-400 border border-stone-700"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 py-3 rounded-xl text-sm font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
            data-testid="save-trail-submit"
          >
            {submitting ? "Saving…" : "Save Trail"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PrivacyOptionProps {
  value: TrailPrivacy;
  current: TrailPrivacy;
  onSelect: (v: TrailPrivacy) => void;
  title: string;
  subtitle: string;
  testId: string;
  disabled?: boolean;
}

function PrivacyOption({
  value, current, onSelect, title, subtitle, testId, disabled,
}: PrivacyOptionProps) {
  const active = current === value;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(value)}
      className={`px-2 py-2.5 rounded-lg border text-left transition-all ${
        disabled
          ? "border-stone-800 text-stone-700 cursor-not-allowed bg-[hsl(22,15%,12%)]"
          : active
          ? "border-amber-500 bg-amber-500/10 text-amber-300"
          : "border-stone-700 text-stone-300 hover:border-stone-500"
      }`}
      data-testid={testId}
    >
      <div className="text-xs font-bold uppercase tracking-wider">{title}</div>
      <div className="text-[10px] text-stone-500 mt-0.5">{subtitle}</div>
    </button>
  );
}
