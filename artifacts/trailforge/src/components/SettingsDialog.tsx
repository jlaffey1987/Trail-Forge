import { useEffect, useState } from "react";
import {
  PushError,
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  getPushSupportLevel,
  loadPushPreferences,
  loadGroupPushPreferences,
  updateGroupPushPreference,
  type PushPreferences,
  type GroupPushPreference,
} from "@/lib/push";
import {
  listOfflineTrails,
  removeOfflineTrail,
  clearAllOffline,
  type OfflineTrail,
} from "@/lib/offlineStore";
import { formatBytes } from "@/lib/downloadManager";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsDialog({ open, onClose }: Props) {
  const [prefs, setPrefs] = useState<PushPreferences | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [offlineTrails, setOfflineTrails] = useState<OfflineTrail[]>([]);
  const [clearingAll, setClearingAll] = useState(false);
  const [groupPrefs, setGroupPrefs] = useState<GroupPushPreference[]>([]);
  const [togglingGroup, setTogglingGroup] = useState<string | null>(null);
  const [groupErrMsg, setGroupErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setErrMsg(null);
    void loadPushPreferences().then((p) => {
      if (!cancelled) {
        setPrefs(p);
        setLoading(false);
      }
    });
    void listOfflineTrails().then((list) => {
      if (!cancelled) setOfflineTrails(list);
    });
    void loadGroupPushPreferences().then((gp) => {
      if (!cancelled) setGroupPrefs(gp);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const supportLevel = getPushSupportLevel();
  // The toggle is conceptually "on" when *both* the server-side opt-in is true
  // and this device has an active subscription. That way a user with two
  // devices can see precisely which one is wired up.
  const toggleOn = !!prefs && prefs.enabled && prefs.subscribedOnThisDevice;

  async function handleToggle() {
    if (!prefs) return;
    setBusy(true);
    setErrMsg(null);
    try {
      if (toggleOn) {
        await disablePushOnThisDevice();
      } else {
        await enablePushOnThisDevice();
      }
      const fresh = await loadPushPreferences();
      setPrefs(fresh);
    } catch (err) {
      const message =
        err instanceof PushError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Couldn't update push settings";
      setErrMsg(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center"
      onClick={onClose}
      data-testid="settings-dialog-backdrop"
    >
      <div
        className="w-full max-w-md bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,16%)]">
          <h2
            id="settings-dialog-title"
            className="text-sm font-bold text-stone-100 uppercase tracking-wider"
          >
            Settings
          </h2>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-100 text-xl leading-none px-1"
            data-testid="settings-dialog-close"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="p-4 space-y-4">
          <section data-testid="settings-push-section">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <h3 className="text-xs font-bold uppercase tracking-widest text-stone-300">
                  Push notifications
                </h3>
                <p className="text-[11px] text-stone-500 mt-1">
                  Get a phone alert when someone joins a group you're in or
                  shares a trail with you.
                </p>
              </div>
              <button
                role="switch"
                aria-checked={toggleOn}
                disabled={
                  loading ||
                  busy ||
                  supportLevel === "unsupported" ||
                  supportLevel === "denied"
                }
                onClick={() => void handleToggle()}
                data-testid="settings-push-toggle"
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
                  toggleOn ? "bg-amber-500" : "bg-stone-700"
                } ${
                  loading || busy || supportLevel === "unsupported" || supportLevel === "denied"
                    ? "opacity-50 cursor-not-allowed"
                    : "cursor-pointer"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                    toggleOn ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {supportLevel === "unsupported" && (
              <p
                className="mt-2 text-[11px] text-stone-500"
                data-testid="settings-push-unsupported"
              >
                This browser doesn't support push notifications. Try installing
                TrailForge as an app from your browser's "Add to Home Screen"
                menu.
              </p>
            )}
            {supportLevel === "denied" && (
              <p
                className="mt-2 text-[11px] text-amber-300"
                data-testid="settings-push-denied"
              >
                Notifications are blocked for this site. Enable them in your
                browser settings to turn this on.
              </p>
            )}
            {errMsg && (
              <p
                className="mt-2 text-[11px] text-red-400"
                data-testid="settings-push-error"
              >
                {errMsg}
              </p>
            )}
            {prefs &&
              prefs.enabled &&
              !prefs.subscribedOnThisDevice &&
              supportLevel !== "unsupported" &&
              supportLevel !== "denied" && (
                <p
                  className="mt-2 text-[11px] text-stone-500"
                  data-testid="settings-push-other-device"
                >
                  Push is on for your account but not this device — tap the
                  toggle to add this device.
                </p>
              )}
          </section>

          {prefs?.enabled && groupPrefs.length > 0 && (
            <section data-testid="settings-group-push-section">
              <h3 className="text-xs font-bold uppercase tracking-widest text-stone-300 mb-1">
                Per-group notifications
              </h3>
              <p className="text-[11px] text-stone-500 mb-2">
                Silence pushes from individual groups without turning off
                notifications entirely.
              </p>
              <div className="space-y-1">
                {groupPrefs.map((gp) => (
                  <div
                    key={gp.group_id}
                    className="flex items-center justify-between bg-[hsl(22,15%,14%)] rounded-lg px-3 py-2"
                    data-testid={`group-push-${gp.group_id}`}
                  >
                    <span className="text-xs text-stone-200 truncate flex-1 min-w-0 mr-2">
                      {gp.group_name}
                    </span>
                    <button
                      role="switch"
                      aria-checked={gp.push_enabled}
                      aria-label={`Notifications for ${gp.group_name}`}
                      disabled={togglingGroup === gp.group_id}
                      onClick={async () => {
                        setTogglingGroup(gp.group_id);
                        setGroupErrMsg(null);
                        try {
                          const newVal = await updateGroupPushPreference(
                            gp.group_id,
                            !gp.push_enabled,
                          );
                          setGroupPrefs((prev) =>
                            prev.map((p) =>
                              p.group_id === gp.group_id
                                ? { ...p, push_enabled: newVal }
                                : p,
                            ),
                          );
                        } catch {
                          setGroupErrMsg("Couldn't update — try again");
                        } finally {
                          setTogglingGroup(null);
                        }
                      }}
                      data-testid={`group-push-toggle-${gp.group_id}`}
                      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${
                        gp.push_enabled ? "bg-amber-500" : "bg-stone-700"
                      } ${
                        togglingGroup === gp.group_id
                          ? "opacity-50 cursor-not-allowed"
                          : "cursor-pointer"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          gp.push_enabled ? "translate-x-4" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                ))}
              </div>
              {groupErrMsg && (
                <p
                  className="mt-2 text-[11px] text-red-400"
                  data-testid="settings-group-push-error"
                >
                  {groupErrMsg}
                </p>
              )}
            </section>
          )}

          <section data-testid="settings-offline-section">
            <h3 className="text-xs font-bold uppercase tracking-widest text-stone-300 mb-2">
              Offline Storage
            </h3>
            {offlineTrails.length === 0 ? (
              <p className="text-[11px] text-stone-500">
                No trails downloaded for offline use yet.
              </p>
            ) : (
              <>
                <p className="text-[11px] text-stone-500 mb-2">
                  {offlineTrails.length} trail{offlineTrails.length !== 1 ? "s" : ""} ·{" "}
                  {formatBytes(offlineTrails.reduce((s, t) => s + t.estimatedSizeBytes, 0))}
                </p>
                <div className="space-y-2 mb-3">
                  {offlineTrails.map((ot) => (
                    <div
                      key={ot.id}
                      className="flex items-center justify-between bg-[hsl(22,15%,14%)] rounded-lg px-3 py-2"
                      data-testid={`offline-trail-${ot.id}`}
                    >
                      <div className="flex-1 min-w-0 mr-2">
                        <div className="text-xs text-stone-200 truncate">{ot.trail.name}</div>
                        <div className="text-[10px] text-stone-500">
                          {formatBytes(ot.estimatedSizeBytes)} · {ot.tileCount} tiles
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await removeOfflineTrail(ot.id);
                            setOfflineTrails((prev) => prev.filter((t) => t.id !== ot.id));
                          } catch {
                            /* non-fatal */
                          }
                        }}
                        className="text-[10px] text-red-400 hover:text-red-300 shrink-0"
                        data-testid={`offline-trail-remove-${ot.id}`}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={clearingAll}
                  onClick={async () => {
                    setClearingAll(true);
                    try {
                      await clearAllOffline();
                      setOfflineTrails([]);
                    } catch {
                      /* non-fatal */
                    } finally {
                      setClearingAll(false);
                    }
                  }}
                  className="w-full py-2 rounded-lg text-xs font-semibold text-red-400 border border-red-500/30 hover:bg-red-900/20 transition-colors disabled:opacity-40"
                  data-testid="offline-clear-all"
                >
                  {clearingAll ? "Clearing…" : "Clear all offline data"}
                </button>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
