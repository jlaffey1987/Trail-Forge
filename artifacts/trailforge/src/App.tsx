import { useEffect, useRef } from "react";
import {
  ClerkProvider,
  SignIn,
  SignUp,
  useClerk,
  useUser,
} from "@clerk/react";
import { dark } from "@clerk/themes";
import {
  Switch,
  Route,
  useLocation,
  Router as WouterRouter,
} from "wouter";
import PlannerTab from "@/pages/PlannerTab";
import MapTab from "@/pages/MapTab";
import MyTrailsTab from "@/pages/MyTrailsTab";
import DiscoverTab from "@/pages/DiscoverTab";
import AITab from "@/pages/AITab";
import UserMenu from "@/components/UserMenu";
import SavedTrailsMergePrompt from "@/components/SavedTrailsMergePrompt";
import InvitesBadge from "@/components/groups/InvitesBadge";
import NotificationsBell from "@/components/groups/NotificationsBell";
import InviteAcceptPage from "@/components/groups/InviteAcceptPage";
import AdminPage from "@/pages/AdminPage";
import { syncCurrentUser } from "@/lib/users";
import { autoAcceptEmailInvites } from "@/lib/groups";

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

// Clerk passes full paths to routerPush/routerReplace, but wouter's
// setLocation prepends the base — strip it to avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const clerkAppearance = {
  baseTheme: dark,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl:
      typeof window !== "undefined"
        ? `${window.location.origin}${basePath}/logo.svg`
        : undefined,
  },
  variables: {
    colorPrimary: "#f0a832",
    colorForeground: "#f5f5f4",
    colorMutedForeground: "#a8a29e",
    colorDanger: "#ef4444",
    colorBackground: "hsl(22, 15%, 11%)",
    colorInput: "hsl(22, 15%, 14%)",
    colorInputForeground: "#f5f5f4",
    colorNeutral: "hsl(30, 12%, 22%)",
    fontFamily: "Inter, system-ui, sans-serif",
    borderRadius: "12px",
  },
  elements: {
    rootBox: "w-full",
    cardBox:
      "bg-[hsl(22,15%,11%)] border border-amber-500/20 rounded-2xl w-[400px] max-w-full overflow-hidden shadow-2xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
  },
};

type Tab = "planner" | "map" | "trails" | "discover" | "ai";

// Each tab has a canonical URL path. The Planner tab is also the index ("/")
// so visiting the root or "/planner" both render Planner. All other tabs map
// 1:1 to their slug so /map, /trails, /discover, /ai are deep-linkable.
const TAB_PATHS: Record<Tab, string> = {
  planner: "/",
  map: "/map",
  trails: "/trails",
  discover: "/discover",
  ai: "/ai",
};

function pathToTab(path: string): Tab {
  // Strip a single trailing slash (except for the root) so "/ai/" still works.
  const normalized = path.length > 1 ? path.replace(/\/$/, "") : path;
  switch (normalized) {
    case "/map":
      return "map";
    case "/trails":
      return "trails";
    case "/discover":
      return "discover";
    case "/ai":
      return "ai";
    case "/":
    case "":
    case "/planner":
    default:
      return "planner";
  }
}

interface NavItem {
  id: Tab;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "planner",
    label: "Planner",
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
  {
    id: "map",
    label: "Map",
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" />
        <line x1="9" y1="3" x2="9" y2="18" />
        <line x1="15" y1="6" x2="15" y2="21" />
      </svg>
    ),
  },
  {
    id: "trails",
    label: "My Trails",
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
        <polyline points="17 21 17 13 7 13 7 21" />
        <polyline points="7 3 7 8 15 8" />
      </svg>
    ),
  },
  {
    id: "discover",
    label: "Discover",
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
  },
  {
    id: "ai",
    label: "AI",
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        <path d="M8 10h.01M12 10h.01M16 10h.01" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    ),
  },
];

function TabContent({ tab }: { tab: Tab }) {
  switch (tab) {
    case "planner": return <PlannerTab />;
    case "map": return <MapTab />;
    case "trails": return <MyTrailsTab />;
    case "discover": return <DiscoverTab />;
    case "ai": return <AITab />;
  }
}

