import React from "react";
import { motion } from "framer-motion";
import {
  Home,
  Compass,
  Server,
  Puzzle,
  Sparkles,
  Camera,
  Sliders,
  Users,
} from "lucide-react";
import { ThemeType } from "./ParticleBackground";
import { translations, LanguageType } from "../lib/translations";

export type TabType = "home" | "singleplayer" | "multiplayer" | "friends" | "mods" | "cosmetics" | "screenshots" | "news" | "settings";

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  theme: ThemeType;
  lang: LanguageType;
}

export const Sidebar = React.memo(function Sidebar({ activeTab, setActiveTab, theme, lang }: SidebarProps) {
  const tooltipZ = "opacity-0 group-hover:opacity-100 transition-opacity duration-200 fixed left-[92px] bg-slate-950/90 border border-slate-800/80 text-white px-2.5 py-1.5 rounded-lg whitespace-nowrap shadow-xl pointer-events-none z-[100]";
  const t = translations[lang];

const menuItems = [
  { id: "home", label: t.home, icon: Home },
  { id: "singleplayer", label: t.instances, icon: Compass },
  { id: "mods", label: t.modBrowser, icon: Puzzle },
  { id: "multiplayer", label: t.multiplayer, icon: Server },
  { id: "friends", label: "Freunde", icon: Users },
  { id: "cosmetics", label: t.cosmetics, icon: Sparkles },
  { id: "screenshots", label: t.screenshots, icon: Camera },
] as const;

  // Theme styles – automatisch via CSS-Variablen an das aktuelle Theme angepasst
  const styles = {
    logoGrad: "theme-logo-grad",
    logoShadow: "theme-shadow-sm group-hover:theme-shadow",
    logoBorder: "theme-border-md",
    logoText: "theme-text",
    activeBg: "theme-bg-light theme-border-light",
    activeIndicator: "theme-active-indicator",
    iconColor: "theme-text",
  };

return (
    <aside className="w-20 md:w-24 h-full bg-slate-950/45 backdrop-blur-xl border-r border-slate-800/60 flex flex-col py-6 z-10 relative select-none">
      {/* Client Logo */}
      <div className="flex flex-col items-center gap-1 group cursor-pointer shrink-0" onClick={() => setActiveTab("home")}>
        <div className={`relative w-12 h-12 rounded-2xl bg-gradient-to-tr ${styles.logoGrad} flex items-center justify-center shadow-lg ${styles.logoShadow} border ${styles.logoBorder} overflow-hidden transition-all duration-300 group-hover:scale-105`}>
          <img src="./images/LauncherOnlyOutline.png" alt="Bamboo" className="w-8 h-8 object-contain opacity-90 group-hover:opacity-100 transition-opacity" />
          <div className="absolute inset-0 bg-gradient-to-t from-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        </div>
        <span className={`text-[10px] font-bold tracking-widest ${styles.logoText} uppercase opacity-80 group-hover:opacity-100 transition-opacity`}>
          BAMBOO
        </span>
      </div>

{/* Navigation Tabs */}
      <nav className="flex flex-col gap-3 w-full px-3 flex-1 overflow-y-auto justify-start mt-6">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;

          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`relative w-full aspect-square rounded-2xl flex flex-col items-center justify-center gap-1 transition-all duration-300 group cursor-pointer ${
                isActive 
                  ? `text-white ${styles.activeBg} shadow-inner` 
                  : "text-slate-400 hover:text-slate-100 hover:bg-slate-800/30 border border-transparent"
              }`}
            >
              {/* Highlight active indicator */}
              {isActive && (
                <motion.div
                  layoutId="activeIndicator"
                  className={`absolute left-0 w-1.5 h-8 rounded-r-full ${styles.activeIndicator}`}
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}

              <Icon className={`w-5.5 h-5.5 transition-transform duration-300 group-hover:scale-110 ${isActive ? styles.iconColor : "text-slate-400 group-hover:text-slate-200"}`} />

              <span className={`text-[9px] md:text-[10px] font-medium tracking-wide ${tooltipZ}`}>
                {item.label}
              </span>
            </button>
          );
})}
</nav>

      {/* Settings at bottom */}
      <div className="w-full px-3 pb-2">
        {(() => {
          const item = { id: "settings", label: t.settings, icon: Sliders } as const;
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              onClick={() => setActiveTab("settings")}
              className={`relative w-full aspect-square rounded-2xl flex flex-col items-center justify-center gap-1 transition-all duration-300 group cursor-pointer ${
                isActive 
                  ? `text-white ${styles.activeBg} shadow-inner` 
                  : "text-slate-400 hover:text-slate-100 hover:bg-slate-800/30 border border-transparent"
              }`}
            >
              {isActive && (
                <motion.div
                  layoutId="activeIndicator"
                  className={`absolute left-0 w-1.5 h-8 rounded-r-full ${styles.activeIndicator}`}
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <Icon className={`w-5.5 h-5.5 transition-transform duration-300 group-hover:scale-110 ${isActive ? styles.iconColor : "text-slate-400 group-hover:text-slate-200"}`} />
              <span className={`text-[9px] md:text-[10px] font-medium tracking-wide ${tooltipZ}`}>{item.label}</span>
            </button>
          );
        })()}
      </div>
    </aside>
  );
});
