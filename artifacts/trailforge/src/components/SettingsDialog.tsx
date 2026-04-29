import { useEffect, useState } from "react";
import {
  PushError,
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  getPushSupportLevel,
  loadPushPreferences,
  type PushPreferences,
} from "@/lib/push";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsDialog({ open, onClose }: Props) {
  const [prefs, setPrefs] = useState<PushPreferences | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

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
        </div>
      </div>
    </div>
  );
}
