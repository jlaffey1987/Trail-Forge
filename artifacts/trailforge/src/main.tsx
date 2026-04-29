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

createRoot(document.getElementById("root")!).render(<App />);
