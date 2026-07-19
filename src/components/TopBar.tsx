import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Bell, 
  ChevronDown, 
  Check, 
  Plus, 
  Minus,
  X,
  User,
} from "lucide-react";
import { TabType } from "./Sidebar";
import { ThemeType } from "./ParticleBackground";
import { translations, LanguageType } from "../lib/translations";

export interface Account {
  id: string;
  username: string;
  type: "Microsoft" | "Offline";
  avatar: string;
  online: boolean;
  uuid?: string;
}

interface TopBarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  theme: ThemeType;
  lang: LanguageType;
  accounts: Account[];
  activeAccount: Account;
  setActiveAccount: (account: Account) => void;
  onWindowClose: () => void;
}

interface ClientNotification {
  id: string;
  title: string;
  desc: string;
  time: string;
  type: "update" | "event" | "alert";
  unread: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({ 
  setActiveTab, 
  theme,
  lang,
  accounts,
  activeAccount,
  setActiveAccount,
  onWindowClose
}) => {
  const t = translations[lang];
  const [notifDropdownOpen, setNotifDropdownOpen] = useState(false);
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);

  // Notifications
  const [notifications, setNotifications] = useState<ClientNotification[]>([]);

  const markAllAsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, unread: false })));
  };

  const switchAccount = (account: Account) => {
    setActiveAccount(account);
    setProfileDropdownOpen(false);
  };

  const hasUnreadNotifs = notifications.some(n => n.unread);

  // Theme colors – automatisch via CSS-Variablen
  const colors = {
    text: "theme-text",
    bg: "theme-bg-light",
    border: "theme-border-light",
    hoverBorder: "hover:theme-border-md",
    shadow: "hover:theme-shadow-sm",
    dot: "theme-bg",
  };

  return (
    <header className="h-12 w-full bg-slate-950/25 backdrop-blur-md border-b border-slate-800/40 px-4 flex items-center justify-between z-20 relative select-none" style={{ WebkitAppRegion: 'drag' } as any}>
      
      <div className="flex-1" />

      {/* Center: Spacer for title / balance */}

      {/* Right section: Notifications, Player Profile, Window Controls */}
      <div className="flex items-center gap-4" style={{ WebkitAppRegion: 'no-drag' } as any}>
        
        {/* Notifications Icon with Dropdown */}
        <div className="relative">
          <button
            onClick={() => {
              setNotifDropdownOpen(!notifDropdownOpen);
              setProfileDropdownOpen(false);
            }}
            className={`p-2.5 rounded-xl border relative transition-all duration-300 cursor-pointer ${
              notifDropdownOpen
                ? `${colors.bg} ${colors.text} border-${colors.text}/30`
                : "bg-slate-900/60 text-slate-400 border-slate-800/80 hover:text-slate-200 hover:border-slate-700/80"
            }`}
          >
            <Bell className="w-5 h-5" />
            {hasUnreadNotifs && (
              <span className={`absolute top-1.5 right-1.5 w-2.5 h-2.5 ${colors.dot} border-2 border-slate-950 rounded-full`} />
            )}
          </button>

          <AnimatePresence>
            {notifDropdownOpen && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                transition={{ duration: 0.15 }}
                className="absolute right-0 mt-2 w-80 bg-slate-950/95 backdrop-blur-xl border border-slate-800/90 rounded-2xl p-2 shadow-2xl z-50 overflow-hidden"
              >
                <div className="px-3 py-2 border-b border-slate-800/50 mb-2 flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">{t.notifications}</span>
                  {hasUnreadNotifs && (
                    <button
                      onClick={markAllAsRead}
                      className={`text-[10px] font-semibold ${colors.text} hover:opacity-85 cursor-pointer`}
                    >
                      {t.markAllRead}
                    </button>
                  )}
                </div>
                <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto custom-scrollbar">
                  {notifications.map((notif) => (
                    <div
                      key={notif.id}
                      className={`p-2.5 rounded-xl border text-left flex flex-col gap-1 transition-all ${
                        notif.unread
                          ? `${colors.bg} border-${colors.text}/10`
                          : "bg-slate-900/20 border-slate-800/40"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`text-xs font-bold ${notif.unread ? colors.text : "text-slate-300"}`}>
                          {notif.title}
                        </span>
                        <span className="text-[9px] text-slate-500">{notif.time}</span>
                      </div>
                      <p className="text-[11px] text-slate-400 leading-normal">{notif.desc}</p>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Divider */}
        <div className="w-px h-6 bg-slate-800" />

        {/* Player Profile with Dropdown */}
        <div className="relative">
          <button
            onClick={() => {
              setProfileDropdownOpen(!profileDropdownOpen);
              setNotifDropdownOpen(false);
            }}
            className={`flex items-center gap-3 bg-slate-900/60 hover:bg-slate-800/70 border border-slate-800/80 ${colors.hoverBorder} pl-2 pr-3.5 py-1.5 rounded-xl transition-all duration-300 cursor-pointer shadow-lg ${colors.shadow} group`}
          >
            {/* Skin Head Render – Benutzer-Icon wenn kein Account, Steve wenn Offline, echter Skin bei Microsoft */}
            <div className="w-8 h-8 rounded-lg bg-slate-950/60 border border-slate-700/50 overflow-hidden flex items-center justify-center shrink-0 relative">
              {activeAccount.id ? (
                <img
                  src={activeAccount.type === "Microsoft" ? activeAccount.avatar : "https://minotar.net/avatar/MHF_Steve"}
                  alt="Avatar"
                  className="w-7 h-7 object-contain group-hover:scale-110 transition-transform duration-300"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = "https://minotar.net/avatar/MHF_Steve";
                  }}
                />
              ) : (
                <User className="w-4 h-4 text-slate-500" />
              )}
              <span className={`absolute bottom-0 right-0 w-2 h-2 rounded-full ${activeAccount.id ? colors.dot : "bg-slate-700"} border border-slate-950`} />
            </div>

            {/* Username */}
            <div className="flex flex-col text-left">
              <span className="text-xs font-bold text-slate-200 group-hover:text-white transition-colors">
                {activeAccount.id ? activeAccount.username : (lang === "de" ? "Kein Account" : "No Account")}
              </span>
              {!activeAccount.id && (
                <span className="text-[9px] text-slate-500 font-medium">{lang === "de" ? "Account hinzufügen" : "Add account"}</span>
              )}
            </div>

            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform duration-300 group-hover:text-slate-200 ${profileDropdownOpen ? "rotate-180" : ""}`} />
          </button>

          <AnimatePresence>
            {profileDropdownOpen && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                transition={{ duration: 0.15 }}
                className="absolute right-0 mt-2 w-72 bg-slate-950/95 backdrop-blur-xl border border-slate-800/90 rounded-2xl p-2 shadow-2xl z-50 overflow-hidden"
              >
                {/* Active Account Summary */}
                <div className="p-3 bg-slate-900/40 rounded-xl border border-slate-800/50 mb-2 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-slate-950/80 border border-slate-700/60 overflow-hidden flex items-center justify-center">
                    {activeAccount.id ? (
                      <img
                        src={activeAccount.type === "Microsoft" ? activeAccount.avatar : "https://minotar.net/avatar/MHF_Steve"}
                        alt="Avatar"
                        className="w-9 h-9 object-contain"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = "https://minotar.net/avatar/MHF_Steve";
                        }}
                      />
                    ) : (
                      <User className="w-5 h-5 text-slate-500" />
                    )}
                  </div>
                  <div className="flex flex-col text-left">
                    <span className="text-sm font-bold text-slate-200">{activeAccount.id ? activeAccount.username : (lang === "de" ? "Kein Account" : "No Account")}</span>
                    <span className="text-[9px] text-slate-500 font-medium">{activeAccount.id ? `Type: ${activeAccount.type} Account` : (lang === "de" ? "Account in Einstellungen hinzufügen" : "Add account in Settings")}</span>
                  </div>
                </div>

                {/* Switch Account Header */}
                <div className="px-3 py-1 mb-1">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t.switchAccount}</span>
                </div>

                {/* Account List */}
                <div className="flex flex-col gap-1 max-h-48 overflow-y-auto custom-scrollbar">
                  {accounts
                    .filter((acc) => acc.id !== activeAccount.id)
                    .map((acc) => (
                      <button
                        key={acc.id}
                        onClick={() => switchAccount(acc)}
                        className="flex items-center justify-between px-2.5 py-2 rounded-xl text-left text-xs hover:bg-slate-800/40 text-slate-300 transition-all border border-transparent hover:border-slate-800 cursor-pointer"
                      >
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-lg bg-slate-950/60 border border-slate-800 overflow-hidden flex items-center justify-center">
                            {acc.type === "Microsoft" ? (
                              <img
                                src={acc.avatar}
                                alt="Avatar"
                                className="w-6 h-6 object-contain"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).src = "https://minotar.net/avatar/MHF_Steve";
                                }}
                              />
                            ) : (
                              <img
                                src="https://minotar.net/avatar/MHF_Steve"
                                alt="Avatar"
                                className="w-6 h-6 object-contain"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).src = "https://minotar.net/avatar/MHF_Steve";
                                }}
                              />
                            )}
                          </div>
                          <div className="flex flex-col">
                            <span className="font-bold text-slate-200">{acc.username}</span>
                            <span className="text-[9px] text-slate-400">{acc.type}</span>
                          </div>
                        </div>
                      </button>
                    ))}
                </div>

                {/* Actions */}
                <div className="mt-2 pt-2 border-t border-slate-800/60 flex flex-col gap-1">
                  <button 
                    onClick={() => {
                      // Set session flag so SettingsView knows to open accounts category
                      sessionStorage.setItem('bamboo-settings-category', 'accounts');
                      setActiveTab("settings");
                      setProfileDropdownOpen(false);
                    }}
                    className={`flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-slate-800/40 text-left text-xs font-semibold ${colors.text} transition-all cursor-pointer`}
                  >
                    <Plus className="w-4 h-4" />
                    {t.manageAccounts}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Window Controls */}
        <div className="flex items-center gap-2 ml-3" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button
            onClick={() => window.electronAPI?.windowMinimize?.()}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-all cursor-pointer"
          >
            <Minus className="w-4 h-4" />
          </button>
          <button
            onClick={onWindowClose}
            className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-all cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};
