import { useEffect, useRef, useState } from "react";
import { Show, useClerk, useUser } from "@clerk/react";
import { useLocation } from "wouter";
import SettingsDialog from "./SettingsDialog";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function Initials({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("") || "U";
  return (
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-600 to-amber-800 text-white flex items-center justify-center text-xs font-bold">
      {initials}
    </div>
  );
}

function SignedOutMenu() {
  const [, setLocation] = useLocation();
  return (
    <button
      onClick={() => setLocation("/sign-in")}
      className="flex items-center gap-1.5 bg-amber-500 text-stone-900 hover:bg-amber-400 transition-colors rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider"
      data-testid="header-sign-in"
    >
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
        <polyline points="10 17 15 12 10 7" />
        <line x1="15" y1="12" x2="3" y2="12" />
      </svg>
      Sign in
    </button>
  );
}

function SignedInMenu() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!user) return null;
  const displayName =
    user.fullName ||
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.username ||
    user.primaryEmailAddress?.emailAddress ||
    "Rider";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5"
        data-testid="header-user-button"
        aria-label="User menu"
      >
        {user.imageUrl ? (
          <img
            src={user.imageUrl}
            alt={displayName}
            className="w-8 h-8 rounded-full border border-amber-500/40 object-cover"
          />
        ) : (
          <Initials name={displayName} />
        )}
      </button>
      {open && (
        <div
          className="absolute right-0 top-10 z-50 w-56 bg-[hsl(22,15%,11%)] border border-[hsl(30,12%,20%)] rounded-xl shadow-2xl overflow-hidden"
          data-testid="user-menu-dropdown"
        >
          <div className="px-3 py-2.5 border-b border-[hsl(30,12%,16%)] flex items-center gap-2.5">
            {user.imageUrl ? (
              <img src={user.imageUrl} alt="" className="w-8 h-8 rounded-full" />
            ) : (
              <Initials name={displayName} />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-stone-100 truncate">{displayName}</p>
              <p className="text-[10px] text-stone-500 truncate">
                {user.primaryEmailAddress?.emailAddress ?? "Signed in"}
              </p>
            </div>
          </div>
          <button
            className="w-full text-left px-3 py-2.5 text-xs font-medium text-stone-300 hover:bg-[hsl(22,15%,14%)] flex items-center gap-2 border-b border-[hsl(30,12%,16%)]"
            onClick={() => {
              setOpen(false);
              setShowSettings(true);
            }}
            data-testid="header-settings"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-stone-400" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </button>
          <button
            className="w-full text-left px-3 py-2.5 text-xs font-medium text-stone-300 hover:bg-[hsl(22,15%,14%)] flex items-center gap-2"
            onClick={async () => {
              setOpen(false);
              await signOut({ redirectUrl: basePath || "/" });
            }}
            data-testid="header-sign-out"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-stone-400" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign out
          </button>
        </div>
      )}
      <SettingsDialog open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
}

export default function UserMenu() {
  return (
    <>
      <Show when="signed-out">
        <SignedOutMenu />
      </Show>
      <Show when="signed-in">
        <SignedInMenu />
      </Show>
    </>
  );
}
