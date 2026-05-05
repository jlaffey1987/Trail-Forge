import { useEffect, useState, useCallback, type ReactNode } from "react";
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

interface ScanSkip {
  id: string;
  source_url: string;
  source_label: string | null;
  extracted_name: string | null;
  reason: string;
  status: "pending" | "resolved";
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_note: string | null;
}

interface ForumSource {
  id: string;
  label: string;
  url: string;
  kind: string;
  disabled: boolean;
  last_scanned_at: string | null;
}

interface AdminEntry {
  user_id: string;
  granted_at: string;
  granted_by: string | null;
  note: string | null;
  users: {
    id: string;
    email: string | null;
    display_name: string | null;
    avatar_url: string | null;
  } | null;
}

type StatusFilter = "pending" | "approved" | "rejected" | "merged";

type AdminAccessState =
  | "admin"
  | "not-admin"
  | "no-admins"
  | "migration-missing"
  | "signed-out";

interface WhoamiResponse {
  isAdmin: boolean;
  signedIn: boolean;
  state: AdminAccessState;
  userId?: string;
  message?: string;
  code?: string;
}

export default function AdminPage() {
  const { isSignedIn } = useCurrentUser();
  const [, setLocation] = useLocation();
  const [whoami, setWhoami] = useState<WhoamiResponse | "loading" | "error">("loading");
  const [callerUserId, setCallerUserId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [items, setItems] = useState<Discovery[]>([]);
  const [forumSources, setForumSources] = useState<ForumSource[]>([]);
  const [scanSkips, setScanSkips] = useState<ScanSkip[]>([]);
  const [skipFilter, setSkipFilter] = useState<"pending" | "resolved">("pending");
  const [admins, setAdmins] = useState<AdminEntry[]>([]);
  const [envAdmins, setEnvAdmins] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [newSource, setNewSource] = useState({ label: "", url: "", kind: "html" });
  const [newAdmin, setNewAdmin] = useState({ userId: "", note: "" });
  const [scanUrl, setScanUrl] = useState("");
  const [harvestSource, setHarvestSource] = useState<"tet" | "act">("tet");
  const [harvestJson, setHarvestJson] = useState("");

  // Whoami check
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/whoami", { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<WhoamiResponse>) : null))
      .then((j) => {
        if (cancelled) return;
        setWhoami(j ?? "error");
        setCallerUserId(j?.userId ?? null);
      })
      .catch(() => !cancelled && setWhoami("error"));
    return () => {
      cancelled = true;
    };
  }, []);

  const adminCheck: "loading" | "yes" | "no" =
    whoami === "loading"
      ? "loading"
      : whoami === "error"
      ? "no"
      : whoami.isAdmin
      ? "yes"
      : "no";

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

  const loadScanSkips = useCallback(async () => {
    const r = await fetch(
      `/api/admin/ai-scan-skips?status=${encodeURIComponent(skipFilter)}`,
      { credentials: "include" },
    );
    if (!r.ok) return;
    const j = (await r.json()) as { items?: ScanSkip[]; note?: string };
    setScanSkips(j.items ?? []);
    if (j.note) setInfo(j.note);
  }, [skipFilter]);

  const loadForumSources = useCallback(async () => {
    const r = await fetch("/api/admin/forum-sources", { credentials: "include" });
    if (!r.ok) return;
    const j = (await r.json()) as { items?: ForumSource[]; note?: string };
    setForumSources(j.items ?? []);
    if (j.note) setInfo(j.note);
  }, []);

  const loadAdmins = useCallback(async () => {
    const r = await fetch("/api/admin/admins", { credentials: "include" });
    if (!r.ok) return;
    const j = (await r.json()) as {
      items?: AdminEntry[];
      envAdmins?: string[];
      note?: string;
    };
    setAdmins(j.items ?? []);
    setEnvAdmins(j.envAdmins ?? []);
    if (j.note) setInfo(j.note);
  }, []);

  useEffect(() => {
    if (adminCheck === "yes") {
      loadDiscoveries();
      loadForumSources();
      loadAdmins();
      loadScanSkips();
    }
  }, [adminCheck, loadDiscoveries, loadForumSources, loadAdmins, loadScanSkips]);

  if (adminCheck === "loading") {
    return (
      <div className="min-h-screen bg-stone-950 text-stone-300 flex items-center justify-center">
        <span className="text-sm">Checking admin access…</span>
      </div>
    );
  }

  if (adminCheck === "no") {
    const state: AdminAccessState =
      whoami !== "loading" && whoami !== "error" ? whoami.state : "not-admin";
    const titles: Record<AdminAccessState, string> = {
      "admin": "Admin",
      "not-admin": "Admin only",
      "no-admins": "Admin features waiting to be turned on",
      "migration-missing": "Admin features waiting to be turned on",
      "signed-out": "Sign in required",
    };
    const explanations: Record<AdminAccessState, ReactNode> = {
      "admin": null,
      "not-admin": (
        <>
          You don't have admin access. If you should, ask the team to add your user id to{" "}
          <code className="text-amber-300">system_admins</code> (or set{" "}
          <code className="text-amber-300">SYSTEM_ADMIN_USER_IDS</code> on the API server).
        </>
      ),
      "no-admins": (
        <>
          The <code className="text-amber-300">system_admins</code> table is empty and{" "}
          <code className="text-amber-300">SYSTEM_ADMIN_USER_IDS</code> isn't set, so nobody is an
          admin yet. Set <code className="text-amber-300">SYSTEM_ADMIN_USER_IDS</code> on the API
          server, or insert a row into <code className="text-amber-300">system_admins</code>, to
          unlock admin features.
        </>
      ),
      "migration-missing": (
        <>
          The <code className="text-amber-300">system_admins</code> table doesn't exist yet — apply
          database migration <code className="text-amber-300">0007</code> on the Supabase project,
          or set <code className="text-amber-300">SYSTEM_ADMIN_USER_IDS</code> on the API server,
          to unlock admin features.
        </>
      ),
      "signed-out": <>You need to sign in before we can check admin access.</>,
    };
    const isBootstrapState = state === "no-admins" || state === "migration-missing";
    return (
      <div
        className="min-h-screen bg-stone-950 text-stone-300 flex flex-col items-center justify-center p-6"
        data-testid="admin-gate"
        data-admin-state={state}
      >
        <h1 className="text-xl font-bold text-amber-400 mb-2">{titles[state]}</h1>
        <p className="text-sm text-stone-400 mb-4 text-center max-w-md">{explanations[state]}</p>
        {isBootstrapState ? (
          <p className="text-[11px] text-stone-500 mb-4 text-center max-w-md">
            Once one admin is configured, that admin can grant access to others from inside the
            app.
          </p>
        ) : null}
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
    loadScanSkips();
  };

  const handleUploadSkipGpx = async (id: string, file: File) => {
    setBusy(`skip-upload-${id}`);
    setInfo(null);
    let gpxText: string;
    try {
      gpxText = await file.text();
    } catch {
      setBusy(null);
      setInfo("Couldn't read the selected file.");
      return;
    }
    if (gpxText.trim().length < 20) {
      setBusy(null);
      setInfo("That GPX file looks empty.");
      return;
    }
    const r = await fetch(`/api/admin/ai-scan-skips/${id}/upload-gpx`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gpxText }),
    });
    setBusy(null);
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      setInfo(`Upload failed: ${j?.error ?? r.status}`);
      return;
    }
    const j = (await r.json()) as { discoveryId?: string | null };
    setInfo(
      j.discoveryId
        ? `GPX queued as discovery ${j.discoveryId} — review it in the discovery queue below.`
        : "GPX queued for review.",
    );
    loadScanSkips();
    loadDiscoveries();
  };

  const handleResolveSkip = async (id: string) => {
    setBusy(`skip-${id}`);
    const r = await fetch(`/api/admin/ai-scan-skips/${id}/resolve`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setBusy(null);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      setInfo(`Resolve failed: ${r.status} ${t.slice(0, 120)}`);
      return;
    }
    loadScanSkips();
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

  const handleAddAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    const userId = newAdmin.userId.trim();
    if (!userId) return;
    setBusy("new-admin");
    setInfo(null);
    const r = await fetch("/api/admin/admins", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        note: newAdmin.note.trim() || null,
      }),
    });
    setBusy(null);
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      setInfo(`Add admin failed: ${j?.error ?? r.status}`);
      return;
    }
    setNewAdmin({ userId: "", note: "" });
    setInfo(`Granted admin to ${userId}.`);
    loadAdmins();
  };

  const handleRevokeAdmin = async (userId: string) => {
    const isSelf = callerUserId != null && userId === callerUserId;
    const confirmText = isSelf
      ? "Revoke YOUR OWN admin access? You'll lose access to this dashboard immediately."
      : `Revoke admin access from ${userId}?`;
    if (!window.confirm(confirmText)) return;
    setBusy(`admin-${userId}`);
    setInfo(null);
    const r = await fetch(`/api/admin/admins/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      credentials: "include",
    });
    setBusy(null);
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      setInfo(`Revoke failed: ${j?.error ?? r.status}`);
      return;
    }
    setInfo(`Revoked admin from ${userId}.`);
    loadAdmins();
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

      <section
        className="mb-6 bg-stone-900 border border-stone-800 rounded-xl p-4"
        data-testid="admin-admins-section"
      >
        <h2 className="text-sm font-bold text-amber-400 uppercase mb-3">
          Manage admins
        </h2>
        <p className="text-xs text-stone-500 mb-3">
          Grant or revoke dashboard access for other Clerk users. Paste their
          Clerk user id (e.g. <code className="text-amber-300">user_2abc…</code>).
          The last remaining admin can&apos;t revoke themselves.
        </p>
        <form
          onSubmit={handleAddAdmin}
          className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-3"
        >
          <input
            value={newAdmin.userId}
            onChange={(e) =>
              setNewAdmin((s) => ({ ...s, userId: e.target.value }))
            }
            placeholder="Clerk user id (user_…)"
            className="px-3 py-2 bg-stone-950 border border-stone-700 rounded-lg text-xs"
            data-testid="admin-new-admin-userid"
          />
          <input
            value={newAdmin.note}
            onChange={(e) =>
              setNewAdmin((s) => ({ ...s, note: e.target.value }))
            }
            placeholder="Optional note (e.g. team lead)"
            className="px-3 py-2 bg-stone-950 border border-stone-700 rounded-lg text-xs md:col-span-2"
            data-testid="admin-new-admin-note"
          />
          <button
            type="submit"
            disabled={busy === "new-admin" || !newAdmin.userId.trim()}
            className="py-2 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold uppercase disabled:opacity-50"
            data-testid="admin-new-admin-submit"
          >
            {busy === "new-admin" ? "Granting…" : "Grant admin"}
          </button>
        </form>
        {admins.length === 0 ? (
          <p className="text-xs text-stone-500" data-testid="admin-admins-empty">
            No admins in <code className="text-amber-300">system_admins</code> yet.
          </p>
        ) : (
          <ul
            className="divide-y divide-stone-800"
            data-testid="admin-admins-list"
          >
            {admins.map((a) => {
              const isSelf =
                callerUserId != null && a.user_id === callerUserId;
              const isOnlyAdmin = admins.length === 1;
              const cannotRevoke = isSelf && isOnlyAdmin;
              return (
                <li
                  key={a.user_id}
                  className="py-2 flex items-center gap-3 text-xs"
                  data-testid={`admin-admins-item-${a.user_id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-stone-200">
                        {a.users?.display_name ??
                          a.users?.email ??
                          a.user_id}
                      </span>
                      {isSelf ? (
                        <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded-full bg-amber-500/15 text-amber-300">
                          you
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-stone-500">
                      <code className="text-stone-400">{a.user_id}</code>
                      {a.users?.email &&
                      a.users.email !== a.users.display_name ? (
                        <span> · {a.users.email}</span>
                      ) : null}
                      <span> · granted {new Date(a.granted_at).toLocaleDateString()}</span>
                      {a.granted_by ? <span> by {a.granted_by}</span> : null}
                    </div>
                    {a.note ? (
                      <p className="text-[11px] text-stone-400 mt-0.5">{a.note}</p>
                    ) : null}
                  </div>
                  <button
                    onClick={() => handleRevokeAdmin(a.user_id)}
                    disabled={cannotRevoke || busy === `admin-${a.user_id}`}
                    title={
                      cannotRevoke
                        ? "You're the only admin — add another admin before revoking your own access."
                        : "Revoke admin"
                    }
                    className="px-2 py-1 rounded-md border border-red-500/40 text-red-300 text-[11px] font-bold uppercase disabled:opacity-30 disabled:cursor-not-allowed"
                    data-testid={`admin-revoke-${a.user_id}`}
                  >
                    Revoke
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {envAdmins.length > 0 ? (
          <p
            className="text-[11px] text-stone-500 mt-3"
            data-testid="admin-env-admins"
          >
            Bootstrapped via <code className="text-amber-300">SYSTEM_ADMIN_USER_IDS</code>:{" "}
            {envAdmins.map((id, i) => (
              <span key={id}>
                {i > 0 ? ", " : ""}
                <code className="text-stone-400">{id}</code>
              </span>
            ))}
            . These can&apos;t be revoked from the UI — change the env var on the API server.
          </p>
        ) : null}
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

      <section
        className="mb-6 bg-stone-900 border border-stone-800 rounded-xl p-4"
        data-testid="admin-scan-skips-section"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-amber-400 uppercase">
            Forum posts that need a manual look
          </h2>
          <div className="flex items-center gap-1">
            {(["pending", "resolved"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSkipFilter(s)}
                className={`px-2 py-1 rounded-md text-[10px] uppercase tracking-wider ${
                  skipFilter === s
                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                    : "text-stone-500 border border-transparent hover:text-stone-300"
                }`}
                data-testid={`admin-skip-status-${s}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-stone-500 mb-3">
          Posts the AI scanner couldn't auto-import — no downloadable GPX and no
          OSM track to snap to. Open the source thread, decide whether to chase
          a manual GPX upload, then mark resolved to clear it from the list.
        </p>
        {scanSkips.length === 0 ? (
          <p className="text-xs text-stone-500" data-testid="admin-scan-skips-empty">
            Nothing in the {skipFilter} list.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="admin-scan-skips-list">
            {scanSkips.map((s) => (
              <li
                key={s.id}
                className="border border-stone-800 rounded-lg p-3 bg-stone-950"
                data-testid="admin-scan-skip-item"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      {s.source_label ? (
                        <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider rounded-full bg-stone-800 text-stone-300">
                          {s.source_label}
                        </span>
                      ) : null}
                      {s.seen_count > 1 ? (
                        <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider rounded-full bg-amber-500/15 text-amber-300">
                          seen {s.seen_count}×
                        </span>
                      ) : null}
                    </div>
                    <h3 className="text-sm font-bold text-stone-200 truncate">
                      {s.extracted_name ?? "(no name extracted)"}
                    </h3>
                    <p className="text-[11px] text-stone-400 mt-0.5">
                      {s.reason}
                    </p>
                    <a
                      href={s.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-amber-400 mt-1 inline-block break-all"
                      data-testid={`admin-skip-link-${s.id}`}
                    >
                      {s.source_url} ↗
                    </a>
                    <p className="text-[11px] text-stone-500 mt-1">
                      first seen {new Date(s.first_seen_at).toLocaleString()}
                      {s.last_seen_at !== s.first_seen_at
                        ? ` · last ${new Date(s.last_seen_at).toLocaleString()}`
                        : ""}
                      {s.resolved_at
                        ? ` · resolved ${new Date(s.resolved_at).toLocaleString()}${s.resolved_by ? ` by ${s.resolved_by}` : ""}`
                        : ""}
                    </p>
                  </div>
                  {skipFilter === "pending" ? (
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <label
                        className={`px-3 py-1.5 rounded-md border border-emerald-500/40 text-emerald-300 text-[11px] font-bold uppercase text-center cursor-pointer ${busy === `skip-upload-${s.id}` ? "opacity-50 pointer-events-none" : "hover:bg-emerald-500/10"}`}
                        data-testid={`admin-upload-skip-gpx-${s.id}`}
                      >
                        {busy === `skip-upload-${s.id}` ? "Uploading…" : "Upload GPX"}
                        <input
                          type="file"
                          accept=".gpx,application/gpx+xml,application/xml,text/xml"
                          className="hidden"
                          data-testid={`admin-upload-skip-gpx-input-${s.id}`}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = "";
                            if (f) handleUploadSkipGpx(s.id, f);
                          }}
                          disabled={busy === `skip-upload-${s.id}`}
                        />
                      </label>
                      <button
                        onClick={() => handleResolveSkip(s.id)}
                        disabled={busy === `skip-${s.id}`}
                        className="px-3 py-1.5 rounded-md border border-amber-500/40 text-amber-300 text-[11px] font-bold uppercase disabled:opacity-50"
                        data-testid={`admin-resolve-skip-${s.id}`}
                      >
                        {busy === `skip-${s.id}` ? "…" : "Mark resolved"}
                      </button>
                    </div>
                  ) : null}
                </div>
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
