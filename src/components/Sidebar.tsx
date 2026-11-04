import React from "react";
import {
  Home,
  Compass,
  Server,
  Puzzle,
  Camera,
  Sliders,
  UserRound,
} from "lucide-react";
import { ThemeType } from "./ParticleBackground";
import { translations, LanguageType } from "../lib/translations";

export type TabType = "home" | "singleplayer" | "multiplayer" | "mods" | "customize" | "screenshots" | "settings";

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  theme: ThemeType;
  lang: LanguageType;
}

const rowBase = "relative flex h-8 w-full items-center gap-2 rounded-lg border px-2 text-[1.125rem] leading-6 font-medium transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] cursor-pointer";
const rowActive = "border-hairline bg-hover text-ink";
const rowIdle = "border-transparent text-ink-secondary hover:bg-hover hover:text-ink";

const buildMenu = (t: (typeof translations)[LanguageType]) => [
  { id: "home", label: t.home, icon: Home },
  { id: "singleplayer", label: t.instances, icon: Compass, tour: "nav-instances" },
  { id: "mods", label: t.modBrowser, icon: Puzzle, tour: "nav-mods" },
  { id: "customize", label: t.customize, icon: UserRound },
  { id: "multiplayer", label: t.multiplayer, icon: Server },
  { id: "screenshots", label: t.screenshots, icon: Camera },
] as const;

// The tour anchors live on the real nav buttons, so both the sidebar and the
// narrow bottom nav carry them.
const tourTarget = (item: unknown) => {
  const tour = (item as { tour?: string }).tour;
  return tour ? { "data-tour": tour } : {};
};

const navRowClass = (isActive: boolean) => `${rowBase} ${isActive ? rowActive : rowIdle}`;

export const Sidebar = React.memo(function Sidebar({ activeTab, setActiveTab, lang }: SidebarProps) {
  const t = translations[lang];
  const menuItems = buildMenu(t);

  return (
    <aside data-tour="sidebar" className="relative z-10 hidden h-full w-[240px] shrink-0 select-none flex-col bg-root after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-hairline after:content-[''] min-[1120px]:flex">
      <div
        className="flex h-14 shrink-0 items-center gap-2.5 px-2.5 cursor-pointer"
        onClick={() => setActiveTab("home")}
      >
        <img src="./images/bamboo-logo.png" alt="" className="h-7 w-7 shrink-0 rounded-[5px]" />
        <span className="text-[1.125rem] font-medium text-ink">Bamboo</span>
      </div>

      <nav className="flex w-full flex-1 flex-col gap-1 overflow-y-auto px-2">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              aria-current={isActive ? "page" : undefined}
              {...tourTarget(item)}
              className={navRowClass(isActive)}
            >
              <Icon className={`h-5 w-5 shrink-0 ${isActive ? "text-accent" : "text-ink-tertiary"}`} aria-hidden="true" />
              <span className="sidebar-label truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="w-full px-2 pb-3">
        <button
          data-tour="nav-settings"
          type="button"
          onClick={() => setActiveTab("settings")}
          aria-current={activeTab === "settings" ? "page" : undefined}
          className={navRowClass(activeTab === "settings")}
        >
          <Sliders
            className={`h-5 w-5 shrink-0 ${activeTab === "settings" ? "text-accent" : "text-ink-tertiary"}`}
            aria-hidden="true"
          />
          <span className="sidebar-label truncate">{t.settings}</span>
        </button>
      </div>
    </aside>
  );
});

export const BottomNav = React.memo(function BottomNav({
  activeTab,
  setActiveTab,
  lang,
}: {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  lang: LanguageType;
}) {
  const t = translations[lang];
  const items: Array<{ id: TabType; label: string; icon: typeof Home }> = [
    ...buildMenu(t),
    { id: "settings", label: t.settings, icon: Sliders },
  ];

  return (
    <nav className="relative z-10 flex h-14 w-full shrink-0 select-none items-stretch border-t border-hairline bg-root px-2 min-[1120px]:hidden">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => setActiveTab(item.id)}
            {...tourTarget(item)}
            aria-current={isActive ? "page" : undefined}
            aria-label={item.label}
            title={item.label}
            className={`flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg text-[0.875rem] font-medium transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] ${
              isActive ? "text-ink" : "text-ink-secondary hover:text-ink"
            }`}
          >
            <Icon className={`h-5 w-5 shrink-0 ${isActive ? "text-accent" : "text-ink-tertiary"}`} aria-hidden="true" />
            <span className="hidden max-w-full truncate px-1 min-[720px]:block">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
});
