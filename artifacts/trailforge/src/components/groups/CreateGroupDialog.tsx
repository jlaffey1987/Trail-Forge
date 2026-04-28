import { useEffect, useState } from "react";
import { type Group, createGroup } from "@/lib/groups";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (group: Group) => void;
}

export default function CreateGroupDialog({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setError(null);
    setSubmitting(false);
  }, [open]);

  if (!open) return null;

  const handleSubmit = async () => {
    setError(null);
    if (name.trim().length < 2) {
      setError("Group name must be at least 2 characters");
      return;
    }
    setSubmitting(true);
    const created = await createGroup({
      name: name.trim(),
      description: description.trim() || null,
    });
    setSubmitting(false);
    if (!created) {
      setError("Could not create group. The Groups feature may not be provisioned yet — apply migration 0006_groups.sql.");
      return;
    }
    onCreated(created);
  };

  return (
    <div
      className="fixed inset-0 z-[3050] flex flex-col"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)" }}
      role="dialog"
      aria-modal="true"
      data-testid="create-group-dialog"
    >
      <div className="mt-auto rounded-t-2xl overflow-hidden flex flex-col" style={{ background: "hsl(22,15%,9%)", maxHeight: "92vh" }}>
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-stone-700"></div>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
          <h2 className="text-base font-bold text-amber-400 uppercase tracking-widest">Create Group</h2>
          <button
            onClick={onClose}
            className="text-xs text-stone-500 hover:text-red-400"
            data-testid="create-group-cancel"
          >
            Cancel
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4 space-y-3">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="e.g. Peak District Riders"
              className="w-full px-3 py-2.5 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-sm text-stone-100 focus:border-amber-500 focus:outline-none"
              data-testid="create-group-name"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-stone-500 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="What is this group about?"
              className="w-full px-3 py-2 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-sm text-stone-100 focus:border-amber-500 focus:outline-none resize-none"
              data-testid="create-group-description"
            />
          </div>
          <p className="text-[11px] text-stone-500">
            Groups are private. Only invited members can see trails shared into the group.
          </p>
          {error && (
            <div className="bg-red-900/40 border border-red-500/40 rounded-lg px-3 py-2">
              <p className="text-xs text-red-300" data-testid="create-group-error">{error}</p>
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
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 py-3 rounded-xl text-sm font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
            data-testid="create-group-submit"
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
