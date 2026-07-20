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
import * as THREE from "three";
import { API_BASE, getLauncherHeaders } from "../services/api";
import type { CosmeticEntity } from "../services/cosmetics";
import { parseCosmeticEntity } from "../services/cosmetics";
import {
  buildCosmeticCardViewModel,
  buildCosmeticCardViewModels,
  progressProvider,
  installCosmetic,
  uninstallCosmetic,
  computeStatusFor,
  addCosmeticListener,
  type CosmeticCardViewModel,
  type CosmeticDownloadProgress,
} from "../services/cosmetics";
import { useCosmeticRenderer } from "../services/cosmetics/hooks/useCosmeticRenderer";

// ===== Types =====
interface PlayerIdentity {
  uuid: string | null;
  username: string | null;
  type: string;
}

/**
 * View-model for the cosmetics card. Strict superset of the Phase 4
 * unified CosmeticEntity and the legacy convenience fields the
 * existing JSX consumes.
 */
type CosmeticItem = CosmeticEntity & {
  // Legacy convenience fields used by the existing card renderer.
  name: string;
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
  fileCount: number;
};

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

// ===== View-model mapper =====

/**
 * Project a Phase 4 CosmeticEntity to the legacy view-model shape the
 * existing card render and selection logic consume. Pure function.
 */
