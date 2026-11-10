import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronDown,
  Plus,
  Minus,
  X,
  User,
  Maximize2,
  Minimize2,
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
  const de = lang === "de";
  const avatarUrl =
    activeAccount.type === "Microsoft" && activeAccount.avatar?.trim()
      ? activeAccount.avatar
      : DEFAULT_AVATAR;
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  useOverlayLayer("menu", profileDropdownOpen);

  useEffect(() => {
    let active = true;
    void window.electronAPI?.window
      .isMaximized?.()
      .then((value) => { if (active) setIsMaximized(!!value); })
      .catch(() => {});
    const unsubscribe = window.electronAPI?.window.onMaximizedChange?.((value) => setIsMaximized(!!value));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

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

  return (
    <header data-tauri-drag-region className="relative z-20 flex h-11 w-full items-center justify-between border-b border-hairline bg-root px-4 select-none" style={dragRegion('drag')}>

      <div className="flex-1" />

      <div className="flex items-center gap-4" style={dragRegion('no-drag')}>

        <div className="relative">
          <button
            ref={profileButtonRef}
            type="button"
            data-tour="account"
            onClick={() => setProfileDropdownOpen(!profileDropdownOpen)}
            aria-expanded={profileDropdownOpen}
            className="group flex h-8 cursor-pointer items-center gap-2 rounded-[var(--r-md)] border border-hairline bg-surface/70 pl-1 pr-2 transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center overflow-hidden rounded-[5px] border border-hairline bg-root">
              {activeAccount.id ? (
                <img
                  src={avatarUrl}
                  alt=""
                  className="h-5 w-5 object-contain"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = DEFAULT_AVATAR;
                  }}
                />
              ) : (
                <User className="h-3.5 w-3.5 text-ink-tertiary" aria-hidden="true" />
              )}
            </div>

            <span className="max-w-[180px] truncate text-mini font-medium text-ink">
              {activeAccount.id ? activeAccount.username : de ? "Konto verbinden" : "Connect account"}
            </span>

            <ChevronDown className={`h-3.5 w-3.5 text-ink-tertiary transition-transform duration-[var(--t-quick)] ease-[var(--ease-out)] ${profileDropdownOpen ? "rotate-180" : ""}`} aria-hidden="true" />
          </button>

          <AnimatePresence>
            {profileDropdownOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={motionSafe({ duration: MOTION.quick, ease: EASE.out })}
                data-blur-tier="menu"
                className="absolute right-0 z-50 mt-2 w-64 origin-top-right overflow-hidden rounded-[var(--r-xl)] border border-stroke bg-surface p-1.5 shadow-[var(--shadow-menu)]"
              >
                <div className="mb-1 flex items-center gap-2.5 rounded-[var(--r-md)] border border-hairline bg-canvas p-2.5">
                  <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-[6px] border border-hairline bg-root">
                    {activeAccount.id ? (
                      <img
                        src={avatarUrl}
                        alt=""
                        className="h-7 w-7 object-contain"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = DEFAULT_AVATAR;
                        }}
                      />
                    ) : (
                      <User className="h-4 w-4 text-ink-tertiary" aria-hidden="true" />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col text-left">
                    <span className="truncate text-small font-medium text-ink">
                      {activeAccount.id ? activeAccount.username : de ? "Kein Konto" : "No account"}
                    </span>
                    <span className="truncate text-micro text-ink-tertiary">
                      {activeAccount.id
                        ? activeAccount.type === "Microsoft" ? "Microsoft" : de ? "Offline-Profil" : "Offline profile"
                        : de ? "In den Einstellungen hinzufügen" : "Add in Settings"}
                    </span>
                    {activeAccount.uuid && (
                      <span className="mt-0.5 truncate font-mono text-micro leading-4 text-ink-quaternary" title={activeAccount.uuid}>
                        {activeAccount.uuid}
                      </span>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    requestSettingsTarget("accounts");
                    setActiveTab("settings");
                    setProfileDropdownOpen(false);
                  }}
                  className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-[var(--r-sm)] px-2 text-left text-small font-medium text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t.manageAccounts}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex items-center gap-1" style={dragRegion('no-drag')}>
          <button
            type="button"
            onClick={() => window.electronAPI?.window.minimize?.()}
            aria-label={de ? "Minimieren" : "Minimize"}
            className="flex h-8 w-10 cursor-pointer items-center justify-center rounded-[var(--r-sm)] text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => window.electronAPI?.window.maximize?.()}
            title={isMaximized
              ? (de ? "Wiederherstellen" : "Restore")
              : (de ? "Maximieren" : "Maximize")}
            aria-label={isMaximized
              ? (de ? "Wiederherstellen" : "Restore")
              : (de ? "Maximieren" : "Maximize")}
            className="flex h-8 w-10 cursor-pointer items-center justify-center rounded-[var(--r-sm)] text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
          >
            {isMaximized ? <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={onWindowClose}
            title={de ? "Schließen" : "Close"}
            aria-label={de ? "Schließen" : "Close"}
            className="flex h-8 w-10 cursor-pointer items-center justify-center rounded-[var(--r-sm)] text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
};
