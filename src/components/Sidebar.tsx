import React from "react";
import { motion } from "framer-motion";
import {
  Home,
  Compass,
  Server,
  Puzzle,
  Camera,
  Sliders,
} from "lucide-react";
import { ThemeType } from "./ParticleBackground";
import { translations, LanguageType } from "../lib/translations";
import { MOTION, EASE, motionSafe } from "../lib/motionTokens";

export type TabType = "home" | "singleplayer" | "multiplayer" | "mods" | "screenshots" | "settings";

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  theme: ThemeType;
  lang: LanguageType;
}

const rowBase = "relative w-full h-8 rounded-lg flex items-center gap-2.5 px-2.5 text-regular font-medium border transition-colors duration-[var(--t-base)] ease-[var(--ease-out)] cursor-pointer";
const rowActive = "border-transparent text-ink theme-bg-light";
const rowIdle = "border-transparent text-ink-secondary hover:text-ink hover:bg-hover";

const buildMenu = (t: (typeof translations)[LanguageType]) => [
  { id: "home", label: t.home, icon: Home },
  { id: "singleplayer", label: t.instances, icon: Compass },
  { id: "mods", label: t.modBrowser, icon: Puzzle },
  { id: "multiplayer", label: t.multiplayer, icon: Server },
  { id: "screenshots", label: t.screenshots, icon: Camera },
] as const;

export const Sidebar = React.memo(function Sidebar({ activeTab, setActiveTab, lang }: SidebarProps) {
  const t = translations[lang];

const menuItems = buildMenu(t);

  const styles = {
    logoShadow: "theme-shadow-sm group-hover:theme-shadow",
    logoBorder: "theme-border-md",
    logoText: "theme-text",
    activeIndicator: "theme-active-indicator",
    iconColor: "theme-text",
  };

return (
    <aside className="hidden min-[1120px]:flex w-[208px] shrink-0 h-full bg-root flex-col after:content-[''] after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-hairline z-10 relative select-none">
      <div
        className="h-11 px-3 flex items-center gap-2 shrink-0 group cursor-pointer"
        onClick={() => setActiveTab("home")}
      >
        <div className={`relative w-7 h-7 rounded-lg flex items-center justify-center shadow-lg ${styles.logoShadow} border ${styles.logoBorder} overflow-hidden transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-base)] ease-[var(--ease-out)] group-hover:scale-105 shrink-0`}>
          <img src="./images/bamboo-logo.png" alt="Bamboo Launcher" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-ink/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-[var(--t-base)] ease-[var(--ease-out)]" />
        </div>
        <span className={`text-micro font-medium ${styles.logoText} uppercase opacity-80 group-hover:opacity-100 transition-opacity`}>
          BAMBOO
        </span>
      </div>

      <nav className="flex flex-col gap-px w-full px-3 flex-1 overflow-y-auto justify-start mt-1">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;

          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`${rowBase} ${isActive ? rowActive : rowIdle}`}
            >
              {isActive && (
                <motion.div
                  layoutId="activeIndicator"
                  className={`absolute left-0 w-1 h-4 rounded-r-full ${styles.activeIndicator}`}
                  transition={motionSafe({ duration: MOTION.quick, ease: EASE.out })}
                />
              )}

              <Icon className={`w-[18px] h-[18px] shrink-0 transition-transform duration-[var(--t-base)] ease-[var(--ease-out)] group-hover:scale-110 ${isActive ? styles.iconColor : "text-ink-secondary"}`} />

              <span className="truncate">{item.label}</span>
            </button>
          );
})}
</nav>

      <div className="w-full px-3 pb-3">
        {(() => {
          const item = { id: "settings", label: t.settings, icon: Sliders } as const;
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              onClick={() => setActiveTab("settings")}
              className={`${rowBase} ${isActive ? rowActive : rowIdle}`}
            >
              {isActive && (
                <motion.div
                  layoutId="activeIndicator"
                  className={`absolute left-0 w-1 h-4 rounded-r-full ${styles.activeIndicator}`}
                  transition={motionSafe({ duration: MOTION.quick, ease: EASE.out })}
                />
              )}
              <Icon className={`w-[18px] h-[18px] shrink-0 transition-transform duration-[var(--t-base)] ease-[var(--ease-out)] group-hover:scale-110 ${isActive ? styles.iconColor : "text-ink-secondary"}`} />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })()}
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
    <nav className="min-[1120px]:hidden h-14 w-full shrink-0 bg-root border-t border-hairline px-2 flex items-stretch z-10 relative select-none">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id;
        return (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 rounded-lg text-mini font-medium transition-colors duration-[var(--t-base)] ease-[var(--ease-out)] cursor-pointer ${
              isActive ? "text-ink" : "text-ink-secondary hover:text-ink"
            }`}
          >
            <Icon className="w-[18px] h-[18px] shrink-0" />
            <span className="truncate max-w-full px-1">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
});
