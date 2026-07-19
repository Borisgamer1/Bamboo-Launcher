import React, { useState, useEffect, Component, ReactNode, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { RunningInstanceBadge } from "./components/RunningInstanceBadge";

import { ParticleBackground, ThemeType } from "./components/ParticleBackground";
import { Sidebar, TabType } from "./components/Sidebar";
import { TopBar, Account } from "./components/TopBar";
import type { Instance } from "./components/InstancesView";
import type { ServerItem } from "./components/MultiplayerView";

const Dashboard = React.lazy(() => import("./components/Dashboard").then(m => ({ default: m.Dashboard })));
const InstancesView = React.lazy(() => import("./components/InstancesView").then(m => ({ default: m.InstancesView })));
const MultiplayerView = React.lazy(() => import("./components/MultiplayerView").then(m => ({ default: m.MultiplayerView })));
const FriendsView = React.lazy(() => import("./components/FriendsView").then(m => ({ default: m.FriendsView })));
const ModsView = React.lazy(() => import("./components/ModsView").then(m => ({ default: m.ModsView })));
const CosmeticsView = React.lazy(() => import("./components/CosmeticsView").then(m => ({ default: m.CosmeticsView })));
const ScreenshotsView = React.lazy(() => import("./components/ScreenshotsView").then(m => ({ default: m.ScreenshotsView })));
const NewsEventsView = React.lazy(() => import("./components/NewsEventsView").then(m => ({ default: m.NewsEventsView })));
const SettingsView = React.lazy(() => import("./components/SettingsView").then(m => ({ default: m.SettingsView })));
import { LanguageType } from "./lib/translations";
import { initFriendsSystem, presenceService, friendStore } from "./friends/index";
import { ToastProvider, useToast } from "./components/Toast";
import { contentSyncService } from "./services/contentSync";
import { themeService, type ThemeDefinition as BambooTheme } from "./services/themeService";
import { assetManager } from "./services/assetManager";

// Re-export for backward compatibility
export type { ThemeDefinition as BambooTheme } from "./services/themeService";

const NO_ACCOUNT: Account = { id: "", username: "", type: "Offline", avatar: "", online: false };

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error) {
    console.error("[Bamboo] Runtime Error:", error);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="w-screen h-screen bg-slate-950 flex items-center justify-center">
          <div className="text-center p-8 max-w-md">
            <h2 className="text-xl font-black text-rose-400 mb-2">Runtime Error</h2>
            <p className="text-slate-400 text-sm mb-4 font-mono">{this.state.error?.message}</p>
            <button onClick={() => this.setState({ hasError: false, error: null })} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-xs font-bold text-slate-200 transition-all cursor-pointer">
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}



// Theme definitions: loaded from ThemeService (data-driven, CDN-backed)
// The BambooTheme interface is now in themeService.ts
// Built-in fallback themes remain available via themeService.getThemes()

