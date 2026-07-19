import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Play, 
  Edit3, 
  Plus, 
  Search, 
  Users, 
  Wifi, 
  Globe,
  X,
  PlusCircle,
  Activity,
  RefreshCw,
  Trash2,
  Cpu,
  Check,
  LogIn,
  Settings as SettingsIcon
} from "lucide-react";
import { TabType } from "./Sidebar";
import { translations, LanguageType } from "../lib/translations";
import { Account } from "./TopBar";
import { Instance } from "./InstancesView";

export interface ServerItem {
  id: string;
  name: string;
  ip: string;
  motd: string;
  onlinePlayers: number;
  maxPlayers: number;
  ping: number;
  version: string;
  icon: string;
  isPinging?: boolean;
  online?: boolean;
}

interface MultiplayerViewProps {
  setActiveTab: (tab: TabType) => void;
  searchQuery: string;
  lang: LanguageType;
  instances: Instance[];
  servers: ServerItem[];
  setServers: React.Dispatch<React.SetStateAction<ServerItem[]>>;
  onLaunchGame?: (instanceName: string) => void;
  activeAccount?: Account;
}

// Simple Minecraft MOTD formatter helper
const formatMOTD = (text: string) => {
  if (!text) return <span className="text-slate-500">No description available</span>;
  
  const parts = text.split(/(§[0-9a-fklmnor])/);
  let currentStyle: React.CSSProperties = {};
  
  const colorMap: Record<string, string> = {
    "§0": "#000000", "§1": "#0000aa", "§2": "#00aa00", "§3": "#00aaaa",
    "§4": "#aa0000", "§5": "#aa00aa", "§6": "#ffaa00", "§7": "#aaaaaa",
    "§8": "#555555", "§9": "#5555ff", "§a": "#55ff55", "§b": "#55ffff",
    "§c": "#ff5555", "§d": "#ff55ff", "§e": "#ffff55", "§f": "#ffffff",
  };

  return parts.map((part, index) => {
    if (part.startsWith("§")) {
      const code = part.toLowerCase();
      if (colorMap[code]) {
        currentStyle = { ...currentStyle, color: colorMap[code] };
      } else if (code === "§l") {
        currentStyle = { ...currentStyle, fontWeight: "bold" };
      } else if (code === "§o") {
        currentStyle = { ...currentStyle, fontStyle: "italic" };
      } else if (code === "§r") {
        currentStyle = {};
      }
      return null;
    }
    return (
      <span key={index} style={{ ...currentStyle }} className="tracking-wide">
        {part}
      </span>
    );
  });
};

