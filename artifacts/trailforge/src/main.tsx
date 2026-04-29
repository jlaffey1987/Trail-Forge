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

createRoot(document.getElementById("root")!).render(<App />);
