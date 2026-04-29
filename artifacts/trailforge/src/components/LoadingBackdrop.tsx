import { useEffect, useState } from "react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

interface LoadingBackdropProps {
  /** Stable variant key — picks the same photo for every render. */
  variant?: "ride" | "ride2";
  /** Optional caption shown beneath the spinner. */
  label?: string;
  /** Spinner accent color. Defaults to the amber theme accent. */
  accent?: string;
  /** Test id for the wrapper element. */
  testId?: string;
}

/**
 * Full-bleed loading state that layers a softly-darkened riding photo behind
 * a spinner so empty pages don't flash a flat dark panel. Picks the smaller
 * 640px variant on narrow screens and crossfades the image in.
 */
export default function LoadingBackdrop({
  variant = "ride",
  label,
  accent = "#f0a832",
  testId,
}: LoadingBackdropProps) {
  const [loaded, setLoaded] = useState(false);

  // Pick the smaller variant on narrow screens to keep slow connections fast.
  const isNarrow =
    typeof window !== "undefined" && window.innerWidth < 520;
  const src = `${basePath}/${variant}-${isNarrow ? "640" : "1280"}.jpg`;

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setLoaded(true);
    };
    img.onerror = () => {
      if (!cancelled) setLoaded(false);
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <div
      className="relative w-full h-full overflow-hidden bg-[hsl(22,15%,8%)]"
      data-testid={testId}
    >
      <div
        className="absolute inset-0 bg-cover bg-center transition-opacity duration-300 ease-out"
        style={{
          backgroundImage: `url("${src}")`,
          opacity: loaded ? 1 : 0,
        }}
        aria-hidden="true"
      />
      {/* Dark gradient veil so spinner + label stay legible regardless of photo. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, hsla(22,18%,6%,0.55) 0%, hsla(22,18%,6%,0.78) 60%, hsla(22,18%,6%,0.92) 100%)",
        }}
        aria-hidden="true"
      />
      <div className="relative z-10 w-full h-full flex flex-col items-center justify-center px-4 text-center">
        <div
          className="w-9 h-9 rounded-full border-2 animate-spin mb-3"
          style={{
            borderColor: `${accent}33`,
            borderTopColor: accent,
          }}
        />
        {label ? (
          <p className="text-sm text-stone-300/90 font-medium drop-shadow">
            {label}
          </p>
        ) : null}
      </div>
    </div>
  );
}
