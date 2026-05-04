export async function registerServiceWorker(baseUrl: string): Promise<boolean> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }
  const swUrl = `${baseUrl}sw.js`;
  try {
    await navigator.serviceWorker.register(swUrl, { scope: baseUrl });
    return true;
  } catch (err) {
    console.warn("[trailforge] service worker registration failed", err);
    return false;
  }
}
