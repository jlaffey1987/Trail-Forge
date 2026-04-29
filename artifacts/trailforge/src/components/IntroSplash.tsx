import { useEffect, useRef, useState } from "react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const STORAGE_KEY = "trailforge:intro-last-shown";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const VIDEO_DURATION_MS = 6_000;
const POSTER_FALLBACK_MS = 600;

// PREVIEW MODE: when true, the intro plays on every page load instead of
// at most once per 24h. Flip back to `false` to restore production
// once-per-day behavior. Path exclusions (/sign-in etc.) still apply.
const ALWAYS_SHOW_INTRO = true;

const EXCLUDED_PATH_PATTERNS = [
  /^\/sign-in(\/|$)/,
  /^\/sign-up(\/|$)/,
  /^\/invite(\/|$)/,
  /^\/admin(\/|$)/,
];

type SplashMode = "video" | "poster" | "off";

function pickInitialMode(): SplashMode {
  if (typeof window === "undefined") return "off";

  const path = window.location.pathname.startsWith(basePath)
    ? window.location.pathname.slice(basePath.length) || "/"
    : window.location.pathname;
  if (EXCLUDED_PATH_PATTERNS.some((re) => re.test(path))) return "off";

  if (!ALWAYS_SHOW_INTRO) {
    let lastShown = 0;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) lastShown = Number.parseInt(raw, 10) || 0;
    } catch {
      // localStorage unavailable — default to lastShown=0
    }
    if (Date.now() - lastShown < ONE_DAY_MS) return "off";
  }

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

function markShown() {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    // ignore
  }
}

export default function IntroSplash() {
  const [mode, setMode] = useState<SplashMode>(() => pickInitialMode());
  const [closing, setClosing] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (mode === "off") return;
    markShown();

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
