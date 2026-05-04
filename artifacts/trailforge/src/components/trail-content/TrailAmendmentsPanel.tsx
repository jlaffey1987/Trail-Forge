import { useEffect, useMemo, useState } from "react";
import {
  fetchTrailAmendments,
  createTrailAmendment,
  decideAmendment,
  requestAmendmentGpxUploadUrl,
  type TrailAmendment,
  type AmendmentChanges,
  type ReasonCategory,
} from "@/lib/trailContent";
import { type Trail } from "@/lib/supabase";
import { useCurrentUser } from "@/hooks/useCurrentUser";

interface Props {
  trail: Trail;
  onCountsChanged?: () => void;
  canModerate: boolean;
}

const STATUS_STYLES: Record<TrailAmendment["status"], string> = {
  pending: "bg-amber-700/40 text-amber-300 border-amber-600/40",
  approved: "bg-emerald-700/40 text-emerald-300 border-emerald-600/40",
  rejected: "bg-red-700/40 text-red-300 border-red-600/40",
  archived: "bg-stone-700/40 text-stone-400 border-stone-600/40",
};

const CATEGORY_STYLES: Record<ReasonCategory, { label: string; cls: string }> = {
  route_change: { label: "Route change", cls: "bg-sky-700/40 text-sky-300 border-sky-600/40" },
  difficulty_change: { label: "Difficulty", cls: "bg-violet-700/40 text-violet-300 border-violet-600/40" },
  request_removal: { label: "Removal", cls: "bg-red-700/40 text-red-300 border-red-600/40" },
  other: { label: "Other", cls: "bg-stone-700/40 text-stone-300 border-stone-600/40" },
};

const REASON_CATEGORIES: { value: ReasonCategory; label: string; description: string }[] = [
  { value: "route_change", label: "Route change", description: "Closure, diversion, new path" },
  { value: "difficulty_change", label: "Difficulty change", description: "Weather, wear, conditions" },
  { value: "request_removal", label: "Request removal", description: "No longer lawful to ride" },
  { value: "other", label: "Other", description: "Any other correction" },
];