function App() {
  const [activeTab, setActiveTab] = useState<TabType>("home");
  const [searchQuery] = useState("");
const [showExitModal, setShowExitModal] = useState(false);

  // Theme state - loaded from ThemeService (data-driven, CDN-backed)
  const [themeId, setThemeId] = useState(() => localStorage.getItem("bamboo-theme") || "bamboo");
  const [availableThemes, setAvailableThemes] = useState<BambooTheme[]>(() => themeService.getThemes());

  // Resolve current theme: check ThemeService first, then fallback to built-in
  const currentTheme = themeService.getTheme(themeId) ||
    availableThemes.find(t => t.id === themeId) ||
    themeService.getDefaultTheme();
  const theme: ThemeType = currentTheme.themeType;

  // Language
  const [lang, setLang] = useState<LanguageType>("de");
  // translations removed

  // Instances (loaded from IPC)
  const [instances, setInstances] = useState<Instance[]>([]);
  const [activeInstance, setActiveInstance] = useState("");

  // Issue 13: Store the last selected instance ID for back navigation from mod browser
  const [modBrowserInstanceId, setModBrowserInstanceId] = useState<string | null>(null);
  const [lastSelectedInstanceId, setLastSelectedInstanceId] = useState<string | null>(null);
  // Issue 13: Override to auto-select instance detail view when coming back from mod browser
  const [selectedInstanceOverride, setSelectedInstanceOverride] = useState<string | null>(null);

  // Servers
  const [servers, setServers] = useState<ServerItem[]>([]);

  // Accounts
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccount, setActiveAccount] = useState<Account>(NO_ACCOUNT);

  // Issue 22: When clicking sidebar mods tab while in instance mod browser, go to global mode
  const handleSetActiveTab = (tab: TabType) => {
    // Locked tabs (friends, multiplayer) are allowed to show their 'not logged in' UI
    if (tab === 'mods' && activeTab === 'mods' && modBrowserInstanceId) {
      // Already in mods tab with instance context - go to global
      setModBrowserInstanceId(null);
      return;
    }
    // Issue 13: When going back to singleplayer from mod browser, restore the selected instance detail view
    if (tab === 'singleplayer' && activeTab === 'mods' && lastSelectedInstanceId) {
      const found = instances.find(i => i.id === lastSelectedInstanceId);
      if (found) {
        setSelectedInstanceOverride(lastSelectedInstanceId);
        setLastSelectedInstanceId(null); // Clear after use
      }
    }
    setActiveTab(tab);
  };

  // Running instances for uptime
  const [runningInstances, setRunningInstances] = useState<{ name: string; startedAt: number }[]>([]);
  const [isLaunching, setIsLaunching] = useState(false);
  const { addToast } = useToast();
  const [launchStep, setLaunchStep] = useState("");

  // ===== LOAD PROFILES FROM IPC =====
  useEffect(() => {
    const load = async () => {
      try {
        const profiles = await window.electronAPI?.getProfiles?.();
        if (profiles && profiles.length > 0) {
const mapped: Instance[] = (profiles as IpcProfile[]).map(mapProfileToInstance);
          setInstances(mapped);
          setActiveInstance(mapped[0]?.name || "");
        }
      } catch { console.warn("[Bamboo] Failed to load profiles"); }
    };
    load();
  }, []);

  // ===== SAVE PROFILES TO IPC =====
  useEffect(() => {
    if (instances.length === 0) return;
    const profiles = instances.map(i => ({
      id: i.id,
      name: i.name,
      version: i.minecraftVersion,
      loader: i.modloader,
      loaderVersion: i.modloaderVersion || "",
      lastPlayed: i.lastPlayed,
      size: i.size,
      // Issue 21: Compute modCount from content array to avoid drift from stale counter
      mods: (i.content || []).filter(c => c.type === 'mods').length,
      desc: i.desc,
      thumbnail: i.thumbnail,
      javaPath: i.javaVersion || "Automatisch",
      installedMods: i.installedMods || [],
      content: i.content || [],
      ram: i.ram,
      // Issue 10: Modpack fields
      isModpack: i.isModpack || false,
      ownContentManagement: i.ownContentManagement || false,
      modpackProjectId: i.modpackProjectId || undefined,
      modpackSource: i.modpackSource || undefined,
      modpackVersion: i.modpackVersion || undefined,
    }));
    const timer = setTimeout(() => {
      window.electronAPI?.saveProfiles?.(profiles);
    }, 500);
    return () => clearTimeout(timer);
  }, [instances]);

  // ===== LOAD SETTINGS/ACCOUNTS =====
  useEffect(() => {
    const load = async () => {
      try {
        const settings = await window.electronAPI?.getSettings?.();
        if (settings) {
          if (settings.accounts && settings.accounts.length > 0) {
            const mapped: Account[] = (settings.accounts as IpcAccount[]).map(mapAccountFromSettings);
            // Filter out accounts without a real username (no placeholder "Spieler" accounts)
            const valid = mapped.filter(a => a.username && a.username !== "Spieler" && a.username !== "BambooPlayer");
            if (valid.length > 0) {
              setAccounts(valid);
              setActiveAccount(valid[0]);
            }
          }
          // No accounts? Keep empty state with NO_ACCOUNT
          if (typeof settings.currentTheme === 'string') {
            // Always accept the theme ID - ThemeService handles validation
            setThemeId(settings.currentTheme);
          }
          if (typeof settings.lang === 'string' && (settings.lang === 'de' || settings.lang === 'en')) {
            setLang(settings.lang);
          }
        }
      } catch { console.warn("[Bamboo] Failed to load settings"); }
    };
    load();
  }, []);

  // ===== PERSIST THEME =====
  useEffect(() => {
    localStorage.setItem("bamboo-theme", themeId);
    const root = document.documentElement;
    root.style.setProperty("--theme-accent", currentTheme.accent);
    root.style.setProperty("--theme-accent-light", currentTheme.accentLight);
    root.style.setProperty("--theme-accent-dark", currentTheme.accentDark);
    root.style.setProperty("--theme-glow", currentTheme.glowColor);
  }, [themeId]);

  // ===== LAUNCH GAME =====
  const handleLaunchGame = (instanceId?: string) => {
    const inst = instanceId ? instances.find(i => i.id === instanceId) : null;
    const target = inst || instances[0];
    if (!target || isLaunching) return;

    // Block launch if no account selected
    if (!activeAccount.id) {
      addToast({
        type: "warning",
        message: lang === "de" ? "Kein Account ausgewählt – Account in den Einstellungen hinzufügen" : "No account selected – add an account in Settings",
      });
      return;
    }

    setIsLaunching(true);
    const folderName = target.name.toLowerCase().replace(/\s+/g, "-");
    const payload = {
      folderName,
      profileName: target.name,
      version: target.minecraftVersion,
      ram: target.ram || 4,
      modLoader: target.modloader === "Vanilla" ? "vanilla" : target.modloader.toLowerCase(),
      loaderVersion: target.modloaderVersion || "",
      javaPath: target.javaVersion === "Automatisch" ? "" : (target.javaVersion || ""),
      authData: { type: activeAccount.type === "Microsoft" ? "microsoft" : "offline", name: activeAccount.username },
      gameOptions: { renderDistance: 12, fov: 70, fullscreen: false, vsync: true, maxFramerate: 120 },
    };

    try {
      window.electronAPI?.launchGame?.(payload);
      window.electronAPI?.onGameReady?.(() => {
        setIsLaunching(false);
        setLaunchStep("");
      });
      window.electronAPI?.onLaunchStatus?.((status: string) => setLaunchStep(status));
    } catch {
      console.warn("[Bamboo] Launch failed");
      setIsLaunching(false);
    }

    setRunningInstances(prev => [...prev, { name: target.name, startedAt: Date.now() }]);
  };

  // Running uptime timer handled by RunningInstanceBadge sub-component

  // ===== LISTEN FOR GAME CLOSED =====
  useEffect(() => {
    const unsub = window.electronAPI?.onGameClosed?.((data) => {
      setRunningInstances(prev => prev.filter(ri => ri.name !== data.profileName));
    });
    return () => { unsub?.(); };
  }, []);

  const handleStopGame = (name: string) => {
    const folderName = name.toLowerCase().replace(/\s+/g, "-");
    window.electronAPI?.stopGame?.({ folderName, profileName: name });
    setRunningInstances(prev => prev.filter(ri => ri.name !== name));
  };

  // ===== INIT FRIENDS =====
  useEffect(() => {
    initFriendsSystem();
    presenceService.setStatus("online");
  }, []);

  // ===== SYNC ACTIVE ACCOUNT TO FRIEND PROFILE =====
  // When a Microsoft account is active, use it as the friend profile (NOT BambooPlayer)
  useEffect(() => {
    if (activeAccount && activeAccount.type === "Microsoft") {
      friendStore.updateMyProfile({
        id: activeAccount.id,
        username: activeAccount.username,
        displayName: activeAccount.username, // Display name is ALWAYS the Minecraft username
        avatar: activeAccount.avatar || "🎋",
      });
    }
  }, [activeAccount]);

  // ===== INIT CONTENT SYNC (Bamboo Cloud API fallback) =====
  useEffect(() => {
    contentSyncService.startAutoSync();
    return () => {
      contentSyncService.stopAutoSync();
    };
  }, []);

  // ===== INIT ASSET MANAGER (CDN sync + self-healing) =====
  useEffect(() => {
    // Start CDN asset sync + self-healing via AssetManager
    assetManager.startAutoSync();

    // After initial sync, try to load CDN themes
    const loadCdnThemes = async () => {
      try {
        // Wait a moment for initial sync to complete
        await new Promise(r => setTimeout(r, 3000));
        const cdnThemes = await themeService.loadCdnThemes();
        if (cdnThemes.length > 0) {
          setAvailableThemes(themeService.getThemes());
          console.log(`[App] CDN themes loaded: ${cdnThemes.length} themes`);
        }
      } catch {
        // CDN themes are optional - built-in fallback always works
      }
    };
    loadCdnThemes();

    return () => {
      assetManager.stopAutoSync();
    };
  }, []);

  // ===== THEME STYLES =====
  // Theme styles – automatisch via CSS-Variablen

  return (
    <ErrorBoundary>
    <ToastProvider>
    <div className="relative w-screen h-screen bg-slate-950 text-slate-100 flex overflow-hidden font-sans select-none">
      <ParticleBackground theme={theme} />
      <Sidebar activeTab={activeTab} setActiveTab={handleSetActiveTab} theme={theme} lang={lang} />

      <div className="flex-1 h-full flex flex-col justify-between overflow-hidden z-10 relative">
<TopBar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          theme={theme}
          lang={lang}
          accounts={accounts}
          activeAccount={activeAccount}
          setActiveAccount={setActiveAccount}
          onWindowClose={() => setShowExitModal(true)}
        />

        <main className="flex-1 overflow-hidden relative">
          <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center"><div className="w-6 h-6 border-2 border-slate-600 border-t-slate-300 rounded-full animate-spin" /></div>}>
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 15, filter: "blur(10px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -15, filter: "blur(10px)" }}
              transition={{ duration: 0.35, ease: "easeInOut" }}
              className="absolute inset-0 flex flex-col"
            >
              {activeTab === "home" && <Dashboard setActiveTab={setActiveTab} theme={theme} activeAccount={activeAccount} lang={lang} />}
              {activeTab === "singleplayer" && <InstancesView setActiveTab={setActiveTab} searchQuery={searchQuery} activeInstance={activeInstance} setActiveInstance={setActiveInstance} lang={lang} instances={instances} setInstances={setInstances} openModBrowserForInstance={(id: string) => { setModBrowserInstanceId(id); setLastSelectedInstanceId(id); setActiveTab("mods"); }} onLaunch={handleLaunchGame} runningInstances={runningInstances} onStopGame={handleStopGame} selectedInstanceOverride={selectedInstanceOverride} />}
              {activeTab === "multiplayer" && <MultiplayerView setActiveTab={setActiveTab} searchQuery={searchQuery} lang={lang} instances={instances} servers={servers} setServers={setServers} onLaunchGame={(name) => setRunningInstances(prev => [...prev, { name, startedAt: Date.now() }])} activeAccount={activeAccount} />}
              {activeTab === "friends" && <FriendsView lang={lang} activeAccount={activeAccount} setActiveTab={setActiveTab} />}
              {activeTab === "mods" && <ModsView setActiveTab={setActiveTab} searchQuery={searchQuery} instances={instances} setInstances={setInstances} fromInstanceId={modBrowserInstanceId} theme={theme} onClearInstance={() => setModBrowserInstanceId(null)} lang={lang} />}
              {activeTab === "cosmetics" && <CosmeticsView setActiveTab={setActiveTab} lang={lang} activeAccount={activeAccount} />}
              {activeTab === "screenshots" && <ScreenshotsView setActiveTab={setActiveTab} lang={lang} />}
              {activeTab === "news" && <NewsEventsView theme={theme} lang={lang} />}
              {activeTab === "settings" && <SettingsView setActiveTab={setActiveTab} theme={theme} themeId={themeId} setTheme={(t: any) => setThemeId(t)} accounts={accounts} setAccounts={setAccounts} activeAccount={activeAccount} setActiveAccount={setActiveAccount} lang={lang} setLang={setLang} />}
            </motion.div>
          </AnimatePresence>
          </Suspense>
        </main>

        <footer className="h-10 w-full bg-slate-950/45 backdrop-blur-xl border-t border-slate-800/40 px-6 flex items-center justify-between text-slate-400 text-[11px] font-semibold shrink-0 select-none">
          <div className="flex items-center gap-4">
            <span className="font-black text-slate-200">Bamboo Launcher</span>
            <span className={`text-[9px] font-bold ${styles.badgeBg} px-2 py-0.2 rounded`}>v0.1.0</span>
            <div className="w-px h-3 bg-slate-800" />
            <div className={`flex items-center gap-1.5 ${styles.accentText}`}>
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Up to date</span>
            </div>

          </div>



          <RunningInstanceBadge instances={runningInstances} />
        </footer>
      </div>

      {/* Exit Modal */}
      <AnimatePresence>
        {showExitModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50 pointer-events-auto" onClick={() => setShowExitModal(false)}>
            <motion.div initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 20 }} className="bg-slate-950 border border-slate-800/80 rounded-3xl max-w-sm w-full p-6 shadow-2xl flex flex-col gap-4 text-left" onClick={e => e.stopPropagation()}>
              <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
                <AlertCircle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-black text-white tracking-wide">Launcher beenden?</h3>
                <p className="text-xs text-slate-400 leading-relaxed mt-2">Möchtest du den Launcher wirklich schließen?</p>
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setShowExitModal(false)} className="flex-1 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer">{lang === "de" ? "Abbrechen" : "Cancel"}</button>
                <button onClick={() => { window.electronAPI?.windowClose?.(); }} className="flex-1 bg-rose-500 hover:bg-rose-400 text-white py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-lg shadow-rose-500/10">{lang === "de" ? "Beenden" : "Quit"}</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

