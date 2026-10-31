import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronDown,
  Plus,
  Minus,
  X,
  User,
} from "lucide-react";
import { TabType } from "./Sidebar";
import { ThemeType } from "./ParticleBackground";
import { translations, LanguageType } from "../lib/translations";
import { useOverlayLayer } from "../lib/overlayLayers";
import { MOTION, EASE, motionSafe } from "../lib/motionTokens";
import { requestSettingsTarget } from "../lib/settingsNavigation";

import type { Account } from "../lib/accountSession";

const DEFAULT_AVATAR = "https://minotar.net/avatar/MHF_Steve";

export type { Account };

type DragRegionStyle = React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' };
const dragRegion = (region: 'drag' | 'no-drag'): DragRegionStyle => ({ WebkitAppRegion: region });

interface TopBarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  theme: ThemeType;
  lang: LanguageType;
  activeAccount: Account;
  onWindowClose: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  setActiveTab,
  lang,
  activeAccount,
  onWindowClose
}) => {
  const t = translations[lang];
  const avatarUrl =
    activeAccount.type === "Microsoft" && activeAccount.avatar?.trim()
      ? activeAccount.avatar
      : DEFAULT_AVATAR;
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  const profileButtonRef = useRef<HTMLButtonElement>(null);

  useOverlayLayer("menu", profileDropdownOpen);

  useEffect(() => {
    if (!profileDropdownOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setProfileDropdownOpen(false);
      profileButtonRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [profileDropdownOpen]);

  const colors = {
    text: "theme-text",
    bg: "theme-bg-light",
    border: "theme-border-light",
    hoverBorder: "hover:theme-border-md",
    shadow: "hover:theme-shadow-sm",
    dot: "theme-bg",
  };

  return (
    <header className="h-[42px] w-full bg-root border-b border-hairline px-4 flex items-center justify-between z-20 relative select-none" style={dragRegion('drag')}>

      <div className="flex-1" />

      <div className="flex items-center gap-4" style={dragRegion('no-drag')}>

        <div className="relative">
          <button
            ref={profileButtonRef}
            onClick={() => {
              setProfileDropdownOpen(!profileDropdownOpen);
            }}
            className={`flex h-7 items-center gap-2 bg-surface/60 hover:bg-selected border border-stroke/80 ${colors.hoverBorder} pl-1 pr-2 rounded-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-base)] ease-[var(--ease-out)] cursor-pointer shadow-sm ${colors.shadow} group`}
          >
            <div className="relative shrink-0">
              <div className="h-[22px] w-[22px] rounded-md bg-root/60 border border-rim overflow-hidden flex items-center justify-center">
                {activeAccount.id ? (
                  <img
                    src={avatarUrl}
                    alt="Avatar"
                    className="h-5 w-5 object-contain group-hover:scale-110 transition-transform duration-[var(--t-base)] ease-[var(--ease-out)]"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = DEFAULT_AVATAR;
                    }}
                  />
                ) : (
                  <User className="w-4 h-4 text-ink-tertiary" />
                )}
              </div>
              <span className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ${activeAccount.id ? colors.dot : "bg-selected"} border border-root`} />
            </div>

            <div className="flex min-w-0 flex-col text-left">
              <span className="max-w-[180px] truncate text-mini leading-none font-medium text-ink group-hover:text-ink transition-colors">
                {activeAccount.id ? activeAccount.username : (lang === "de" ? "Kein Account" : "No Account")}
              </span>
              {!activeAccount.id && (
                <span className="mt-0.5 text-[10px] leading-none text-ink-tertiary font-medium">{lang === "de" ? "Account hinzufügen" : "Add account"}</span>
              )}
            </div>

            <ChevronDown className={`w-3.5 h-3.5 text-ink-secondary transition-transform duration-[var(--t-base)] ease-[var(--ease-out)] group-hover:text-ink ${profileDropdownOpen ? "rotate-180" : ""}`} />
          </button>

          <AnimatePresence>
            {profileDropdownOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={motionSafe({ duration: MOTION.quick, ease: EASE.out })}
                data-blur-tier="menu"
                className="absolute right-0 mt-2 origin-top-right w-64 bg-glass backdrop-blur-[16px] backdrop-saturate-[1.2] border border-rim rounded-[var(--r-lg)] p-1.5 shadow-[var(--shadow-menu)] z-50 overflow-hidden"
              >
                <div className="p-2.5 bg-surface/40 rounded-lg border border-hairline mb-2 flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-root/80 border border-rim overflow-hidden flex items-center justify-center">
                    {activeAccount.id ? (
                      <img
                        src={avatarUrl}
                        alt="Avatar"
                        className="w-7 h-7 object-contain"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = DEFAULT_AVATAR;
                        }}
                      />
                    ) : (
                      <User className="w-5 h-5 text-ink-tertiary" />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col text-left">
                    <span className="truncate text-small font-medium text-ink">{activeAccount.id ? activeAccount.username : (lang === "de" ? "Kein Account" : "No Account")}</span>
                    {!activeAccount.id && (
                      <span className="truncate text-micro text-ink-tertiary font-medium">
                        {lang === "de" ? "Account in Einstellungen hinzufügen" : "Add account in Settings"}
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-2 pt-2 border-t border-hairline flex flex-col gap-1">
                  <button
                    onClick={() => {
                      requestSettingsTarget("accounts");
                      setActiveTab("settings");
                      setProfileDropdownOpen(false);
                    }}
                    className={`h-7 flex items-center gap-2 px-2 rounded-[var(--r-sm)] hover:bg-hover text-left text-small font-medium ${colors.text} transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer`}
                  >
                    <Plus className="w-4 h-4" />
                    {t.manageAccounts}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex items-center gap-2 ml-3" style={dragRegion('no-drag')}>
          <button
            onClick={() => window.electronAPI?.window.minimize?.()}
            className="w-[46px] h-8 flex items-center justify-center rounded-lg text-ink-secondary hover:text-ink hover:bg-selected transition-colors cursor-pointer"
          >
            <Minus className="w-4 h-4" />
          </button>
          <button
            onClick={onWindowClose}
            className="w-[46px] h-8 flex items-center justify-center rounded-lg text-ink-secondary hover:text-danger hover:bg-danger/10 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};
