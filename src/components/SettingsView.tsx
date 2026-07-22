import React, { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Sliders, 
  ArrowLeft, 
  Cpu, 
  Monitor, 
  Volume2, 
  Gamepad2, 
  ShieldCheck, 
  X,
  Info,
  Check,
  AlertTriangle,
  Palette,
  Users,
  Plus,
  Trash2,
  Edit2,
  MessageSquare,
  Accessibility,
  Lock
} from "lucide-react";
import { TabType } from "./Sidebar";
import { ThemeType } from "./ParticleBackground";
import { Account } from "./TopBar";
import { translations, LanguageType } from "../lib/translations";
import { themeService, type ThemeDefinition } from "../services/themeService";

interface SettingsViewProps {
  setActiveTab: (tab: TabType) => void;
  theme: ThemeType;
  themeId: string;
  setTheme: (theme: string) => void;
  accounts: Account[];
  setAccounts: React.Dispatch<React.SetStateAction<Account[]>>;
  activeAccount: Account;
  setActiveAccount: (account: Account) => void;
  lang: LanguageType;
  setLang: (lang: LanguageType) => void;
  showGlow: boolean;
  setShowGlow: (v: boolean) => void;
  glowColor: string;
  setGlowColor: (v: string) => void;

  showBgImage: boolean;
  setShowBgImage: (v: boolean) => void;
  showParticles: boolean;
  setShowParticles: (v: boolean) => void;
  showCursorGlow: boolean;
  setShowCursorGlow: (v: boolean) => void;
  bgBrightness: number;
  setBgBrightness: (v: number) => void;
  bgBlur: number;
  setBgBlur: (v: number) => void;
}

type SettingsCategory = "general" | "ingame" | "themes" | "accounts";