function toCosmeticItem(entity: CosmeticEntity): CosmeticItem {
  return {
    ...entity,
    name: entity.displayName,
    type: entity.metadata.category,
    rarity: entity.metadata.rarity,
    accentColor: entity.metadata.accentColor || "",
    previewUrl: entity.declaredPreviewUrl || "",
    imageUrl: entity.declaredPreviewUrl || "",
    modelUrl: "", // Populated by 3D renderer from disk IPC or server API
    fileCount: entity.files.length,
    isActive: entity.isActive,
    sortOrder: entity.sortOrder,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

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


// ===== Module-level cache for Blockbench renderer =====
var _defaultCosmeticTexture: THREE.Texture | null = null;
function getDefaultCosmeticTexture(): THREE.Texture {
  if (!_defaultCosmeticTexture) {
    var pixelCanvas = document.createElement('canvas');
    pixelCanvas.width = 1;
    pixelCanvas.height = 1;
    var pixelCtx = pixelCanvas.getContext('2d');
    if (pixelCtx) {
      pixelCtx.fillStyle = '#888';
      pixelCtx.fillRect(0, 0, 1, 1);
    }
    _defaultCosmeticTexture = new THREE.CanvasTexture(pixelCanvas);
    _defaultCosmeticTexture.magFilter = THREE.NearestFilter;
    _defaultCosmeticTexture.minFilter = THREE.NearestFilter;
  }
  return _defaultCosmeticTexture;
}


export const CosmeticsView: React.FC<CosmeticsViewProps> = ({ activeAccount }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  const blockbenchGroupRef = useRef<THREE.Group | null>(null);
  const loadedBlockbenchRef = useRef<string | null>(null);
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
  // ===== Phase 5: card view-models + install jobs =====
  const [cardVMs, setCardVMs] = useState<CosmeticCardViewModel[]>([]);
  const [installJobs, setInstallJobs] = useState<Record<string, CosmeticDownloadProgress>>({});

  const buildCards = useCallback(async () => {
    try {
      const ctx = progressProvider.toContext();
      const { getAllCosmetics } = await import("../services/cosmetics");
      const ents = getAllCosmetics();
      const vms = await buildCosmeticCardViewModels(ents, ctx);
      setCardVMs(vms);
    } catch (err) {
      console.warn("[Cosmetics] card VM build failed:", err);
    }
  }, []);

  useEffect(() => {
    if (!loadingCosmetics && cosmetics.length) buildCards();
  }, [loadingCosmetics, cosmetics, buildCards]);

  useEffect(() => {
    const unsub = progressProvider.subscribe(() => { buildCards(); });
    return () => { unsub(); };
  }, [buildCards]);
  const handleUninstall = useCallback(async (card: CosmeticCardViewModel) => {
    const { getCosmeticById } = await import("../services/cosmetics");
    const ent = getCosmeticById(card.id);
    if (!ent) return;
    try {
      await uninstallCosmetic(ent.id);
    } catch (err) {
      console.warn("[Cosmetics] uninstall failed:", err);
    } finally {
      buildCards();
    }
  }, [buildCards]);

;

  useEffect(() => {
    const unsub = addCosmeticListener((evt) => {
      if (evt.type === "status_changed" || evt.type === "installed" || evt.type === "error") {
        buildCards();
      } else if (evt.type === "progress") {
        setInstallJobs((prev) => ({ ...prev, [evt.progress.cosmeticId]: evt.progress }));
      }
    });
    return () => { unsub(); };
  }, [buildCards]);

  const handleInstall = useCallback(async (card: CosmeticCardViewModel) => {
    const { getCosmeticById } = await import("../services/cosmetics");
    const ent = getCosmeticById(card.id);
    if (!ent) return;
    setInstallJobs((prev) => ({
      ...prev,
      [card.id]: {
        cosmeticId: card.id, status: "downloading",
        bytesInstalled: 0, bytesTotal: card.statusInfo.bytesTotal,
        percent: 0, startedAt: Date.now(),
      },
    }));
    try {
      var result = await installCosmetic(ent, { highPriority: true });
      console.log("[Cosmetics] handleInstall: installCosmetic returned", result);
    } catch (err) {
      console.warn("[Cosmetics] install failed:", err);
      setInstallJobs((prev) => prev[card.id] ? {
        ...prev,
        [card.id]: { ...prev[card.id], status: "error", lastError: String(err) },
      } : prev);
    } finally {
      // ALWAYS refresh cards so the badge reflects the new status (success OR error)
      buildCards();
    }
  }, [buildCards]);

    // Subscribe to live cosmetic progress from Minecraft client (via Electron IPC)
  useEffect(() => {
    if (!window.electronAPI?.onCosmeticProgress) return;
    const unsub = window.electronAPI.onCosmeticProgress(function(data) {
      if (data && typeof data === 'object') {
        progressProvider.update({
          playtimeHours: data.playtimeHours,
          blocksMined: data.blocksMined,
          mobsKilled: data.mobsKilled,
          playerKills: data.playerKills,
          distanceTraveled: data.distanceTraveled,
          achievements: data.achievements,
        } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      }
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, []);

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
      const res = await fetch(`${API_BASE}/content/cosmetics?active=true&limit=100`, {
        headers: getLauncherHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const raws = (Array.isArray(data?.data) ? data.data : []) as unknown[];
      const items: CosmeticItem[] = raws
        .map((raw) => {
          try {
            return toCosmeticItem(parseCosmeticEntity(raw));
          } catch {
            return null;
          }
        })
        .filter((x): x is CosmeticItem => x !== null);
      setCosmetics(items);
    } catch (err: any) {
      setCosmeticsError(err.message);
    } finally {
      setLoadingCosmetics(false);
    }
  }, []);

  useEffect(() => { fetchCosmetics(); }, [fetchCosmetics]);

  // ===== Selection =====

  // ===== 3D Cosmetic Preview with Blockbench Model Renderer =====
  const blockbenchCancelledRef = useRef(false);

  useEffect(() => {
    try {
    const viewer = viewerRef.current;
    if (!viewer) { console.log('[Cosmetics] 3D effect: no viewer, skipping'); return; }

    // Find which cosmetic type has a selection
    var selectedTypes = Object.keys(selectedCosmetics);
    if (selectedTypes.length === 0) {
      clearBlockbenchModel(viewer, blockbenchGroupRef);
      viewer.loadCape(null);
      loadedBlockbenchRef.current = null;
      return;
    }

    // Get the first selected cosmetic
    var selectedType = selectedTypes[0];
    var selectedId = selectedCosmetics[selectedType];
    var cosmetic = cosmetics.find(function(c) { return c.id === selectedId; });
    if (!cosmetic) {
      clearBlockbenchModel(viewer, blockbenchGroupRef);
      viewer.loadCape(null);
      loadedBlockbenchRef.current = null;
      return;
    }

    var slug = (cosmetic as any).slug || cosmetic.id;

    // Always load cape texture (works for cape-type cosmetics and preview)
    var url = cosmetic.previewUrl || cosmetic.imageUrl || API_BASE + '/content/cosmetics/' + cosmetic.id + '/image';
    if (url) {
      viewer.loadCape(url).catch(function() {});
    } else {
      viewer.loadCape(null);
    }

    // Cancel previous load
    blockbenchCancelledRef.current = false;

    // Load Blockbench model from disk or server
    blockbenchCancelledRef.current = false;
    loadBlockbenchModel(slug, viewer, blockbenchGroupRef, blockbenchCancelledRef, loadedBlockbenchRef, 0).catch(function(err) {
      console.warn('[Cosmetics] Blockbench model load failed:', err);
    });

  } catch(e) { console.error('[Cosmetics] 3D effect CRASHED:', e && e.message); }
  }, [selectedCosmetics, cosmetics]);

  /** Helper: clear previously loaded Blockbench model from viewer scene */
  function clearBlockbenchModel(
    viewer: SkinViewer,
    groupRef: React.MutableRefObject<THREE.Group | null>
  ) {
    if (groupRef.current) {
      viewer.scene.remove(groupRef.current);
      groupRef.current.traverse(function(child: any) {
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(function(m: any) { if (m.map) m.map.dispose(); m.dispose(); });
          } else {
            if (child.material.map) child.material.map.dispose();
            child.material.dispose();
          }
        }
        if (child.geometry) child.geometry.dispose();
      });
      groupRef.current = null;
    }
  }

  /** Load a Blockbench model from disk or server and add to viewer scene */
  async function loadBlockbenchModel(
    slug: string,
    viewer: SkinViewer,
    groupRef: React.MutableRefObject<THREE.Group | null>,
    cancelledRef: React.MutableRefObject<boolean>,
    loadedRef: React.MutableRefObject<string | null>,
    retryCount: number = 0
  ) {
    console.log('[Cosmetics] loadBlockbenchModel START — slug =', slug, ', retry =', retryCount);
    // Clear previous model
    clearBlockbenchModel(viewer, groupRef);

    if (cancelledRef.current) { console.log('[Cosmetics] loadBlockbenchModel: cancelled'); return; }

    // Try to load from local disk first
    var jsonPath = 'cosmetics/' + slug + '/model.json';
    console.log('[Cosmetics] loadBlockbenchModel: trying disk read — path =', jsonPath);
    var jsonContent = '';
    var loadedFromDisk = false;

    if (window.electronAPI && window.electronAPI.readCosmeticFile) {
      try {
        var result = await window.electronAPI.readCosmeticFile(jsonPath);
        console.log('[Cosmetics] loadBlockbenchModel: IPC read result =', result ? { success: result.success, type: result.type, hasData: !!result.data } : 'null');
        if (result && result.success && result.data) {
          jsonContent = result.data;
          loadedFromDisk = true;
          console.log('[Cosmetics] loadBlockbenchModel: model.json LOADED FROM DISK ✓');
        } else {
          console.log('[Cosmetics] loadBlockbenchModel: model.json NOT on disk —', result && result.error);
        }
      } catch (e) {
        console.log('[Cosmetics] loadBlockbenchModel: IPC error —', e && e.message);
      }
    } else {
      console.log('[Cosmetics] loadBlockbenchModel: readCosmeticFile not available on window.electronAPI');
    }

    if (cancelledRef.current) return;

    // If not on disk, try fetching from server API
    if (!jsonContent) {
      try {
        var serverUrl = API_BASE + '/content/cosmetics/' + slug + '/model';
        console.log('[Cosmetics] loadBlockbenchModel: trying server —', serverUrl);
        var resp = await fetch(serverUrl, { headers: getLauncherHeaders() });
        console.log('[Cosmetics] loadBlockbenchModel: server response —', resp.status, resp.statusText);
        if (resp.ok) {
          jsonContent = await resp.text();
          console.log('[Cosmetics] loadBlockbenchModel: model.json LOADED FROM SERVER ✓');
        }
      } catch (e) {
        console.log('[Cosmetics] loadBlockbenchModel: server error —', e && e.message);
      }
    }

    if (cancelledRef.current) return;

    if (!jsonContent) {
      console.log('[Cosmetics] loadBlockbenchModel: NO model data found for', slug);
      throw new Error('No model data found for: ' + slug);
    }

    console.log('[Cosmetics] loadBlockbenchModel: JSON content length =', jsonContent.length);
    var modelData = JSON.parse(jsonContent);
    console.log('[Cosmetics] loadBlockbenchModel: JSON PARSED ✓ — elements =', (modelData.elements || []).length, ', textures =', (modelData.textures || []).length);

    if (cancelledRef.current) return;

    // 1) LOAD TEXTURES FIRST, then build meshes
    var textures = modelData.textures || [];
    var loadedTextures: Record<string, THREE.Texture | null> = {};

    for (var ti = 0; ti < textures.length; ti++) {
      if (cancelledRef.current) return;
      var texRef = textures[ti];
      if (texRef && texRef.source) {
        try {
          var texPath = 'cosmetics/' + slug + '/' + texRef.source;
          var texture = await loadSingleTexture(texPath, cancelledRef);
          loadedTextures[String(ti)] = texture;
        } catch (e) {
          loadedTextures[String(ti)] = null;
        }
      }
    }

    if (cancelledRef.current) return;

    // 2) BUILD MESHES with loaded textures
    var group = buildBlockbenchMeshes(modelData, loadedTextures);

    if (cancelledRef.current) return;

    if (!group) {
      if (retryCount < 2) {
      await new Promise(function(r) { setTimeout(r, 500); });
      if (cancelledRef.current) { throw new Error('Cancelled'); }
      return loadBlockbenchModel(slug, viewer, groupRef, cancelledRef, loadedRef, retryCount + 1);
    }
      throw new Error('No meshes built from model after ' + (retryCount + 1) + ' attempts');
    }

    // Position the model in front of the player
    group.position.set(0, -1.2, -1.5);
    group.scale.set(0.8, 0.8, 0.8);

    viewer.scene.add(group);
    console.log('[Cosmetics] loadBlockbenchModel: viewer.scene.add(group) ✓ — group has', group.children.length, 'meshes');
    groupRef.current = group;
    loadedRef.current = slug;
    console.log('[Cosmetics] loadBlockbenchModel: RENDERING COMPLETE ✓ — slug =', slug);
  }

  /** Load a single texture file from disk or server */
  async function loadSingleTexture(texPath: string, cancelledRef?: React.MutableRefObject<boolean>): Promise<THREE.Texture | null> {
    var imageSrc: string | null = null;

    if (window.electronAPI && window.electronAPI.readCosmeticFile) {
      try {
        var result = await window.electronAPI.readCosmeticFile(texPath);
        if (result && result.success && result.data && result.type === 'image') {
          imageSrc = result.data;
        }
      } catch (e) {}
    }

    if (!imageSrc) {
      return null;
    }

    return new Promise<THREE.Texture | null>(function(resolve) {
      var img = new window.Image();
      img.onload = function() {
        if (cancelledRef && cancelledRef.current) { resolve(null); return; }
        // Use CanvasTexture instead of Texture constructor (Three.js version compat)
        var canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        var ctx = canvas.getContext('2d');
        if (ctx) ctx.drawImage(img, 0, 0);
        var tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        resolve(tex);
      };
      img.onerror = function() { resolve(null); };
      img.src = imageSrc!;
    });
  }

  /** Convert Blockbench elements to Three.js meshes with textures */
  function buildBlockbenchMeshes(
    modelData: any,
    loadedTextures: Record<string, THREE.Texture | null>
  ): THREE.Group | null {
    if (!modelData.elements || !Array.isArray(modelData.elements) || modelData.elements.length === 0) {
      return null;
    }

    var group = new THREE.Group();
    var elements = modelData.elements;

    // Use cached default pixel texture
    var defaultTexture = getDefaultCosmeticTexture();

    // Face order mapping: Blockbench face name -> Three.js BoxGeometry face index
    // BoxGeometry faces: +x(0), -x(1), +y(2), -y(3), +z(4), -z(5)
    // Blockbench: east(+x), west(-x), up(+y), down(-y), south(+z), north(-z)
    var faceOrder = ['east', 'west', 'up', 'down', 'south', 'north'];
    // Blockbench UV to Three.js UV mapping for each face
    // Blockbench UV is [u1, v1, u2, v2] where (u1,v1) is top-left and (u2,v2) is bottom-right
    // Three.js BoxGeometry UVs are 0,0 = bottom-left, 1,1 = top-right
    // Blockbench UV needs V flip: v1 becomes (1 - v1/texHeight), v2 becomes (1 - v2/texHeight)
    // But we're using NearestFilter so exact UV doesn't matter as much

    var texWidth = modelData.resolution ? modelData.resolution.width || 64 : 64;
    var texHeight = modelData.resolution ? modelData.resolution.height || 64 : 64;

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!el.from || !el.to) continue;

      var from = el.from;
      var to = el.to;
      var dx = to[0] - from[0];
      var dy = to[1] - from[1];
      var dz = to[2] - from[2];
      if (dx <= 0 || dy <= 0 || dz <= 0) continue;

      var centerX = (from[0] + to[0]) / 2;
      var centerY = (from[1] + to[1]) / 2;
      var centerZ = (from[2] + to[2]) / 2;

      // Scale down Blockbench coords (16px = 1 block in MC)
      var SCALE = 0.05;

      var geometry = new THREE.BoxGeometry(dx * SCALE, dy * SCALE, dz * SCALE);

      // Build materials for each face
      var materials: THREE.MeshBasicMaterial[] = [];

      for (var fi = 0; fi < 6; fi++) {
        var faceName = faceOrder[fi];
        var faceData = el.faces ? el.faces[faceName] : null;

        var material: THREE.MeshBasicMaterial;

        if (faceData && faceData.texture !== undefined) {
          var texIdx = faceData.texture;
          if (typeof texIdx === 'string' && texIdx.startsWith('#')) {
            texIdx = parseInt(texIdx.substring(1), 10);
          }
          var texture = loadedTextures[String(texIdx)] || defaultTexture;

          // Get UV from face data
          var uv = faceData.uv || [0, 0, 16, 16];
          // Create a texture with UV offset for this face
          // For simplicity, use the full texture with UV transform
          // Three.js doesn't support per-face UV offset on BoxGeometry easily
          // So we use a cloned texture with offset/repeat

          var faceTex = texture;
          if (texture && texture !== defaultTexture && faceData.uv) {
            faceTex = texture.clone();
            var uvWidth = (uv[2] - uv[0]) / texWidth;
            var uvHeight = (uv[3] - uv[1]) / texHeight;
            faceTex.repeat.set(uvWidth, uvHeight);
            faceTex.offset.set(uv[0] / texWidth, 1 - uv[3] / texHeight);
            faceTex.needsUpdate = true;
          }

          material = new THREE.MeshBasicMaterial({
            map: faceTex,
            transparent: true,
            alphaTest: 0.1,
            depthWrite: true,
            side: THREE.DoubleSide,
          });
        } else {
          // No texture for this face - use light gray
          material = new THREE.MeshBasicMaterial({
            color: new THREE.Color(0xaaaaaa),
            transparent: true,
            side: THREE.DoubleSide,
          });
        }

        materials.push(material);
      }

      var mesh = new THREE.Mesh(geometry, materials);
      mesh.position.set(centerX * SCALE, centerY * SCALE, centerZ * SCALE);

      // Apply rotation if specified
      if (el.rotation) {
        var r = el.rotation;
        var angleRad = (r.angle || 0) * Math.PI / 180;
        var axis = r.axis || 'x';
        var origin = r.origin || [8, 8, 8];

        // Position relative to origin
        mesh.position.set(
          (centerX - origin[0]) * SCALE,
          (centerY - origin[1]) * SCALE,
          (centerZ - origin[2]) * SCALE
        );

        // Apply rotation around origin
        var quat = new THREE.Quaternion();
        var axisVec = new THREE.Vector3(
          axis === 'x' ? 1 : 0,
          axis === 'y' ? 1 : 0,
          axis === 'z' ? 1 : 0
        );
        quat.setFromAxisAngle(axisVec, angleRad);
        mesh.quaternion.copy(quat);

        // Translate back
        mesh.position.x += origin[0] * SCALE;
        mesh.position.y += origin[1] * SCALE;
        mesh.position.z += origin[2] * SCALE;
      }

      group.add(mesh);
    }

    return group.children.length > 0 ? group : null;
  }

  const handleSelectCosmetic = (cosmetic: CosmeticItem) => {
    if (!cosmetic || !cosmetic.type) { console.log("[Cosmetics] handleSelectCosmetic: invalid cosmetic"); return; }
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


  const filteredCosmetics = cosmetics.filter((c) => {
    if (activeFilter !== "all" && c.type !== activeFilter) return false;
    // Phase 5: lockVisibility === 'hidden' AND not yet unlocked -> hide from grid.
    const vm = cardVMs.find((m) => m.id === c.id);
    const hidden = (c.metadata && c.metadata.lockVisibility) === 'hidden';
    if (!hidden) return true;
    return vm ? vm.unlock.unlocked : false;
  });

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
            {/* Type Filter */}
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
                const cardVM =
                cardVMs.find((c) => c.id === cosmetic.id);
                const phase5vm = cardVM;
                const installProgress = installJobs[cosmetic.id];
                const isLocked = !!cardVM && !cardVM.unlock.unlocked;
                const phase5ModuleOk = !!cardVM;
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
                              {(cosmetic.fileCount > 0 && (cosmetic.previewUrl || cosmetic.id)) ? (
                                <img 
                                  src={cosmetic.previewUrl || `${API_BASE}/content/cosmetics/${cosmetic.id}/image`} 
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
                                {/* Phase 5 install button */}
                                {phase5ModuleOk && cardVM && cardVM.status !== 'installed' && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleInstall(cardVM); }}
                                    disabled={cardVM.status === 'downloading'}
                                    style={{
                                      fontSize: '10px', fontWeight: 700,
                                      padding: '4px 8px', borderRadius: '6px',
                                      color: '#fff', cursor: cardVM.status === 'downloading' ? 'wait' : 'pointer',
                                      background:
                                        cardVM.status === 'error' ? '#ef4444' :
                                        cardVM.status === 'update_available' ? '#f59e0b' :
                                        '#10b981',
                                      border: 'none', marginLeft: 'auto',
                                      opacity: cardVM.status === 'downloading' ? 0.7 : 1,
                                    }}>
                                    {cardVM.status === 'downloading'
                                      ? `⬇ ${installJobs[cardVM.id]?.percent ?? cardVM.statusInfo.percent ?? 0}%`
                                      : cardVM.status === 'error' ? '↻ Erneut versuchen'
                                      : cardVM.status === 'update_available' ? '↻ Update installieren'
                                      : '⬇ Installieren'}
                                  </button>
                                )}
                                {phase5ModuleOk && cardVM && cardVM.status === 'installed' && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleUninstall(cardVM); }}
                                    style={{
                                      fontSize: '10px', fontWeight: 700,
                                      padding: '4px 8px', borderRadius: '6px',
                                      color: '#94a3b8', cursor: 'pointer',
                                      background: 'rgba(148,163,184,0.10)',
                                      border: '1px solid rgba(148,163,184,0.30)', marginLeft: '4px',
                                    }}>
                                    Deinstallieren
                                  </button>
                                )}

                                                                {/* Phase 5 progress bar (when downloading) */}
                                {phase5ModuleOk && cardVM && cardVM.status === 'downloading' && (
                                  <div style={{ width: '100px', height: '4px', background: 'rgba(148,163,184,0.20)', borderRadius: '2px', overflow: 'hidden', marginLeft: 'auto' }}>
                                    <div style={{
                                      width: `${installJobs[cardVM.id]?.percent ?? cardVM.statusInfo.percent ?? 0}%`,
                                      height: '100%', background: '#3b82f6', transition: 'width 0.2s',
                                    }} />
                                  </div>
                                )}

                              </div>
                            </div>
                          </div>
                          
                          {/* Phase 5 status badge */}
                          {phase5ModuleOk && (
                            <span title={installProgress ? `Download: ${installProgress.status}` : cardVM?.status}
                              style={{
                                fontSize: '9px', fontWeight: 700,
                                padding: '2px 6px', borderRadius: '999px',
                                color:
                                  !cardVM || cardVM.status === 'not_installed' ? '#94a3b8' :
                                  cardVM.status === 'installed' ? '#22c55e' :
                                  cardVM.status === 'downloading' ? '#3b82f6' :
                                  cardVM.status === 'update_available' ? '#f59e0b' :
                                  '#ef4444',
                                background:
                                  !cardVM || cardVM.status === 'not_installed' ? 'rgba(148,163,184,0.10)' :
                                  'rgba(34,197,94,0.12)',
                                border: '1px solid rgba(148,163,184,0.30)',
                              }}>
                              {!cardVM || cardVM.status === 'not_installed' ? '— NICHT INSTALLIERT' :
                                cardVM.status === 'installed' ? '✓ INSTALLIERT' :
                                cardVM.status === 'downloading' ? `⬇ ${installProgress?.percent ?? cardVM.statusInfo.percent ?? 0}%` :
                                cardVM.status === 'update_available' ? '↻ UPDATE' :
                                '✕ FEHLER'}
                            </span>
                          )}
                          {/* Numeric unlock progress bar */}
                          {phase5ModuleOk && isLocked && cardVM && cardVM.unlock.missingRequirements[0]?.progressPct != null && (
                            <div style={{ width: '100%', marginTop: '2px' }}>
                              <div style={{ width: '100%', height: '4px', background: 'rgba(148,163,184,0.15)', borderRadius: '2px', overflow: 'hidden' }}>
                                <div style={{
                                  width: cardVM.unlock.missingRequirements[0].progressPct + '%',
                                  height: '100%',
                                  background: 'linear-gradient(90deg, #f59e0b, #f97316)',
                                  borderRadius: '2px',
                                  transition: 'width 0.5s ease',
                                }} />
                              </div>
                            </div>
                          )}
                                                   {/* Phase 5 lock badge */}
                          {phase5ModuleOk && isLocked && (
                            <span title={cardVM?.unlock.shortMessage}
                              style={{
                                fontSize: '9px', fontWeight: 700,
                                padding: '2px 6px', borderRadius: '999px',
                                color: cardVM?.unlock.missingRequirements[0]?.progressPct != null ? '#fbbf24' : '#f97316',
                                background: 'rgba(251,191,36,0.10)',
                                border: '1px solid rgba(251,191,36,0.30)',
                              }}>
                              🔒 {cardVM?.unlock.missingRequirements[0]?.detail || 'GESPERRT'}
                            </span>
                          )}
                          {phase5ModuleOk && !isLocked && cardVM && cardVM.unlock.reasonKey !== 'always_available' && (
                            <span style={{
                              fontSize: '9px', fontWeight: 700,
                              padding: '2px 6px', borderRadius: '999px',
                              color: '#22c55e', background: 'rgba(34,197,94,0.10)',
                              border: '1px solid rgba(34,197,94,0.30)',
                            }}>✓ FREIGESCHALTET</span>
                          )}

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