function MainShell() {
  const [location, setLocation] = useLocation();
  const activeTab = pathToTab(location);

  // Cross-tab navigation bridge: other tabs (e.g. My Trails → "Record" / "Draw")
  // can dispatch `trailforge:open-add-trail` with a chosen mode. We navigate to
  // the Map tab path with `?mode=...` so MapTab's mount-effect auto-opens the
  // matching contribute flow.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: string }>).detail ?? {};
      const mode = detail.mode;
      if (mode !== "upload" && mode !== "record" && mode !== "draw") return;
      const params = new URLSearchParams(window.location.search);
      params.set("mode", mode);
      const qs = params.toString();
      setLocation(`${TAB_PATHS.map}${qs ? `?${qs}` : ""}`);
    };
    window.addEventListener("trailforge:open-add-trail", handler as EventListener);
    return () => {
      window.removeEventListener("trailforge:open-add-trail", handler as EventListener);
    };
  }, [setLocation]);

  // Cross-tab navigation bridge: the notifications bell dispatches
  // `trailforge:open-trail` with a trail id when the user taps a "shared a
  // trail" entry. We jump to the Discover tab and pass the id via ?trail=...
  // so DiscoverTab can open its TrailDetailSheet on the matching row.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ trailId?: string }>).detail ?? {};
      const trailId = detail.trailId;
      if (!trailId) return;
      const params = new URLSearchParams(window.location.search);
      params.set("trail", trailId);
      const qs = params.toString();
      setLocation(`${TAB_PATHS.discover}${qs ? `?${qs}` : ""}`);
    };
    window.addEventListener("trailforge:open-trail", handler as EventListener);
    return () => {
      window.removeEventListener(
        "trailforge:open-trail",
        handler as EventListener,
      );
    };
  }, [setLocation]);

  // Cross-tab navigation bridge: Map tab dispatches `trailforge:open-planner`
  // when a user taps "Build Route" on the on-map route panel. We switch to
  // the Planner tab and write `?build=1` so PlannerTab's mount-effect can
  // prompt for start + end addresses.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ build?: boolean }>).detail ?? {};
      const params = new URLSearchParams(window.location.search);
      if (detail.build) {
        params.set("build", "1");
      }
      const qs = params.toString();
      setLocation(`${TAB_PATHS.planner}${qs ? `?${qs}` : ""}`);
    };
    window.addEventListener("trailforge:open-planner", handler as EventListener);
    return () => {
      window.removeEventListener("trailforge:open-planner", handler as EventListener);
    };
  }, [setLocation]);

  return (
    <div className="flex flex-col h-full max-w-md mx-auto bg-[hsl(22,15%,8%)]" style={{ maxWidth: "430px" }}>
      <header
        className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,14%)]"
        style={{ background: "linear-gradient(180deg, hsl(22,18%,9%) 0%, hsl(22,15%,8%) 100%)" }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-stone-900" fill="currentColor">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
            </svg>
          </div>
          <div>
            <h1
              className="text-sm font-black tracking-widest uppercase text-stone-100"
              style={{ letterSpacing: "0.18em" }}
            >
              TrailForge
            </h1>
            <p
              className="text-[9px] text-stone-500 uppercase tracking-widest"
              style={{ letterSpacing: "0.15em" }}
            >
              Off-Road Navigator
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,20%)] rounded-full px-2 py-1">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400"></div>
            <span className="text-[10px] text-stone-400">GPS Active</span>
          </div>
          <NotificationsBell />
          <InvitesBadge />
          <UserMenu />
        </div>
      </header>

      <main className="flex-1 overflow-hidden relative">
        <div className="h-full">
          <TabContent tab={activeTab} />
        </div>
      </main>

      <nav
        className="shrink-0 border-t border-[hsl(30,12%,14%)] safe-bottom"
        style={{ background: "linear-gradient(0deg, hsl(22,18%,7%) 0%, hsl(22,15%,9%) 100%)" }}
      >
        <div className="flex">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setLocation(TAB_PATHS[item.id])}
                className="flex-1 flex flex-col items-center justify-center py-2.5 gap-0.5 relative transition-all"
                data-testid={`nav-${item.id}`}
              >
                {isActive && (
                  <span
                    className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full"
                    style={{ background: "linear-gradient(90deg, #d4870c, #f0a832)" }}
                  />
                )}
                <span
                  className="transition-colors"
                  style={{ color: isActive ? "#f0a832" : "#6b7280" }}
                >
                  {item.icon}
                </span>
                <span
                  className="text-[10px] font-semibold uppercase tracking-wider transition-colors"
                  style={{
                    color: isActive ? "#f0a832" : "#6b7280",
                    letterSpacing: "0.06em",
                  }}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[hsl(22,15%,8%)] px-4">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        fallbackRedirectUrl={basePath || "/"}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[hsl(22,15%,8%)] px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        fallbackRedirectUrl={basePath || "/"}
      />
    </div>
  );
}

/**
 * Mirror Clerk users into Supabase `users` table on every sign-in.
 * Lazy & defensive — the helper handles the case where the table is not yet
 * provisioned.
 */
function ClerkUserSync() {
  const { user, isLoaded, isSignedIn } = useUser();
  const lastSyncedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user) return;
    if (lastSyncedRef.current === user.id) return;
    lastSyncedRef.current = user.id;
    void (async () => {
      await syncCurrentUser();
      // After we know the Supabase user row exists, also sweep any
      // pending email-bound group invites for this user.
      await autoAcceptEmailInvites();
    })();
  }, [isLoaded, isSignedIn, user]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back to TrailForge",
            subtitle: "Sign in to access your trails on any device",
          },
        },
        signUp: {
          start: {
            title: "Join TrailForge",
            subtitle: "Save trails, plan routes, and ride with confidence",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <ClerkUserSync />
      <SavedTrailsMergePrompt />
      <Switch>
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/invite/:token">
          {(params) => <InviteAcceptPage token={params.token ?? ""} />}
        </Route>
        <Route path="/admin" component={AdminPage} />
        <Route component={MainShell} />
      </Switch>
    </ClerkProvider>
  );
}

export default function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}