const FIELD_LABELS: Record<keyof AmendmentChanges, string> = {
  name: "Name",
  difficulty: "Difficulty",
  type: "Type",
  legal_status: "Legal status",
  terrain: "Terrain",
  action: "Action",
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function diffPairs(changes: AmendmentChanges): { label: string; value: string }[] {
  return (Object.keys(changes) as (keyof AmendmentChanges)[])
    .filter((k) => changes[k] !== undefined)
    .map((k) => ({
      label: FIELD_LABELS[k] ?? k,
      value: changes[k] === null ? "(cleared)" : String(changes[k]),
    }));
}

export default function TrailAmendmentsPanel({ trail, onCountsChanged, canModerate }: Props) {
  const { isSignedIn } = useCurrentUser();
  const [items, setItems] = useState<TrailAmendment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const [reasonCategory, setReasonCategory] = useState<ReasonCategory>("other");
  const [name, setName] = useState<string>(trail.name ?? "");
  const [difficulty, setDifficulty] = useState<string>(
    trail.difficulty != null ? String(trail.difficulty) : "",
  );
  const [legalStatus, setLegalStatus] = useState<string>(trail.legal_status ?? "");
  const [terrain, setTerrain] = useState<string>(trail.terrain ?? "");
  const [reason, setReason] = useState("");
  const [gpxFile, setGpxFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<TrailAmendment | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState<TrailAmendment | null>(null);

  const isRemoval = reasonCategory === "request_removal";

  const initial = useMemo(
    () => ({
      name: trail.name ?? "",
      difficulty: trail.difficulty != null ? String(trail.difficulty) : "",
      legalStatus: trail.legal_status ?? "",
      terrain: trail.terrain ?? "",
    }),
    [trail],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTrailAmendments(trail.id).then((rows) => {
      if (cancelled) return;
      setItems(rows);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [trail.id]);

  const submit = async () => {
    setError(null);
    const proposed: AmendmentChanges = {};

    if (isRemoval) {
      proposed.action = "remove";
    } else {
      if (name.trim() && name.trim() !== initial.name) proposed.name = name.trim();
      if (difficulty !== initial.difficulty) {
        if (difficulty === "") proposed.difficulty = null;
        else {
          const n = Number(difficulty);
          if (!Number.isInteger(n) || n < 1 || n > 10) {
            setError("Difficulty must be an integer 1-10");
            return;
          }
          proposed.difficulty = n;
        }
      }
      if (legalStatus !== initial.legalStatus)
        proposed.legal_status = legalStatus.trim() === "" ? null : legalStatus.trim();
      if (terrain !== initial.terrain)
        proposed.terrain = terrain.trim() === "" ? null : terrain.trim();
    }

    const hasChange = Object.keys(proposed).length > 0;
    if (!hasChange && !gpxFile) {
      setError(isRemoval ? "Select the removal reason" : "Edit at least one field or attach a replacement GPX");
      return;
    }
    if (reason.trim().length === 0) {
      setError("Add a short reason explaining the change");
      return;
    }

    setSubmitting(true);
    let gpxKey: string | undefined;
    try {
      if (gpxFile) {
        const ticket = await requestAmendmentGpxUploadUrl(trail.id);
        if (!ticket) throw new Error("Could not get upload URL");
        const put = await fetch(ticket.uploadURL, {
          method: "PUT",
          body: gpxFile,
          headers: { "Content-Type": "application/gpx+xml" },
        });
        if (!put.ok) throw new Error(`GPX upload failed: ${put.status}`);
        gpxKey = ticket.storageKey;
      }
      const created = await createTrailAmendment(trail.id, {
        proposedChanges: proposed,
        reason: reason.trim(),
        replacementGpxStorageKey: gpxKey,
        reasonCategory,
      });
      if (!created) throw new Error("Could not submit amendment");
      setItems((prev) => [created, ...prev]);
      setShowForm(false);
      setReason("");
      setGpxFile(null);
      setReasonCategory("other");
      onCountsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  const runDecision = async (
    am: TrailAmendment,
    decision: "approve" | "reject",
    reasonText?: string,
  ) => {
    setDeciding(true);
    setDecideError(null);
    try {
      const ok = await decideAmendment(trail.id, am.id, decision, reasonText);
      if (!ok) {
        setDecideError(
          decision === "approve"
            ? "Could not approve this amendment. Please try again."
            : "Could not reject this amendment. Please try again.",
        );
        return false;
      }
      const rows = await fetchTrailAmendments(trail.id);
      setItems(rows);
      onCountsChanged?.();
      return true;
    } finally {
      setDeciding(false);
    }
  };

  const onApprove = (am: TrailAmendment) => {
    const isRemovalAm = am.proposed_changes?.action === "remove";
    if (isRemovalAm) {
      setConfirmingRemoval(am);
      return;
    }
    void runDecision(am, "approve");
  };

  const confirmRemovalApproval = async () => {
    if (!confirmingRemoval) return;
    const ok = await runDecision(confirmingRemoval, "approve");
    if (ok) {
      setConfirmingRemoval(null);
    }
  };

  const onRejectClick = (am: TrailAmendment) => {
    setDecideError(null);
    setRejectReason("");
    setRejecting(am);
  };

  const confirmReject = async () => {
    if (!rejecting) return;
    const trimmed = rejectReason.trim();
    const ok = await runDecision(rejecting, "reject", trimmed === "" ? undefined : trimmed);
    if (ok) {
      setRejecting(null);
      setRejectReason("");
    }
  };

  const cancelReject = () => {
    if (deciding) return;
    setRejecting(null);
    setRejectReason("");
  };

  return (
    <div className="px-4 pt-3 pb-5 space-y-3" data-testid="trail-amendments-panel">
      <div className="flex items-center justify-between">
        <p className="text-xs text-stone-400">
          {loading ? "Loading…" : `${items.length} amendment${items.length === 1 ? "" : "s"}`}
        </p>
        {isSignedIn ? (
          <button
            onClick={() => setShowForm((v) => !v)}
            className="px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900"
            style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
            data-testid="amendment-toggle-form"
          >
            {showForm ? "Cancel" : "Propose Edit"}
          </button>
        ) : (
          <span className="text-[11px] text-stone-500">Sign in to propose</span>
        )}
      </div>

      {decideError && !rejecting ? (
        <div
          className="rounded-lg border border-red-600/40 bg-red-900/20 px-3 py-2 text-[11px] text-red-300 flex items-start justify-between gap-2"
          role="alert"
          data-testid="amendment-decide-error"
        >
          <span>{decideError}</span>
          <button
            onClick={() => setDecideError(null)}
            className="text-red-300/80 hover:text-red-200 text-[10px] uppercase tracking-wider"
            data-testid="amendment-decide-error-dismiss"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {showForm ? (
        <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,18%)] rounded-lg p-3 space-y-2">
          <FormField label="What kind of change?">
            <div className="grid grid-cols-2 gap-1.5 mt-1">
              {REASON_CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  type="button"
                  onClick={() => setReasonCategory(cat.value)}
                  className={`text-left px-2.5 py-2 rounded-lg border text-[11px] transition-colors ${
                    reasonCategory === cat.value
                      ? "border-amber-500/60 bg-amber-500/15 text-amber-300"
                      : "border-stone-700 bg-stone-900/40 text-stone-400 hover:border-stone-600"
                  }`}
                  data-testid={`amendment-category-${cat.value}`}
                >
                  <div className="font-bold">{cat.label}</div>
                  <div className="text-[10px] opacity-70">{cat.description}</div>
                </button>
              ))}
            </div>
          </FormField>

          {!isRemoval ? (
            <>
              <FormField label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={200}
                  className="w-full bg-stone-900 border border-stone-700 rounded p-1.5 text-sm text-stone-200"
                  data-testid="amendment-name"
                />
              </FormField>
              <div className="grid grid-cols-2 gap-2">
                <FormField label="Difficulty (1-10)">
                  <input
                    value={difficulty}
                    onChange={(e) => setDifficulty(e.target.value)}
                    inputMode="numeric"
                    className="w-full bg-stone-900 border border-stone-700 rounded p-1.5 text-sm text-stone-200"
                    data-testid="amendment-difficulty"
                  />
                </FormField>
                <FormField label="Legal status">
                  <input
                    value={legalStatus}
                    onChange={(e) => setLegalStatus(e.target.value)}
                    maxLength={100}
                    className="w-full bg-stone-900 border border-stone-700 rounded p-1.5 text-sm text-stone-200"
                    data-testid="amendment-legal"
                  />
                </FormField>
              </div>
              <FormField label="Terrain">
                <input
                  value={terrain}
                  onChange={(e) => setTerrain(e.target.value)}
                  maxLength={100}
                  className="w-full bg-stone-900 border border-stone-700 rounded p-1.5 text-sm text-stone-200"
                  data-testid="amendment-terrain"
                />
              </FormField>
              <FormField label="Replacement GPX (optional)">
                <input
                  type="file"
                  accept=".gpx,application/gpx+xml,application/xml,text/xml"
                  onChange={(e) => setGpxFile(e.target.files?.[0] ?? null)}
                  className="text-xs text-stone-300"
                  data-testid="amendment-gpx"
                />
              </FormField>
            </>
          ) : (
            <div className="rounded-lg border border-red-600/30 bg-red-900/15 px-3 py-2 text-[11px] text-red-300">
              This will request the trail be hidden from all riders. Please explain below why the trail should be removed.
            </div>
          )}

          <FormField label={isRemoval ? "Why should this trail be removed?" : "Reason for change"}>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={2000}
              className="w-full bg-stone-900 border border-stone-700 rounded p-1.5 text-sm text-stone-200"
              data-testid="amendment-reason"
            />
          </FormField>
          {error ? <p className="text-[11px] text-red-400">{error}</p> : null}
          <div className="flex justify-end">
            <button
              onClick={submit}
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
              style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
              data-testid="amendment-submit"
            >
              {submitting ? "Submitting…" : isRemoval ? "Submit Removal Request" : "Submit Amendment"}
            </button>
          </div>
        </div>
      ) : null}

      {!loading && items.length === 0 ? (
        <p className="text-xs text-stone-500 text-center py-6">No amendments proposed yet.</p>
      ) : null}

      <div className="space-y-2">
        {items.map((am) => {
          const pairs = diffPairs(am.proposed_changes ?? {});
          const author = am.users?.display_name ?? "A rider";
          const catStyle = am.reason_category ? CATEGORY_STYLES[am.reason_category] : null;
          return (
            <div
              key={am.id}
              className="rounded-lg p-3 bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,18%)]"
              data-testid={`amendment-${am.id}`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold border ${
                      STATUS_STYLES[am.status]
                    }`}
                    data-testid={`amendment-status-${am.id}`}
                  >
                    {am.status}
                  </span>
                  {catStyle ? (
                    <span
                      className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold border ${catStyle.cls}`}
                      data-testid={`amendment-category-tag-${am.id}`}
                    >
                      {catStyle.label}
                    </span>
                  ) : null}
                  <span className="text-xs text-stone-300">{author}</span>
                </div>
                <span className="text-[10px] text-stone-500">{timeAgo(am.created_at)}</span>
              </div>
              {pairs.length > 0 ? (
                <ul className="text-xs text-stone-300 mt-1 space-y-0.5">
                  {pairs.map((p) => (
                    <li key={p.label}>
                      <span className="text-stone-500">{p.label}: </span>
                      <span className="text-amber-300">{p.value}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {am.replacement_gpx_storage_key ? (
                <p className="text-[11px] text-sky-300 mt-1">
                  Includes a replacement GPX file
                </p>
              ) : null}
              <p className="text-xs text-stone-400 mt-2 whitespace-pre-wrap">{am.reason}</p>
              {am.decision_reason ? (
                <p className="text-[11px] text-stone-500 mt-1 italic">
                  Decision note: {am.decision_reason}
                </p>
              ) : null}
              {canModerate && am.status === "pending" ? (
                <div className="flex gap-2 mt-2 justify-end">
                  <button
                    onClick={() => onRejectClick(am)}
                    disabled={deciding}
                    className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider text-red-300 border border-red-600/40 hover:bg-red-900/30 disabled:opacity-50"
                    data-testid={`amendment-reject-${am.id}`}
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => onApprove(am)}
                    disabled={deciding}
                    className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider text-emerald-300 border border-emerald-600/40 hover:bg-emerald-900/30 disabled:opacity-50"
                    data-testid={`amendment-approve-${am.id}`}
                  >
                    Approve
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {rejecting ? (
        <div
          className="fixed inset-0 z-[3050] flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="amendment-reject-title"
          data-testid="amendment-reject-dialog"
        >
          <div
            className="w-full max-w-md rounded-2xl overflow-hidden"
            style={{ background: "hsl(22,15%,9%)" }}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)]">
              <h2
                id="amendment-reject-title"
                className="text-base font-bold text-amber-400 uppercase tracking-widest"
              >
                Reject Amendment
              </h2>
              <button
                onClick={cancelReject}
                disabled={deciding}
                className="text-xs text-stone-500 hover:text-red-400 disabled:opacity-50"
                data-testid="amendment-reject-cancel"
              >
                Cancel
              </button>
            </div>
            <div className="px-4 py-4 space-y-3">
              <p className="text-xs text-stone-400">
                Add an optional note explaining why this amendment is being rejected. The
                author will see this note alongside the decision.
              </p>
              <FormField label="Decision reason (optional)">
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  autoFocus
                  className="w-full bg-stone-900 border border-stone-700 rounded p-2 text-sm text-stone-200"
                  data-testid="amendment-reject-reason"
                />
              </FormField>
              {decideError ? (
                <p
                  className="text-[11px] text-red-400"
                  role="alert"
                  data-testid="amendment-reject-dialog-error"
                >
                  {decideError}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button
                  onClick={cancelReject}
                  disabled={deciding}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-300 border border-stone-700 hover:bg-stone-800 disabled:opacity-50"
                  data-testid="amendment-reject-dialog-cancel"
                >
                  Keep Pending
                </button>
                <button
                  onClick={confirmReject}
                  disabled={deciding}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg, #b91c1c, #ef4444)" }}
                  data-testid="amendment-reject-confirm"
                >
                  {deciding ? "Rejecting…" : "Confirm Reject"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {confirmingRemoval ? (
        <div
          className="fixed inset-0 z-[3050] flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="amendment-removal-title"
          data-testid="amendment-removal-dialog"
        >
          <div
            className="w-full max-w-md rounded-2xl overflow-hidden"
            style={{ background: "hsl(22,15%,9%)" }}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)]">
              <h2
                id="amendment-removal-title"
                className="text-base font-bold text-red-400 uppercase tracking-widest"
              >
                Confirm Trail Removal
              </h2>
              <button
                onClick={() => setConfirmingRemoval(null)}
                disabled={deciding}
                className="text-xs text-stone-500 hover:text-red-400 disabled:opacity-50"
                data-testid="amendment-removal-cancel"
              >
                Cancel
              </button>
            </div>
            <div className="px-4 py-4 space-y-3">
              <div className="rounded-lg border border-red-600/30 bg-red-900/15 px-3 py-2 text-[11px] text-red-300">
                Approving this removal request will hide the trail from all riders. The trail data will be preserved but no longer visible in search or on the map.
              </div>
              <p className="text-xs text-stone-400">
                Reason given: <span className="text-stone-200">{confirmingRemoval.reason}</span>
              </p>
              {decideError ? (
                <p className="text-[11px] text-red-400" role="alert">{decideError}</p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmingRemoval(null)}
                  disabled={deciding}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-300 border border-stone-700 hover:bg-stone-800 disabled:opacity-50"
                  data-testid="amendment-removal-dialog-cancel"
                >
                  Keep Visible
                </button>
                <button
                  onClick={confirmRemovalApproval}
                  disabled={deciding}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg, #b91c1c, #ef4444)" }}
                  data-testid="amendment-removal-confirm"
                >
                  {deciding ? "Removing…" : "Confirm Removal"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[10px] uppercase tracking-wider text-stone-500">
      <span>{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
