import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Compass,
  Server,
  Puzzle,
  Sparkles,
  Camera,
  Sliders,
  ArrowRight,
  Crown,
  Clock,
  ExternalLink,
  ChevronRight,
  BookOpen,
  Zap,
  CheckCircle,
  X,
  RefreshCw,
  Pin,
  Calendar,
  User,
  AlertTriangle,
  Timer,
} from "lucide-react";
import { TabType } from "./Sidebar";
import { ThemeType } from "./ParticleBackground";
import { Account } from "./TopBar";
import { translations, LanguageType } from "../lib/translations";
import { BannerSlideshow } from "./BannerSlideshow";
import { API_BASE } from "../services/api";
import { SkinViewer, WalkingAnimation } from "skinview3d";

interface DashboardProps {
  setActiveTab: (tab: TabType) => void;
  theme: ThemeType;
  activeAccount: Account;
  lang: LanguageType;
}

export const Dashboard: React.FC<DashboardProps> = ({ setActiveTab, theme, activeAccount, lang }) => {
  const t = translations[lang];
  const skinCanvasRef = useRef<HTMLCanvasElement>(null);
  const skinViewerRef = useRef<SkinViewer | null>(null);
  const [newsItems, setNewsItems] = useState<any[]>([]);
  const [newsLoading, setNewsLoading] = useState(true);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [events, setEvents] = useState<{id:string;title:string;startDate:string;endDate:string|null;bannerUrl:string;isActive:boolean}[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);

  // ===== Player Identity (wie Cosmetics-Tab) =====
  const [playerIdentity, setPlayerIdentity] = useState<{uuid:string|null;username:string|null;type:string} | null>(null);

  useEffect(() => {
    const loadIdentity = async () => {
      try {
        const result = await window.electronAPI?.getPlayerIdentity?.();
        if (result) setPlayerIdentity(result);
      } catch { console.warn('[Dashboard] Failed to load player identity'); }
    };
    loadIdentity();
  }, []);

  useEffect(() => {
    const fetchDashboardNews = async () => {
      setNewsLoading(true);
      setNewsError(null);
      try {
        const url = new URL(`${API_BASE}/content/news`);
        url.searchParams.set("active", "true");
        url.searchParams.set("limit", "3");
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setNewsItems(data.data || []);
      } catch (err: any) {
        setNewsError(err.message);
        setNewsItems([]);
      } finally {
        setNewsLoading(false);
      }
    };
    const fetchDashboardEvents = async () => {
      setEventsLoading(true);
      try {
        const url = new URL(`${API_BASE}/content/event`);
        url.searchParams.set("active", "true");
        url.searchParams.set("limit", "4");
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setEvents((data.data || []).filter((e: {id:string;title:string;startDate:string;endDate:string|null;bannerUrl:string;isActive:boolean}) => e.isActive || new Date(e.startDate).getTime() > Date.now()));
      } catch {
        setEvents([]);
      } finally {
        setEventsLoading(false);
      }
    };
    fetchDashboardNews();
    fetchDashboardEvents();
  }, []);

  // ===== Skin Viewer 3D – Steve bei Offline/Kein Account, eigener Skin bei Microsoft =====
  useEffect(() => {
    if (!skinCanvasRef.current) return;
    if (!activeAccount.id) return; // Kein Account => kein Skin

    // Identity auflösen: activeAccount zuerst (playerIdentity ignorieren bei Offline-Accounts)
    const isMicrosoft = activeAccount.type === "Microsoft";
    const mcUuid = playerIdentity?.uuid || activeAccount?.uuid;
    const skinUrl = isMicrosoft && mcUuid
      ? `https://minotar.net/skin/${mcUuid}`
      : isMicrosoft && activeAccount.username
      ? `https://minotar.net/skin/${activeAccount.username}`
      : "https://minotar.net/skin/MHF_Steve";

    const viewer = new SkinViewer({
      canvas: skinCanvasRef.current,
      width: 320,
      height: 420,
    });
    skinViewerRef.current = viewer;
    viewer.autoRotate = true;
    viewer.autoRotateSpeed = 0.5;
    const walkAnim = new WalkingAnimation();
    walkAnim.speed = 0.3;
    viewer.animation = walkAnim;

    viewer.loadSkin(skinUrl).catch(() => {});

    return () => { viewer.dispose(); skinViewerRef.current = null; };
  }, [activeAccount.id, activeAccount.uuid, activeAccount.type, playerIdentity?.uuid, playerIdentity?.type]);

  // Quick Action Cards configuration (Translated!)
  const quickActions = [
    {
      id: "singleplayer",
      title: t.instances,
      desc: lang === "de" ? "Verwalte, konfiguriere und starte isolierte Spielversionen oder eigene Modpacks." : "Manage, configure, and launch isolated game versions or custom modpacks.",
      count: "Modpacks & Profiles",
      icon: Compass,
      gradient: "from-blue-600/20 to-blue-400/5",
      border: "hover:border-blue-500/40",
      glow: "group-hover:shadow-blue-500/10",
      iconColor: "text-blue-400",
    },
    {
      id: "multiplayer",
      title: t.multiplayer,
      desc: lang === "de" ? "Verbinde dich mit Community-Netzwerken, Minispielen und eigenen Survival-Servern." : "Connect to community networks, mini-games, and custom survival servers.",
      count: "Echtzeit-Pings / Live Pings",
      icon: Server,
      gradient: "from-indigo-600/20 to-indigo-400/5",
      border: "hover:border-indigo-500/40",
      glow: "group-hover:shadow-indigo-500/10",
      iconColor: "text-indigo-400",
    },
    {
      id: "mods",
      title: t.modBrowser,
      desc: lang === "de" ? "Durchsuche, filtere und installiere Tausende von Modifikationen direkt über CurseForge & Modrinth." : "Browse, query, and install thousands of modifications directly from CurseForge & Modrinth.",
      count: "CurseForge & Modrinth",
      icon: Puzzle,
      gradient: "from-amber-600/20 to-amber-400/5",
      border: "hover:border-amber-500/40",
      glow: "group-hover:shadow-amber-500/10",
      iconColor: "text-amber-400",
    },
    {
      id: "cosmetics",
      title: t.cosmetics,
      desc: lang === "de" ? "Rüste exklusive Umhänge, animierte Flügel, Hüte und Emotes aus." : "Equip custom capes, animated wings, hats, and emotes to stand out in lobbies.",
      count: "Skins & Capes",
      icon: Sparkles,
      gradient: "from-purple-600/20 to-purple-400/5",
      border: "hover:border-purple-500/40",
      glow: "group-hover:shadow-purple-500/10",
      iconColor: "text-purple-400",
    },
    {
      id: "screenshots",
      title: t.screenshots,
      desc: lang === "de" ? "Durchsuche, kopiere und teile hochauflösende Screenshots deiner Abenteuer." : "Browse, copy, and share high-resolution screenshots and memories.",
      count: "F2 Screenshots",
      icon: Camera,
      gradient: "from-cyan-600/20 to-cyan-400/5",
      border: "hover:border-cyan-500/40",
      glow: "group-hover:shadow-cyan-500/10",
      iconColor: "text-cyan-400",
    },
    {
      id: "settings",
      title: t.settings,
      desc: lang === "de" ? "Passe Starteigenschaften, Arbeitsspeicher-Zuweisung, visuelle und audio Optimierungen an." : "Customize performance options, graphics quality, audio profiles, and keybindings.",
      count: "Launcher Config",
      icon: Sliders,
      gradient: "from-slate-600/20 to-slate-400/5",
      border: "hover:border-slate-500/40",
      glow: "group-hover:shadow-slate-500/10",
      iconColor: "text-slate-400",
    },
  ];

  // Theme colors – automatisch via CSS-Variablen an das aktuelle Theme angepasst
  const colors = {
    text: "theme-text",
    border: "theme-border-light",
    hoverBorder: "hover:theme-border-md",
    bg: "theme-bg-light",
    button: "theme-bg hover:theme-bg-hover text-slate-950 theme-shadow hover:theme-shadow-lg",
    glow: "theme-from-subtle",
    ring: "theme-border-light",
    ring2: "theme-border-subtle",
    blurBg: "theme-bg-subtle",
    badge: "theme-bg-md theme-text theme-border-md",
    newsBadge: "theme-bg-md theme-text theme-border-md",
    newsTextHover: "group-hover:theme-text-bright",
    newsBtn: "theme-bg text-slate-950 theme-shadow",
  };

  return (
    <div className="flex-1 overflow-y-auto h-full p-6 flex flex-col gap-6 custom-scrollbar z-10 relative select-none">

      {/* Banner Slideshow */}
      <BannerSlideshow accentText={colors.text} accentBg={colors.bg} />

      {/* Upper Grid: Player Section & News Panel */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">

        {/* PLAYER SECTION — Premium Redesign */}
        <div className="xl:col-span-4 flex flex-col">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className={`flex-1 bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-6 flex flex-col justify-between relative overflow-hidden group shadow-2xl ${colors.hoverBorder}`}
          >
            {/* Premium ambient glow */}
            <div className={`absolute -inset-20 bg-gradient-to-br ${colors.glow} via-transparent to-transparent opacity-60 pointer-events-none`} />
            <div className="absolute top-0 right-0 w-64 h-64 rounded-full bg-[var(--theme-accent)]/5 blur-3xl pointer-events-none" />
            
            {/* Grid pattern overlay */}
            <div className="absolute inset-0 opacity-[0.03] pointer-events-none" 
              style={{ backgroundImage: `radial-gradient(circle at 1px 1px, var(--theme-accent) 1px, transparent 0)`, backgroundSize: '24px 24px' }} />

            {/* Card Header */}
            <div className="flex items-center justify-between z-10 relative">
              <div className="flex items-center gap-2.5">
                <div className={`w-8 h-8 rounded-xl ${colors.bg} border ${colors.border} flex items-center justify-center`}>
                  <Crown className={`w-4 h-4 ${colors.text}`} />
                </div>
                <div>
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.15em]">{t.activeProfile}</span>
                </div>
              </div>
              <div className={`flex items-center gap-1.5 ${colors.badge} px-3 py-1 rounded-full`}>
                <span className="w-1.5 h-1.5 rounded-full theme-bg animate-pulse" />
              </div>
            </div>

            {/* Premium 3D Skin Viewer — Platzhalter bei keinem Account, Steve bei Offline, eigener Skin bei Microsoft */}
            <div className="my-1 flex-1 flex items-center justify-center relative select-none min-h-[200px]">
              {activeAccount.id ? (
                <>
                  {/* Ambient glow behind character */}
                  <div className={`absolute w-40 h-40 rounded-full ${colors.bg} blur-3xl opacity-40`} />
                  
                  {/* 3D Skin Viewer Canvas */}
                  <canvas
                    ref={skinCanvasRef}
                    className="h-56 w-auto z-10 object-contain pointer-events-none select-none outline-none"
                    style={{ imageRendering: "pixelated" }}
                  />
                  
                  {/* Reflection glow */}
                  <div className={`absolute bottom-4 w-32 h-4 rounded-full ${colors.bg} blur-xl opacity-30`} />
                </>
              ) : (
                <div className="flex flex-col items-center gap-3 opacity-40">
                  <User className="w-16 h-16 text-slate-600" />
                  <p className="text-xs text-slate-500 font-medium">{lang === "de" ? "Kein Account" : "No Account"}</p>
                </div>
              )}
            </div>

            {/* Player Info Footer — Premium Style */}
            <div className="z-10 relative mt-1 pt-3 border-t border-slate-800/40">
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-2xl font-black text-white tracking-wide truncate drop-shadow-lg">
                    {activeAccount.id ? activeAccount.username : (lang === "de" ? "Kein Account" : "No Account")}
                  </h2>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-[10px] font-bold ${colors.text} bg-[var(--theme-accent)]/10 border border-[var(--theme-accent)]/20 px-2 py-0.5 rounded-md`}>
                      {activeAccount.id ? (playerIdentity?.type === "microsoft" || activeAccount.type === "Microsoft" ? "Microsoft" : "Offline") : "-"}
                    </span>
                    {activeAccount.uuid && (
                      <span className="text-[9px] font-mono text-slate-600 truncate max-w-[120px]" title={activeAccount.uuid}>
                        {activeAccount.uuid.slice(0, 8)}...
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setActiveTab("cosmetics")}
                  className={`${colors.button} px-5 py-2.5 rounded-xl text-xs font-black tracking-wide shadow-lg transition-all duration-300 flex items-center gap-2 cursor-pointer hover:-translate-y-0.5 hover:shadow-xl shrink-0`}
                >
                  <Sparkles className="w-4 h-4 fill-slate-950" />
                  {t.wardrobeBtn}
                </button>
              </div>
            </div>
          </motion.div>
        </div>

        {/* NEWS PANEL */}
        <div className="xl:col-span-8 flex flex-col">
          <div className="flex-1 bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-6 flex flex-col shadow-2xl relative overflow-hidden">
            {/* Title Header */}
            <div className="flex items-center justify-between mb-4 shrink-0">
              <div className="flex items-center gap-2">
                <BookOpen className={`w-5 h-5 ${colors.text}`} />
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{t.clientUpdates}</span>
              </div>
              <button
                onClick={() => setActiveTab("news")}
                className={`text-[10px] font-bold ${colors.text} hover:opacity-80 transition-opacity flex items-center gap-1 cursor-pointer`}
              >
                {lang === "de" ? "Alle anzeigen" : "View all"} <ChevronRight className="w-3 h-3" />
              </button>
            </div>

            {newsLoading ? (
              <div className="flex-1 flex items-center justify-center py-8">
                <div className="flex flex-col items-center gap-2">
                  <RefreshCw className={`w-6 h-6 ${colors.text} animate-spin`} />
                  <span className="text-[10px] text-slate-500 font-medium">
                    {lang === "de" ? "Lade Neuigkeiten..." : "Loading news..."}
                  </span>
                </div>
              </div>
            ) : newsError ? (
              <div className="flex-1 flex items-center justify-center py-8">
                <div className="text-center flex flex-col items-center gap-2">
                  <AlertTriangle className="w-8 h-8 text-amber-400" />
                  <p className="text-xs text-slate-400 font-medium">
                    {lang === "de" ? "News nicht verfügbar" : "News unavailable"}
                  </p>
                </div>
              </div>
            ) : newsItems.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-8">
                <div className="text-center flex flex-col items-center gap-2">
                  <BookOpen className="w-8 h-8 text-slate-600" />
                  <p className="text-sm text-slate-400 font-medium">
                    {lang === "de" ? "Keine Neuigkeiten verfügbar" : "No news available"}
                  </p>
                  <p className="text-xs text-slate-500">
                    {lang === "de" ? "Neue Updates erscheinen hier, sobald sie veröffentlicht werden." : "New updates will appear here once published."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col gap-2 overflow-y-auto custom-scrollbar min-h-0">
                {newsItems.map((item, idx) => (
                  <div
                    key={item.id}
                    onClick={() => setActiveTab("news")}
                    className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all group ${
                      item.isPinned
                        ? `${colors.bg} ${colors.border}`
                        : "border-slate-800/40 hover:border-slate-700/60 hover:bg-slate-900/20"
                    }`}
                  >
                    {item.bannerUrl && (
                      <div className="w-14 h-14 rounded-xl overflow-hidden shrink-0 border border-slate-800/60 bg-slate-900">
                        <img
                          src={item.bannerUrl}
                          alt={item.title}
                          className="w-full h-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        {item.isPinned && <Pin className="w-3 h-3 text-amber-400" />}
                        <h4 className={`text-xs font-black text-slate-100 truncate ${colors.newsTextHover} transition-colors`}>
                          {item.title}
                        </h4>
                      </div>
                      {item.subtitle && (
                        <p className="text-[10px] text-slate-400 line-clamp-1 leading-relaxed">{item.subtitle}</p>
                      )}
                      <div className="flex items-center gap-3 mt-1 text-[9px] text-slate-500">
                        <span className="flex items-center gap-1"><Calendar className="w-2.5 h-2.5" /> {new Date(item.publishedAt || item.createdAt).toLocaleDateString(lang === "de" ? "de-DE" : "en-US", { day: "numeric", month: "short" })}</span>
                        <span className="flex items-center gap-1"><User className="w-2.5 h-2.5" /> {item.author}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Events Section */}
      {events.length > 0 && (
        <div className="bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Timer className={`w-5 h-5 ${colors.text}`} />
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{lang === "de" ? "Aktive Events" : "Active Events"}</span>
            </div>
            <button
              onClick={() => setActiveTab("news")}
              className={`text-[10px] font-bold ${colors.text} hover:opacity-80 transition-opacity flex items-center gap-1 cursor-pointer`}
            >
              {lang === "de" ? "Alle anzeigen" : "View all"} <ChevronRight className="w-3 h-3" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {events.slice(0, 4).map((item) => {
              const isLive = item.isActive && new Date(item.startDate).getTime() <= Date.now() && (!item.endDate || new Date(item.endDate).getTime() >= Date.now());
              const startsSoon = new Date(item.startDate).getTime() > Date.now();
              const timeUntil = new Date(item.startDate).getTime() - Date.now();
              const daysUntil = Math.ceil(timeUntil / 86400000);
              return (
                <div
                  key={item.id}
                  onClick={() => setActiveTab("news")}
                  className={`rounded-2xl border cursor-pointer transition-all duration-300 group hover:-translate-y-1 ${
                    isLive ? `${colors.border} ${colors.bg}` : "border-slate-800/40 hover:border-slate-700/60 bg-slate-900/20"
                  }`}
                >
                  {item.bannerUrl && (
                    <div className="h-24 rounded-t-2xl overflow-hidden">
                      <img src={item.bannerUrl} alt={item.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    </div>
                  )}
                  <div className="p-3">
                    <div className="flex items-center gap-2 mb-1">
                      {isLive ? (
                        <span className="text-[9px] font-black text-rose-400 bg-rose-500/10 border border-rose-500/20 px-1.5 py-0.5 rounded uppercase animate-pulse">LIVE</span>
                      ) : startsSoon ? (
                        <span className="text-[9px] font-black text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded uppercase">{daysUntil}d</span>
                      ) : null}
                    </div>
                    <h4 className="text-xs font-black text-slate-100 truncate group-hover:text-white transition-colors">{item.title}</h4>
                    <p className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1">
                      <Calendar className="w-2.5 h-2.5" />
                      {new Date(item.startDate).toLocaleDateString(lang === "de" ? "de-DE" : "en-US", { day: "numeric", month: "short" })}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 mb-4">
        <Zap className={`w-5 h-5 ${colors.text}`} />
        <h3 className="text-sm font-black text-slate-400 uppercase tracking-widest">{t.quickAccess}</h3>
      </div>

      {/* QUICK ACTIONS GRID */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {quickActions.map((action, idx) => {
          const Icon = action.icon;
          const clickHandler = () => {
            setActiveTab(action.id === "singleplayer" ? "singleplayer" : action.id as TabType);
          };

          return (
            <motion.div
              key={action.id}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: idx * 0.05 }}
              onClick={clickHandler}
              className={`group relative rounded-2xl p-5 border border-slate-800/60 bg-gradient-to-br ${action.gradient} ${action.border} cursor-pointer transition-all duration-300 hover:shadow-2xl ${action.glow} hover:-translate-y-1`}
            >
              <div className="absolute inset-0 bg-gradient-to-t from-white/2 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-2xl" />

              <div className="flex items-start justify-between">
                <div className="p-3.5 rounded-2xl bg-slate-900/80 border border-slate-800/80 group-hover:theme-border-light group-hover:bg-slate-950 transition-all duration-300 shadow-inner">
                  <Icon className={`w-6 h-6 group-hover:scale-110 transition-transform duration-300 ${action.id === "settings" ? colors.text : action.iconColor}`} />
                </div>

                <span className="text-[10px] font-bold text-slate-400 bg-slate-900/60 border border-slate-800/60 px-2.5 py-1 rounded-full group-hover:theme-text group-hover:theme-border-light transition-colors">
                  {action.count}
                </span>
              </div>

              <div className="mt-5 text-left">
                <h4 className="text-base font-black text-slate-100 group-hover:text-white group-hover:translate-x-0.5 transition-all tracking-wide">
                  {action.title}
                </h4>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed group-hover:text-slate-300 transition-colors">
                  {action.desc}
                </p>
              </div>

              <div className="absolute right-5 bottom-5 text-slate-500 group-hover:theme-text group-hover:translate-x-1.5 transition-all duration-300">
                <ArrowRight className="w-4 h-4" />
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
};