export const SettingsView: React.FC<SettingsViewProps> = ({ 
  setActiveTab, 
  theme,
  themeId,
  setTheme,
  accounts,
  setAccounts,
  activeAccount,
  setActiveAccount,
  lang,
  setLang,
  showGlow,
  setShowGlow,
  glowColor,
  setGlowColor,

  showBgImage,
  setShowBgImage,
  showParticles,
  setShowParticles,
  showCursorGlow,
  setShowCursorGlow,
  bgBrightness,
  setBgBrightness,
  bgBlur,
  setBgBlur,
}) => {
  const t = translations[lang];
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(() => {
    // Check if we should open accounts category directly
    try {
      const saved = sessionStorage.getItem('bamboo-settings-category');
      if (saved === 'accounts' || saved === 'general' || saved === 'ingame' || saved === 'themes') {
        sessionStorage.removeItem('bamboo-settings-category');
        return saved as SettingsCategory;
      }
    } catch {}
    return "general";
  });

  // Settings State
  // General
  const [launchOnStartup, setLaunchOnStartup] = useState(false);
  const [closeOnStart, setCloseOnStart] = useState(true);
  const [ramAllocation, setRamAllocation] = useState(4096); // in MB

  // In-Game Settings (MASSIVE Minecraft Option Set!)
  // 1. Video Settings
  const [graphicsQuality, setGraphicsQuality] = useState("Fancy");
  const [renderDistance, setRenderDistance] = useState(12);
  const [simulationDistance, setSimulationDistance] = useState(10);
  const [maxFPS, setMaxFramerate] = useState(144);
  const [smoothLighting, setSmoothLighting] = useState("Maximum");
  const [smoothLightingLevel, setSmoothLightingLevel] = useState(100);
  const [vsync, setVsync] = useState(false);
  const [guiScale, setGuiScale] = useState("Auto");
  const [brightness, setBrightness] = useState(80);
  const [clouds, setClouds] = useState("Fancy");
  const [fullscreen, setFullscreen] = useState(false);
  const [mipmapLevels, setMipmapLevels] = useState("4x");
  const [entityShadows, setEntityShadows] = useState(true);
  const [distortionEffects, setDistortionEffects] = useState(100);
  const [fovEffects, setFovEffects] = useState(100);
  const [biomeBlend, setBiomeBlend] = useState("5x5");
  const [entityDistance, setEntityDistance] = useState(100);

  // 2. Audio Settings
  const [masterVolume, setMasterVolume] = useState(80);
  const [musicVolume, setMusicVolume] = useState(30);
  const [jukeboxVolume, setJukeboxVolume] = useState(40);
  const [weatherVolume, setWeatherVolume] = useState(50);
  const [blocksVolume, setBlocksVolume] = useState(60);
  const [hostileVolume, setHostileVolume] = useState(70);
  const [friendlyVolume, setFriendlyVolume] = useState(50);
  const [playersVolume, setPlayersVolume] = useState(80);
  const [ambientVolume, setAmbientVolume] = useState(60);
  const [voiceVolume, setVoiceVolume] = useState(80);
  const [directionalAudio, setDirectionalAudio] = useState(true);

  // 3. Control Settings
  const [sensitivity, setSensitivity] = useState(50);
  const [invertMouse, setInvertMouse] = useState(false);
  const [autoJump, setAutoJump] = useState(false);
  const [discreteScroll, setDiscreteScroll] = useState(true);
  const [rawInput, setRawInput] = useState(true);
  const [touchscreen, setTouchscreen] = useState(false);
  const [sneakMode, setSneakMode] = useState("Hold");
  const [sprintMode, setSprintMode] = useState("Toggle");

  // 4. Chat Settings
  const [chatVisibility, setChatVisibility] = useState("Shown");
  const [chatColors, setChatColors] = useState(true);
  const [webLinks, setWebLinks] = useState(true);
  const [promptOnLinks, setPromptOnLinks] = useState(true);
  const [chatOpacity, setChatOpacity] = useState(90);
  const [chatSize, setChatSize] = useState(100);
  const [chatLineSpacing, setChatLineSpacing] = useState(2);
  const [chatDelay, setChatDelay] = useState(0);

  // 5. Accessibility Settings
  const [narrator, setNarrator] = useState("Off");
  const [highContrast, setHighContrast] = useState(false);
  const [textBackground, setTextBackground] = useState("Chat");
  const [textScale, setTextScale] = useState(100);

  // Account creation states
  const [newUsername, setNewWorldName] = useState("");
  const [newAccountType, setNewAccountType] = useState<"Microsoft" | "Offline">("Offline");

  const [showAddAccountModal, setShowAddAccountModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [editUsername, setEditUsername] = useState("");

  // Microsoft Device Code Login
  const [showMsDeviceCodeModal, setShowMsDeviceCodeModal] = useState(false);
  const [msDeviceCode, setMsDeviceCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [msLoginStep, setMsLoginStep] = useState("");

const [showSavedToast, setShowSavedToast] = useState(false);

  // Load settings from backend on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await window.electronAPI?.getSettings?.();
        if (!settings) return;
        if (typeof settings.ramAllocation === 'number') setRamAllocation(settings.ramAllocation);
        if (typeof settings.launchOnStartup === 'boolean') setLaunchOnStartup(settings.launchOnStartup);
        if (typeof settings.closeOnStart === 'boolean') setCloseOnStart(settings.closeOnStart);
        if (typeof settings.lang === 'string') setLang(settings.lang as LanguageType);
        if (typeof settings.currentTheme === 'string') setTheme(settings.currentTheme);
        if (settings.mcOptions && typeof settings.mcOptions === 'object') {
          const o = settings.mcOptions;
          if (o.graphicsQuality) setGraphicsQuality(o.graphicsQuality);
          if (typeof o.renderDistance === 'number') setRenderDistance(o.renderDistance);
          if (typeof o.simulationDistance === 'number') setSimulationDistance(o.simulationDistance);
          if (typeof o.maxFPS === 'number') setMaxFramerate(o.maxFPS);
          if (o.smoothLighting) setSmoothLighting(o.smoothLighting);
          if (typeof o.smoothLightingLevel === 'number') setSmoothLightingLevel(o.smoothLightingLevel);
          if (typeof o.vsync === 'boolean') setVsync(o.vsync);
          if (o.guiScale) setGuiScale(o.guiScale);
          if (typeof o.brightness === 'number') setBrightness(o.brightness);
          if (o.clouds) setClouds(o.clouds);
          if (typeof o.fullscreen === 'boolean') setFullscreen(o.fullscreen);
          if (o.mipmapLevels) setMipmapLevels(o.mipmapLevels);
          if (typeof o.entityShadows === 'boolean') setEntityShadows(o.entityShadows);
          if (typeof o.distortionEffects === 'number') setDistortionEffects(o.distortionEffects);
          if (typeof o.fovEffects === 'number') setFovEffects(o.fovEffects);
          if (o.biomeBlend) setBiomeBlend(o.biomeBlend);
          if (typeof o.entityDistance === 'number') setEntityDistance(o.entityDistance);
          if (typeof o.masterVolume === 'number') setMasterVolume(o.masterVolume);
          if (typeof o.musicVolume === 'number') setMusicVolume(o.musicVolume);
          if (typeof o.jukeboxVolume === 'number') setJukeboxVolume(o.jukeboxVolume);
          if (typeof o.weatherVolume === 'number') setWeatherVolume(o.weatherVolume);
          if (typeof o.blocksVolume === 'number') setBlocksVolume(o.blocksVolume);
          if (typeof o.hostileVolume === 'number') setHostileVolume(o.hostileVolume);
          if (typeof o.friendlyVolume === 'number') setFriendlyVolume(o.friendlyVolume);
          if (typeof o.playersVolume === 'number') setPlayersVolume(o.playersVolume);
          if (typeof o.ambientVolume === 'number') setAmbientVolume(o.ambientVolume);
          if (typeof o.voiceVolume === 'number') setVoiceVolume(o.voiceVolume);
          if (typeof o.directionalAudio === 'boolean') setDirectionalAudio(o.directionalAudio);
          if (typeof o.sensitivity === 'number') setSensitivity(o.sensitivity);
          if (typeof o.invertMouse === 'boolean') setInvertMouse(o.invertMouse);
          if (typeof o.autoJump === 'boolean') setAutoJump(o.autoJump);
          if (typeof o.discreteScroll === 'boolean') setDiscreteScroll(o.discreteScroll);
          if (typeof o.rawInput === 'boolean') setRawInput(o.rawInput);
          if (typeof o.touchscreen === 'boolean') setTouchscreen(o.touchscreen);
          if (o.sneakMode) setSneakMode(o.sneakMode);
          if (o.sprintMode) setSprintMode(o.sprintMode);
          if (o.chatVisibility) setChatVisibility(o.chatVisibility);
          if (typeof o.chatColors === 'boolean') setChatColors(o.chatColors);
          if (typeof o.webLinks === 'boolean') setWebLinks(o.webLinks);
          if (typeof o.promptOnLinks === 'boolean') setPromptOnLinks(o.promptOnLinks);
          if (typeof o.chatOpacity === 'number') setChatOpacity(o.chatOpacity);
          if (typeof o.chatSize === 'number') setChatSize(o.chatSize);
          if (typeof o.chatLineSpacing === 'number') setChatLineSpacing(o.chatLineSpacing);
          if (typeof o.chatDelay === 'number') setChatDelay(o.chatDelay);
          if (o.narrator) setNarrator(o.narrator);
          if (typeof o.highContrast === 'boolean') setHighContrast(o.highContrast);
          if (o.textBackground) setTextBackground(o.textBackground);
          if (typeof o.textScale === 'number') setTextScale(o.textScale);
        }
      } catch { console.warn('[Settings] Failed to load settings'); }
    };
    loadSettings();
  }, []);

  const handleSave = () => {
    window.electronAPI?.saveSettings?.({
      defaultRam: ramAllocation,
      accounts,
      currentTheme: theme,
      ramAllocation,
      launchOnStartup,
      closeOnStart,
      lang,
      mcOptions: {
        graphicsQuality, renderDistance, simulationDistance, maxFPS,
        smoothLighting, smoothLightingLevel, vsync, guiScale, brightness, clouds, fullscreen,
        mipmapLevels, entityShadows, distortionEffects, fovEffects, biomeBlend, entityDistance,
        masterVolume, musicVolume, jukeboxVolume, weatherVolume, blocksVolume,
        hostileVolume, friendlyVolume, playersVolume, ambientVolume, voiceVolume, directionalAudio,
        sensitivity, invertMouse, autoJump, discreteScroll, rawInput, touchscreen, sneakMode, sprintMode,
        chatVisibility, chatColors, webLinks, promptOnLinks, chatOpacity, chatSize, chatLineSpacing, chatDelay,
        narrator, highContrast, textBackground, textScale,
      },
    });
    setShowSavedToast(true);
    setTimeout(() => setShowSavedToast(false), 3000);
  };

  const handleAddAccount = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim()) return;

    const newAcc: Account = {
      id: `acc_${Date.now()}`,
      username: newUsername,
      type: "Offline",
      avatar: "https://minotar.net/avatar/MHF_Steve",
      online: false
    };

    const updatedAccounts = [...accounts, newAcc];
    setAccounts(updatedAccounts);
    // Auto-select first account if this is the only one
    if (updatedAccounts.length === 1) {
      setActiveAccount(newAcc);
    }
    setShowAddAccountModal(false);
    setNewWorldName("");
    setNewAccountType("Offline");
  };

  const handleDeleteAccount = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const filtered = accounts.filter(acc => acc.id !== id);
    setAccounts(filtered);
    if (activeAccount.id === id) {
      // Wenn der aktive Account gelöscht wird, auf leeren Account zurücksetzen
      setActiveAccount({ id: "", username: "", type: "Offline", avatar: "", online: false });
    }
  };

  const handleStartRename = (acc: Account, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingAccount(acc);
    setEditUsername(acc.username);
  };

  const handleSaveRename = () => {
    if (!editUsername.trim() || !editingAccount) return;
    setAccounts(prev => prev.map(acc => {
      if (acc.id === editingAccount.id) {
        const updated = { ...acc, username: editUsername };
        if (activeAccount.id === acc.id) {
          setActiveAccount(updated);
        }
        return updated;
      }
      return acc;
    }));
    setEditingAccount(null);
  };

  // Microsoft Device Code Login
  const handleStartMicrosoftLogin = () => {
    window.electronAPI?.startMicrosoftLogin?.();
    setMsLoginStep("Starting Microsoft login...");
    setShowMsDeviceCodeModal(true);
  };

  useEffect(() => {
    const unsubDeviceCode = window.electronAPI?.onMsDeviceCode?.((data) => {
      setMsDeviceCode(data);
      setMsLoginStep("Please complete the verification in your browser.");
    });
    const unsubLoginStep = window.electronAPI?.onMsLoginStep?.((step) => {
      setMsLoginStep(step);
    });
    const unsubLoginResult = window.electronAPI?.onMsLoginResult?.((result) => {
      setShowMsDeviceCodeModal(false);
      setMsDeviceCode(null);
      setMsLoginStep("");
      if (result.success && result.name) {
        const newAcc: Account = {
          id: `acc_ms_${Date.now()}`,
          username: result.name,
          type: "Microsoft",
          avatar: `https://minotar.net/avatar/${result.uuid || result.name}`,
          online: true,
          uuid: result.uuid,
        };
        setAccounts(prev => {
          const updated = [...prev, newAcc];
          // Auto-select first account if this is the only one
          if (updated.length === 1) {
            setActiveAccount(newAcc);
          }
          return updated;
        });
      }
    });
    return () => {
      unsubDeviceCode?.();
      unsubLoginStep?.();
      unsubLoginResult?.();
    };
  }, []);

  // Force re-render when theme service notifies of new themes loaded
  const [themeVersion, setThemeVersion] = useState(0);

  // Theme selector - loaded from ThemeService (data-driven, CDN-backed)
  // Uses useMemo to rebuild theme list when themes change or language changes
  const themesList = useMemo(() => buildThemeList(themeService.getThemes(), lang), [themeVersion, lang]);

  // Subscribe to theme service updates
  useEffect(() => {
    const unsub = themeService.subscribe(() => {
      setThemeVersion(v => v + 1);
    });
    return unsub;
  }, []);

  // Load CDN themes + backend themes on mount
  useEffect(() => {
    Promise.all([
      themeService.loadCdnThemes(),
      themeService.loadBackendThemes(),
    ]).then(() => {
      setThemeVersion(v => v + 1);
    });
  }, []);

  // Re-fetch backend themes whenever user opens the themes category
  // This ensures newly created admin themes show up without restart
  useEffect(() => {
    if (activeCategory === "themes") {
      themeService.refreshAllThemes().then(() => {
        setThemeVersion(v => v + 1);
      });
    }
  }, [activeCategory]);

  // Helper: build display-ready theme list from ThemeDefinitions
  function buildThemeList(themes: ThemeDefinition[], _currentLang: LanguageType) {
    // Derive a semi-transparent bg style from the accent color for Tailwind
    // Since we can't use dynamic Tailwind classes, use a neutral fallback
    return themes.map((t) => ({
      ...t,
      accent: t.accentLabel || t.name,
      accentColor: t.accent,
      accentText: "theme-text",
      bgStyle: "border-transparent",
      badge: "theme-bg-md theme-text theme-border-md",
    }));
  }

  // Theme helper – nutzt CSS-Variablen statt hardcodierter Theme-Farben
  const themeAccent = {
    text: "theme-text",
    border: "theme-border-md",
    bg: "theme-bg-light",
    button: "theme-bg hover:theme-bg-hover text-slate-950",
    accentColor: "accent-[var(--theme-accent)]",
    slider: "accent-[var(--theme-accent)]"
  };

  return (
    <div className="flex-1 overflow-y-auto h-full p-6 flex flex-col gap-6 custom-scrollbar z-10 relative select-none">
      
      {/* Header Panel */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-6 shadow-2xl">
        <div className="flex items-center gap-4">
          <div>
            <h2 className="text-2xl font-black text-white tracking-wide flex items-center gap-2">
              {t.clientSettingsTitle}
            </h2>
            <p className="text-xs text-slate-400 mt-1">{t.clientSettingsDesc}</p>
          </div>
        </div>

      </div>

      {/* Main Settings Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch flex-1">
        
        {/* Left Side: Settings Categories */}
        <div className="lg:col-span-3 flex flex-col gap-2 bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-4 shadow-2xl shrink-0 h-fit">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest px-3 mb-2 text-left block">Categories</span>
          
          <button
            onClick={() => setActiveCategory("general")}
            className={`flex items-center gap-3 px-4 py-3.5 rounded-xl text-xs font-black tracking-wide transition-all cursor-pointer text-left ${
              activeCategory === "general"
                ? `${themeAccent.bg} ${themeAccent.text} border ${themeAccent.border}`
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 border border-transparent"
            }`}
          >
            <Cpu className="w-4 h-4" />
            {t.generalAndRam}
          </button>

          <button
            onClick={() => setActiveCategory("ingame")}
            className={`flex items-center gap-3 px-4 py-3.5 rounded-xl text-xs font-black tracking-wide transition-all cursor-pointer text-left ${
              activeCategory === "ingame"
                ? `${themeAccent.bg} ${themeAccent.text} border ${themeAccent.border}`
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 border border-transparent"
            }`}
          >
            <Sliders className="w-4 h-4" />
            {t.inGameSettings}
          </button>

          <button
            onClick={() => setActiveCategory("themes")}
            className={`flex items-center gap-3 px-4 py-3.5 rounded-xl text-xs font-black tracking-wide transition-all cursor-pointer text-left ${
              activeCategory === "themes"
                ? `${themeAccent.bg} ${themeAccent.text} border ${themeAccent.border}`
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 border border-transparent"
            }`}
          >
            <Palette className="w-4 h-4" />
            {t.launcherThemes}
          </button>

          <button
            onClick={() => setActiveCategory("accounts")}
            className={`flex items-center gap-3 px-4 py-3.5 rounded-xl text-xs font-black tracking-wide transition-all cursor-pointer text-left ${
              activeCategory === "accounts"
                ? `${themeAccent.bg} ${themeAccent.text} border ${themeAccent.border}`
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 border border-transparent"
            }`}
          >
            <Users className="w-4 h-4" />
            {t.manageAccounts}
          </button>
        </div>

        {/* Right Side: Settings Panel Detail */}
        <div className="lg:col-span-9 bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-6 shadow-2xl flex flex-col justify-between text-left min-h-[480px]">
          
          <div className="flex flex-col gap-6 overflow-y-auto max-h-[500px] custom-scrollbar pr-2">
            
            {/* 1. GENERAL CATEGORY */}
            {activeCategory === "general" && (
              <div className="flex flex-col gap-5">
                <h3 className="text-sm font-black text-slate-100 uppercase tracking-wider border-b border-slate-900 pb-3">{t.generalAndRam}</h3>
                
                {/* Launch on startup */}
                <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                  <div>
                    <span className="block text-xs font-bold text-slate-200">{t.launchOnStartup}</span>
                    <span className="text-[10px] text-slate-400 mt-1 block leading-normal">{t.launchOnStartupDesc}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLaunchOnStartup(!launchOnStartup)}
                    className={`w-11 h-6 rounded-full p-0.5 transition-colors duration-300 cursor-pointer ${
                      launchOnStartup ? "theme-bg" : "bg-slate-800"
                    }`}
                  >
                    <div
                      className="w-5 h-5 rounded-full bg-slate-950 shadow-md transform transition-transform duration-300"
                      style={{ transform: launchOnStartup ? "translateX(20px)" : "translateX(0)" }}
                    />
                  </button>
                </div>

                {/* Close on start */}
                <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                  <div>
                    <span className="block text-xs font-bold text-slate-200">{t.closeLauncherOnStart}</span>
                    <span className="text-[10px] text-slate-400 mt-1 block leading-normal">{t.closeLauncherOnStartDesc}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCloseOnStart(!closeOnStart)}
                    className={`w-11 h-6 rounded-full p-0.5 transition-colors duration-300 cursor-pointer ${
                      closeOnStart ? "theme-bg" : "bg-slate-800"
                    }`}
                  >
                    <div
                      className="w-5 h-5 rounded-full bg-slate-950 shadow-md transform transition-transform duration-300"
                      style={{ transform: closeOnStart ? "translateX(20px)" : "translateX(0)" }}
                    />
                  </button>
                </div>

                {/* Language Select (Requirement 7!) */}
                <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                  <div>
                    <span className="block text-xs font-bold text-slate-200">{t.clientLanguage}</span>
                    <span className="text-[10px] text-slate-400 mt-1 block leading-normal">{t.clientLanguageDesc}</span>
                  </div>
                  <select
                    value={lang}
                    onChange={(e) => setLang(e.target.value as any)}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-xs font-bold text-slate-200 outline-none focus:theme-border"
                  >
                    <option value="en">English (US)</option>
                    <option value="de">Deutsch</option>
                  </select>
                </div>

                {/* RAM Allocator */}
                <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="block text-xs font-bold text-slate-200">{t.systemRamAllocation}</span>
                      <span className="text-[10px] text-slate-400 mt-1 block leading-normal">{t.systemRamAllocationDesc}</span>
                    </div>
                    <span className={`text-sm font-black ${themeAccent.text} font-mono bg-slate-950/60 border border-slate-800 px-3 py-1.5 rounded-xl`}>
                      {ramAllocation.toLocaleString()} MB
                    </span>
                  </div>

                  <input
                    type="range"
                    min={1024}
                    max={16384}
                    step={512}
                    value={ramAllocation}
                    onChange={(e) => setRamAllocation(parseInt(e.target.value))}
                    className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer mt-2`}
                  />

                  <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono mt-1">
                    <span>{t.minRam}</span>
                    <span>{t.recommendedRam}</span>
                    <span>{t.maxRam}</span>
                  </div>

                  {/* RAM warnings */}
                  {ramAllocation < 2048 && (
                    <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl flex gap-2.5 items-start mt-2">
                      <AlertTriangle className="w-4.5 h-4.5 text-amber-400 shrink-0 mt-0.5" />
                      <span className="text-[10px] text-amber-300 leading-normal font-medium">
                        {t.ramWarningLow}
                      </span>
                    </div>
                  )}

                  {ramAllocation > 12288 && (
                    <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl flex gap-2.5 items-start mt-2">
                      <AlertTriangle className="w-4.5 h-4.5 text-rose-400 shrink-0 mt-0.5" />
                      <span className="text-[10px] text-rose-300 leading-normal font-medium">
                        {t.ramWarningHigh}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 2. COMBINED IN-GAME SETTINGS */}
            {activeCategory === "ingame" && (
              <div className="flex flex-col gap-8">
                <h3 className="text-sm font-black text-slate-100 uppercase tracking-wider border-b border-slate-900 pb-3">{t.inGameSettings}</h3>
                
                {/* 2.1 VIDEO SETTINGS */}
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-widest border-l-2 theme-border pl-2">
                    <Monitor className={`w-4 h-4 ${themeAccent.text}`} />
                    {t.videoSettings}
                  </div>

                  {/* Graphics Quality */}
                  <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                    <div>
                      <span className="block text-xs font-bold text-slate-200">{t.graphicsQualityLabel}</span>
                      <span className="text-[10px] text-slate-400 mt-1 block leading-normal">{t.graphicsQualityDesc}</span>
                    </div>
                    <div className="flex gap-1.5">
                      {["Fast", "Fancy", "Fabulous!"].map((q) => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => setGraphicsQuality(q)}
                          className={`px-3 py-1.5 rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                            graphicsQuality === q
                              ? `${themeAccent.bg} ${themeAccent.text} ${themeAccent.border}`
                              : "bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200 hover:border-slate-700"
                          }`}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Render & Simulation Distance Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Render Distance */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.renderDistanceLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{renderDistance} Chunks</span>
                      </div>
                      <input
                        type="range"
                        min={2}
                        max={32}
                        value={renderDistance}
                        onChange={(e) => setRenderDistance(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer mt-1`}
                      />
                    </div>

                    {/* Simulation Distance */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.simulationDistanceLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{simulationDistance} Chunks</span>
                      </div>
                      <input
                        type="range"
                        min={2}
                        max={32}
                        value={simulationDistance}
                        onChange={(e) => setSimulationDistance(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer mt-1`}
                      />
                    </div>
                  </div>

                  {/* Max Framerate & Smooth Lighting Levels */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Max FPS */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.maxFpsLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{maxFPS === 260 ? "Unlimited" : `${maxFPS} FPS`}</span>
                      </div>
                      <input
                        type="range"
                        min={30}
                        max={260}
                        step={10}
                        value={maxFPS}
                        onChange={(e) => setMaxFramerate(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer mt-1`}
                      />
                    </div>

                    {/* Smooth Lighting Level */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">Smooth Lighting Level</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{smoothLightingLevel}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={smoothLightingLevel}
                        onChange={(e) => setSmoothLightingLevel(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer mt-1`}
                      />
                    </div>
                  </div>

                  {/* Option Grid for Selects/Toggles */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Smooth Lighting */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.smoothLightingLabel}</span>
                      <select
                        value={smoothLighting}
                        onChange={(e) => setSmoothLighting(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-200 outline-none"
                      >
                        <option value="Off">Off</option>
                        <option value="Minimum">Minimum</option>
                        <option value="Maximum">Maximum</option>
                      </select>
                    </div>

                    {/* V-Sync */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.vsyncLabel}</span>
                      <button
                        type="button"
                        onClick={() => setVsync(!vsync)}
                        className={`px-4 py-1.5 rounded-xl border text-xs font-bold transition-all ${
                          vsync ? "theme-bg-light theme-text theme-border-light" : "bg-slate-950 text-slate-500 border-slate-800"
                        }`}
                      >
                        {vsync ? "ON" : "OFF"}
                      </button>
                    </div>

                    {/* GUI Scale */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.guiScaleLabel}</span>
                      <select
                        value={guiScale}
                        onChange={(e) => setGuiScale(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-200 outline-none"
                      >
                        <option value="Auto">Auto</option>
                        <option value="1x">1x</option>
                        <option value="2x">2x</option>
                        <option value="3x">3x</option>
                        <option value="4x">4x</option>
                      </select>
                    </div>

                    {/* Brightness */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.brightnessLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{brightness === 100 ? "Bright" : brightness === 0 ? "Moody" : `${brightness}%`}</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={brightness}
                        onChange={(e) => setBrightness(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer mt-1`}
                      />
                    </div>

                    {/* Clouds */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.cloudsLabel}</span>
                      <select
                        value={clouds}
                        onChange={(e) => setClouds(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-200 outline-none"
                      >
                        <option value="Off">Off</option>
                        <option value="Fast">Fast</option>
                        <option value="Fancy">Fancy</option>
                      </select>
                    </div>

                    {/* Fullscreen */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.fullscreenLabel}</span>
                      <button
                        type="button"
                        onClick={() => setFullscreen(!fullscreen)}
                        className={`px-4 py-1.5 rounded-xl border text-xs font-bold transition-all ${
                          fullscreen ? "theme-bg-light theme-text theme-border-light" : "bg-slate-950 text-slate-500 border-slate-800"
                        }`}
                      >
                        {fullscreen ? "ON" : "OFF"}
                      </button>
                    </div>

                    {/* Mipmap Levels */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.mipmapLabel}</span>
                      <select
                        value={mipmapLevels}
                        onChange={(e) => setMipmapLevels(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-200 outline-none"
                      >
                        <option value="Off">Off</option>
                        <option value="1x">1x</option>
                        <option value="2x">2x</option>
                        <option value="3x">3x</option>
                        <option value="4x">4x</option>
                      </select>
                    </div>

                    {/* Entity Shadows */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.entityShadowsLabel}</span>
                      <button
                        type="button"
                        onClick={() => setEntityShadows(!entityShadows)}
                        className={`px-4 py-1.5 rounded-xl border text-xs font-bold transition-all ${
                          entityShadows ? "theme-bg-light theme-text theme-border-light" : "bg-slate-950 text-slate-500 border-slate-800"
                        }`}
                      >
                        {entityShadows ? "ON" : "OFF"}
                      </button>
                    </div>

                    {/* Distortion Effects Slider */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.distortionLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{distortionEffects}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={distortionEffects}
                        onChange={(e) => setDistortionEffects(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer mt-1`}
                      />
                    </div>

                    {/* FOV Effects Slider */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.fovEffectsLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{fovEffects}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={fovEffects}
                        onChange={(e) => setFovEffects(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer mt-1`}
                      />
                    </div>

                    {/* Biome Blend */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.biomeBlendLabel}</span>
                      <select
                        value={biomeBlend}
                        onChange={(e) => setBiomeBlend(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-200 outline-none"
                      >
                        <option value="Off">Off (Fastest)</option>
                        <option value="3x3">3x3 (Fast)</option>
                        <option value="5x5">5x5 (Normal)</option>
                        <option value="9x9">9x9 (Fancy)</option>
                        <option value="15x15">15x15 (Maximum)</option>
                      </select>
                    </div>

                    {/* Entity Distance */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.entityDistanceLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{entityDistance}%</span>
                      </div>
                      <input
                        type="range"
                        min={50}
                        max={500}
                        step={50}
                        value={entityDistance}
                        onChange={(e) => setEntityDistance(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer mt-1`}
                      />
                    </div>
                  </div>
                </div>

                {/* 2.2 AUDIO MIXER SETTINGS */}
                <div className="flex flex-col gap-4 mt-4">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-widest border-l-2 theme-border pl-2">
                    <Volume2 className={`w-4 h-4 ${themeAccent.text}`} />
                    {t.audioMixer}
                  </div>

                  {/* Volume Sliders Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Master Volume */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.masterVolumeLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{masterVolume}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={masterVolume}
                        onChange={(e) => setMasterVolume(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer`}
                      />
                    </div>

                    {/* Music Volume */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.musicVolumeLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{musicVolume}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={musicVolume}
                        onChange={(e) => setMusicVolume(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer`}
                      />
                    </div>

                    {/* Jukebox/Note Blocks */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.jukeboxVolumeLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{jukeboxVolume}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={jukeboxVolume}
                        onChange={(e) => setJukeboxVolume(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer`}
                      />
                    </div>

                    {/* Weather */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.weatherVolumeLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{weatherVolume}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={weatherVolume}
                        onChange={(e) => setWeatherVolume(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer`}
                      />
                    </div>

                    {/* Blocks */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.blocksVolumeLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{blocksVolume}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={blocksVolume}
                        onChange={(e) => setBlocksVolume(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer`}
                      />
                    </div>

                    {/* Hostile Creatures */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.hostileVolumeLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{hostileVolume}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={hostileVolume}
                        onChange={(e) => setHostileVolume(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer`}
                      />
                    </div>

                    {/* Friendly Creatures */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.friendlyVolumeLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{friendlyVolume}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={friendlyVolume}
                        onChange={(e) => setFriendlyVolume(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer`}
                      />
                    </div>

                    {/* Players Volume */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.playersVolumeLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{playersVolume}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={playersVolume}
                        onChange={(e) => setPlayersVolume(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer`}
                      />
                    </div>

                    {/* Ambient / Environment */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.ambientVolumeLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{ambientVolume}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={ambientVolume}
                        onChange={(e) => setAmbientVolume(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer`}
                      />
                    </div>

                    {/* Directional Audio */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <div>
                        <span className="block text-xs font-bold text-slate-200">{t.directionalAudioLabel}</span>
                        <span className="text-[10px] text-slate-400 mt-1 block leading-normal">{t.directionalAudioDesc}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDirectionalAudio(!directionalAudio)}
                        className={`px-4 py-1.5 rounded-xl border text-xs font-bold transition-all ${
                          directionalAudio ? "theme-bg-light theme-text theme-border-light" : "bg-slate-950 text-slate-500 border-slate-800"
                        }`}
                      >
                        {directionalAudio ? "ON" : "OFF"}
                      </button>
                    </div>
                  </div>
                </div>

                {/* 2.3 CONTROL BINDINGS */}
                <div className="flex flex-col gap-4 mt-4">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-widest border-l-2 theme-border pl-2">
                    <Gamepad2 className={`w-4 h-4 ${themeAccent.text}`} />
                    {t.mouseSensitivityLabel}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Mouse Sensitivity */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.mouseSensitivityLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{sensitivity}%</span>
                      </div>
                      <input
                        type="range"
                        min={10}
                        max={150}
                        value={sensitivity}
                        onChange={(e) => setSensitivity(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer`}
                      />
                    </div>

                    {/* Invert Mouse */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.invertMouseLabel}</span>
                      <button
                        type="button"
                        onClick={() => setInvertMouse(!invertMouse)}
                        className={`px-4 py-1.5 rounded-xl border text-xs font-bold transition-all ${
                          invertMouse ? "theme-bg-light theme-text theme-border-light" : "bg-slate-950 text-slate-500 border-slate-800"
                        }`}
                      >
                        {invertMouse ? "ON" : "OFF"}
                      </button>
                    </div>

                    {/* Auto Jump */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.autoJumpLabel}</span>
                      <button
                        type="button"
                        onClick={() => setAutoJump(!autoJump)}
                        className={`px-4 py-1.5 rounded-xl border text-xs font-bold transition-all ${
                          autoJump ? "theme-bg-light theme-text theme-border-light" : "bg-slate-950 text-slate-500 border-slate-800"
                        }`}
                      >
                        {autoJump ? "ON" : "OFF"}
                      </button>
                    </div>

                    {/* Raw Input */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.rawInputLabel}</span>
                      <button
                        type="button"
                        onClick={() => setRawInput(!rawInput)}
                        className={`px-4 py-1.5 rounded-xl border text-xs font-bold transition-all ${
                          rawInput ? "theme-bg-light theme-text theme-border-light" : "bg-slate-950 text-slate-500 border-slate-800"
                        }`}
                      >
                        {rawInput ? "ON" : "OFF"}
                      </button>
                    </div>

                    {/* Sneak Mode */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.sneakModeLabel}</span>
                      <select
                        value={sneakMode}
                        onChange={(e) => setSneakMode(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-200 outline-none"
                      >
                        <option value="Hold">Hold Key</option>
                        <option value="Toggle">Toggle Mode</option>
                      </select>
                    </div>

                    {/* Sprint Mode */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.sprintModeLabel}</span>
                      <select
                        value={sprintMode}
                        onChange={(e) => setSprintMode(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-200 outline-none"
                      >
                        <option value="Hold">Hold Key</option>
                        <option value="Toggle">Toggle Mode</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* 2.4 CHAT SETTINGS */}
                <div className="flex flex-col gap-4 mt-4">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-widest border-l-2 theme-border pl-2">
                    <MessageSquare className={`w-4 h-4 ${themeAccent.text}`} />
                    {t.chatSettings}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Chat Visibility */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.chatVisibilityLabel}</span>
                      <select
                        value={chatVisibility}
                        onChange={(e) => setChatVisibility(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-200 outline-none"
                      >
                        <option value="Shown">Shown (All)</option>
                        <option value="Commands">Commands Only</option>
                        <option value="Hidden">Hidden</option>
                      </select>
                    </div>

                    {/* Chat Colors */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.chatColorsLabel}</span>
                      <button
                        type="button"
                        onClick={() => setChatColors(!chatColors)}
                        className={`px-4 py-1.5 rounded-xl border text-xs font-bold transition-all ${
                          chatColors ? "theme-bg-light theme-text theme-border-light" : "bg-slate-950 text-slate-500 border-slate-800"
                        }`}
                      >
                        {chatColors ? "ON" : "OFF"}
                      </button>
                    </div>

                    {/* Chat Opacity */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.chatOpacityLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{chatOpacity}%</span>
                      </div>
                      <input
                        type="range"
                        min={10}
                        max={100}
                        value={chatOpacity}
                        onChange={(e) => setChatOpacity(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer`}
                      />
                    </div>

                    {/* Chat Text Size */}
                    <div className="bg-slate-900/20 border border-slate-850 p-4 rounded-2xl flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{t.chatSizeLabel}</span>
                        <span className={`text-xs font-mono font-black ${themeAccent.text}`}>{chatSize}%</span>
                      </div>
                      <input
                        type="range"
                        min={50}
                        max={150}
                        value={chatSize}
                        onChange={(e) => setChatSize(parseInt(e.target.value))}
                        className={`w-full ${themeAccent.slider} bg-slate-950 h-1.5 rounded-lg cursor-pointer`}
                      />
                    </div>
                  </div>
                </div>

                {/* 2.5 ACCESSIBILITY OPTIONS */}
                <div className="flex flex-col gap-4 mt-4">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-widest border-l-2 theme-border pl-2">
                    <Accessibility className={`w-4 h-4 ${themeAccent.text}`} />
                    {t.accessibilityOptions}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Narrator */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.narratorLabel}</span>
                      <select
                        value={narrator}
                        onChange={(e) => setNarrator(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-200 outline-none"
                      >
                        <option value="Off">Narrator: Off</option>
                        <option value="Chat">Narrator: Chat</option>
                        <option value="System">Narrator: System</option>
                      </select>
                    </div>

                    {/* High Contrast */}
                    <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                      <span className="text-xs font-bold text-slate-200">{t.highContrastLabel}</span>
                      <button
                        type="button"
                        onClick={() => setHighContrast(!highContrast)}
                        className={`px-4 py-1.5 rounded-xl border text-xs font-bold transition-all ${
                          highContrast ? "theme-bg-light theme-text theme-border-light" : "bg-slate-950 text-slate-500 border-slate-800"
                        }`}
                      >
                        {highContrast ? "ON" : "OFF"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 3. THEMES CATEGORY */}
            {activeCategory === "themes" && (
              <div className="flex flex-col gap-5">
                <div className="flex items-center justify-between border-b border-slate-900 pb-3">
                  <h3 className="text-sm font-black text-slate-100 uppercase tracking-wider">{t.launcherThemes}</h3>
                  <button
                    type="button"
                    onClick={() => {
                      themeService.refreshAllThemes().then(() => {
                        setThemeVersion(v => v + 1);
                      });
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-800 bg-slate-900/40 hover:bg-slate-800/60 text-slate-400 hover:text-slate-200 text-[10px] font-bold transition-all cursor-pointer"
                  >
                    Aktualisieren
                  </button>
                </div>
                <p className="text-xs text-slate-400 leading-normal">Select a launcher aesthetic theme. Changing themes instantly updates the background image, accent colors, glowing indicators, and particle configurations globally.</p>

                {/* Background Options — compact accordion panel */}
                <details className="group bg-slate-900/15 border border-slate-800/40 rounded-2xl overflow-hidden">
                  <summary className="flex items-center justify-between p-3.5 cursor-pointer text-xs font-bold text-slate-300 hover:text-slate-100 transition-colors select-none list-none">
                    <div className="flex items-center gap-2">
                      <svg className="w-4 h-4 text-slate-500 group-open:rotate-90 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                      Hintergrund-Optionen
                    </div>
                    <span className="text-[10px] text-slate-500">Helligkeit · Unschärfe · Toggles</span>
                  </summary>
                  <div className="px-3.5 pb-3.5 flex flex-col gap-2.5">
                    {/* Row 1: 4 toggles inline */}
                    <div className="grid grid-cols-4 gap-2">
                      {/* Show/hide background image */}
                      <div className="flex flex-col items-center gap-1.5 bg-slate-900/30 border border-slate-800/40 rounded-xl p-2.5">
                        <span className="text-[10px] font-bold text-slate-400 text-center leading-tight">Bild</span>
                        <button type="button" onClick={() => setShowBgImage(!showBgImage)} className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-300 cursor-pointer shrink-0 ${showBgImage ? "theme-bg" : "bg-slate-800"}`}>
                          <div className="w-4 h-4 rounded-full bg-slate-950 shadow-md transform transition-transform duration-300" style={{ transform: showBgImage ? "translateX(14px)" : "translateX(0)" }} />
                        </button>
                      </div>
                      {/* Show/hide particles */}
                      <div className="flex flex-col items-center gap-1.5 bg-slate-900/30 border border-slate-800/40 rounded-xl p-2.5">
                        <span className="text-[10px] font-bold text-slate-400 text-center leading-tight">Partikel</span>
                        <button type="button" onClick={() => setShowParticles(!showParticles)} className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-300 cursor-pointer shrink-0 ${showParticles ? "theme-bg" : "bg-slate-800"}`}>
                          <div className="w-4 h-4 rounded-full bg-slate-950 shadow-md transform transition-transform duration-300" style={{ transform: showParticles ? "translateX(14px)" : "translateX(0)" }} />
                        </button>
                      </div>
                      {/* Show/hide cursor glow */}
                      <div className="flex flex-col items-center gap-1.5 bg-slate-900/30 border border-slate-800/40 rounded-xl p-2.5">
                        <span className="text-[10px] font-bold text-slate-400 text-center leading-tight">Cursor</span>
                        <button type="button" onClick={() => setShowCursorGlow(!showCursorGlow)} className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-300 cursor-pointer shrink-0 ${showCursorGlow ? "theme-bg" : "bg-slate-800"}`}>
                          <div className="w-4 h-4 rounded-full bg-slate-950 shadow-md transform transition-transform duration-300" style={{ transform: showCursorGlow ? "translateX(14px)" : "translateX(0)" }} />
                        </button>
                      </div>
                      {/* Glow toggle + color picker */}
                      <div className="flex flex-col items-center gap-1 bg-slate-900/30 border border-slate-800/40 rounded-xl p-2">
                        <span className="text-[10px] font-bold text-slate-400 text-center leading-tight">Glow</span>
                        <button type="button" onClick={() => setShowGlow(!showGlow)} className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-300 cursor-pointer shrink-0 ${showGlow ? "theme-bg" : "bg-slate-800"}`}>
                          <div className="w-4 h-4 rounded-full bg-slate-950 shadow-md transform transition-transform duration-300" style={{ transform: showGlow ? "translateX(14px)" : "translateX(0)" }} />
                        </button>
                        <div className="flex items-center gap-1 mt-1">
                            <input type="color" value={glowColor} onChange={(e) => setGlowColor(e.target.value)} className="w-7 h-7 rounded-md cursor-pointer border border-slate-700/50 bg-transparent p-0" />
                            <button
                              type="button"
                              onClick={() => setGlowColor("")}
                              className="w-4 h-4 rounded bg-slate-800 border border-slate-600/50 hover:border-slate-400 transition-colors duration-150 shrink-0 flex items-center justify-center text-[8px] text-slate-500 hover:text-slate-300"
                              title="Standard-Blau"
                            >R</button>
                          </div>
                      </div>
                    </div>


                    {/* Row 2: Brightness + Blur sliders side by side */}
                    <div className="grid grid-cols-2 gap-2.5">
                      <div className="bg-slate-900/30 border border-slate-800/40 rounded-xl p-2.5 flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-slate-400">Helligkeit</span>
                          <span className="text-[10px] font-mono font-black theme-text">{bgBrightness}%</span>
                        </div>
                        <input type="range" min={5} max={100} value={bgBrightness} onChange={(e) => setBgBrightness(parseInt(e.target.value))} className="w-full accent-[var(--theme-accent)] bg-slate-950 h-1 rounded-lg cursor-pointer" />
                      </div>
                      {/* Blur */}
                      <div className="bg-slate-900/30 border border-slate-800/40 rounded-xl p-2.5 flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-slate-400">Unschärfe</span>
                          <span className="text-[10px] font-mono font-black theme-text">{bgBlur > 0 ? `${bgBlur}px` : "Aus"}</span>
                        </div>
                        <input type="range" min={0} max={20} value={bgBlur} onChange={(e) => setBgBlur(parseInt(e.target.value))} className="w-full accent-[var(--theme-accent)] bg-slate-950 h-1 rounded-lg cursor-pointer" />
                      </div>
                    </div>
                  </div>
                </details>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {themesList.map((t) => {
                    const isSelected = themeId === t.id;
                    return (
                      <div
                        key={t.id}
                        onClick={() => setTheme(t.id)}
                        className={`group relative rounded-2xl p-3 border cursor-pointer transition-all duration-300 flex flex-col justify-between min-h-[90px] ${
                          isSelected 
                            ? `${t.bgStyle} shadow-xl scale-[1.01]` 
                            : "border-slate-850 bg-slate-900/20 hover:border-slate-700"
                        }`}
                      style={isSelected ? { background: `linear-gradient(135deg, ${t.accentColor}22, ${t.accentColor}11)`, borderColor: t.accentColor + '44' } : {}}
                      >
                        <div className="flex items-start justify-between">
                          <h4 className="text-sm font-black text-slate-100 tracking-wide">{t.name}</h4>
                          {isSelected ? (
                            <div className="w-5 h-5 rounded-full theme-bg text-slate-950 flex items-center justify-center shadow-lg">
                              <Check className="w-3.5 h-3.5 stroke-[3]" />
                            </div>
                          ) : (
                            <div className="w-5 h-5 rounded-full bg-slate-950 border flex items-center justify-center text-slate-500 group-hover:text-slate-300 transition-colors" style={{borderColor: t.accentColor + '44'}} />
                          )}
                        </div>

                        <p className="text-[10px] text-slate-400 leading-relaxed mt-1.5">{t.desc}</p>

                        <div className="mt-2 pt-1.5 border-t border-slate-900/60 flex items-center justify-between text-[8px] font-bold text-slate-500">
                          <span>Accent: <strong className={t.accentText}>{t.accent}</strong> <span className="inline-block w-3 h-3 rounded-full align-middle" style={{ backgroundColor: t.accentColor }}></span></span>
                          <span className="uppercase tracking-widest">Select Theme</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 4. ACCOUNTS CATEGORY */}
            {activeCategory === "accounts" && (
              <div className="flex flex-col gap-5">
                <div className="flex items-center justify-between border-b border-slate-900 pb-3">
                  <h3 className="text-sm font-black text-slate-100 uppercase tracking-wider">{t.manageAccounts}</h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleStartMicrosoftLogin}
                      className="bg-sky-500 hover:bg-sky-400 text-slate-950 px-4 py-2 rounded-xl text-xs font-black tracking-wide flex items-center gap-1.5 cursor-pointer shadow-lg shadow-sky-500/10"
                    >
                      <Lock className="w-4 h-4 stroke-[3]" />
                      Microsoft-Konto
                    </button>
                    <button
                      onClick={() => setShowAddAccountModal(true)}
                      className="theme-bg hover:theme-bg-hover text-slate-950 px-4 py-2 rounded-xl text-xs font-black tracking-wide flex items-center gap-1.5 cursor-pointer theme-shadow-lg"
                    >
                      <Plus className="w-4 h-4 stroke-[3]" />
                      {t.addAccount}
                    </button>
                  </div>
                </div>

                <p className="text-xs text-slate-400 leading-normal">{t.addAccountDesc}</p>

                {/* Accounts List */}
                <div className="flex flex-col gap-3 mt-2">
                  {accounts.map((acc) => {
                    const isActive = activeAccount.id === acc.id;
                    const isEditing = editingAccount?.id === acc.id;

                    return (
                      <div
                        key={acc.id}
                        onClick={() => !isEditing && setActiveAccount(acc)}
                        className={`p-4 rounded-2xl border transition-all duration-300 flex flex-col sm:flex-row sm:items-center justify-between gap-4 cursor-pointer relative overflow-hidden ${
                          isActive 
                            ? `${themeAccent.bg} ${themeAccent.border} shadow-lg shadow-${themeAccent.accentColor}-500/2` 
                            : "bg-slate-900/20 border-slate-850 hover:border-slate-800"
                        }`}
                      >
                        {/* Left Info */}
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 rounded-xl bg-slate-950/80 border border-slate-700/60 overflow-hidden flex items-center justify-center shrink-0">
                            <img
                              src={acc.avatar}
                              alt="Avatar"
                              className="w-10 h-10 object-contain"
                              onError={(e) => {
                                (e.target as HTMLImageElement).src = "https://api.mineatar.io/face/c06f89064c8a49119c29ea1dbd1aab82?scale=8";
                              }}
                            />
                          </div>

                          <div className="text-left flex flex-col">
                            {isEditing ? (
                              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="text"
                                  value={editUsername}
                                  onChange={(e) => setEditUsername(e.target.value)}
                                  className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-xs font-bold text-slate-200 outline-none focus:theme-border"
                                />
                                <button
                                  onClick={handleSaveRename}
                                  className="theme-bg hover:theme-bg-hover text-slate-950 p-1.5 rounded-lg text-[10px] font-bold"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditingAccount(null)}
                                  className="bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-400 p-1.5 rounded-lg text-[10px]"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <span className="text-sm font-black text-slate-100 flex items-center gap-2">
                                {acc.username}
                                {isActive && (
                                  <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded ${themeAccent.bg} ${themeAccent.text} border ${themeAccent.border}`}>
                                    {t.activeLabel}
                                  </span>
                                )}
                              </span>
                            )}
                            <span className="text-[10px] text-slate-400 font-medium mt-1">
                              {acc.type} Account
                            </span>
                          </div>
                        </div>

                        {/* Right Actions */}
                        <div className="flex items-center gap-2 self-end sm:self-auto" onClick={(e) => e.stopPropagation()}>
                          {acc.type === "Offline" && !isEditing && (
                            <button
                              onClick={(e) => handleStartRename(acc, e)}
                              className="p-2 bg-slate-900/60 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-white rounded-xl transition-all cursor-pointer"
                              title="Rename Offline Account"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            onClick={(e) => handleDeleteAccount(acc.id, e)}
                            className="p-2 bg-slate-900/60 hover:bg-rose-500/10 border border-slate-800 hover:border-rose-500/25 text-slate-400 hover:text-rose-400 rounded-xl transition-all cursor-pointer"
                            title="Delete Account"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

          </div>

          {/* Footer Save Action */}
          <div className="border-t border-slate-900 pt-4 flex justify-between items-center mt-4">
            <span className="text-[10px] text-slate-500 font-bold">
              Unsaved changes will be discarded on launcher exit.
            </span>
            <button
              onClick={handleSave}
              className={`${themeAccent.button} px-5 py-2.5 rounded-xl text-xs font-black tracking-wide shadow-lg transition-all cursor-pointer`}
            >
              {t.applyChanges}
            </button>
          </div>
        </div>

      </div>

      {/* SAVED TOAST NOTIFICATION */}
      <AnimatePresence>
        {showSavedToast && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}              className="fixed bottom-24 right-6 bg-slate-950 border theme-border-md p-4 rounded-2xl shadow-2xl flex items-center gap-3 z-50 pointer-events-auto"
          >
            <div className="w-8 h-8 rounded-xl theme-bg-light theme-border-light flex items-center justify-center theme-text shrink-0">
              <Check className="w-4.5 h-4.5 stroke-[3]" />
            </div>
            <div className="text-left">
              <span className="block text-xs font-bold text-slate-200">{t.settingsSaved}</span>
              <span className="text-[10px] text-slate-400">{t.settingsSavedDesc}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* MICROSOFT DEVICE CODE MODAL */}
      <AnimatePresence>
        {showMsDeviceCodeModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50"
            onClick={() => { setShowMsDeviceCodeModal(false); setMsDeviceCode(null); setMsLoginStep(""); }}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              className="bg-slate-950 border border-slate-800/80 rounded-3xl max-w-md w-full overflow-hidden shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-slate-900 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Lock className="w-5 h-5 text-sky-400" />
                  <h3 className="text-lg font-black text-white tracking-wide">Microsoft-Login</h3>
                </div>
                <button
                  onClick={() => { setShowMsDeviceCodeModal(false); setMsDeviceCode(null); setMsLoginStep(""); }}
                  className="bg-slate-900 hover:bg-slate-800 border border-slate-800 p-2 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-6 flex flex-col gap-4 text-left">
                {msDeviceCode ? (
                  <>
                    <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5 text-center">
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-3">Device Code</p>
                      <p className="text-3xl font-black text-white tracking-[0.25em] font-mono select-all">{msDeviceCode.userCode}</p>
                    </div>

                    <div className="bg-slate-900/20 border border-slate-850 rounded-2xl p-4">
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">Verification URL</p>
                      <p className="text-xs text-sky-400 font-mono break-all">{msDeviceCode.verificationUri}</p>
                    </div>

                    <p className="text-xs text-slate-400 leading-relaxed">
                      {msLoginStep}
                    </p>

                    <div className="flex gap-2">
                      <button
                        onClick={() => window.electronAPI?.copyToClipboard?.(msDeviceCode.userCode)}
                        className="flex-1 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer"
                      >
                        Code kopieren
                      </button>
                      <button
                        onClick={() => window.electronAPI?.openExternal?.(msDeviceCode.verificationUri)}
                        className="flex-1 bg-sky-500 hover:bg-sky-400 text-slate-950 py-2.5 rounded-xl text-xs font-black tracking-wide shadow-lg shadow-sky-500/10 transition-all cursor-pointer"
                      >
                        Seite öffnen
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="py-8 flex flex-col items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center">
                      <div className="w-5 h-5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
                    </div>
                    <p className="text-sm text-slate-300 font-bold">{msLoginStep || "Initializing..."}</p>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ADD ACCOUNT MODAL */}
      <AnimatePresence>
        {showAddAccountModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50"
            onClick={() => setShowAddAccountModal(false)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              className="bg-slate-950 border border-slate-800/80 rounded-3xl max-w-md w-full overflow-hidden shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-slate-900 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Plus className="w-5 h-5 theme-text" />
                  <h3 className="text-lg font-black text-white tracking-wide">{t.addAccount}</h3>
                </div>
                <button
                  onClick={() => setShowAddAccountModal(false)}
                  className="bg-slate-900 hover:bg-slate-800 border border-slate-800 p-2 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleAddAccount} className="p-6 flex flex-col gap-4 text-left">
                {/* Username */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">{t.usernameLabel}</label>
                  <input
                    type="text"
                    required
                    value={newUsername}
                    onChange={(e) => setNewWorldName(e.target.value)}
                    placeholder="Alex_Offline"
                    className="w-full bg-slate-900/40 border border-slate-800 focus:theme-border rounded-xl py-2.5 px-4 text-sm text-slate-200 placeholder-slate-500 outline-none transition-all"
                  />
                </div>



                <div className="flex gap-3 mt-4 pt-4 border-t border-slate-900">
                  <button
                    type="button"
                    onClick={() => setShowAddAccountModal(false)}
                    className="flex-1 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-3 rounded-xl text-xs font-bold transition-all cursor-pointer"
                  >
                    {t.cancel}
                  </button>
                  <button
                    type="submit"
                    className="flex-1 theme-bg hover:theme-bg-hover text-slate-950 py-3 rounded-xl text-xs font-black tracking-wide theme-shadow-lg transition-all cursor-pointer"
                  >
                    {t.addAccount}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
};



