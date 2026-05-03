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
import IntroSplash from "@/components/IntroSplash";
import { syncCurrentUser } from "@/lib/users";
import { autoAcceptEmailInvites } from "@/lib/groups";
import { setPlannerRouteUserId } from "@/lib/plannerRouteStore";

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
        ? `${window.location.origin}${basePath}/brand-cover.jpg`
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
    logoBox: "flex justify-center",
    logoImage: "max-h-16 w-auto rounded-md",
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

  // Cross-tab navigation bridge: the `trailforge:open-group` window event is
  // still in use because the service worker's `notificationclick` handler
  // can't import wouter directly. We jump to the My Trails tab and pass the
  // id via `?group=...` so GroupsSection auto-opens the matching dialog.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ groupId?: string }>).detail ?? {};
      const groupId = detail.groupId;
      if (!groupId) return;
      const params = new URLSearchParams(window.location.search);
      params.set("group", groupId);
      const qs = params.toString();
      setLocation(`${TAB_PATHS.trails}${qs ? `?${qs}` : ""}`);
    };
    window.addEventListener("trailforge:open-group", handler as EventListener);
    return () => {
      window.removeEventListener(
        "trailforge:open-group",
        handler as EventListener,
      );
    };
  }, [setLocation]);

  // ---------------------------------------------------------------------------
  // Push-notification deep-link handler. The service worker's
  // `notificationclick` opens or focuses our SPA at "/?trail=<id>" or
  // "/?group=<id>". On boot, route those root-level query params to the right
  // tab. For trails we navigate directly via setLocation; for groups we
  // dispatch the `trailforge:open-group` event (still bridged above) since
  // GroupsSection consumes it from inside the My Trails tab.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const trailId = params.get("trail");
    const groupId = params.get("group");
    if (!trailId && !groupId) return;
    if (trailId) {
      const next = new URLSearchParams(window.location.search);
      next.set("trail", trailId);
      setLocation(`${TAB_PATHS.discover}?${next.toString()}`);
    } else if (groupId) {
      window.dispatchEvent(
        new CustomEvent("trailforge:open-group", { detail: { groupId } }),
      );
    }
    // Note: we deliberately don't strip the param here — the receiving tab
    // (DiscoverTab / GroupsSection) consumes it once the dialog opens, then
    // clears it from the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col h-full mx-auto bg-[hsl(22,15%,8%)]" style={{ maxWidth: "min(100%, 560px)" }}>
      <header
        className="tf-header safe-top shrink-0 flex items-center justify-between px-4 pb-3.5 border-b border-[hsl(30,12%,14%)]"
      >
        <div className="flex items-center">
          <img
            src={`${basePath}/brand-cover.jpg`}
            alt="TrailForge"
            className="h-9 w-auto rounded-md"
          />
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

      <nav className="tf-nav shrink-0 border-t border-[hsl(30,12%,14%)] safe-bottom">
        <div className="flex">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setLocation(TAB_PATHS[item.id])}
                className={`tf-nav__item ${isActive ? "tf-nav__item--active" : ""}`}
                data-testid={`nav-${item.id}`}
                aria-current={isActive ? "page" : undefined}
              >
                <span className="relative z-10">{item.icon}</span>
                <span
                  className="text-[10px] font-semibold uppercase tracking-wider relative z-10"
                  style={{ letterSpacing: "0.06em" }}
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

  // Hand the planner-route store the current Clerk user id whenever it
  // changes. The store hydrates from Supabase on sign-in (cross-device
  // restore) and falls back to local-only mode on sign-out.
  useEffect(() => {
    if (!isLoaded) return;
    setPlannerRouteUserId(isSignedIn && user ? user.id : null);
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
      <IntroSplash />
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}
