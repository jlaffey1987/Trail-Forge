import { useEffect, useRef, useState } from "react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const VIDEO_DURATION_MS = 6_000;
const POSTER_FALLBACK_MS = 600;

// The intro plays on every fresh app load / reload — it is part of the
// product's launch identity. Path exclusions below still apply so deep
// links into sign-in / sign-up / invite / admin are never blocked, and
// so a reload while the user is already inside one of the inner tabs
// (Map / My Trails / Discover / AI) doesn't waste another 6 seconds
// replaying the intro. The most common cause of an in-app reload is a
// mobile OS evicting the workspace preview / PWA when the native file
// picker takes over the screen — without these exclusions that would
// look exactly like the app "restarting" mid-upload. The network-aware
// branch below also falls back to a static poster on offline /
// Save-Data / 2g connections so we never burn a slow user's data.

const EXCLUDED_PATH_PATTERNS = [
  /^\/sign-in(\/|$)/,
  /^\/sign-up(\/|$)/,
  /^\/invite(\/|$)/,
  /^\/admin(\/|$)/,
  /^\/map(\/|$)/,
  /^\/trails(\/|$)/,
  /^\/discover(\/|$)/,
  /^\/ai(\/|$)/,
];

type SplashMode = "video" | "poster" | "off";

function pickInitialMode(): SplashMode {
  if (typeof window === "undefined") return "off";

  const path = window.location.pathname.startsWith(basePath)
    ? window.location.pathname.slice(basePath.length) || "/"
    : window.location.pathname;
  if (EXCLUDED_PATH_PATTERNS.some((re) => re.test(path))) return "off";

  if (typeof navigator !== "undefined") {
    if (navigator.onLine === false) return "poster";
    const conn = (navigator as Navigator & {
      connection?: {
        saveData?: boolean;
        effectiveType?: string;
      };
    }).connection;
    if (conn?.saveData) return "poster";
    if (conn?.effectiveType === "slow-2g" || conn?.effectiveType === "2g") {
      return "poster";
    }
  }
  return "video";
}

export default function IntroSplash() {
  const [mode, setMode] = useState<SplashMode>(() => pickInitialMode());
  const [closing, setClosing] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (mode === "off") return;

    if (mode === "poster") {
      closeTimerRef.current = window.setTimeout(() => {
        setClosing(true);
      }, POSTER_FALLBACK_MS);
      return () => {
        if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
      };
    }

    // mode === "video": hard cap at slightly over the video length so a
    // stuck/failed video can never trap the splash on screen.
    closeTimerRef.current = window.setTimeout(() => {
      setClosing(true);
    }, VIDEO_DURATION_MS + 500);

    const v = videoRef.current;
    if (v) {
      v.muted = true;
      const playPromise = v.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          // Autoplay blocked — fall through to poster fade-out
          setClosing(true);
        });
      }
    }

    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    };
  }, [mode]);

  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => setMode("off"), 350);
    return () => window.clearTimeout(t);
  }, [closing]);

  if (mode === "off") return null;

  const skip = () => setClosing(true);
  const onVideoEnded = () => setClosing(true);

  return (
    <div
      className={`tf-intro ${closing ? "tf-intro--closing" : ""}`}
      role="dialog"
      aria-label="TrailForge intro"
      data-testid="intro-splash"
    >
      {mode === "video" ? (
        // Order matters: WebM is listed first so browsers that support it
        // (Chrome / Firefox / modern Edge) pick the smaller VP9 file. Safari
        // / older mobile browsers drop through to the H.264 MP4 fallback.
        // We deliberately do NOT set a `src` attribute on the <video> tag —
        // doing so would short-circuit <source> negotiation and force MP4
        // for everyone, defeating the WebM size win.
        <video
          ref={videoRef}
          className="tf-intro__media"
          poster={`${basePath}/intro-poster.jpg`}
          muted
          playsInline
          autoPlay
          preload="auto"
          onEnded={onVideoEnded}
          onError={() => setClosing(true)}
        >
          <source src={`${basePath}/intro.webm`} type="video/webm" />
          <source src={`${basePath}/intro.mp4`} type="video/mp4" />
        </video>
      ) : (
        <img
          className="tf-intro__media"
          src={`${basePath}/intro-poster.jpg`}
          alt=""
          aria-hidden="true"
        />
      )}

      <div className="tf-intro__veil" aria-hidden="true" />

      <div className="tf-intro__content">
        <div className="tf-intro__brand">
          <span className="tf-intro__wordmark">TrailForge</span>
          <span className="tf-intro__tagline">Off-Road Navigator</span>
        </div>
      </div>

      <button
        type="button"
        onClick={skip}
        className="tf-intro__skip"
        data-testid="intro-splash-skip"
        aria-label="Skip intro"
      >
        Skip
      </button>
    </div>
  );
}
