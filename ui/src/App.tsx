import React, { Component, ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { motion, MotionConfig, useReducedMotion } from "framer-motion";
import { AlertCircle } from "lucide-react";
import { RunningInstanceBadge } from "./components/RunningInstanceBadge";
import { BackgroundTaskBar } from "./components/BackgroundTaskBar";
import { updateBackgroundTask } from "./lib/backgroundTasks";
import { instanceFolderKeyOf } from "./lib/instanceFolders";

import { ParticleBackground } from "./components/ParticleBackground";
import { Sidebar, BottomNav } from "./components/Sidebar";
import { TopBar, Account } from "./components/TopBar";
import { CommandPalette } from "./components/CommandPalette";
import { useAccountSession } from "./lib/accountSession";
import { Dialog } from "./components/Dialog";
import { dialogButton } from "./components/dialogSupport";
import { MOTION, EASE } from "./lib/motionTokens";
import { ToastProvider } from "./components/ToastHost";
import { useToast } from "./components/Toast";
import { useAppearance } from "./hooks/useAppearance";
import { useLauncherFont } from "./hooks/useLauncherFont";
import { useTheme } from "./hooks/useTheme";
import { useLauncherSettings } from "./hooks/useLauncherSettings";
import { useInstances } from "./hooks/useInstances";
import { useAppNavigation } from "./hooks/useAppNavigation";
import { useLaunchController } from "./hooks/useLaunchController";
import { useLogAnalyses } from "./hooks/useLogAnalyses";
import { useAppOverlays } from "./hooks/useAppOverlays";
import { useServers } from "./hooks/useServers";
import { usePersistence } from "./hooks/usePersistence";
import { useUpdater } from "./hooks/useUpdater";
import { LAUNCHER_VERSION } from "./lib/version";
import { OnboardingFlow } from "./components/onboarding/OnboardingFlow";
import { ChangelogDialog } from "./components/settings/ChangelogDialog";
import { LaunchPreflightDialog } from "./components/LaunchPreflightDialog";
import { shouldShowChangelog, shouldShowTour } from "./lib/onboarding";
import { requestSettingsTarget } from "./lib/settingsNavigation";

const Dashboard = React.lazy(() => import("./components/Dashboard").then(m => ({ default: m.Dashboard })));
const InstancesView = React.lazy(() => import("./components/InstancesView").then(m => ({ default: m.InstancesView })));
const MultiplayerView = React.lazy(() => import("./components/MultiplayerView").then(m => ({ default: m.MultiplayerView })));
const ModsView = React.lazy(() => import("./components/ModsView").then(m => ({ default: m.ModsView })));
const CustomizeView = React.lazy(() => import("./components/customize/CustomizeView").then(m => ({ default: m.CustomizeView })));
const ScreenshotsView = React.lazy(() => import("./components/ScreenshotsView").then(m => ({ default: m.ScreenshotsView })));
const SettingsView = React.lazy(() => import("./components/SettingsView").then(m => ({ default: m.SettingsView })));

export type { ThemeDefinition as BambooTheme } from "./services/themeService";

const NO_ACCOUNT: Account = { id: "", username: "", type: "Offline", avatar: "", online: false, active: false };

type OverlayChoice = "onboarding-welcome" | "onboarding-tour" | "changelog" | null;

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
        <div className="w-screen h-screen bg-root flex items-center justify-center">
          <div className="text-center p-8 max-w-md">
            <h2 className="text-title3 font-semibold text-danger mb-2">Runtime Error</h2>
            <p className="text-ink-secondary text-regular mb-4 font-mono">{this.state.error?.message}</p>
            <button onClick={() => this.setState({ hasError: false, error: null })} className="px-4 py-2 bg-raised hover:bg-selected rounded-xl text-small font-medium text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer">
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const reduceMotion = useReducedMotion();
  const { addToast } = useToast();
  const accountSession = useAccountSession();
  const activeAccount = accountSession.account ?? NO_ACCOUNT;

  const appearance = useAppearance();
  const launcherFont = useLauncherFont();
  const themeState = useTheme();
  const settingsState = useLauncherSettings({ setThemeId: themeState.setThemeId });
  const instancesState = useInstances();
  const navigation = useAppNavigation({ instances: instancesState.instances });
  const logAnalyses = useLogAnalyses();
  const serversState = useServers();
  const updater = useUpdater();
  const overlays = useAppOverlays();
  const launch = useLaunchController({
    instances: instancesState.instances,
    setInstances: instancesState.setInstances,
    setActiveInstance: instancesState.setActiveInstance,
    activeAccount,
    preferences: settingsState.preferences,
    lang: settingsState.lang,
    addToast,
    clearAnalyses: logAnalyses.clear,
    analyzeAfterCrash: logAnalyses.reanalyze,
  });
  // Ein Startwunsch aus einem Shortcut wartet auf dieses Signal: erst wenn die
  // Oberfläche steht, darf das Spiel starten.
  useEffect(() => {
    window.electronAPI?.system?.ready?.();
  }, []);

  // One app-wide listener keeps the footer honest even after the view that
  // started an install has been unmounted.
  useEffect(() => {
    const offModpack = window.electronAPI?.mods.onModpackProgress?.((data) => {
      if (!data || typeof data.folderName !== "string") return;
      updateBackgroundTask(`modpack:${data.folderName}`, {
        percent: data.percent,
        detail: data.label,
      });
    });
    const offTask = window.electronAPI?.tasks.onProgress?.((data) => {
      if (!data || typeof data.id !== "string") return;
      updateBackgroundTask(data.id, {
        percent: data.percent ?? null,
        detail: data.label,
      });
    });
    return () => {
      offModpack?.();
      offTask?.();
    };
  }, []);

  const shortcutInstances = instancesState.instances;
  const setShortcutActiveInstance = instancesState.setActiveInstance;
  const shortcutRequestRef = useRef<{ instances: typeof shortcutInstances; launch: typeof launch; navigation: typeof navigation }>({
    instances: shortcutInstances,
    launch,
    navigation,
  });
  useEffect(() => {
    shortcutRequestRef.current = { instances: shortcutInstances, launch, navigation };
  }, [shortcutInstances, launch, navigation]);
  const pendingShortcutRef = useRef("");

  const launchFromShortcut = useCallback((folderName: string) => {
    const state = shortcutRequestRef.current;
    const target = state.instances.find((instance) => instanceFolderKeyOf(instance) === folderName);
    if (!target) {
      // Profiles may still be loading when the shortcut arrives; keep it until
      // the list is available instead of silently dropping the launch.
      pendingShortcutRef.current = folderName;
      return;
    }
    pendingShortcutRef.current = "";
    state.navigation.handleSetActiveTab("singleplayer");
    setShortcutActiveInstance(target.name);
    window.setTimeout(() => state.launch.launchGame(target.id), 350);
  }, [setShortcutActiveInstance]);

  useEffect(() => {
    const offLaunchRequest = window.electronAPI?.instances.onLaunchRequest?.(launchFromShortcut);
    return () => {
      offLaunchRequest?.();
    };
  }, [launchFromShortcut]);

  useEffect(() => {
    if (pendingShortcutRef.current) launchFromShortcut(pendingShortcutRef.current);
  }, [shortcutInstances, launchFromShortcut]);

  const saveAllData = usePersistence({
    instances: instancesState.instances,
    themeId: themeState.themeId,
    lang: settingsState.lang,
    preferences: settingsState.preferences,
    settingsLoaded: settingsState.settingsLoaded,
    profilesLoaded: instancesState.profilesLoaded,
    legacyCoversDetected: instancesState.legacyCoversDetected,
    showBgImage: appearance.showBgImage,
    showParticles: appearance.showParticles,
    showGlow: appearance.showGlow,
    mainColor: appearance.mainColor,
    bgBrightness: appearance.bgBrightness,
    bgBlur: appearance.bgBlur,
  });

  // The startup overlay is derived from stored state until the user acts on it:
  // a first start gets the intro first, an update gets the changelog.
  const [overlayChoice, setOverlayChoice] = useState<OverlayChoice | undefined>(undefined);
  const { saveOnboarding } = settingsState;
  const overlay: OverlayChoice = overlayChoice !== undefined
    ? overlayChoice
    : !settingsState.settingsLoaded
      ? null
      : (() => {
          if (shouldShowTour(settingsState.onboarding)) return "onboarding-welcome";
          const seenInStorage = (() => {
            try {
              return localStorage.getItem('bamboo-last-seen-version');
            } catch {
              return null;
            }
          })();
          if (seenInStorage === LAUNCHER_VERSION) return null;
          if (shouldShowChangelog(settingsState.onboarding, LAUNCHER_VERSION)) return "changelog";
          return null;
        })();

  // A first start continues into "what's new"; closing a repeated tour does not.
  const finishOnboarding = useCallback(() => {
    const seenInStorage = (() => {
      try {
        return localStorage.getItem('bamboo-last-seen-version');
      } catch {
        return null;
      }
    })();
    const changelogPending = seenInStorage !== LAUNCHER_VERSION && shouldShowChangelog(settingsState.onboarding, LAUNCHER_VERSION);
    saveOnboarding({ tourDone: true });
    setOverlayChoice(changelogPending ? "changelog" : null);
  }, [saveOnboarding, settingsState.onboarding]);

  const closeChangelog = useCallback(() => {
    setOverlayChoice(null);
    try {
      localStorage.setItem('bamboo-last-seen-version', LAUNCHER_VERSION);
    } catch {
      /* ignore */
    }
    saveOnboarding({ lastSeenVersion: LAUNCHER_VERSION });
  }, [saveOnboarding]);

  // The first paint must not fade in: a cold start already takes a moment, and
  // an opacity animation on top of it made the window look half-transparent
  // while the first data arrived. Tab switches afterwards keep the motion.
  const paintedOnce = useRef(false);
  useEffect(() => {
    paintedOnce.current = true;
  }, []);

  return (
    <ErrorBoundary>
    <MotionConfig
      reducedMotion="user"
      transition={reduceMotion ? { duration: 0 } : { duration: MOTION.base, ease: EASE.out }}
    >
    <ToastProvider>
    <div className="relative w-screen h-screen bg-root text-ink flex flex-col overflow-hidden font-sans select-none">
      <ParticleBackground
        accent={themeState.currentTheme.accent}
        bgImage={themeState.currentTheme.bgImage}
        particleShapes={themeState.currentTheme.particleShapes}
        particleImage={themeState.currentTheme.particleImage}
        showGlow={appearance.showGlow}
        glowOverlayColor={appearance.mainColor || "#080415"}
        glowColor={appearance.mainColor || "#080415"}
        showBgImage={appearance.showBgImage}
        showParticles={appearance.showParticles}
        bgBrightness={appearance.bgBrightness}
        bgBlur={appearance.bgBlur}
        particleSize={themeState.currentTheme.particleSize ?? 8}
        particleFrequency={themeState.currentTheme.particleFrequency ?? 40}
        particleDirection={themeState.currentTheme.particleDirection || "bottom"}
      />
      <TopBar
        activeTab={navigation.activeTab}
        setActiveTab={navigation.setActiveTab}
        theme={themeState.theme}
        lang={settingsState.lang}
        activeAccount={activeAccount}
        onWindowClose={() => overlays.setShowExitModal(true)}
      />

      <div className="flex-1 min-h-0 w-full flex overflow-hidden">
        <Sidebar activeTab={navigation.activeTab} setActiveTab={navigation.handleSetActiveTab} theme={themeState.theme} lang={settingsState.lang} />

        <div className="flex-1 min-w-0 h-full flex flex-col justify-between overflow-hidden z-10 relative">

        <main tabIndex={-1} className="flex-1 overflow-hidden relative">
          <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center"><div className="w-6 h-6 border-2 border-stroke-strong border-t-stroke-strong rounded-full animate-spin" /></div>}>
            <motion.div
              key={navigation.activeTab}
              initial={reduceMotion || !paintedOnce.current ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: MOTION.base, ease: EASE.out }}
              className="absolute inset-0 flex flex-col"
            >
              {navigation.activeTab === "home" && (
                <Dashboard
                  setActiveTab={navigation.handleSetActiveTab}
                  activeAccount={activeAccount}
                  lang={settingsState.lang}
                  instances={instancesState.instances}
                  servers={serversState.servers}
                  runningInstances={launch.runningInstances}
                  launchingFolder={launch.launchingFolder}
                  onLaunch={launch.launchGame}
                  onStopGame={launch.stopGame}
                  onOpenInstance={(name) => {
                    instancesState.setActiveInstance(name);
                    navigation.handleSetActiveTab("singleplayer");
                  }}
                  onServerJoined={serversState.markJoined}
                  onToggleServerPin={serversState.togglePinned}
                />
              )}
              {navigation.activeTab === "singleplayer" && <InstancesView setActiveTab={navigation.setActiveTab} searchQuery={navigation.searchQuery} setActiveInstance={instancesState.setActiveInstance} lang={settingsState.lang} instances={instancesState.instances} setInstances={instancesState.setInstances} openModBrowserForInstance={navigation.openModBrowserForInstance} onLaunch={launch.launchGame} runningInstances={launch.runningInstances} onStopGame={launch.stopGame} launchProgress={launch.launchProgress} selectedInstanceOverride={navigation.selectedInstanceOverride} onClearSelectedInstanceOverride={navigation.clearSelectedInstanceOverride} instancesListToken={navigation.instancesListToken} launching={launch.isLaunching} launchingFolder={launch.launchingFolder} hasAccount={!!activeAccount.id} preferences={settingsState.preferences} setPreferences={settingsState.setPreferences} analyses={logAnalyses.analyses} onReanalyze={logAnalyses.reanalyze} />}
              {navigation.activeTab === "multiplayer" && <MultiplayerView setActiveTab={navigation.setActiveTab} searchQuery={navigation.searchQuery} lang={settingsState.lang} instances={instancesState.instances} servers={serversState.servers} setServers={serversState.setServers} onLaunchServer={launch.launchGame} onServerJoined={serversState.markJoined} preflightOpen={!!launch.preflight} activeAccount={activeAccount} />}
              {navigation.activeTab === "mods" && <ModsView key={`${navigation.modBrowserInstanceId ?? "global"}:${navigation.modBrowserEntryToken}`} setActiveTab={navigation.handleSetActiveTab} searchQuery={navigation.searchQuery} instances={instancesState.instances} setInstances={instancesState.setInstances} fromInstanceId={navigation.modBrowserInstanceId} onClearInstance={navigation.clearModBrowser} lang={settingsState.lang} />}
              {navigation.activeTab === "customize" && (
                <CustomizeView
                  lang={settingsState.lang}
                  locked={launch.isLaunching || launch.runningInstances.length > 0}
                  instances={instancesState.instances}
                  preferences={settingsState.preferences}
                  setPreferences={settingsState.setPreferences}
                  onOpenAccounts={() => {
                    requestSettingsTarget("accounts");
                    navigation.handleSetActiveTab("settings");
                  }}
                />
              )}
              {navigation.activeTab === "screenshots" && <ScreenshotsView setActiveTab={navigation.setActiveTab} lang={settingsState.lang} />}
              {navigation.activeTab === "settings" && (
                <SettingsView
                  lang={settingsState.lang}
                  setLang={settingsState.setLang}
                  themeId={themeState.themeId}
                  setThemeId={themeState.setThemeId}
                  themes={themeState.availableThemes}
                  mode={themeState.mode}
                  setMode={themeState.setMode}
                  customAccent={themeState.customAccent}
                  setCustomAccent={themeState.setCustomAccent}
                  customBg={themeState.customBg}
                  setCustomBg={themeState.setCustomBg}
                  preferences={settingsState.preferences}
                  setPreferences={settingsState.setPreferences}
                  showBgImage={appearance.showBgImage}
                  setShowBgImage={appearance.setShowBgImage}
                  showParticles={appearance.showParticles}
                  setShowParticles={appearance.setShowParticles}
                  showGlow={appearance.showGlow}
                  setShowGlow={appearance.setShowGlow}
                  bgBrightness={appearance.bgBrightness}
                  setBgBrightness={appearance.setBgBrightness}
                  bgBlur={appearance.bgBlur}
                  setBgBlur={appearance.setBgBlur}
                  launcherFont={launcherFont.launcherFont}
                  setLauncherFont={launcherFont.setLauncherFont}
                  statisticsEnabled={settingsState.statisticsEnabled}
                  setStatisticsEnabled={settingsState.setStatisticsEnabled}
                  setInstances={instancesState.setInstances}
                  accountSession={accountSession}
                  updateStatus={updater.status}
                  onCheckForUpdates={updater.check}
                  onInstallUpdate={updater.install}
                  onRestartTour={() => setOverlayChoice("onboarding-tour")}
                  onOpenChangelog={() => setOverlayChoice("changelog")}
                />
              )}
            </motion.div>
          </Suspense>
        </main>

        <BottomNav activeTab={navigation.activeTab} setActiveTab={navigation.handleSetActiveTab} lang={settingsState.lang} />

        <footer className="h-10 w-full bg-root border-t border-hairline px-6 flex items-center justify-between text-ink-secondary text-micro font-medium shrink-0 select-none">
          <div className="flex shrink-0 items-center">
            <span className="font-mono text-micro tabular-nums text-ink-quaternary">v{LAUNCHER_VERSION}</span>
          </div>

          <div className="flex min-w-0 flex-1 justify-center px-4">
            <BackgroundTaskBar />
          </div>

          <RunningInstanceBadge instances={launch.runningInstances} lang={settingsState.lang} />
        </footer>
        </div>
      </div>

      <CommandPalette
        key={overlays.paletteOpen ? "open" : "closed"}
        open={overlays.paletteOpen}
        onClose={() => overlays.setPaletteOpen(false)}
        onNavigate={navigation.handleSetActiveTab}
        onExit={() => overlays.setShowExitModal(true)}
        lang={settingsState.lang}
        instances={instancesState.instances}
        recentInstance={instancesState.activeInstance}
        onOpenInstance={(name) => {
          instancesState.setActiveInstance(name);
          navigation.handleSetActiveTab("singleplayer");
        }}
        onInstanceIntent={(intent) => {
          sessionStorage.setItem("bamboo-instances-intent", intent);
          navigation.handleSetActiveTab("singleplayer");
          window.dispatchEvent(new CustomEvent("bamboo-instances-intent", { detail: intent }));
        }}
      />

      <Dialog
        open={overlays.showExitModal}
        onClose={() => overlays.setShowExitModal(false)}
        title={settingsState.lang === "de" ? "Launcher beenden?" : "Quit launcher?"}
        titleId="exit-dialog-title"
        closeLabel={settingsState.lang === "de" ? "Schließen" : "Close"}
        icon={<AlertCircle className="h-4 w-4" />}
        tone="danger"
        footer={
          <>
            <button data-autofocus onClick={() => overlays.setShowExitModal(false)} className={dialogButton.secondary}>
              {settingsState.lang === "de" ? "Abbrechen" : "Cancel"}
            </button>
            <button
              onClick={() => { Promise.race([saveAllData(), new Promise(r => setTimeout(r, 2000))]).finally(() => window.electronAPI?.window.close?.()); }}
              className={dialogButton.danger}
            >
              {settingsState.lang === "de" ? "Beenden" : "Quit"}
            </button>
          </>
        }
      >
        <p>
          {settingsState.lang === "de"
            ? "Möchtest du den Launcher wirklich schließen?"
            : "Do you really want to close the launcher?"}
        </p>
      </Dialog>

      {(overlay === "onboarding-welcome" || overlay === "onboarding-tour") && (
        <OnboardingFlow
          lang={settingsState.lang}
          initialStep={overlay === "onboarding-tour" ? "tour" : "welcome"}
          hasInstances={instancesState.instances.length > 0}
          onFinish={finishOnboarding}
        />
      )}

      <ChangelogDialog
        open={overlay === "changelog"}
        version={LAUNCHER_VERSION}
        lang={settingsState.lang}
        onClose={closeChangelog}
      />

      <LaunchPreflightDialog
        prompt={launch.preflight}
        busy={launch.preflightBusy}
        lang={settingsState.lang}
        onCancel={launch.cancelPreflight}
        onConfirm={launch.confirmPreflight}
        onDisable={launch.disablePreflight}
      />

</div>
    </ToastProvider>
    </MotionConfig>
    </ErrorBoundary>
  );
}

export default App;