</div>
    </ToastProvider>
    </ErrorBoundary>
  );
}

// ===== MODULE-LEVEL CONSTANTS (not recreated on every render) =====
const styles = {
  accentText: "theme-text",
  badgeBg: "theme-bg-light theme-text theme-border-light",
  glowShadow: "theme-glow",
};

// ===== TYPE-SAFE IPC DATA HELPERS =====
interface IpcProfile {
  id?: string;
  name?: string;
  version?: string;
  loader?: string;
  loaderVersion?: string;
  lastPlayed?: string;
  size?: string;
  mods?: number;
  desc?: string;
  thumbnail?: string;
  javaPath?: string;
  installedMods?: string[];
  content?: Array<{type: string; [key:string]: unknown}>;
  ram?: number;
  isModpack?: boolean;
  ownContentManagement?: boolean;
  modpackProjectId?: string;
  modpackSource?: string;
  modpackVersion?: string;
}

interface IpcAccount {
  id?: string;
  name?: string;
  type?: string;
  avatar?: string;
  uuid?: string;
}

function mapProfileToInstance(p: IpcProfile, i: number): Instance {
  return {
    id: p.id || String(i),
    name: p.name || "",
    minecraftVersion: p.version || "1.21",
    modloader: (p.loader === "vanilla" || p.loader === "Vanilla") ? "Vanilla" as const : (p.loader || "Fabric") as any,
    modloaderVersion: p.loaderVersion || "",
    lastPlayed: p.lastPlayed || "Nie",
    size: p.size || "0 MB",
    modCount: (p.content || []).filter(c => c.type === 'mods').length || p.mods || 0,
    desc: p.desc || "",
    thumbnail: p.thumbnail || "",
    javaVersion: p.javaPath || "Automatisch",
    installedMods: p.installedMods || [],
    content: (p.content || []) as any,
    ram: p.ram,
    isModpack: p.isModpack || false,
    ownContentManagement: p.ownContentManagement || false,
    modpackProjectId: p.modpackProjectId || undefined,
    modpackSource: (p.modpackSource as "modrinth" | "curseforge") || undefined,
    modpackVersion: p.modpackVersion || undefined,
  };
}

function mapAccountFromSettings(a: IpcAccount, i: number): Account {
  return {
    id: a.id || String(i),
    username: a.name || "Spieler",
    type: a.type === "microsoft" ? "Microsoft" : "Offline",
    avatar: a.avatar || `https://mc-heads.net/avatar/${a.uuid || "Steve"}/32`,
    online: i === 0,
    uuid: a.uuid,
  };
}

export default App;






