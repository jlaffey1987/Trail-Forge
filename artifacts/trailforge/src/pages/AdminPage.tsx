import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useCurrentUser } from "@/hooks/useCurrentUser";

interface Discovery {
  id: string;
  source: string;
  source_url: string;
  source_title: string | null;
  extracted_name: string | null;
  extracted_location: string | null;
  extracted_summary: string | null;
  extracted_difficulty: number | null;
  extracted_surface: string | null;
  ai_grade: number | null;
  ai_grade_rationale: string | null;
  status: string;
  created_at: string;
  bbox_min_lat: number | null;
  bbox_max_lat: number | null;
  bbox_min_lng: number | null;
  bbox_max_lng: number | null;
}

interface ForumSource {
  id: string;
  label: string;
  url: string;
  kind: string;
  disabled: boolean;
  last_scanned_at: string | null;
}

type StatusFilter = "pending" | "approved" | "rejected" | "merged";

export default function AdminPage() {
  const { isSignedIn } = useCurrentUser();
  const [, setLocation] = useLocation();
  const [adminCheck, setAdminCheck] = useState<"loading" | "yes" | "no">("loading");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [items, setItems] = useState<Discovery[]>([]);
  const [forumSources, setForumSources] = useState<ForumSource[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [newSource, setNewSource] = useState({ label: "", url: "", kind: "html" });
  const [scanUrl, setScanUrl] = useState("");
  const [harvestSource, setHarvestSource] = useState<"tet" | "act">("tet");
  const [harvestJson, setHarvestJson] = useState("");

  // Whoami check
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/whoami", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { isAdmin: boolean } | null) => {
        if (cancelled) return;
        setAdminCheck(j?.isAdmin ? "yes" : "no");
      })
      .catch(() => !cancelled && setAdminCheck("no"));
    return () => {
      cancelled = true;
    };
  }, []);

  const loadDiscoveries = useCallback(async () => {
    const r = await fetch(
      `/api/admin/discovered-trails?status=${encodeURIComponent(statusFilter)}`,
      { credentials: "include" },
    );
    if (!r.ok) return;
    const j = (await r.json()) as { items?: Discovery[]; note?: string };
    setItems(j.items ?? []);
    if (j.note) setInfo(j.note);
  }, [statusFilter]);

  const loadForumSources = useCallback(async () => {
    const r = await fetch("/api/admin/forum-sources", { credentials: "include" });
    if (!r.ok) return;
    const j = (await r.json()) as { items?: ForumSource[]; note?: string };
    setForumSources(j.items ?? []);
    if (j.note) setInfo(j.note);
  }, []);

  useEffect(() => {
    if (adminCheck === "yes") {
      loadDiscoveries();
      loadForumSources();
    }
  }, [adminCheck, loadDiscoveries, loadForumSources]);

  if (adminCheck === "loading") {
    return (
      <div className="min-h-screen bg-stone-950 text-stone-300 flex items-center justify-center">
        <span className="text-sm">Checking admin access…</span>
      </div>
    );
  }

  if (adminCheck === "no") {
    return (
      <div className="min-h-screen bg-stone-950 text-stone-300 flex flex-col items-center justify-center p-6">
        <h1 className="text-xl font-bold text-amber-400 mb-2">Admin only</h1>
        <p className="text-sm text-stone-400 mb-4 text-center max-w-md">
          You don't have admin access. If you should, ask the team to add your user id to{" "}
          <code className="text-amber-300">system_admins</code> (or set{" "}
          <code className="text-amber-300">SYSTEM_ADMIN_USER_IDS</code> on the API server).
        </p>
        <button
          onClick={() => setLocation(isSignedIn ? "/" : "/sign-in")}
          className="px-4 py-2 rounded-lg border border-amber-500/40 text-amber-400 text-sm"
        >
          Back to TrailForge
        </button>
      </div>
    );
  }

  const handleApprove = async (id: string) => {
    setBusy(id);
    const r = await fetch(`/api/admin/discovered-trails/${id}/approve`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setBusy(null);
    if (r.status === 409) {
      const j = await r.json().catch(() => null) as
        | { dedupeMatch?: { trailId: string; name: string } }
        | null;
      if (j?.dedupeMatch) {
        const useMerge = window.confirm(
          `An existing trail "${j.dedupeMatch.name}" (${j.dedupeMatch.trailId}) already covers this area. Merge into it instead?`,
        );
        if (useMerge) {
          await handleMerge(id, j.dedupeMatch.trailId);
        } else {
          setInfo(`Approve refused — duplicate of "${j.dedupeMatch.name}". Use Merge instead.`);
        }
        return;
      }
      const t = await r.text().catch(() => "");
      setInfo(`Approve failed: 409 ${t.slice(0, 200)}`);
      return;
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      setInfo(`Approve failed: ${r.status} ${t.slice(0, 120)}`);
      return;
    }
    setInfo("Approved — published as a public trail.");
    loadDiscoveries();
  };

  const handleMerge = async (id: string, prefilledTrailId?: string) => {
    const trailId =
      prefilledTrailId ??
      window.prompt("Merge into which existing trail? Paste the trail UUID:")?.trim();
    if (!trailId) return;
    setBusy(id);
    const r = await fetch(`/api/admin/discovered-trails/${id}/merge`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trailId }),
    });
    setBusy(null);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      setInfo(`Merge failed: ${r.status} ${t.slice(0, 200)}`);
      return;
    }
    setInfo(`Merged into trail ${trailId}.`);
    loadDiscoveries();
  };

  const handleReject = async (id: string) => {
    const note = window.prompt("Optional reason for rejection?") ?? "";
    setBusy(id);
    const r = await fetch(`/api/admin/discovered-trails/${id}/reject`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
    setBusy(null);
    if (!r.ok) return;
    loadDiscoveries();
  };

  const handleAddSource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSource.label || !newSource.url) return;
    setBusy("new-source");
    const r = await fetch("/api/admin/forum-sources", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newSource),
    });
    setBusy(null);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      setInfo(`Add source failed: ${r.status} ${t.slice(0, 120)}`);
      return;
    }
    setNewSource({ label: "", url: "", kind: "html" });
    loadForumSources();
  };

  const handleDeleteSource = async (id: string) => {
    if (!window.confirm("Remove this forum source?")) return;
    setBusy(id);
    await fetch(`/api/admin/forum-sources/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    setBusy(null);
    loadForumSources();
  };

  const handleForumScan = async () => {
    setBusy("forum-scan");
    setInfo(null);
    const url = scanUrl
      ? `/api/admin/forum-scan?url=${encodeURIComponent(scanUrl)}`
      : "/api/admin/forum-scan";
    const r = await fetch(url, { method: "POST", credentials: "include" });
    setBusy(null);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      setInfo(`Forum scan failed: ${r.status} ${t.slice(0, 200)}`);
      return;
    }
    const j = await r.json();
    setInfo(
      `Scan: ${j.scanned} sources, ${j.queued} queued, ${j.skipped ?? 0} skipped` +
        (Array.isArray(j.errors) && j.errors.length ? ` — ${j.errors.length} errors` : ""),
    );
    loadDiscoveries();
  };

  const handleHarvest = async () => {
    setBusy("harvest");
    setInfo(null);
    let entries: unknown;
    try {
      entries = JSON.parse(harvestJson);
    } catch {
      setBusy(null);
      setInfo("Harvest JSON must be a valid array of entries.");
      return;
    }
    const r = await fetch("/api/admin/harvest", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: harvestSource, entries }),
    });
    setBusy(null);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      setInfo(`Harvest failed: ${r.status} ${t.slice(0, 200)}`);
      return;
    }
    const j = await r.json();
    setInfo(`Harvest: queued ${j.queued}, skipped ${j.skipped}.`);
    loadDiscoveries();
  };

  const handleBackfill = async () => {
    setBusy("backfill");
    setInfo(null);
    const r = await fetch("/api/admin/grade-backfill", {
      method: "POST",
      credentials: "include",
    });
    setBusy(null);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      setInfo(`Backfill failed: ${r.status} ${t.slice(0, 200)}`);
      return;
    }
    const j = await r.json();
    setInfo(
      `Backfill: graded ${j.graded}/${j.scanned}${j.failed ? `, ${j.failed} failed` : ""}.${j.note ? ` ${j.note}` : ""}`,
    );
  };

  return (
    <div
      className="min-h-screen bg-stone-950 text-stone-200 p-6"
      data-testid="admin-page"
    >
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black text-amber-400 uppercase tracking-wider">
            TrailForge Admin
          </h1>
          <p className="text-xs text-stone-500">
            AI grading, forum scan, external harvest, and review queue
          </p>
        </div>
        <button
          onClick={() => setLocation("/")}
          className="px-3 py-2 rounded-lg border border-stone-700 text-stone-400 text-xs hover:text-amber-400"
        >
          ← Back to app
        </button>
      </header>

      {info ? (
        <div
          className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/40 text-amber-300 text-xs"
          data-testid="admin-info"
        >
          {info}
        </div>
      ) : null}

      <section className="mb-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-stone-900 border border-stone-800 rounded-xl p-4">
          <h2 className="text-sm font-bold text-amber-400 uppercase mb-2">Forum scan</h2>
          <p className="text-xs text-stone-500 mb-3">
            Walks active forum sources and queues new trail mentions for review.
          </p>
          <input
            value={scanUrl}
            onChange={(e) => setScanUrl(e.target.value)}
            placeholder="Optional: ad-hoc URL"
            className="w-full mb-2 px-3 py-2 bg-stone-950 border border-stone-700 rounded-lg text-xs"
            data-testid="admin-scan-url"
          />
          <button
            onClick={handleForumScan}
            disabled={busy === "forum-scan"}
            className="w-full py-2 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold uppercase tracking-wider disabled:opacity-50"
            data-testid="admin-run-scan"
          >
            {busy === "forum-scan" ? "Scanning…" : "Run forum scan"}
          </button>
        </div>

        <div className="bg-stone-900 border border-stone-800 rounded-xl p-4">
          <h2 className="text-sm font-bold text-amber-400 uppercase mb-2">External harvest</h2>
          <p className="text-xs text-stone-500 mb-3">
            Link-out mode (TET/ACT terms forbid GPX rehosting — see licensing spike).
          </p>
          <select
            value={harvestSource}
            onChange={(e) => setHarvestSource(e.target.value as "tet" | "act")}
            className="w-full mb-2 px-3 py-2 bg-stone-950 border border-stone-700 rounded-lg text-xs"
            data-testid="admin-harvest-source"
          >
            <option value="tet">TET (Trans Euro Trail)</option>
            <option value="act">ACT (Adventure Country Tracks)</option>
          </select>
          <textarea
            value={harvestJson}
            onChange={(e) => setHarvestJson(e.target.value)}
            placeholder='[{"name":"...", "country":"UK", "sourceUrl":"https://transeurotrail.org/..."}]'
            className="w-full mb-2 px-3 py-2 bg-stone-950 border border-stone-700 rounded-lg text-xs font-mono h-24"
            data-testid="admin-harvest-json"
          />
          <button
            onClick={handleHarvest}
            disabled={busy === "harvest"}
            className="w-full py-2 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold uppercase tracking-wider disabled:opacity-50"
            data-testid="admin-run-harvest"
          >
            {busy === "harvest" ? "Queuing…" : "Queue entries"}
          </button>
        </div>

        <div className="bg-stone-900 border border-stone-800 rounded-xl p-4">
          <h2 className="text-sm font-bold text-amber-400 uppercase mb-2">AI grading</h2>
          <p className="text-xs text-stone-500 mb-3">
            Backfill ungrades trails (recent 20). Use on each release to keep new uploads scored.
          </p>
          <button
            onClick={handleBackfill}
            disabled={busy === "backfill"}
            className="w-full py-2 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold uppercase tracking-wider disabled:opacity-50"
            data-testid="admin-run-backfill"
          >
            {busy === "backfill" ? "Grading…" : "Run grade backfill"}
          </button>
        </div>
      </section>

      <section className="mb-6 bg-stone-900 border border-stone-800 rounded-xl p-4">
        <h2 className="text-sm font-bold text-amber-400 uppercase mb-3">Forum sources</h2>
        <form onSubmit={handleAddSource} className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-3">
          <input
            value={newSource.label}
            onChange={(e) => setNewSource((s) => ({ ...s, label: e.target.value }))}
            placeholder="Label (e.g. ADV Rider — UK)"
            className="px-3 py-2 bg-stone-950 border border-stone-700 rounded-lg text-xs"
            data-testid="admin-new-source-label"
          />
          <input
            value={newSource.url}
            onChange={(e) => setNewSource((s) => ({ ...s, url: e.target.value }))}
            placeholder="https://forum.example/threads/..."
            className="px-3 py-2 bg-stone-950 border border-stone-700 rounded-lg text-xs md:col-span-2"
            data-testid="admin-new-source-url"
          />
          <button
            type="submit"
            disabled={busy === "new-source"}
            className="py-2 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold uppercase"
            data-testid="admin-new-source-submit"
          >
            Add source
          </button>
        </form>
        {forumSources.length === 0 ? (
          <p className="text-xs text-stone-500">No forum sources configured yet.</p>
        ) : (
          <ul className="divide-y divide-stone-800" data-testid="admin-forum-source-list">
            {forumSources.map((s) => (
              <li key={s.id} className="py-2 flex items-center gap-2 text-xs">
                <span className="font-bold text-stone-200 truncate max-w-[200px]">{s.label}</span>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-400 truncate max-w-[300px]"
                >
                  {s.url}
                </a>
                <span className="ml-auto text-stone-500">
                  {s.last_scanned_at ? `last ${new Date(s.last_scanned_at).toLocaleString()}` : "never scanned"}
                </span>
                <button
                  onClick={() => handleDeleteSource(s.id)}
                  className="text-red-400 hover:text-red-300"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-stone-900 border border-stone-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-amber-400 uppercase">Discovery review queue</h2>
          <div className="flex items-center gap-1">
            {(["pending", "approved", "rejected", "merged"] as StatusFilter[]).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-2 py-1 rounded-md text-[10px] uppercase tracking-wider ${
                  statusFilter === s
                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                    : "text-stone-500 border border-transparent hover:text-stone-300"
                }`}
                data-testid={`admin-status-${s}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        {items.length === 0 ? (
          <p className="text-xs text-stone-500" data-testid="admin-queue-empty">
            Nothing in the {statusFilter} queue.
          </p>
        ) : (
          <ul className="space-y-3" data-testid="admin-queue-list">
            {items.map((d) => (
              <li
                key={d.id}
                className="border border-stone-800 rounded-lg p-3 bg-stone-950"
                data-testid="admin-queue-item"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider rounded-full bg-stone-800 text-stone-300">
                        {d.source}
                      </span>
                      {d.ai_grade != null ? (
                        <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider rounded-full bg-amber-500/15 text-amber-300">
                          AI {d.ai_grade}/10
                        </span>
                      ) : null}
                      {d.extracted_difficulty != null ? (
                        <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider rounded-full bg-stone-800 text-stone-300">
                          claimed {d.extracted_difficulty}/10
                        </span>
                      ) : null}
                    </div>
                    <h3 className="text-sm font-bold text-stone-200">
                      {d.extracted_name ?? "(no name extracted)"}
                    </h3>
                    {d.extracted_location ? (
                      <p className="text-[11px] text-stone-500">{d.extracted_location}</p>
                    ) : null}
                    {d.extracted_summary ? (
                      <p className="text-xs text-stone-400 mt-1">{d.extracted_summary}</p>
                    ) : null}
                    {d.ai_grade_rationale ? (
                      <p className="text-[11px] text-amber-400 mt-1">AI: {d.ai_grade_rationale}</p>
                    ) : null}
                    <a
                      href={d.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-amber-400 mt-1 inline-block"
                    >
                      Source ↗
                    </a>
                  </div>
                  {statusFilter === "pending" ? (
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        onClick={() => handleApprove(d.id)}
                        disabled={busy === d.id}
                        className="px-3 py-1.5 rounded-md bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[11px] font-bold uppercase disabled:opacity-50"
                        data-testid={`admin-approve-${d.id}`}
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => handleMerge(d.id)}
                        disabled={busy === d.id}
                        className="px-3 py-1.5 rounded-md border border-stone-600 text-stone-300 text-[11px] font-bold uppercase disabled:opacity-50 hover:text-amber-300 hover:border-amber-500/40"
                        data-testid={`admin-merge-${d.id}`}
                        title="Merge this discovery into an existing trail"
                      >
                        Merge
                      </button>
                      <button
                        onClick={() => handleReject(d.id)}
                        disabled={busy === d.id}
                        className="px-3 py-1.5 rounded-md border border-red-500/40 text-red-300 text-[11px] font-bold uppercase disabled:opacity-50"
                        data-testid={`admin-reject-${d.id}`}
                      >
                        Reject
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
