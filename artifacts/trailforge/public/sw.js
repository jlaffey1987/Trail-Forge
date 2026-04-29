/* TrailForge service worker.
 *
 * The single most important reason this file exists is to keep iOS happy.
 * When a web page is "Added to Home Screen" on iOS and run as a standalone
 * PWA, the WebView is *aggressively* evicted from memory whenever the OS
 * file picker (or any other system sheet) takes over the screen. When the
 * user dismisses the picker, iOS launches a fresh WebView and reloads the
 * URL — which destroys all in-memory state, including the file the user
 * just chose. From the user's perspective the app appears to "restart" the
 * moment they try to upload anything.
 *
 * Apps that register a service worker are treated by iOS as full-fledged
 * installed apps and the WebView is held in memory across system sheets
 * far more reliably. Even a relatively minimal SW like this one is enough
 * to flip that behaviour, so we don't need an aggressive caching strategy
 * here — just a valid registration with a few sensible defaults.
 *
 * Strategies used:
 *   - install:  pre-cache the app shell ("./") so the PWA can launch
 *               offline without a blank screen.
 *   - activate: clean up old cache versions and claim existing clients
 *               immediately so the SW takes effect on first load.
 *   - fetch:    network-first for navigation requests (fall back to the
 *               cached shell), stale-while-revalidate for same-origin
 *               static assets, and pass-through for everything else
 *               (cross-origin requests, the API, POST/PUT/DELETE, etc.).
 */

const CACHE_NAME = "trailforge-shell-v1";
const APP_SHELL = ["./"];

// Derive the app's base path from the registration scope rather than
// assuming "/". This way a deployment under "/trailforge/" or any other
// sub-path keeps working — most importantly, the API bypass below stays
// correct if the API ever lives under the same scope.
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const API_PREFIX = `${SCOPE_PATH}api/`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {
        /* Pre-cache failures must not block installation. */
      }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  // Never serve API responses from cache — the app must always see fresh
  // data, and most of these are write operations / authenticated reads.
  // We also bypass any "/api/" prefix outside our own scope just in case.
  if (url.pathname.startsWith(API_PREFIX) || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, clone))
            .catch(() => undefined);
          return response;
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached ?? caches.match("./")),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkPromise = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === "basic") {
            const clone = response.clone();
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(request, clone))
              .catch(() => undefined);
          }
          return response;
        })
        .catch(() => cached);
      return cached ?? networkPromise;
    }),
  );
});