export const MultiplayerView: React.FC<MultiplayerViewProps> = ({ 
  setActiveTab, 
  searchQuery: initialSearch,
  lang,
  instances,
  servers,
  setServers,
  onLaunchGame,
  activeAccount
}) => {
  const t = translations[lang];
  const [search, setSearch] = useState(initialSearch);
  const [addModalOpen, setAddModalOpen] = useState(false);
  
  // Edit modal state (handles renaming AND deletion!)
  const [editingServer, setEditingServer] = useState<ServerItem | null>(null);
  const [editName, setEditName] = useState("");

  // Play popup state (for choosing instance to join with!)
  const [joiningServer, setJoiningServer] = useState<ServerItem | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>("");
  const [launchStep, setLaunchStep] = useState<"idle" | "launching" | "connecting">("idle");

  // States for searched IP status (dynamic querying)
  const [searchedServerStatus, setSearchedServerStatus] = useState<ServerItem | null>(null);
  const [isSearchingIP, setIsSearchingIP] = useState(false);

  // Form states
  const [newServerName, setNewServerName] = useState("");
  const [newServerIP, setNewServerIP] = useState("");

  // Function to ping a server
  const pingServer = async (server: ServerItem): Promise<ServerItem> => {
    try {
      const result = await window.electronAPI?.pingServer?.(server.ip);
      if (!result) throw new Error("No ping result");
      if (result.online) {
        return {
          ...server,
          onlinePlayers: result.playersOnline,
          maxPlayers: result.playersMax,
          motd: result.motd || server.motd,
          ping: result.ping,
          version: result.version || server.version,
          icon: result.icon || server.icon,
          online: true,
          isPinging: false
        };
      } else {
        return { ...server, online: false, isPinging: false, ping: 999 };
      }
    } catch (e) {
      return { ...server, online: false, isPinging: false, ping: 999 };
    }
  };

  // Ping all servers on mount or refresh
  const pingAllServers = async () => {
    if (servers.length === 0) return;
    setServers(prev => prev.map(s => ({ ...s, isPinging: true })));
    const updated = await Promise.all(servers.map(s => pingServer(s)));
    setServers(updated);
  };

  useEffect(() => {
    pingAllServers();
  }, []);

  // Dynamic IP Search & Fetch Logic
  useEffect(() => {
    const isIPPattern = search.includes(".") || search.toLowerCase() === "localhost";
    
    if (isIPPattern && search.length > 3) {
      const delayDebounce = setTimeout(async () => {
        setIsSearchingIP(true);
        setSearchedServerStatus(null);
        
        try {
          const result = await window.electronAPI?.pingServer?.(search);
          if (!result) throw new Error("No result");
          
          if (result.online) {
            setSearchedServerStatus({
              id: "searched_ip",
              name: search,
              ip: search,
              motd: result.motd || "Online Server",
              onlinePlayers: result.playersOnline,
              maxPlayers: result.playersMax,
              ping: result.ping,
              version: result.version || "1.21.4",
              icon: result.icon || "https://api.mineatar.io/face/c06f89064c8a49119c29ea1dbd1aab82?scale=8",
              online: true,
              isPinging: false
            });
          } else {
            setSearchedServerStatus({
              id: "searched_ip_offline",
              name: search,
              ip: search,
              motd: "§cServer is offline or unreachable.",
              onlinePlayers: 0,
              maxPlayers: 0,
              ping: 999,
              version: "N/A",
              icon: "https://api.mineatar.io/face/c06f89064c8a49119c29ea1dbd1aab82?scale=8",
              online: false,
              isPinging: false
            });
          }
        } catch (e) {
          // offline fallback
        } finally {
          setIsSearchingIP(false);
        }
      }, 800);

      return () => clearTimeout(delayDebounce);
    } else {
      setSearchedServerStatus(null);
      setIsSearchingIP(false);
    }
  }, [search]);

  // Form handlers
  const handleAddServer = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newServerName.trim() || !newServerIP.trim()) return;

    const newServer: ServerItem = {
      id: `s_${Date.now()}`,
      name: newServerName,
      ip: newServerIP,
      motd: `§ePinging server...`,
      onlinePlayers: 0,
      maxPlayers: 100,
      ping: 0,
      version: "1.21.4",
      icon: "https://api.mineatar.io/face/c06f89064c8a49119c29ea1dbd1aab82?scale=8",
      isPinging: true
    };

    setServers(prev => [...prev, newServer]);
    setAddModalOpen(false);
    setNewServerName("");
    setNewServerIP("");

    // Trigger ping for the newly added server
    setTimeout(async () => {
      const updated = await pingServer(newServer);
      setServers(prev => prev.map(s => s.id === newServer.id ? updated : s));
    }, 500);
  };

  // Edit modal action: Save Name
  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName.trim() || !editingServer) return;
    setServers(prev => prev.map(s => s.id === editingServer.id ? { ...s, name: editName } : s));
    setEditingServer(null);
  };

  // Edit modal action: Delete Server
  const handleDeleteServerFromEdit = () => {
    if (!editingServer) return;
    setServers(prev => prev.filter(s => s.id !== editingServer.id));
    setEditingServer(null);
  };

  // Launch and Join Server Process (Requirement 5!)
  const triggerLaunchAndJoin = () => {
    if (!joiningServer || !selectedInstanceId) return;

    setLaunchStep("launching");

    const selectedInst = instances.find(i => i.id === selectedInstanceId);
    if (!selectedInst) return;

    const folderName = selectedInst.name.toLowerCase().replace(/\s+/g, "-");
    window.electronAPI?.launchGame?.({
      folderName,
      profileName: selectedInst.name,
      version: selectedInst.minecraftVersion,
      ram: 4,
      modLoader: selectedInst.modloader === "Vanilla" ? "vanilla" : selectedInst.modloader.toLowerCase(),
      loaderVersion: selectedInst.modloaderVersion || "",
      javaPath: selectedInst.javaVersion === "Automatisch" ? "" : (selectedInst.javaVersion || ""),
      authData: { type: "offline", name: "Spieler" },
      gameOptions: { joinServer: joiningServer.ip.split(":")[0], joinPort: parseInt(joiningServer.ip.split(":")[1]) || 25565 },
    });

    onLaunchGame?.(selectedInst.name);

    const unsubReady = window.electronAPI?.onGameReady?.(() => {
      setLaunchStep("idle");
      setJoiningServer(null);
      unsubReady?.();
    });
  };

  const handleOpenJoinPopup = (server: ServerItem) => {
    setJoiningServer(server);
    setLaunchStep("idle");
    if (instances.length > 0) {
      setSelectedInstanceId(instances[0].id);
    } else {
      setSelectedInstanceId("");
    }
  };

  const filteredServers = servers.filter(s => 
    s.name.toLowerCase().includes(search.toLowerCase()) || 
    s.ip.toLowerCase().includes(search.toLowerCase())
  );

  // ===== OFFLINE USER CHECK =====
  const isOfflineUser = !activeAccount || activeAccount.type === "Offline" || activeAccount.username === "BambooPlayer";
  const hasMicrosoftAccount = activeAccount?.type === "Microsoft";

  if (isOfflineUser && !hasMicrosoftAccount) {
    return (
      <div className="flex-1 h-full flex items-center justify-center p-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md text-center"
        >
          <div className="w-20 h-20 rounded-3xl bg-slate-900/60 border border-slate-800/60 mx-auto flex items-center justify-center mb-6">
            <LogIn className="w-10 h-10 text-slate-500" />
          </div>
          <h2 className="text-2xl font-black text-white tracking-wide mb-3">
            {lang === "de" ? "Online-Funktionen" : "Online Features"}
          </h2>
          <p className="text-sm text-slate-400 leading-relaxed mb-6">
            {lang === "de"
              ? "Melde dich mit einem Microsoft-Konto an, um Multiplayer-Server hinzuzufügen und zu verwalten."
              : "Sign in with a Microsoft account to add and manage multiplayer servers."}
          </p>
          <div className="flex flex-col gap-3 items-center">
            <button
              onClick={() => {
                sessionStorage.setItem('bamboo-settings-category', 'accounts');
                setActiveTab("settings");
              }}
              className="px-6 py-3 rounded-xl text-sm font-bold bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white transition-all cursor-pointer shadow-lg shadow-blue-500/20"
            >
              <SettingsIcon className="w-4 h-4 inline mr-2" />
              {lang === "de" ? "Zu den Kontoeinstellungen" : "Go to Account Settings"}
            </button>
            <p className="text-[10px] text-slate-500">
              {lang === "de"
                ? "Benötigt wird ein gültiger Minecraft: Java Edition Account."
                : "Requires a valid Minecraft: Java Edition account."}
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto h-full p-6 flex flex-col gap-6 custom-scrollbar z-10 relative select-none">
      
      {/* Header Panel */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-6 shadow-2xl">
        <div className="flex items-center gap-4">
          <div>
            <h2 className="text-2xl font-black text-white tracking-wide flex items-center gap-2">
              {t.multiplayerServers}
            </h2>
            <p className="text-xs text-slate-400 mt-1">{t.multiplayerDesc}</p>
          </div>
        </div>

        {/* Buttons */}
        <div className="flex items-center gap-3">
          <button
            onClick={pingAllServers}
            className="p-3 bg-slate-900/60 hover:bg-slate-850 border border-slate-800 hover:border-slate-700 text-slate-300 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
            title="Refresh All Server Statuses"
          >
            <RefreshCw className="w-4 h-4 animate-spin-slow" />
            {t.refreshList}
          </button>
          <button
            onClick={() => setAddModalOpen(true)}
            className="theme-bg hover:theme-bg-hover text-slate-950 px-5 py-3 rounded-2xl text-xs font-black tracking-wider uppercase theme-shadow-lg hover:theme-shadow-lg transition-all duration-300 flex items-center gap-2 cursor-pointer hover:-translate-y-0.5"
          >
            <Plus className="w-4 h-4 stroke-[3]" />
            {t.addServer}
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="flex items-center gap-4 bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
        <div className="w-full md:w-80 relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.searchServers}
            className="w-full bg-slate-950/40 border border-slate-800 focus:theme-border rounded-xl py-2 pl-10 pr-4 text-xs text-slate-200 placeholder-slate-400 outline-none transition-all"
          />
        </div>
      </div>

      {/* DYNAMIC IP SEARCH CARD IF QUERYING */}
      <AnimatePresence>
        {isSearchingIP && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="p-5 theme-bg-subtle theme-border-light rounded-3xl flex items-center justify-between gap-4 text-left"
          >
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-2xl theme-bg-light theme-border-light flex items-center justify-center theme-text">
                <RefreshCw className="w-5 h-5 animate-spin" />
              </div>
              <div>
                <h4 className="text-sm font-black text-slate-200">{t.queryingIP}</h4>
                <p className="text-xs text-slate-400 mt-1">{t.connectingIP} <strong className="theme-text">"{search}"</strong>...</p>
              </div>
            </div>
          </motion.div>
        )}

        {searchedServerStatus && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="p-5 bg-slate-950/60 backdrop-blur-xl border theme-border-md rounded-3xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-left shadow-2xl animate-pulse"
          >
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-slate-900 border border-slate-850 flex items-center justify-center overflow-hidden">
                <img src={searchedServerStatus.icon} alt="Server icon" className="w-10 h-10 object-contain" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-base font-black text-slate-100">{searchedServerStatus.name}</h4>
                  <span className="text-[10px] theme-bg-light theme-text theme-border-light px-2 py-0.5 rounded font-mono">
                    {searchedServerStatus.ip}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1.5 font-mono leading-relaxed">
                  {formatMOTD(searchedServerStatus.motd)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              {searchedServerStatus.online && (
                <div className="text-right mr-2 hidden sm:block">
                  <span className="block text-xs font-black text-slate-200">
                    {searchedServerStatus.onlinePlayers.toLocaleString()} / {searchedServerStatus.maxPlayers.toLocaleString()}
                  </span>
                  <span className="text-[10px] text-slate-500 font-bold">{t.playersLive}</span>
                </div>
              )}

              <button
                onClick={() => {
                  setServers([...servers, { ...searchedServerStatus, id: `s_${Date.now()}` }]);
                  setSearch("");
                }}
                className="theme-bg hover:theme-bg-hover text-slate-950 px-4 py-2.5 rounded-xl text-xs font-black uppercase transition-all flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-4 h-4 stroke-[3]" />
                {t.addToList}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Servers List */}
      <div className="flex flex-col gap-4">
        <AnimatePresence mode="popLayout">
          {filteredServers.map((server, index) => (
            <motion.div
              key={server.id}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.25, delay: index * 0.04 }}
              className="bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-5 flex flex-col md:flex-row items-center justify-between gap-5 group hover:theme-border-md hover:shadow-2xl transition-all duration-300 relative overflow-hidden"
            >
              {/* Left Side: Icon & Details */}
              <div className="flex items-center gap-5 w-full md:w-auto">
                {/* Server Icon */}
                <div className="w-16 h-16 rounded-2xl bg-slate-900/80 border border-slate-800/80 group-hover:theme-border-light flex items-center justify-center shrink-0 overflow-hidden relative shadow-lg">
                  {server.isPinging ? (
                    <RefreshCw className="w-6 h-6 text-slate-500 animate-spin" />
                  ) : (
                    <img src={server.icon} alt={server.name} className="w-12 h-12 object-contain" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>

                {/* Name, IP, and MOTD */}
                <div className="flex flex-col text-left min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h3 className="text-lg font-black text-slate-100 group-hover:theme-text-bright transition-colors tracking-wide">
                      {server.name}
                    </h3>
                    <span className="text-[10px] text-slate-500 font-semibold bg-slate-900/40 border border-slate-850 px-2 py-0.5 rounded">
                      {server.ip}
                    </span>
                  </div>
                  
                  {/* MOTD formatted */}
                  <p className="text-xs text-slate-400 mt-2 leading-relaxed whitespace-pre-line font-mono">
                    {server.isPinging ? (
                      <span className="text-slate-500 italic animate-pulse">Checking connection status...</span>
                    ) : (
                      formatMOTD(server.motd)
                    )}
                  </p>
                </div>
              </div>

              {/* Right Side: Quick Stats & Actions */}
              <div className="flex items-center justify-between md:justify-end gap-6 w-full md:w-auto border-t md:border-t-0 border-slate-900 pt-4 md:pt-0 shrink-0">
                {/* Players & Ping */}
                <div className="flex items-center gap-6">
                  {/* Player Count */}
                  <div className="text-right">
                    <div className="flex items-center gap-1.5 justify-end text-slate-200">
                      <Users className="w-4 h-4 text-slate-400" />
                      <span className="text-sm font-black tracking-wide">
                        {server.isPinging ? "..." : server.onlinePlayers.toLocaleString()}
                      </span>
                      <span className="text-xs text-slate-500 font-medium">
                        / {server.isPinging ? "..." : server.maxPlayers.toLocaleString()}
                      </span>
                    </div>
                    {/* Player progress bar */}
                    <div className="w-28 h-1 bg-slate-900 rounded-full overflow-hidden mt-1.5">
                      <div 
                        className="h-full theme-bg rounded-full theme-glow transition-all duration-500" 
                        style={{ width: server.isPinging ? "0%" : `${(server.onlinePlayers / (server.maxPlayers || 100)) * 100}%` }}
                      />
                    </div>
                  </div>

                  {/* Ping Indicator */}
                  <div className="flex flex-col items-center justify-center bg-slate-900/40 border border-slate-850/60 px-3 py-1.5 rounded-xl">
                    <Wifi className={`w-4.5 h-4.5 ${
                      server.isPinging
                        ? "text-slate-500"
                        : server.ping < 35 
                        ? "theme-text" 
                        : server.ping < 80 
                        ? "text-amber-400" 
                        : "text-rose-400"
                    }`} />
                    <span className="text-[10px] font-bold text-slate-300 mt-0.5">
                      {server.isPinging ? "..." : `${server.ping}ms`}
                    </span>
                  </div>
                </div>

                {/* Actions (Trash bin button removed as requested, handled inside Edit properties!) */}
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => {
                      setEditingServer(server);
                      setEditName(server.name);
                    }}
                    className="p-3 bg-slate-900/40 hover:bg-slate-800/60 border border-slate-850 hover:border-slate-700 text-slate-400 hover:text-white rounded-xl transition-all cursor-pointer"
                    title={t.editServer}
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={() => handleOpenJoinPopup(server)}
                    className="p-3 theme-bg hover:theme-bg-hover text-slate-950 rounded-xl transition-all duration-300 theme-shadow-lg hover:theme-shadow-lg hover:scale-105 cursor-pointer flex items-center justify-center"
                  >
                    <Play className="w-4.5 h-4.5 fill-slate-950 stroke-[2.5]" />
                  </button>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* EMPTY STATE COMPLYING WITH REQUIREMENT 6 */}
        {servers.length === 0 && !searchedServerStatus && (
          <div className="py-24 text-center flex flex-col items-center justify-center gap-4">
            <div className="w-20 h-20 rounded-3xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 shadow-2xl">
              <Globe className="w-10 h-10" />
            </div>
            <div>
              <p className="text-base font-black text-slate-200">Keine Server hinzugefügt / No servers found</p>
              <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">Füge einen Server hinzu oder suche eine IP-Adresse, um online mit Freunden zu spielen.</p>
            </div>
            <button
              onClick={() => setAddModalOpen(true)}
              className="theme-bg hover:theme-bg-hover text-slate-950 px-5 py-2.5 rounded-xl text-xs font-black uppercase theme-shadow-lg cursor-pointer"
            >
              Server hinzufügen
            </button>
          </div>
        )}
      </div>

      {/* PLAY SERVER INSTANCE SELECTOR POPUP (Requirement 5!) */}
      <AnimatePresence>
        {joiningServer && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50"
            onClick={() => launchStep === "idle" && setJoiningServer(null)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              className="bg-slate-950 border border-slate-800/80 rounded-3xl max-w-sm w-full overflow-hidden shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              {launchStep === "idle" && (
                <>
                  <div className="p-6 border-b border-slate-900 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Play className="w-5 h-5 theme-text" />
                      <h3 className="text-base font-black text-white tracking-wide">{t.selectInstanceJoin}</h3>
                    </div>
                    <button
                      onClick={() => setJoiningServer(null)}
                      className="bg-slate-900 hover:bg-slate-800 border border-slate-800 p-2 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="p-6 flex flex-col gap-4 text-left">
                    <p className="text-xs text-slate-400 leading-normal">
                      {t.selectInstanceJoinDesc} <strong className="theme-text">{joiningServer.name}</strong> ({joiningServer.ip})
                    </p>

                    {/* Instance selector list */}
                    {instances.length > 0 ? (
                      <div className="flex flex-col gap-2 max-h-40 overflow-y-auto custom-scrollbar">
                        {instances.map(inst => (
                          <button
                            key={inst.id}
                            type="button"
                            onClick={() => setSelectedInstanceId(inst.id)}
                            className={`p-3 rounded-xl border text-left flex items-center justify-between transition-all cursor-pointer ${
                              selectedInstanceId === inst.id
                                ? "theme-bg-light theme-text theme-border-md"
                                : "bg-slate-900/20 text-slate-400 border-slate-850 hover:border-slate-800"
                            }`}
                          >
                            <span className="font-bold text-xs">{inst.name}</span>
                            <span className="text-[10px] text-slate-500">MC {inst.minecraftVersion}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-center text-xs text-rose-400">
                        Bitte erstelle zuerst eine Instanz im Instanzen-Reiter!
                      </div>
                    )}

                    <div className="flex gap-3 mt-4 pt-4 border-t border-slate-900">
                      <button
                        type="button"
                        onClick={() => setJoiningServer(null)}
                        className="flex-1 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-3 rounded-xl text-xs font-bold transition-all cursor-pointer"
                      >
                        {t.cancel}
                      </button>
                      <button
                        type="button"
                        disabled={!selectedInstanceId}
                        onClick={triggerLaunchAndJoin}
                        className="flex-1 theme-bg hover:theme-bg-hover text-slate-950 py-3 rounded-xl text-xs font-black tracking-wide theme-shadow-lg transition-all cursor-pointer disabled:opacity-50"
                      >
                        {t.launchAndJoin}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* GORGEOUS LAUNCHING / CONNECTING SCREEN */}
              {launchStep !== "idle" && (
                <div className="p-8 flex flex-col items-center justify-center gap-4 min-h-[250px]">
                  <div className="relative w-16 h-16 rounded-2xl theme-bg flex items-center justify-center shadow-2xl">
                    <RefreshCw className="w-8 h-8 text-slate-950 animate-spin" />
                    <div className="absolute inset-0 rounded-2xl border theme-border animate-ping opacity-25" />
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <h4 className="text-base font-black text-white uppercase tracking-wider">
                      {launchStep === "launching" ? t.launchingMc : t.connectingToServer}
                    </h4>
                    <p className="text-xs text-slate-500 font-medium animate-pulse">
                      {launchStep === "launching" ? "Minecraft Java Edition loading..." : joiningServer.ip}
                    </p>
                  </div>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* EDIT SERVER MODAL (Handles Renaming AND Deletion as requested!) */}
      <AnimatePresence>
        {editingServer && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50"
            onClick={() => setEditingServer(null)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              className="bg-slate-950 border border-slate-800/80 rounded-3xl max-w-sm w-full overflow-hidden shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-slate-900 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Edit3 className="w-5 h-5 theme-text" />
                  <h3 className="text-lg font-black text-white tracking-wide">{t.editServer}</h3>
                </div>
                <button
                  onClick={() => setEditingServer(null)}
                  className="bg-slate-900 hover:bg-slate-800 border border-slate-800 p-2 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleSaveEdit} className="p-6 flex flex-col gap-4 text-left">
                {/* Display Name */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">{t.displayName}</label>
                  <input
                    type="text"
                    required
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full bg-slate-900/40 border border-slate-800 focus:theme-border rounded-xl py-2.5 px-4 text-sm text-slate-200 outline-none transition-all"
                  />
                  <span className="text-[10px] text-slate-500 leading-normal">
                    {t.localRenameInfo}
                  </span>
                </div>

                {/* Server IP (Read Only) */}
                <div className="flex flex-col gap-1.5 opacity-60">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Server IP Address</label>
                  <input
                    type="text"
                    disabled
                    value={editingServer.ip}
                    className="w-full bg-slate-900/20 border border-slate-850 rounded-xl py-2.5 px-4 text-sm text-slate-400 outline-none cursor-not-allowed"
                  />
                </div>

                {/* Footer Buttons */}
                <div className="flex gap-2.5 mt-4 pt-4 border-t border-slate-900">
                  {/* Delete Server inside Edit modal as requested! */}
                  <button
                    type="button"
                    onClick={handleDeleteServerFromEdit}
                    className="bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 py-3 px-4 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 shrink-0"
                    title="Remove Server"
                  >
                    <Trash2 className="w-4 h-4" />
                    {t.delete}
                  </button>
                  
                  <button
                    type="button"
                    onClick={() => setEditingServer(null)}
                    className="flex-1 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-3 rounded-xl text-xs font-bold transition-all cursor-pointer"
                  >
                    {t.cancel}
                  </button>
                  <button
                    type="submit"
                    className="flex-1 theme-bg hover:theme-bg-hover text-slate-950 py-3 rounded-xl text-xs font-black tracking-wide theme-shadow-lg transition-all cursor-pointer"
                  >
                    {t.saveChanges}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ADD SERVER MODAL */}
      <AnimatePresence>
        {addModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50"
            onClick={() => setAddModalOpen(false)}
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
                  <PlusCircle className="w-5 h-5 theme-text" />
                  <h3 className="text-lg font-black text-white tracking-wide">{t.addServer}</h3>
                </div>
                <button
                  onClick={() => setAddModalOpen(false)}
                  className="bg-slate-900 hover:bg-slate-800 border border-slate-800 p-2 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleAddServer} className="p-6 flex flex-col gap-4 text-left">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Server Name</label>
                  <input
                    type="text"
                    required
                    value={newServerName}
                    onChange={(e) => setNewServerName(e.target.value)}
                    placeholder="My Survival Server"
                    className="w-full bg-slate-900/40 border border-slate-800 focus:theme-border rounded-xl py-2.5 px-4 text-sm text-slate-200 placeholder-slate-500 outline-none transition-all"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Server Address / IP</label>
                  <input
                    type="text"
                    required
                    value={newServerIP}
                    onChange={(e) => setNewServerIP(e.target.value)}
                    placeholder="mc.myserver.com"
                    className="w-full bg-slate-900/40 border border-slate-800 focus:theme-border rounded-xl py-2.5 px-4 text-sm text-slate-200 placeholder-slate-500 outline-none transition-all"
                  />
                </div>

                <div className="flex gap-3 mt-4 pt-4 border-t border-slate-900">
                  <button
                    type="button"
                    onClick={() => setAddModalOpen(false)}
                    className="flex-1 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-3 rounded-xl text-xs font-bold transition-all cursor-pointer"
                  >
                    {t.cancel}
                  </button>
                  <button
                    type="submit"
                    className="flex-1 theme-bg hover:theme-bg-hover text-slate-950 py-3 rounded-xl text-xs font-black tracking-wide theme-shadow-lg transition-all cursor-pointer"
                  >
                    {t.addServer}
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
