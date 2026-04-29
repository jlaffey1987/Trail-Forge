import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

document.documentElement.classList.add("dark");
document.body.classList.add("dark");

// Stop accidental file drops outside the GPX upload zone from navigating the
// browser to the file's URL — which would unload the SPA and look exactly like
// the app "restarting". The upload dropzone has its own onDragOver/onDrop
// handlers that also call preventDefault, so its happy path is unaffected:
// these window-level listeners only neutralise drops that miss the zone.
if (typeof window !== "undefined") {
  window.addEventListener(
    "dragover",
    (e) => {
      e.preventDefault();
    },
    { passive: false },
  );
  window.addEventListener(
    "drop",
    (e) => {
      e.preventDefault();
    },
    { passive: false },
  );
}

// Register the service worker. The single most important reason we do this
// is so iOS treats our "Add to Home Screen" install as a real PWA and stops
// killing the WebView whenever the OS file picker takes over the screen —
// without an active SW, iOS aggressively evicts standalone web apps and
// the chosen file is lost on the way back, which manifests to the user as
// the app "restarting" mid-upload.
//
// We register synchronously here (rather than waiting for `window.load`) so
// the SW is in place even if the user starts the upload flow during the
// initial page load — otherwise the very first session can still hit the
// eviction bug.
if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  const swUrl = `${import.meta.env.BASE_URL}sw.js`;
  navigator.serviceWorker
    .register(swUrl, { scope: import.meta.env.BASE_URL })
    .catch((err) => {
      // Non-fatal: the app still works without the SW; we just lose the
      // PWA-stability benefits. Log so we can spot problems in dev.
      // eslint-disable-next-line no-console
      console.warn("[trailforge] service worker registration failed", err);
    });
}

// ---------------------------------------------------------------------------
// Last-chance error capture. Without these, a thrown error inside a React
// click handler (e.g. the GPX save flow) tears down the React tree and the
// rider just sees a blank screen with no clue what went wrong. We surface
// the message into a top-level overlay so the user can at least screenshot
// it and read what happened.
// ---------------------------------------------------------------------------

function showFatalOverlay(message: string) {
  // Defensive: only ever inject one overlay so a flood of unhandled
  // rejections doesn't paint over the app a hundred times.
  if (document.getElementById("trailforge-fatal-overlay")) return;
  const el = document.createElement("div");
  el.id = "trailforge-fatal-overlay";
  el.setAttribute(
    "style",
    [
      "position:fixed",
      "inset:0",
      "z-index:99999",
      "background:rgba(15,10,8,0.97)",
      "color:#fcd34d",
      "padding:24px",
      "font-family:system-ui,sans-serif",
      "overflow:auto",
      "display:flex",
      "flex-direction:column",
      "gap:16px",
    ].join(";"),
  );
  el.innerHTML = `
    <div style="font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#f59e0b;">
      Something went wrong
    </div>
    <div style="font-size:14px;color:#fde68a;line-height:1.5;white-space:pre-wrap;word-break:break-word;">
      ${message.replace(/[<>&]/g, (c) =>
        c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
      )}
    </div>
    <button id="trailforge-fatal-reload" style="margin-top:12px;padding:12px 16px;border-radius:10px;border:none;background:linear-gradient(135deg,#d4870c,#f0a832);color:#1c1410;font-weight:700;text-transform:uppercase;letter-spacing:1px;font-size:13px;">
      Reload App
    </button>
  `;
  document.body.appendChild(el);
  document
    .getElementById("trailforge-fatal-reload")
    ?.addEventListener("click", () => {
      window.location.reload();
    });
}

if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    // eslint-disable-next-line no-console
    console.error("[trailforge] window error:", event.error ?? event.message);
    const msg =
      event.error instanceof Error && event.error.message
        ? event.error.message
        : event.message || "Unknown error";
    showFatalOverlay(`Crash: ${msg}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    // eslint-disable-next-line no-console
    console.error("[trailforge] unhandled rejection:", event.reason);
    const reason = event.reason;
    const msg =
      reason instanceof Error && reason.message
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "Unhandled async error";
    showFatalOverlay(`Async error: ${msg}`);
  });
}

// React error boundary so a render-time crash anywhere below shows a
// visible message instead of unmounting to a blank screen.
class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[trailforge] React error boundary caught:", error, info);
  }

  render() {
    if (this.state.error) {
      const msg = this.state.error.message || String(this.state.error);
      return (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,10,8,0.97)",
            color: "#fcd34d",
            padding: 24,
            fontFamily: "system-ui, sans-serif",
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 16,
            zIndex: 99999,
          }}
        >
          <div
            style={{
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 2,
              color: "#f59e0b",
            }}
          >
            App crashed
          </div>
          <div
            style={{
              fontSize: 14,
              color: "#fde68a",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {msg}
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 12,
              padding: "12px 16px",
              borderRadius: 10,
              border: "none",
              background: "linear-gradient(135deg,#d4870c,#f0a832)",
              color: "#1c1410",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 1,
              fontSize: 13,
            }}
          >
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <RootErrorBoundary>
    <App />
  </RootErrorBoundary>,
);
