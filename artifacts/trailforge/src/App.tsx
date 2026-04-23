import { useState } from "react";
import PlannerTab from "@/pages/PlannerTab";
import MapTab from "@/pages/MapTab";
import MyTrailsTab from "@/pages/MyTrailsTab";
import DiscoverTab from "@/pages/DiscoverTab";
import AITab from "@/pages/AITab";

type Tab = "planner" | "map" | "trails" | "discover" | "ai";

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

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("planner");

  return (
    <div className="flex flex-col h-full max-w-md mx-auto bg-[hsl(22,15%,8%)]" style={{ maxWidth: "430px" }}>
      {/* Header */}
      <header className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,14%)]"
        style={{ background: "linear-gradient(180deg, hsl(22,18%,9%) 0%, hsl(22,15%,8%) 100%)" }}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-stone-900" fill="currentColor">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-black tracking-widest uppercase text-stone-100" style={{ letterSpacing: "0.18em" }}>
              TrailForge
            </h1>
            <p className="text-[9px] text-stone-500 uppercase tracking-widest" style={{ letterSpacing: "0.15em" }}>
              Off-Road Navigator
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,20%)] rounded-full px-2 py-1">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400"></div>
            <span className="text-[10px] text-stone-400">GPS Active</span>
          </div>
          <button className="w-8 h-8 rounded-full bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,20%)] flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-stone-400" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="8" r="4" />
              <path d="M6 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
            </svg>
          </button>
        </div>
      </header>

      {/* Tab Content */}
      <main className="flex-1 overflow-hidden relative">
        <div className="h-full">
          <TabContent tab={activeTab} />
        </div>
      </main>

      {/* Bottom Navigation */}
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
                onClick={() => setActiveTab(item.id)}
                className="flex-1 flex flex-col items-center justify-center py-2.5 gap-0.5 relative transition-all"
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
