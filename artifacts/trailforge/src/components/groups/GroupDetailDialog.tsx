import { useCallback, useEffect, useRef, useState } from "react";
import {
  type GroupDetail,
  type GroupInvite,
  approveJoinRequest,
  buildInviteUrl,
  createInvite,
  declineJoinRequest,
  deleteGroup,
  fetchGroupDetail,
  finalizeGroupCover,
  formatExpiry,
  groupCoverPhotoUrl,
  leaveGroup,
  removeGroupCover,
  removeMember,
  requestGroupCoverUploadUrl,
  revokeInvite,
  transferGroupOwnership,
  updateGroup,
} from "@/lib/groups";
import { preparePhotoForUpload } from "@/lib/photoUpload";

interface Props {
  groupId: string | null;
  onClose: () => void;
}

// Email invites have been removed in favor of "discoverable groups" —
// owners flip the discoverable toggle and people request to join from the
// Discover tab. Link and username invites are still supported as fallbacks.
type InviteMode = "link" | "username";

export default function GroupDetailDialog({ groupId, onClose }: Props) {
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [inviteMode, setInviteMode] = useState<InviteMode>("link");
  const [inviteUsername, setInviteUsername] = useState("");
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [coverUploading, setCoverUploading] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [discoverableToggling, setDiscoverableToggling] = useState(false);
  const [decidingRequestId, setDecidingRequestId] = useState<string | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    if (!groupId) return;
    setLoading(true);
    const d = await fetchGroupDetail(groupId);
    setDetail(d);
    setLoading(false);
  }, [groupId]);

  useEffect(() => {
    if (groupId) {
      setActionError(null);
      setConfirmDelete(false);
      setConfirmLeave(false);
      setCopiedToken(null);
      setCoverError(null);
      void refresh();
    } else {
      setDetail(null);
    }
  }, [groupId, refresh]);

  if (!groupId) return null;

  const isOwner = detail?.callerRole === "owner";
  const isAdmin = detail?.callerRole === "admin";
  const canManage = isOwner || isAdmin;

  const handleCreateInvite = async () => {
    setActionError(null);
    setCreatingInvite(true);
    const opts: { username?: string } =
      inviteMode === "username" && inviteUsername.trim()
        ? { username: inviteUsername.trim() }
        : {};
    const result = await createInvite(groupId, opts);
    setCreatingInvite(false);
    if (!result.invite) {
      setActionError(result.error || "Could not create invite");
      return;
    }
    setInviteUsername("");
    await refresh();
    void copyInviteLink(result.invite);
  };

  const handleToggleDiscoverable = async () => {
    if (!detail) return;
    setActionError(null);
    setDiscoverableToggling(true);
    const next = !detail.group.discoverable;
    const updated = await updateGroup(groupId, { discoverable: next });
    setDiscoverableToggling(false);
    if (!updated) {
      setActionError("Could not update discoverable setting");
      return;
    }
    await refresh();
  };

  const handleApproveRequest = async (requestId: string) => {
    setActionError(null);
    setDecidingRequestId(requestId);
    const ok = await approveJoinRequest(groupId, requestId);
    setDecidingRequestId(null);
    if (!ok) {
      setActionError("Could not approve request");
      return;
    }
    await refresh();
  };

  const handleDeclineRequest = async (requestId: string) => {
    setActionError(null);
    setDecidingRequestId(requestId);
    const ok = await declineJoinRequest(groupId, requestId);
    setDecidingRequestId(null);
    if (!ok) {
      setActionError("Could not decline request");
      return;
    }
    await refresh();
  };

  const handleTransferOwnership = async (toUserId: string) => {
    setActionError(null);
    setTransferring(true);
    const res = await transferGroupOwnership(groupId, toUserId);
    setTransferring(false);
    setTransferTargetId(null);
    if ("error" in res) {
      setActionError(res.error || "Could not transfer ownership");
      return;
    }
    await refresh();
  };

  const copyInviteLink = async (inv: GroupInvite) => {
    const url = buildInviteUrl(inv.token);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(inv.token);
      setTimeout(() => setCopiedToken((cur) => (cur === inv.token ? null : cur)), 2200);
    } catch {
      window.prompt("Copy invite link:", url);
    }
  };

  const handleRevoke = async (inviteId: string) => {
    setActionError(null);
    const ok = await revokeInvite(groupId, inviteId);
    if (!ok) {
      setActionError("Could not revoke invite");
      return;
    }
    await refresh();
  };

  const handleRemoveMember = async (userId: string) => {
    setActionError(null);
    const ok = await removeMember(groupId, userId);
    if (!ok) {
      setActionError("Could not remove member");
      return;
    }
    await refresh();
  };

  const handleDelete = async () => {
    setActionError(null);
    const ok = await deleteGroup(groupId);
    if (!ok) {
      setActionError("Could not delete group");
      return;
    }
    onClose();
  };

  const handleCoverFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setCoverError(null);
    setCoverUploading(true);
    try {
      const prepared = await preparePhotoForUpload(files[0]);
      const ticket = await requestGroupCoverUploadUrl(groupId);
      if (!ticket) throw new Error("Could not get upload URL");
      const putRes = await fetch(ticket.uploadURL, {
        method: "PUT",
        body: prepared.blob,
        headers: { "Content-Type": "image/jpeg" },
      });
      if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
      const updated = await finalizeGroupCover(groupId, ticket.storageKey);
      if (!updated) throw new Error("Failed to save cover photo");
      await refresh();
    } catch (err) {
      console.error("group cover upload failed", err);
      setCoverError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setCoverUploading(false);
      if (coverInputRef.current) coverInputRef.current.value = "";
    }
  };

  const handleRemoveCover = async () => {
    setCoverError(null);
    setCoverUploading(true);
    try {
      const updated = await removeGroupCover(groupId);
      if (!updated) throw new Error("Could not remove cover");
      await refresh();
    } catch (err) {
      console.error("group cover remove failed", err);
      setCoverError(err instanceof Error ? err.message : "Could not remove");
    } finally {
      setCoverUploading(false);
    }
  };

  const handleLeave = async () => {
    setActionError(null);
    const ok = await leaveGroup(groupId);
    if (!ok) {
      setActionError("Could not leave group");
      return;
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[3060] flex flex-col"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)" }}
      role="dialog"
      aria-modal="true"
      data-testid="group-detail-dialog"
    >
      <div className="mt-auto rounded-t-2xl overflow-hidden flex flex-col" style={{ background: "hsl(22,15%,9%)", maxHeight: "92vh" }}>
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-stone-700"></div>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)] shrink-0">
          <div>
            <h2 className="text-base font-bold text-amber-400 uppercase tracking-widest">
              {detail?.group.name ?? "Group"}
            </h2>
            <p className="text-[11px] text-stone-500 mt-0.5">
              {detail
                ? `${detail.members.length} member${detail.members.length === 1 ? "" : "s"} · ${detail.sharedTrailCount} trail${detail.sharedTrailCount === 1 ? "" : "s"}`
                : "Loading…"}
            </p>
          </div>
          <button onClick={onClose} className="text-xs text-stone-500 hover:text-red-400" data-testid="group-detail-close">
            Close
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4 space-y-4">
          {loading && !detail && <div className="text-xs text-stone-500 py-4 text-center">Loading…</div>}

          {detail && (
            <>
              {/* Cover photo */}
              {(() => {
                const coverUrl = groupCoverPhotoUrl(detail.group.cover_photo_key);
                const showControls = canManage;
                if (!coverUrl && !showControls) return null;
                return (
                  <div className="space-y-2" data-testid="group-cover-section">
                    {coverUrl ? (
                      <div className="relative w-full aspect-[16/7] rounded-xl overflow-hidden bg-stone-800">
                        <img
                          src={coverUrl}
                          alt={`${detail.group.name} cover`}
                          className="w-full h-full object-cover"
                          data-testid="group-cover-image"
                        />
                      </div>
                    ) : showControls ? (
                      <div
                        className="w-full aspect-[16/7] rounded-xl border border-dashed border-[hsl(30,12%,22%)] bg-[hsl(22,15%,11%)] flex items-center justify-center text-[11px] text-stone-500"
                        data-testid="group-cover-empty"
                      >
                        No cover photo yet
                      </div>
                    ) : null}
                    {showControls && (
                      <div className="flex items-center gap-2">
                        <input
                          ref={coverInputRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => void handleCoverFiles(e.target.files)}
                          data-testid="group-cover-input"
                        />
                        <button
                          type="button"
                          disabled={coverUploading}
                          onClick={() => coverInputRef.current?.click()}
                          className="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
                          style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
                          data-testid="group-cover-upload-btn"
                        >
                          {coverUploading
                            ? "Uploading…"
                            : detail.group.cover_photo_key
                              ? "Replace cover"
                              : "Upload cover"}
                        </button>
                        {detail.group.cover_photo_key && (
                          <button
                            type="button"
                            disabled={coverUploading}
                            onClick={() => void handleRemoveCover()}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider text-red-400 border border-red-500/30 disabled:opacity-50"
                            data-testid="group-cover-remove-btn"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    )}
                    {coverError && (
                      <p
                        className="text-[11px] text-red-300"
                        data-testid="group-cover-error"
                      >
                        {coverError}
                      </p>
                    )}
                  </div>
                );
              })()}

              {detail.group.description && (
                <p className="text-xs text-stone-400 whitespace-pre-line">{detail.group.description}</p>
              )}

              {/* Discoverability — owner / admin only */}
              {canManage && (
                <div
                  className="space-y-2 bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] rounded-lg p-3"
                  data-testid="group-discoverable-section"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[11px] font-bold uppercase tracking-widest text-stone-400">
                        Discoverable
                      </h3>
                      <p className="text-[11px] text-stone-500 mt-1">
                        Listed in Discover so anyone can ask to join. You'll
                        review each request below.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!detail.group.discoverable}
                      disabled={discoverableToggling}
                      onClick={() => void handleToggleDiscoverable()}
                      className={
                        "shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 " +
                        (detail.group.discoverable
                          ? "bg-amber-500"
                          : "bg-stone-700")
                      }
                      data-testid="group-discoverable-toggle"
                    >
                      <span
                        className={
                          "inline-block h-5 w-5 transform rounded-full bg-white transition-transform " +
                          (detail.group.discoverable
                            ? "translate-x-5"
                            : "translate-x-1")
                        }
                      />
                    </button>
                  </div>
                </div>
              )}

              {/* Pending join requests — owner / admin only */}
              {canManage && detail.joinRequests.length > 0 && (
                <div className="space-y-2" data-testid="join-requests-section">
                  <h3 className="text-[11px] font-bold uppercase tracking-widest text-stone-400">
                    Requests to join ({detail.joinRequests.length})
                  </h3>
                  <div className="space-y-1.5">
                    {detail.joinRequests.map((r) => {
                      const label =
                        r.display_name ?? r.email ?? r.user_id;
                      const initial = (label ?? "?")
                        .slice(0, 1)
                        .toUpperCase();
                      const busy = decidingRequestId === r.id;
                      return (
                        <div
                          key={r.id}
                          className="flex items-center justify-between gap-2 bg-[hsl(22,15%,12%)] border border-amber-500/20 rounded-lg px-3 py-2"
                          data-testid={`join-request-row-${r.id}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {r.avatar_url ? (
                              <img
                                src={r.avatar_url}
                                alt=""
                                className="w-7 h-7 rounded-full"
                              />
                            ) : (
                              <div className="w-7 h-7 rounded-full bg-stone-700 flex items-center justify-center text-[10px] text-stone-300">
                                {initial}
                              </div>
                            )}
                            <div className="min-w-0">
                              <div className="text-xs text-stone-200 truncate">
                                {label}
                              </div>
                              {r.message && (
                                <div className="text-[10px] text-stone-500 truncate">
                                  "{r.message}"
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              disabled={busy}
                              onClick={() =>
                                void handleApproveRequest(r.id)
                              }
                              className="text-[10px] font-bold uppercase tracking-wider text-stone-900 px-2.5 py-1.5 rounded-md disabled:opacity-50"
                              style={{
                                background:
                                  "linear-gradient(135deg, #d4870c, #f0a832)",
                              }}
                              data-testid={`join-request-approve-${r.id}`}
                            >
                              {busy ? "…" : "Approve"}
                            </button>
                            <button
                              disabled={busy}
                              onClick={() =>
                                void handleDeclineRequest(r.id)
                              }
                              className="text-[10px] font-bold uppercase tracking-wider text-red-400 hover:text-red-300 px-2 py-1 disabled:opacity-50"
                              data-testid={`join-request-decline-${r.id}`}
                            >
                              Decline
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Invites — owner / admin only */}
              {canManage && (
                <div className="space-y-2">
                  <h3 className="text-[11px] font-bold uppercase tracking-widest text-stone-400">Invite</h3>
                  <div className="flex gap-1 text-[10px] uppercase tracking-wider" data-testid="invite-mode-tabs">
                    {(["link", "username"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setInviteMode(m)}
                        className={
                          "px-2.5 py-1 rounded-full font-bold border transition-colors " +
                          (inviteMode === m
                            ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                            : "border-stone-700 text-stone-500 hover:text-stone-300")
                        }
                        data-testid={`invite-mode-${m}`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    {inviteMode === "username" && (
                      <input
                        type="text"
                        value={inviteUsername}
                        onChange={(e) => setInviteUsername(e.target.value)}
                        placeholder="username"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        className="flex-1 px-3 py-2 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-xs text-stone-100"
                        data-testid="invite-username-input"
                      />
                    )}
                    {inviteMode === "link" && (
                      <div className="flex-1 px-3 py-2 rounded-lg bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] text-xs text-stone-500 italic">
                        Anyone with the link can join (14 days)
                      </div>
                    )}
                    <button
                      disabled={
                        creatingInvite ||
                        (inviteMode === "username" && !inviteUsername.trim())
                      }
                      onClick={() => void handleCreateInvite()}
                      className="px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
                      style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
                      data-testid="invite-create-btn"
                    >
                      {creatingInvite
                        ? "…"
                        : inviteMode === "link"
                          ? "Get Link"
                          : "Invite"}
                    </button>
                  </div>
                  <p className="text-[10px] text-stone-500">
                    {inviteMode === "username"
                      ? "Sent to that user's invite inbox. They accept or decline."
                      : "Share the link — caller must be signed in to accept."}
                  </p>

                  {detail.invites.length > 0 && (
                    <div className="space-y-1.5 pt-1" data-testid="invite-list">
                      {detail.invites.map((inv) => {
                        const expired = new Date(inv.expires_at).getTime() < Date.now();
                        const used = inv.accepted_at != null;
                        return (
                          <div
                            key={inv.id}
                            className="flex items-center justify-between gap-2 bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] rounded-lg px-3 py-2"
                            data-testid={`invite-row-${inv.id}`}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="text-xs text-stone-200 truncate">
                                {inv.email ?? "Link invite"}
                              </div>
                              <div className="text-[10px] text-stone-500">
                                {used ? "Used" : expired ? "Expired" : formatExpiry(inv.expires_at)}
                              </div>
                            </div>
                            {!used && !expired && (
                              <button
                                onClick={() => void copyInviteLink(inv)}
                                className="text-[10px] font-bold uppercase tracking-wider text-amber-400 hover:text-amber-300 px-2 py-1"
                                data-testid={`invite-copy-${inv.id}`}
                              >
                                {copiedToken === inv.token ? "Copied!" : "Copy"}
                              </button>
                            )}
                            <button
                              onClick={() => void handleRevoke(inv.id)}
                              className="text-[10px] font-bold uppercase tracking-wider text-red-400 hover:text-red-300 px-2 py-1"
                              data-testid={`invite-revoke-${inv.id}`}
                            >
                              {used || expired ? "Remove" : "Revoke"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Members */}
              <div className="space-y-2">
                <h3 className="text-[11px] font-bold uppercase tracking-widest text-stone-400">Members</h3>
                <div className="space-y-1.5" data-testid="member-list">
                  {detail.members.map((m) => (
                    <div
                      key={m.user_id}
                      className="flex items-center justify-between gap-2 bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] rounded-lg px-3 py-2"
                      data-testid={`member-row-${m.user_id}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {m.avatar_url ? (
                          <img src={m.avatar_url} alt="" className="w-7 h-7 rounded-full" />
                        ) : (
                          <div className="w-7 h-7 rounded-full bg-stone-700 flex items-center justify-center text-[10px] text-stone-300">
                            {(m.display_name ?? m.email ?? "?").slice(0, 1).toUpperCase()}
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="text-xs text-stone-200 truncate">{m.display_name ?? m.email ?? m.user_id}</div>
                          <div className="text-[10px] text-stone-500">{m.role}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {isOwner && m.role !== "owner" && (
                          <button
                            onClick={() => setTransferTargetId(m.user_id)}
                            className="text-[10px] font-bold uppercase tracking-wider text-amber-400 hover:text-amber-300 px-2 py-1"
                            data-testid={`member-transfer-${m.user_id}`}
                            title="Transfer ownership to this member"
                          >
                            Make Owner
                          </button>
                        )}
                        {canManage && m.role !== "owner" && (
                          <button
                            onClick={() => void handleRemoveMember(m.user_id)}
                            className="text-[10px] font-bold uppercase tracking-wider text-red-400 hover:text-red-300 px-2 py-1"
                            data-testid={`member-remove-${m.user_id}`}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Transfer ownership confirmation */}
              {transferTargetId && (() => {
                const target = detail.members.find((mm) => mm.user_id === transferTargetId);
                const targetLabel = target?.display_name ?? target?.email ?? target?.user_id ?? "this member";
                return (
                  <div
                    className="bg-amber-900/30 border border-amber-500/40 rounded-lg p-3 space-y-2"
                    data-testid="transfer-confirm"
                  >
                    <p className="text-xs text-amber-200">
                      Transfer ownership to <span className="font-bold">{targetLabel}</span>?
                      You'll become an admin.
                    </p>
                    <div className="flex gap-2">
                      <button
                        disabled={transferring}
                        onClick={() => setTransferTargetId(null)}
                        className="flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-300 border border-stone-700 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        disabled={transferring}
                        onClick={() => void handleTransferOwnership(transferTargetId)}
                        className="flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-900 disabled:opacity-50"
                        style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
                        data-testid="transfer-confirm-btn"
                      >
                        {transferring ? "Transferring…" : "Transfer"}
                      </button>
                    </div>
                  </div>
                );
              })()}

              {actionError && (
                <div className="bg-red-900/40 border border-red-500/40 rounded-lg px-3 py-2">
                  <p className="text-xs text-red-300" data-testid="group-detail-error">{actionError}</p>
                </div>
              )}

              {/* Danger zone */}
              <div className="border-t border-[hsl(30,12%,16%)] pt-3 flex flex-col gap-2">
                {isOwner ? (
                  confirmDelete ? (
                    <div className="bg-red-900/30 border border-red-500/40 rounded-lg p-3 space-y-2">
                      <p className="text-xs text-red-200">
                        Delete this group permanently? All shares and invites will be removed.
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setConfirmDelete(false)}
                          className="flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-300 border border-stone-700"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => void handleDelete()}
                          className="flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-white bg-red-600"
                          data-testid="group-delete-confirm"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="w-full py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-red-400 border border-red-500/30"
                      data-testid="group-delete-btn"
                    >
                      Delete Group
                    </button>
                  )
                ) : confirmLeave ? (
                  <div className="bg-stone-800/60 border border-stone-700 rounded-lg p-3 space-y-2">
                    <p className="text-xs text-stone-300">Leave this group? You'll need a new invite to rejoin.</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setConfirmLeave(false)}
                        className="flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-300 border border-stone-700"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => void handleLeave()}
                        className="flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-white bg-red-600"
                        data-testid="group-leave-confirm"
                      >
                        Leave
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmLeave(true)}
                    className="w-full py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-400 border border-stone-700"
                    data-testid="group-leave-btn"
                  >
                    Leave Group
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
