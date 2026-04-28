import { useEffect, useState } from "react";
import {
  updateOwnedTrail,
  replaceOwnedTrailGpx,
  uploadGpxToStorage,
  type Trail,
  type TrailPrivacy,
  type UpdateTrailInput,
} from "@/lib/supabase";
import { validateGpxString } from "@/lib/gpx";

const TRAIL_TYPES = ["BOAT", "Green Lane", "UCR", "Other"];
const SURFACES = ["Mixed", "Gravel", "Dirt", "Mud", "Rocky", "Sand", "Grass", "Tarmac"];

interface Props {
  open: boolean;
  trail: Trail | null;
  onClose: () => void;
  /** Called after a successful save/replace so the parent can refresh. */
  onChanged: (updated: Trail) => void;
}

function inferPrivacy(trail: Trail): TrailPrivacy {
  return trail.is_public ? "public" : "private";
}

export default function EditTrailDialog({ open, trail, onClose, onChanged }: Props) {
  const [name, setName] = useState("");
  const [difficulty, setDifficulty] = useState(5);
  const [legalStatus, setLegalStatus] = useState("BOAT");
  const [terrain, setTerrain] = useState("Mixed");
  const [distanceKm, setDistanceKm] = useState("0");
  const [description, setDescription] = useState("");
  const [privacy, setPrivacy] = useState<TrailPrivacy>("private");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);

  useEffect(() => {
    if (!open || !trail) return;
    setName(trail.name ?? "");
    setDifficulty(trail.difficulty ?? 5);
    setLegalStatus(trail.legal_status ?? trail.type ?? "BOAT");
    setTerrain(trail.terrain ?? "Mixed");
    setDistanceKm((trail.distance_km ?? 0).toString());
    setDescription(trail.description ?? "");
    setPrivacy(inferPrivacy(trail));
    setError(null);
    setSubmitting(false);
    setReplacing(false);
  }, [open, trail]);

  if (!open || !trail) return null;

  const handleSave = async () => {
    setError(null);
    if (name.trim().length < 2) {
      setError("Trail name must be at least 2 characters");
      return;
    }
    const distNum = parseFloat(distanceKm);
    if (isNaN(distNum) || distNum < 0) {
      setError("Distance must be a number");
      return;
    }
    setSubmitting(true);
    const input: UpdateTrailInput = {
      name: name.trim(),
      difficulty,
      legal_status: legalStatus,
      type: legalStatus,
      terrain,
      distance_km: distNum,
      description: description.trim() || null,
      privacy,
    };
    const updated = await updateOwnedTrail(trail.id, input);
    setSubmitting(false);
    if (!updated) {
      setError("Could not update trail");
      return;
    }
    onChanged(updated);
    onClose();
  };

  const handleReplaceGpx = async (file: File) => {
    setError(null);
    if (!/\.gpx$/i.test(file.name)) {
      setError("Please choose a .gpx file");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("GPX file is too large (max 10 MB)");
      return;
    }
    const text = await file.text();
    const v = validateGpxString(text);
    if (!v.ok) {
      setError(v.error ?? "Could not parse GPX");
      return;
    }
    setReplacing(true);
    // Upload the new GPX file to object storage first; pass the resulting
    // objectPath to the replace endpoint so the server can finalize the ACL,
    // persist the new artifact reference, and remove the old object.
    const ticket = await uploadGpxToStorage(text);
    if (!ticket) {
      setReplacing(false);
      setError("Could not upload GPX to storage");
      return;
    }
    const updated = await replaceOwnedTrailGpx(trail.id, {
      gpx_data: text,
      gpx_object_path: ticket.objectPath,
      distance_km: parseFloat(v.distanceKm.toFixed(2)),
      bbox_min_lat: v.bbox?.minLat ?? null,
      bbox_max_lat: v.bbox?.maxLat ?? null,
      bbox_min_lng: v.bbox?.minLng ?? null,
      bbox_max_lng: v.bbox?.maxLng ?? null,
    });
    setReplacing(false);
    if (!updated) {
      setError("Could not replace GPX");
      return;
    }
    setDistanceKm(v.distanceKm.toFixed(2));
    onChanged(updated);
  };

  return (
    <div
      className="fixed inset-0 z-[2900] flex flex-col"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)" }}
      role="dialog"
      aria-modal="true"
      data-testid="edit-trail-dialog"
    >
      <div
        className="mt-auto rounded-t-2xl overflow-hidden flex flex-col"
        style={{ background: "hsl(22,15%,9%)", maxHeight: "92vh" }}
      >
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-stone-700"></div>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
          <div>
            <h2 className="text-base font-bold text-amber-400 uppercase tracking-widest">
              Edit Trail
            </h2>
            <p className="text-[11px] text-stone-500 mt-0.5 truncate max-w-[240px]">{trail.name}</p>
          </div>
          <button
            onClick={onClose}
            className="text-xs text-stone-500 hover:text-red-400"
            data-testid="edit-trail-cancel"
          >
            Close
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4 space-y-4">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-sm text-stone-100 focus:border-amber-500 focus:outline-none"
              maxLength={200}
              data-testid="edit-trail-name"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500">Difficulty</label>
              <span className="text-sm font-bold text-amber-400">{difficulty}/10</span>
            </div>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={difficulty}
              onChange={(e) => setDifficulty(parseInt(e.target.value, 10))}
              className="w-full accent-amber-500"
              data-testid="edit-trail-difficulty"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">Type</label>
              <select
                value={legalStatus}
                onChange={(e) => setLegalStatus(e.target.value)}
                className="w-full px-2 py-2 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-sm text-stone-100"
                data-testid="edit-trail-type"
              >
                {TRAIL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">Surface</label>
              <select
                value={terrain}
                onChange={(e) => setTerrain(e.target.value)}
                className="w-full px-2 py-2 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-sm text-stone-100"
                data-testid="edit-trail-surface"
              >
                {SURFACES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">Distance (km)</label>
            <input
              type="number"
              step="0.1"
              min="0"
              value={distanceKm}
              onChange={(e) => setDistanceKm(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-sm text-stone-100"
              data-testid="edit-trail-distance"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">Notes</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={5000}
              className="w-full px-3 py-2 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-sm text-stone-100 resize-none"
              data-testid="edit-trail-description"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">Visibility</label>
            <div className="grid grid-cols-3 gap-2">
              {(["private", "public", "group"] as const).map((p) => {
                const disabled = p === "group";
                const active = privacy === p;
                return (
                  <button
                    key={p}
                    type="button"
                    disabled={disabled}
                    onClick={() => setPrivacy(p)}
                    className={`px-2 py-2.5 rounded-lg border text-xs font-bold uppercase tracking-wider ${
                      disabled
                        ? "border-stone-800 text-stone-700"
                        : active
                        ? "border-amber-500 bg-amber-500/10 text-amber-300"
                        : "border-stone-700 text-stone-300"
                    }`}
                    data-testid={`edit-trail-privacy-${p}`}
                  >
                    {p === "group" ? "Group (soon)" : p}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Replace GPX */}
          <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] rounded-lg p-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-stone-400 mb-1">
              Replace GPX track
            </div>
            <p className="text-[11px] text-stone-500 mb-2">
              Upload a new .gpx file to overwrite the recorded route. The
              distance and bounding box are recomputed automatically.
            </p>
            <label
              className={`block w-full text-center py-2 rounded-lg text-xs font-bold uppercase tracking-wider border cursor-pointer ${
                replacing
                  ? "border-stone-700 text-stone-500"
                  : "border-amber-500/50 text-amber-300 hover:bg-amber-500/10"
              }`}
              data-testid="edit-trail-replace-gpx"
            >
              {replacing ? "Replacing…" : "Choose GPX file…"}
              <input
                type="file"
                accept=".gpx,application/gpx+xml,application/xml,text/xml"
                className="hidden"
                disabled={replacing}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleReplaceGpx(file);
                  e.target.value = "";
                }}
              />
            </label>
          </div>

          {error && (
            <div className="bg-red-900/40 border border-red-500/40 rounded-lg px-3 py-2">
              <p className="text-xs text-red-300" data-testid="edit-trail-error">{error}</p>
            </div>
          )}
        </div>

        <div className="border-t border-[hsl(30,12%,16%)] p-3 flex gap-2 shrink-0">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 py-3 rounded-xl text-sm font-bold uppercase tracking-wider text-stone-400 border border-stone-700"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={submitting}
            className="flex-1 py-3 rounded-xl text-sm font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
            data-testid="edit-trail-save"
          >
            {submitting ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
