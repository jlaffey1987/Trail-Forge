import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

export function useInstallPrompt(): {
  canInstall: boolean;
  isInstalled: boolean;
  promptInstall: () => Promise<boolean>;
} {
  const [canInstall, setCanInstall] = useState(deferredPrompt != null);
  const [isInstalled, setIsInstalled] = useState(
    typeof window !== "undefined" &&
      window.matchMedia("(display-mode: standalone)").matches,
  );

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      deferredPrompt = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    };

    const onInstalled = () => {
      deferredPrompt = null;
      setCanInstall(false);
      setIsInstalled(true);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    const mql = window.matchMedia("(display-mode: standalone)");
    const onDisplayChange = (e: MediaQueryListEvent) => setIsInstalled(e.matches);
    mql.addEventListener("change", onDisplayChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      mql.removeEventListener("change", onDisplayChange);
    };
  }, []);

  const promptInstall = async (): Promise<boolean> => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    setCanInstall(false);
    if (outcome === "accepted") {
      setIsInstalled(true);
      return true;
    }
    return false;
  };

  return { canInstall, isInstalled, promptInstall };
}
