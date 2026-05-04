import { useEffect, useRef, useState } from "react";

const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 5_000;

async function probePing(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
    const res = await fetch("/api/healthz", {
      method: "HEAD",
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const update = (val: boolean) => setOnline(val);
    const goOnline = () => {
      void probePing().then((reachable) => update(reachable));
    };
    const goOffline = () => update(false);

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    intervalRef.current = setInterval(() => {
      if (navigator.onLine) {
        void probePing().then((reachable) => update(reachable));
      } else {
        update(false);
      }
    }, PING_INTERVAL_MS);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return online;
}
