import { useEffect, useState } from "react";
import {
  fetchTrailNotes,
  createTrailNote,
  deleteTrailNote,
  type TrailNote,
  type NoteKind,
} from "@/lib/trailContent";
import { useCurrentUser } from "@/hooks/useCurrentUser";

interface Props {
  trailId: string;
  onCountsChanged?: () => void;
}

const KIND_STYLES: Record<NoteKind, { label: string; chip: string; border: string }> = {
  info: {
    label: "Info",
    chip: "bg-stone-700/50 text-stone-200",
    border: "border-stone-700",
  },
  warning: {
    label: "Warning",
    chip: "bg-amber-700/40 text-amber-300",
    border: "border-amber-600/40",
  },
  condition: {
    label: "Condition",
    chip: "bg-sky-700/40 text-sky-300",
    border: "border-sky-600/40",
  },
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function TrailNotesPanel({ trailId, onCountsChanged }: Props) {
  const { isSignedIn, userId } = useCurrentUser();
  const [notes, setNotes] = useState<TrailNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<NoteKind>("info");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTrailNotes(trailId).then((items) => {
      if (cancelled) return;
      setNotes(items);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [trailId]);

  const submit = async () => {
    const text = body.trim();
    if (!text) return;
    setSubmitting(true);
    setError(null);
    const note = await createTrailNote(trailId, { body: text, kind });
    setSubmitting(false);
    if (!note) {
      setError("Could not post note");
      return;
    }
    setNotes((prev) => [note, ...prev]);
    setBody("");
    setKind("info");
    onCountsChanged?.();
  };

  const remove = async (note: TrailNote) => {
    if (!confirm("Remove this note?")) return;
    const ok = await deleteTrailNote(trailId, note.id);
    if (ok) {
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
      onCountsChanged?.();
    }
  };

  return (
    <div className="px-4 pt-3 pb-5 space-y-3" data-testid="trail-notes-panel">
      {isSignedIn ? (
        <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,18%)] rounded-lg p-3">
          <div className="flex gap-2 mb-2">
            {(Object.keys(KIND_STYLES) as NoteKind[]).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded-full font-bold transition-all ${
                  kind === k
                    ? KIND_STYLES[k].chip + " ring-1 ring-amber-500/40"
                    : "bg-stone-800 text-stone-400 hover:text-stone-200"
                }`}
                data-testid={`note-kind-${k}`}
              >
                {KIND_STYLES[k].label}
              </button>
            ))}
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Share an info, warning, or current condition..."
            rows={3}
            maxLength={2000}
            className="w-full bg-stone-900 border border-stone-700 rounded-lg p-2 text-sm text-stone-200 placeholder:text-stone-500 focus:outline-none focus:border-amber-500/60"
            data-testid="note-input"
          />
          {error ? <p className="text-[11px] text-red-400 mt-1">{error}</p> : null}
          <div className="flex justify-end mt-2">
            <button
              onClick={submit}
              disabled={submitting || body.trim().length === 0}
              className="px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
              style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
              data-testid="note-submit"
            >
              {submitting ? "Posting…" : "Post Note"}
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-stone-900/50 border border-stone-800 rounded-lg p-3 text-xs text-stone-400">
          Sign in to add a note about this trail.
        </div>
      )}

      {loading ? (
        <p className="text-xs text-stone-500 text-center py-6">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="text-xs text-stone-500 text-center py-6">
          No notes yet — be the first to add a tip about this trail.
        </p>
      ) : (
        <div className="space-y-2">
          {notes.map((n) => {
            const style = KIND_STYLES[n.kind] ?? KIND_STYLES.info;
            const author = n.users?.display_name ?? "A rider";
            const isOwn = n.author_user_id === userId;
            return (
              <div
                key={n.id}
                className={`rounded-lg p-3 bg-[hsl(22,15%,11%)] border ${style.border}`}
                data-testid={`note-${n.id}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold ${style.chip}`}
                    >
                      {style.label}
                    </span>
                    <span className="text-xs text-stone-300">{author}</span>
                  </div>
                  <span className="text-[10px] text-stone-500">{timeAgo(n.created_at)}</span>
                </div>
                <p className="text-sm text-stone-200 whitespace-pre-wrap">{n.body}</p>
                {isOwn ? (
                  <div className="flex justify-end mt-2">
                    <button
                      onClick={() => remove(n)}
                      className="text-[10px] text-stone-500 hover:text-red-400 uppercase tracking-wider"
                      data-testid={`note-delete-${n.id}`}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
