import React, { useEffect, useRef, useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Sparkles, Shirt, Eye, EyeOff, RotateCcw,
  RefreshCw, AlertCircle, Image, Check,
  Star, Crown, Diamond, Shield, Feather,
  Rabbit, Gift,
} from "lucide-react";
import { TabType } from "./Sidebar";
import { LanguageType } from "../lib/translations";
import { Account } from "./TopBar";
import { SkinViewer, WalkingAnimation } from "skinview3d";
import { API_BASE, getLauncherHeaders } from "../services/api";

// ===== Types =====
interface PlayerIdentity {
  uuid: string | null;
  username: string | null;
  type: string;
}

interface CosmeticItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  type: string;
  rarity: string;
  previewUrl: string;
  imageUrl: string;
  modelUrl: string;
  accentColor: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface CosmeticsViewProps {
  setActiveTab: (tab: TabType) => void;
  lang: LanguageType;
  activeAccount: Account;
}

const COSMETIC_TYPES = ["cape", "aura", "hat", "ear", "wings", "rank", "other"] as const;
const COSMETIC_RARITIES = ["common", "rare", "epic", "legendary", "mythic"] as const;

const RARITY_CONFIG: Record<string, { icon: React.ElementType; color: string; bg: string; border: string }> = {
  common: { icon: Shield, color: "text-slate-400", bg: "bg-slate-500/10", border: "border-slate-500/20" },
  rare: { icon: Star, color: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/20" },
  epic: { icon: Diamond, color: "text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500/20" },
  legendary: { icon: Crown, color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/20" },
  mythic: { icon: Crown, color: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/20" },
};

// Type icons (no emojis, using lucide-react icons like the sidebar)
const TYPE_ICONS: Record<string, { icon: React.ElementType; label: string }> = {
  cape: { icon: Shirt, label: "Cape" },
  aura: { icon: Sparkles, label: "Aura" },
  hat: { icon: Crown, label: "Hat" },
  ear: { icon: Rabbit, label: "Ears" },
  wings: { icon: Feather, label: "Wings" },
  rank: { icon: Star, label: "Rank" },
  other: { icon: Gift, label: "Other" },
};

// Default skin for users without Microsoft account (raw image URL)
const DEFAULT_SKIN_URL = "https://minotar.net/skin/MHF_Steve";

// In-game cape toggle reference (prepared for future rendering)
let capeEnabledInGame = true;
export function setCapeInGame(enabled: boolean) {
  capeEnabledInGame = enabled;
  console.log(`[Cosmetics] Cape in-game ${enabled ? "activated" : "deactivated"}`);
}
export function isCapeInGame() { return capeEnabledInGame; }

// Selected cosmetics store (prepared for future rendering on player)
interface CosmeticSelection {
  type: string;
  cosmeticId: string | null;
}
let cosmeticSelections: CosmeticSelection[] = COSMETIC_TYPES.map(t => ({ type: t, cosmeticId: null }));
export function selectCosmetic(type: string, cosmeticId: string | null) {
  const idx = cosmeticSelections.findIndex(s => s.type === type);
  if (idx >= 0) cosmeticSelections[idx].cosmeticId = cosmeticId;
  else cosmeticSelections.push({ type, cosmeticId });
  window.dispatchEvent(new CustomEvent('cosmetic-selected', { detail: { type, cosmeticId } }));
}
export function getCosmeticSelections() { return [...cosmeticSelections]; }

export const CosmeticsView: React.FC<CosmeticsViewProps> = ({ activeAccount }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  const [showCape, setShowCape] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);
  const [animEnabled, setAnimEnabled] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<PlayerIdentity | null>(null);

  // Cosmetics state
  const [cosmetics, setCosmetics] = useState<CosmeticItem[]>([]);
  const [loadingCosmetics, setLoadingCosmetics] = useState(true);
  const [cosmeticsError, setCosmeticsError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [selectedCosmetics, setSelectedCosmetics] = useState<Record<string, string | null>>({});

  // Fetch player identity via IPC
  useEffect(() => {
    const loadIdentity = async () => {
      try {
        const result = await window.electronAPI?.getPlayerIdentity?.();
        if (result) setIdentity(result);
      } catch { console.warn('[Cosmetics] Failed to load player identity'); }
    };
    loadIdentity();
  }, []);

  const cosUuid = identity?.uuid || activeAccount?.uuid;
  
  // Use default skin URL for offline/non-Microsoft accounts
  const isMicrosoft = identity?.type === "microsoft" || activeAccount?.type === "Microsoft";
  const skinUrl = isMicrosoft && cosUuid
    ? `https://minotar.net/skin/${cosUuid}`
    : isMicrosoft && (activeAccount?.username || identity?.username)
    ? `https://minotar.net/skin/${activeAccount?.username || identity?.username}`
    : DEFAULT_SKIN_URL;

  // ===== Skin Viewer =====
  useEffect(() => {
    if (!canvasRef.current) return;
    setIsLoading(true);
    setError(null);

    const viewer = new SkinViewer({
      canvas: canvasRef.current,
      width: 320,
      height: 420,
    });
    viewerRef.current = viewer;
    // WalkingAnimation immer setzen, Geschwindigkeit über animEnabled gesteuert
    const walkAnim = new WalkingAnimation();
    walkAnim.speed = animEnabled ? 1 : 0;
    viewer.animation = walkAnim;
    viewer.autoRotate = autoRotate;
    viewer.autoRotateSpeed = 0.8;

    viewer.loadSkin(skinUrl)
      .then(() => {
        setIsLoading(false);
      })
      .catch(() => {
        setError("Skin konnte nicht geladen werden");
        setIsLoading(false);
      });

    return () => { viewer.dispose(); viewerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skinUrl]);

  useEffect(() => {
    if (viewerRef.current) viewerRef.current.autoRotate = autoRotate;
  }, [autoRotate]);

  // Animation-Toggle: Geschwindigkeit umschalten + bei Deaktivierung in Standposition zurücksetzen
  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer && viewer.animation instanceof WalkingAnimation) {
      if (animEnabled) {
        viewer.animation.speed = 1;
      } else {
        viewer.animation.speed = 0;
        viewer.animation.progress = 0; // Zurücksetzen in neutrale Standposition
      }
    }
  }, [animEnabled]);

  // Cape toggle — prepared for in-game rendering
  const handleCapeToggle = () => {
    const newState = !showCape;
    setShowCape(newState);
    setCapeInGame(newState);
  };

  const handleReloadSkin = () => {
    if (!viewerRef.current) return;
    setIsLoading(true);
    setError(null);
    viewerRef.current
      .loadSkin(skinUrl)
      .then(() => {
        setIsLoading(false);
      })
      .catch(() => {
        setError("Skin konnte nicht geladen werden");
        setIsLoading(false);
      });
  };

  // ===== Cosmetics API =====
  const fetchCosmetics = useCallback(async () => {
    setLoadingCosmetics(true);
    setCosmeticsError(null);
    try {
      // Nur aktive Cosmetics im Launcher anzeigen (inaktive/Draft-Items ausblenden)
      const res = await fetch(`${API_BASE}/cosmetics?active=true&limit=100`, {
        headers: getLauncherHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCosmetics(data.data || []);
    } catch (err: any) {
      setCosmeticsError(err.message);
    } finally {
      setLoadingCosmetics(false);
    }
  }, []);

  useEffect(() => { fetchCosmetics(); }, [fetchCosmetics]);

  // ===== Selection =====
  const handleSelectCosmetic = (cosmetic: CosmeticItem) => {
    const currentSelected = selectedCosmetics[cosmetic.type];
    if (currentSelected === cosmetic.id) {
      // Deselect
      const newSel = { ...selectedCosmetics };
      delete newSel[cosmetic.type];
      setSelectedCosmetics(newSel);
      selectCosmetic(cosmetic.type, null);
    } else {
      // Select
      setSelectedCosmetics(prev => ({ ...prev, [cosmetic.type]: cosmetic.id }));
      selectCosmetic(cosmetic.type, cosmetic.id);
    }
  };

  const filteredCosmetics = activeFilter === "all"
    ? cosmetics
    : cosmetics.filter(c => c.type === activeFilter);

  return (
    <div className="flex-1 h-full flex flex-col p-6 overflow-hidden">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col h-full gap-6"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl theme-bg-light theme-border-light border flex items-center justify-center">
              <Sparkles className="w-6 h-6 theme-text" />
            </div>
            <div>
              <h2 className="text-2xl font-black text-white tracking-wide">Cosmetics</h2>
              <p className="text-sm text-slate-400">Passe deinen Look individuell an</p>
            </div>
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 flex gap-6 min-h-0">
          {/* Left: 3D Viewer */}
          <div className="w-[360px] shrink-0 flex flex-col gap-4">
            <div className="flex-1 bg-slate-950/50 rounded-3xl border border-slate-800/60 p-4 relative overflow-hidden flex items-center justify-center">
              <canvas ref={canvasRef} className="rounded-2xl outline-none max-w-full max-h-full" style={{ imageRendering: "auto" }} />
              {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/40 backdrop-blur-sm rounded-3xl">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-10 h-10 border-2 theme-border-md border-t-[var(--theme-accent)] rounded-full animate-spin" />
                    <span className="text-xs font-semibold text-slate-400">Skin wird geladen...</span>
                  </div>
                </div>
              )}
              {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm rounded-3xl">
                  <div className="text-center p-4">
                    <p className="text-sm font-bold text-rose-400 mb-2">{error}</p>
                    <button onClick={handleReloadSkin} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-xs font-bold text-slate-200 transition-all">
                      Erneut versuchen
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="bg-slate-900/50 border border-slate-800/60 rounded-2xl p-4 backdrop-blur-md">
              <div className="flex items-center gap-2 mb-3">
                <Shirt className="w-4 h-4 theme-text" />
                <h3 className="text-sm font-bold text-slate-200">Optionen</h3>
              </div>
              <div className="flex flex-col gap-2">
                {/* Cape toggle — controls in-game cape visibility */}
                <button onClick={handleCapeToggle}
                  className={`flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-bold transition-all border ${
                    showCape ? "theme-bg-light theme-text theme-border-md" : "bg-slate-800/60 text-slate-300 border-slate-700/50 hover:bg-slate-800"
                  }`}>
                  <span>Umhang <span className="text-[9px] text-slate-500 font-normal">(im Spiel)</span></span>
                  {showCape ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
                
                {/* Rotation toggle — narrower */}
                <div className="flex gap-2">
                  <button onClick={() => setAutoRotate(!autoRotate)}
                    className={`flex-1 flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-bold transition-all border ${
                      autoRotate ? "theme-bg-light theme-text theme-border-md" : "bg-slate-800/60 text-slate-300 border-slate-700/50 hover:bg-slate-800"
                    }`}>
                    <span>Rotation</span>
                    <RotateCcw className={`w-4 h-4 ${autoRotate ? "animate-spin" : ""}`} />
                  </button>

                  {/* Animation-Toggle */}
                  <button onClick={() => setAnimEnabled(!animEnabled)}
                    className={`flex-1 flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-bold transition-all border ${
                      animEnabled ? "theme-bg-light theme-text theme-border-md" : "bg-slate-800/60 text-slate-300 border-slate-700/50 hover:bg-slate-800"
                    }`}>
                    <span>Animation</span>
                    {animEnabled ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </button>
                </div>
                
                <button onClick={handleReloadSkin}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-slate-800/60 text-slate-300 border border-slate-700/50 hover:bg-slate-800 transition-all">
                  <RotateCcw className="w-4 h-4" />
                  Skin neu laden
                </button>
              </div>
            </div>
          </div>

          {/* Right: Cosmetics Grid */}
          <div className="flex-1 flex flex-col gap-4 min-h-0">
            {/* Type Filter — Icons statt Emojis */}
            <div className="flex gap-1.5 overflow-x-auto shrink-0">
              <button onClick={() => setActiveFilter("all")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all border whitespace-nowrap cursor-pointer ${
                  activeFilter === "all" ? "theme-bg-light theme-text theme-border-light" : "bg-slate-900/20 border-slate-800 text-slate-400 hover:text-slate-200"
                }`}>
                Alle ({cosmetics.length})
              </button>
              {COSMETIC_TYPES.map(t => {
                const count = cosmetics.filter(c => c.type === t).length;
                const typeCfg = TYPE_ICONS[t];
                const TypeIcon = typeCfg?.icon || Gift;
                return (
                  <button key={t} onClick={() => setActiveFilter(t)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all border whitespace-nowrap cursor-pointer ${
                      activeFilter === t ? "theme-bg-light theme-text theme-border-light" : "bg-slate-900/20 border-slate-800 text-slate-400 hover:text-slate-200"
                    }`}>
                    <TypeIcon className="w-3.5 h-3.5" />
                    {typeCfg?.label || t} ({count})
                  </button>
                );
              })}
            </div>

            {/* Cosmetics Grid */}
            <div className="flex-1 overflow-y-auto custom-scrollbar pr-1">
              {loadingCosmetics ? (
                <div className="flex items-center justify-center py-16">
                  <RefreshCw className="w-6 h-6 theme-text animate-spin" />
                </div>
              ) : cosmeticsError ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <AlertCircle className="w-10 h-10 text-amber-400" />
                  <p className="text-sm text-slate-400">Cosmetics konnten nicht geladen werden</p>
                  <p className="text-xs text-slate-500">{cosmeticsError}</p>
                  <button onClick={fetchCosmetics} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-xs font-bold text-slate-200 transition-all">Erneut versuchen</button>
                </div>
              ) : filteredCosmetics.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Sparkles className="w-12 h-12 text-slate-600" />
                  <p className="text-sm font-bold text-slate-400">
                    {activeFilter === "all" ? "Keine Cosmetics vorhanden" : `Keine Cosmetics vom Typ "${activeFilter}"`}
                  </p>
                  <p className="text-xs text-slate-500">Cosmetics können im Admin Panel verwaltet werden.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {filteredCosmetics.map((cosmetic, idx) => {
                    const rarityCfg = RARITY_CONFIG[cosmetic.rarity] || RARITY_CONFIG.common;
                    const RarityIcon = rarityCfg.icon;
                    const TypeIcon = (TYPE_ICONS[cosmetic.type]?.icon) || Gift;
                    const isSelected = selectedCosmetics[cosmetic.type] === cosmetic.id;
                    return (
                      <motion.div
                        key={cosmetic.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.03 }}
                        onClick={() => handleSelectCosmetic(cosmetic)}
                        className={`bg-slate-950/45 backdrop-blur-xl border rounded-2xl p-4 group transition-all cursor-pointer ${
                          isSelected
                            ? "theme-border-md theme-bg-subtle theme-shadow"
                            : "border-slate-800/60 hover:theme-border-light"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            {/* Preview image */}
                            <div className="w-14 h-14 rounded-xl bg-slate-900 border border-slate-800 overflow-hidden shrink-0 flex items-center justify-center relative">
                              {(cosmetic.previewUrl || cosmetic.slug) ? (
                                <img 
                                  src={cosmetic.previewUrl || `${API_BASE}/cosmetics/${cosmetic.slug}/image`} 
                                  alt={cosmetic.name} 
                                  className="w-full h-full object-cover"
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                              ) : (
                                <TypeIcon className="w-6 h-6 text-slate-500" />
                              )}
                              {isSelected && (
                                <div className="absolute inset-0 theme-bg-md flex items-center justify-center">
                                  <Check className="w-6 h-6 theme-text" />
                                </div>
                              )}
                            </div>
                            <div className="min-w-0">
                              <h4 className="text-sm font-black text-slate-100 truncate">{cosmetic.name}</h4>
                              <p className="text-[10px] text-slate-400 truncate mt-0.5">{cosmetic.description || "Keine Beschreibung"}</p>
                              <div className="flex items-center gap-2 mt-1.5">
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${rarityCfg.bg} ${rarityCfg.color} ${rarityCfg.border} border flex items-center gap-0.5`}>
                                  <RarityIcon className="w-2.5 h-2.5" />
                                  {cosmetic.rarity}
                                </span>
                                <span className="text-[9px] text-slate-500 font-medium flex items-center gap-0.5">
                                  <TypeIcon className="w-2.5 h-2.5" />
                                  {TYPE_ICONS[cosmetic.type]?.label || cosmetic.type}
                                </span>
                              </div>
                            </div>
                          </div>
                          {/* Selection indicator */}
                          <div className={`w-5 h-5 rounded-full border-2 transition-all shrink-0 flex items-center justify-center ${
                            isSelected ? "theme-border theme-bg" : "border-slate-600 group-hover:border-slate-400"
                          }`}>
                            {isSelected && <Check className="w-3 h-3 text-white" />}
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
