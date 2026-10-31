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
  RefreshCw,
  Trash2,
  LogIn,
  Settings as SettingsIcon,
  Share2,
  Copy,
  ExternalLink,
  ShieldCheck,
  Check
} from "lucide-react";
import { TabType } from "./Sidebar";
import { translations, LanguageType } from "../lib/translations";
import { requestSettingsTarget } from "../lib/settingsNavigation";
import { Account } from "./TopBar";
import { Instance } from "./InstancesView";
import { MOTION, EASE, motionSafe, staggerDelay } from "../lib/motionTokens";
import { Dialog } from "./Dialog";
import { dialogButton } from "./dialogSupport";
import { useToast } from "./Toast";
import { JoinSheet } from "./join/JoinSheet";
import type { JoinOffer } from "../electron";

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
  onLaunchGame?: (instanceName: string, folderName?: string) => void;
  activeAccount?: Account;
  joinOffer?: JoinOffer | null;
  onCloseJoin?: () => void;
  onJoinLaunched?: (instanceName: string, folderName?: string) => void;
}

const formatMOTD = (text: string) => {
  if (!text) return <span className="text-ink-tertiary">No description available</span>;

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
        currentStyle = { ...currentStyle, fontWeight: 600 };
      } else if (code === "§o") {
        currentStyle = { ...currentStyle, fontStyle: "italic" };
      } else if (code === "§r") {
        currentStyle = {};
      }
      return null;
    }
    return (
      <span key={index} style={{ ...currentStyle }} >
        {part}
      </span>
    );
  });
};

const parseMcVersion = (value?: string): [number, number, number] | null => {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(value ?? "");
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
};

type VersionRelation = "match" | "serverNewer" | "instanceNewer" | "unknown";

const compareMcVersions = (serverVersion?: string, instanceVersion?: string): VersionRelation => {
  const server = parseMcVersion(serverVersion);
  const instance = parseMcVersion(instanceVersion);
  if (!server || !instance) return "unknown";
  for (let i = 0; i < 3; i += 1) {
    if (server[i] > instance[i]) return "serverNewer";
    if (server[i] < instance[i]) return "instanceNewer";
  }
  return "match";
};

export const MultiplayerView: React.FC<MultiplayerViewProps> = ({
  setActiveTab,
  searchQuery: initialSearch,
  lang,
  instances,
  servers,
  setServers,
  onLaunchGame,
  activeAccount,
  joinOffer,
  onCloseJoin,
  onJoinLaunched,
}) => {
  const t = translations[lang];
  const { addToast } = useToast();
  const orderedInstances = React.useMemo(
    () => [...instances].sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0)),
    [instances],
  );
  const [search, setSearch] = useState(initialSearch);
  const [addModalOpen, setAddModalOpen] = useState(false);

  const [editingServer, setEditingServer] = useState<ServerItem | null>(null);
  const [editName, setEditName] = useState("");

  const [joiningServer, setJoiningServer] = useState<ServerItem | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>("");
  const [launchStep, setLaunchStep] = useState<"idle" | "launching" | "connecting">("idle");
  const [inviteTarget, setInviteTarget] = useState<ServerItem | null>(null);
  const [inviteProfileId, setInviteProfileId] = useState<string>("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteServer, setInviteServer] = useState<string>("");

  const [searchedServerStatus, setSearchedServerStatus] = useState<ServerItem | null>(null);
  const [isSearchingIP, setIsSearchingIP] = useState(false);

  const serversRef = React.useRef(servers);
  React.useEffect(() => {
    serversRef.current = servers;
  }, [servers]);
  const autoRefreshBusyRef = React.useRef(false);
  const autoRefreshTickRef = React.useRef(0);

  const updateSearch = (value: string) => {
    setSearch(value);
    const looksLikeAddress = value.includes(".") || value.toLowerCase() === "localhost";
    if (!looksLikeAddress || value.length <= 3) {
      setSearchedServerStatus(null);
      setIsSearchingIP(false);
    }
  };

  const [newServerName, setNewServerName] = useState("");
  const [newServerIP, setNewServerIP] = useState("");

  const pingServer = React.useCallback(async (server: ServerItem): Promise<ServerItem> => {
    try {
      const result = await window.electronAPI?.servers.ping?.(server.ip);
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
    } catch {
      return { ...server, online: false, isPinging: false, ping: 999 };
    }
  }, []);

  const pingAllServers = React.useCallback(async () => {
    const current = serversRef.current;
    if (current.length === 0) return;
    setServers(prev => prev.map(s => ({ ...s, isPinging: true })));
    const updated = await Promise.all(current.map(s => pingServer(s)));
    const byId = new Map(updated.map(s => [s.id, s]));
    setServers(prev => prev.map(s => byId.get(s.id) ?? s));
  }, [pingServer, setServers]);

  /**
   * Silent status refresh that reuses pingServer. Offline servers are skipped
   * on the regular cadence so a dead address is not pinged every cycle.
   */
  const refreshServerStatuses = React.useCallback(async (includeOffline: boolean) => {
    if (autoRefreshBusyRef.current) return;
    const current = serversRef.current;
    const targets = current.filter(s => includeOffline || s.online !== false);
    if (targets.length === 0) return;
    autoRefreshBusyRef.current = true;
    try {
      const refreshed = await Promise.all(targets.map(s => pingServer(s)));
      const byId = new Map(refreshed.map(s => [s.id, s]));
      setServers(prev => prev.map(s => byId.get(s.id) ?? s));
    } finally {
      autoRefreshBusyRef.current = false;
    }
  }, [pingServer, setServers]);

  useEffect(() => {
    void pingAllServers();
  }, [pingAllServers]);

  useEffect(() => {
    const AUTO_REFRESH_MS = 30000;
    const OFFLINE_RETRY_EVERY = 4;
    const timer = setInterval(() => {
      autoRefreshTickRef.current += 1;
      const includeOffline = autoRefreshTickRef.current % OFFLINE_RETRY_EVERY === 0;
      void refreshServerStatuses(includeOffline);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshServerStatuses]);

  useEffect(() => {
    const isIPPattern = search.includes(".") || search.toLowerCase() === "localhost";

    if (isIPPattern && search.length > 3) {
      const delayDebounce = setTimeout(async () => {
        setIsSearchingIP(true);
        setSearchedServerStatus(null);

        try {
          const result = await window.electronAPI?.servers.ping?.(search);
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
        } catch {
          // A failed lookup already renders as the offline entry above.
        } finally {
          setIsSearchingIP(false);
        }
      }, 800);

      return () => clearTimeout(delayDebounce);
    }
  }, [search]);

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

    setTimeout(async () => {
      const updated = await pingServer(newServer);
      setServers(prev => prev.map(s => s.id === newServer.id ? updated : s));
    }, 500);
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName.trim() || !editingServer) return;
    setServers(prev => prev.map(s => s.id === editingServer.id ? { ...s, name: editName } : s));
    setEditingServer(null);
  };

  const handleDeleteServerFromEdit = () => {
    if (!editingServer) return;
    setServers(prev => prev.filter(s => s.id !== editingServer.id));
    setEditingServer(null);
  };

  const triggerLaunchAndJoin = () => {
    if (!joiningServer || !selectedInstanceId) return;

    setLaunchStep("launching");

    const selectedInst = instances.find(i => i.id === selectedInstanceId);
    if (!selectedInst) return;

    const folderName = selectedInst.folderName || selectedInst.name.toLowerCase().replace(/\s+/g, "-");
    window.electronAPI?.launch.start?.({
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

    onLaunchGame?.(selectedInst.name, folderName);

    const unsubReady = window.electronAPI?.launch.onReady?.(() => {
      setLaunchStep("idle");
      setJoiningServer(null);
      unsubReady?.();
    });
  };

  useEffect(() => {
    const unsub = window.electronAPI?.launch.onFailed?.(() => setLaunchStep("idle"));
    return () => { unsub?.(); };
  }, []);

  const handleOpenJoinPopup = (server: ServerItem) => {
    setJoiningServer(server);
    setLaunchStep("idle");
    if (orderedInstances.length > 0) {
      setSelectedInstanceId(orderedInstances[0].id);
    } else {
      setSelectedInstanceId("");
    }
  };

  const splitServerAddress = (value: string): { host: string; port: number } => {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      const end = trimmed.indexOf("]");
      if (end > 0) {
        const host = trimmed.slice(1, end);
        const port = Number(trimmed.slice(end + 1).replace(/^:/, ""));
        return { host, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 25565 };
      }
    }
    const colon = trimmed.lastIndexOf(":");
    if (colon > 0 && trimmed.indexOf(":") === colon) {
      const port = Number(trimmed.slice(colon + 1));
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        return { host: trimmed.slice(0, colon), port };
      }
    }
    return { host: trimmed, port: 25565 };
  };

  const buildInvite = async (server: ServerItem, profileId: string): Promise<string | null> => {
    const { host, port } = splitServerAddress(server.ip);
    try {
      const link = await window.electronAPI?.join.buildLink?.({
        v: 1,
        host,
        port,
        profile: profileId,
        ...(server.name ? { name: [...server.name].slice(0, 64).join("") } : {}),
      });
      if (!link) throw new Error(lang === "de" ? "Kein Link erstellt." : "No link created.");
      setInviteLink(link);
      return link;
    } catch (error) {
      setInviteLink(null);
      addToast({ type: "error", message: (error as Error).message });
      return null;
    }
  };

  const handleCreateInvite = async (server: ServerItem) => {
    const preferred = instances.some(inst => inst.id === selectedInstanceId)
      ? selectedInstanceId
      : instances[0]?.id ?? "";
    setInviteTarget(server);
    setInviteServer(server.name);
    setInviteProfileId(preferred);
    setInviteLink(null);
    if (preferred) await buildInvite(server, preferred);
  };

  const closeInvite = () => {
    setInviteTarget(null);
    setInviteLink(null);
  };

  const selectInviteProfile = (profileId: string) => {
    setInviteProfileId(profileId);
    if (inviteTarget && profileId) void buildInvite(inviteTarget, profileId);
  };

  const copyInvite = () => {
    if (!inviteLink) return;
    window.electronAPI?.system.copy?.(inviteLink);
    addToast({
      type: "success",
      message: lang === "de" ? "Einladungslink kopiert." : "Invite link copied.",
    });
  };

  const shareInvite = () => {
    if (!inviteLink) return;
    window.electronAPI?.system.copy?.(inviteLink);
    window.electronAPI?.system.openExternal?.("discord://");
    addToast({
      type: "info",
      message: lang === "de"
        ? "Link kopiert. Discord wird geöffnet, falls verfügbar."
        : "Link copied. Discord opens if available.",
    });
  };

  const filteredServers = servers.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.ip.toLowerCase().includes(search.toLowerCase())
  );

  const isOfflineUser = !activeAccount || activeAccount.type === "Offline" || activeAccount.username === "BambooPlayer";
  const hasMicrosoftAccount = activeAccount?.type === "Microsoft";

  const joinSheet = (
    <JoinSheet
      key={joinOffer ? "open" : "closed"}
      open={!!joinOffer}
      offer={joinOffer ?? null}
      lang={lang}
      offline={isOfflineUser}
      onClose={() => onCloseJoin?.()}
      onLaunched={(instance) => onJoinLaunched?.(instance.name, instance.folderName)}
      onOpenInstances={() => setActiveTab("singleplayer")}
    />
  );

  if (isOfflineUser && !hasMicrosoftAccount) {
    return (
      <>
      <div className="flex-1 h-full flex items-center justify-center p-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md text-center"
        >
          <div className="w-20 h-20 rounded-2xl bg-surface/60 border border-hairline mx-auto flex items-center justify-center mb-6">
            <LogIn className="w-10 h-10 text-ink-tertiary" />
          </div>
          <h2 className="text-title2 font-semibold text-ink mb-3">
            {lang === "de" ? "Online-Funktionen" : "Online Features"}
          </h2>
          <p className="text-regular text-ink-secondary mb-6">
            {lang === "de"
              ? "Melde dich mit einem Microsoft-Konto an, um Multiplayer-Server hinzuzufügen und zu verwalten."
              : "Sign in with a Microsoft account to add and manage multiplayer servers."}
          </p>
          <div className="flex flex-col gap-3 items-center">
            <button
              onClick={() => {
                requestSettingsTarget('accounts');
                setActiveTab("settings");
              }}
              className="px-6 py-3 rounded-xl text-regular font-medium theme-bg hover:theme-bg-hover text-accent-contrast transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer theme-shadow-lg"
            >
              <SettingsIcon className="w-4 h-4 inline mr-2" />
              {lang === "de" ? "Zu den Kontoeinstellungen" : "Go to Account Settings"}
            </button>
            <p className="text-micro text-ink-tertiary">
              {lang === "de"
                ? "Benötigt wird ein gültiger Minecraft: Java Edition Account."
                : "Requires a valid Minecraft: Java Edition account."}
            </p>
          </div>
        </motion.div>
      </div>
      {joinSheet}
      </>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto h-full p-6 flex flex-col gap-6 custom-scrollbar z-10 relative select-none">

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-surface border border-hairline rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center gap-4">
          <div>
            <h2 className="text-title2 font-semibold text-ink flex items-center gap-2">
              {t.multiplayerServers}
            </h2>
            <p className="text-small text-ink-secondary mt-1">{t.multiplayerDesc}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={pingAllServers}
            className="p-3 bg-surface/60 hover:bg-hover border border-stroke hover:border-rim text-ink rounded-2xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer flex items-center gap-1.5"
            title="Refresh All Server Statuses"
          >
            <RefreshCw className="w-4 h-4 animate-spin-slow" />
            {t.refreshList}
          </button>
          <button
            onClick={() => setAddModalOpen(true)}
 className="theme-bg hover:theme-bg-hover text-accent-contrast px-5 py-3 rounded-2xl text-small font-medium theme-shadow-lg hover:theme-shadow-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-base)] ease-[var(--ease-out)] flex items-center gap-2 cursor-pointer hover:-translate-y-px"
          >
            <Plus className="w-4 h-4 stroke-[3]" />
            {t.addServer}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-4 bg-surface/20 border border-stroke p-4 rounded-2xl">
        <div className="w-full md:w-80 relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-secondary" />
          <input
            type="text"
            value={search}
            onChange={(e) => updateSearch(e.target.value)}
            placeholder={t.searchServers}
            className="w-full bg-root/40 border border-stroke focus:theme-border rounded-xl py-2 pl-10 pr-4 text-small text-ink placeholder:text-ink-tertiary outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
          />
        </div>
      </div>

      <AnimatePresence>
        {isSearchingIP && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="p-5 theme-bg-subtle theme-border-light rounded-2xl flex items-center justify-between gap-4 text-left"
          >
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-2xl theme-bg-light theme-border-light flex items-center justify-center theme-text">
                <RefreshCw className="w-5 h-5 animate-spin" />
              </div>
              <div>
                <h4 className="text-regular font-medium text-ink">{t.queryingIP}</h4>
                <p className="text-small text-ink-secondary mt-1">{t.connectingIP} <strong className="theme-text">"{search}"</strong>...</p>
              </div>
            </div>
          </motion.div>
        )}

        {searchedServerStatus && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="p-5 bg-surface border theme-border-md rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-left shadow-2xl animate-pulse"
          >
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-surface border border-stroke flex items-center justify-center overflow-hidden">
                <img src={searchedServerStatus.icon} alt="Server icon" className="w-10 h-10 object-contain" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-large font-semibold text-ink">{searchedServerStatus.name}</h4>
                  <span className="text-micro theme-bg-light theme-text theme-border-light px-2 py-0.5 rounded font-mono">
                    {searchedServerStatus.ip}
                  </span>
                </div>
                <p className="text-small text-ink-secondary mt-1.5 font-mono">
                  {formatMOTD(searchedServerStatus.motd)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              {searchedServerStatus.online && (
                <div className="text-right mr-2 hidden sm:block">
                  <span className="block text-small font-medium text-ink">
                    {searchedServerStatus.onlinePlayers.toLocaleString()} / {searchedServerStatus.maxPlayers.toLocaleString()}
                  </span>
                  <span className="text-micro text-ink-tertiary font-medium">{t.playersLive}</span>
                </div>
              )}

              <button
                onClick={() => {
                  setServers([...servers, { ...searchedServerStatus, id: `s_${Date.now()}` }]);
                  updateSearch("");
                }}
 className="theme-bg hover:theme-bg-hover text-accent-contrast px-4 py-2.5 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-4 h-4 stroke-[3]" />
                {t.addToList}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-col gap-4">
        <AnimatePresence mode="popLayout">
          {filteredServers.map((server, index) => (
            <motion.div
              key={server.id}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={motionSafe({ duration: MOTION.slow, delay: staggerDelay(index), ease: EASE.out })}
              className="bg-surface border border-hairline rounded-2xl p-5 flex flex-col md:flex-row items-center justify-between gap-5 group hover:theme-border-md hover:shadow-2xl transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-base)] ease-[var(--ease-out)] relative overflow-hidden"
            >
              <div className="flex items-center gap-5 w-full md:w-auto">
                <div className="w-16 h-16 rounded-2xl bg-surface/80 border border-stroke/80 group-hover:theme-border-light flex items-center justify-center shrink-0 overflow-hidden relative shadow-lg">
                  {server.isPinging ? (
                    <RefreshCw className="w-6 h-6 text-ink-tertiary animate-spin" />
                  ) : (
                    <img src={server.icon} alt={server.name} className="w-12 h-12 object-contain" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-ink/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>

                <div className="flex flex-col text-left min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h3 className="text-large font-semibold text-ink group-hover:theme-text-bright transition-colors">
                      {server.name}
                    </h3>
                    <span className="text-micro text-ink-tertiary font-medium bg-surface/40 border border-stroke px-2 py-0.5 rounded">
                      {server.ip}
                    </span>
                    {!server.isPinging && server.online === false && (
                      <span className="text-micro font-medium text-danger bg-danger/10 border border-danger/20 px-2 py-0.5 rounded">
                        {lang === "de" ? "Nicht erreichbar" : "Unreachable"}
                      </span>
                    )}
                  </div>

                  <p className="text-small text-ink-secondary mt-2 whitespace-pre-line font-mono">
                    {server.isPinging ? (
                      <span className="text-ink-tertiary italic animate-pulse">Checking connection status...</span>
                    ) : server.online === false ? (
                      <span className="text-danger font-medium">
                        {lang === "de" ? "Server ist offline oder nicht erreichbar." : "Server is offline or unreachable."}
                      </span>
                    ) : (
                      formatMOTD(server.motd)
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between md:justify-end gap-6 w-full md:w-auto border-t md:border-t-0 border-hairline pt-4 md:pt-0 shrink-0">
                <div className="flex items-center gap-6">
                  <div className="text-right">
                    <div className="flex items-center gap-1.5 justify-end text-ink">
                      <Users className="w-4 h-4 text-ink-secondary" />
                      <span className="text-regular font-medium">
                        {server.isPinging ? "..." : server.online === false ? "—" : server.onlinePlayers.toLocaleString()}
                      </span>
                      <span className="text-small text-ink-tertiary font-medium">
                        / {server.isPinging ? "..." : server.online === false ? "—" : server.maxPlayers.toLocaleString()}
                      </span>
                    </div>
                    <div className="w-28 h-1 bg-surface rounded-full overflow-hidden mt-1.5">
                      <div
                        className="h-full theme-bg rounded-full theme-glow transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-out)] ease-[var(--ease-out)]"
                        style={{ width: server.isPinging || server.online === false ? "0%" : `${(server.onlinePlayers / (server.maxPlayers || 100)) * 100}%` }}
                      />
                    </div>
                  </div>

                  <div className="flex flex-col items-center justify-center bg-surface/40 border border-hairline px-3 py-1.5 rounded-xl">
                    <Wifi className={`w-4.5 h-4.5 ${
                      server.isPinging
                        ? "text-ink-tertiary"
                        : server.ping < 35
                        ? "theme-text"
                        : server.ping < 80
                        ? "text-warning"
                        : "text-danger"
                    }`} />
                    <span className={`text-micro font-medium mt-0.5 ${server.online === false && !server.isPinging ? "text-danger" : "text-ink"}`}>
                      {server.isPinging ? "..." : server.online === false ? (lang === "de" ? "offline" : "offline") : `${server.ping}ms`}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void handleCreateInvite(server)}
                    className="p-3 bg-surface/40 hover:bg-selected border border-stroke hover:border-rim text-ink-secondary hover:text-ink rounded-xl transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                    title={lang === "de" ? "Einladungslink erstellen" : "Create invite link"}
                  >
                    <Share2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => {
                      setEditingServer(server);
                      setEditName(server.name);
                    }}
                    className="p-3 bg-surface/40 hover:bg-selected border border-stroke hover:border-rim text-ink-secondary hover:text-ink rounded-xl transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                    title={t.editServer}
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleOpenJoinPopup(server)}
                    className="p-3 theme-bg hover:theme-bg-hover text-accent-contrast rounded-xl transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-base)] ease-[var(--ease-out)] theme-shadow-lg hover:theme-shadow-lg hover:scale-105 cursor-pointer flex items-center justify-center"
                  >
                    <Play className="w-4.5 h-4.5 fill-root stroke-[2.5]" />
                  </button>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {servers.length === 0 && !searchedServerStatus && (
          <div className="py-24 text-center flex flex-col items-center justify-center gap-4">
            <div className="w-20 h-20 rounded-2xl bg-surface border border-stroke flex items-center justify-center text-ink-secondary shadow-2xl">
              <Globe className="w-10 h-10" />
            </div>
            <div>
              <p className="text-large font-semibold text-ink">Keine Server hinzugefügt / No servers found</p>
              <p className="text-small text-ink-tertiary mt-1 max-w-sm mx-auto">Füge einen Server hinzu oder suche eine IP-Adresse, um online mit Freunden zu spielen.</p>
            </div>
            <button
              onClick={() => setAddModalOpen(true)}
 className="theme-bg hover:theme-bg-hover text-accent-contrast px-5 py-2.5 rounded-xl text-small font-medium theme-shadow-lg cursor-pointer"
            >
              Server hinzufügen
            </button>
          </div>
        )}
      </div>

      <AnimatePresence>
        {joiningServer && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-50"
            onClick={() => launchStep === "idle" && setJoiningServer(null)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
              className="bg-root border border-stroke/80 rounded-2xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              {launchStep === "idle" && (
                <>
                  <div className="p-6 border-b border-hairline flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Play className="w-5 h-5 theme-text" />
                      <h3 className="text-large font-semibold text-ink">{t.selectInstanceJoin}</h3>
                    </div>
                    <button
                      onClick={() => setJoiningServer(null)}
                      className="bg-surface hover:bg-hover border border-stroke p-2 rounded-xl text-ink-secondary hover:text-ink transition-colors cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="p-6 flex flex-col gap-4 text-left">
                    <p className="text-small text-ink-secondary">
                      {t.selectInstanceJoinDesc} <strong className="theme-text">{joiningServer.name}</strong> ({joiningServer.ip})
                    </p>

                    {orderedInstances.length > 0 ? (
                      <div className="flex flex-col gap-2.5 max-h-72 overflow-y-auto custom-scrollbar">
                        {orderedInstances.map(inst => {
                          const relation = compareMcVersions(joiningServer.version, inst.minecraftVersion);
                          const relationLabel = relation === "match"
                            ? (lang === "de" ? "Version passt" : "Version match")
                            : relation === "serverNewer"
                              ? (lang === "de" ? `Server neuer (${joiningServer.version})` : `Server newer (${joiningServer.version})`)
                              : relation === "instanceNewer"
                                ? (lang === "de" ? `Instanz neuer (${inst.minecraftVersion})` : `Instance newer (${inst.minecraftVersion})`)
                                : (lang === "de" ? "Version unbekannt" : "Version unknown");
                          const relationTone = relation === "match" ? "text-success" : relation === "unknown" ? "text-ink-tertiary" : "text-warning";
                          const selected = selectedInstanceId === inst.id;
                          return (
                            <button
                              key={inst.id}
                              type="button"
                              onClick={() => setSelectedInstanceId(inst.id)}
                              className={`p-4 rounded-2xl border text-left flex items-center gap-3.5 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer ${
                                selected
                                  ? "theme-bg-light theme-text theme-border-md"
                                  : "bg-surface/20 border-stroke hover:bg-hover hover:border-rim"
                              }`}
                            >
                              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-hairline bg-black">
                                {inst.thumbnail ? (
                                  <img src={inst.thumbnail} alt="" className="h-full w-full object-cover" />
                                ) : null}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-regular font-medium">{inst.name}</span>
                                  {selected && <Check className="w-4 h-4 shrink-0" />}
                                </div>
                                <span className="mt-0.5 block truncate text-micro text-ink-tertiary">
                                  MC {inst.minecraftVersion}{inst.modloader ? ` · ${inst.modloader}` : ""}
                                </span>
                                <span className={`mt-0.5 block truncate text-micro font-medium ${relationTone}`}>{relationLabel}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="p-4 bg-danger/10 border border-danger/20 rounded-xl text-center text-small text-danger">
                        Bitte erstelle zuerst eine Instanz im Instanzen-Reiter!
                      </div>
                    )}

                    <div className="flex gap-3 mt-4 pt-4 border-t border-hairline">
                      <button
                        type="button"
                        onClick={() => setJoiningServer(null)}
                        className="flex-1 bg-surface hover:bg-hover border border-stroke text-ink py-3 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                      >
                        {t.cancel}
                      </button>
                      <button
                        type="button"
                        disabled={!selectedInstanceId}
                        onClick={triggerLaunchAndJoin}
                        className="flex-1 theme-bg hover:theme-bg-hover text-accent-contrast py-3 rounded-xl text-small font-medium theme-shadow-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer disabled:opacity-50"
                      >
                        {t.launchAndJoin}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {launchStep !== "idle" && (
                <div className="p-8 flex flex-col items-center justify-center gap-4 min-h-[250px]">
                  <div className="relative w-16 h-16 rounded-2xl theme-bg flex items-center justify-center shadow-2xl">
                    <RefreshCw className="w-8 h-8 text-accent-contrast animate-spin" />
                    <div className="absolute inset-0 rounded-2xl border theme-border animate-ping opacity-25" />
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <h4 className="text-micro font-medium text-ink uppercase tracking-label">
                      {launchStep === "launching" ? t.launchingMc : t.connectingToServer}
                    </h4>
                    <p className="text-small text-ink-tertiary font-medium animate-pulse">
                      {launchStep === "launching" ? "Minecraft Java Edition loading..." : joiningServer.ip}
                    </p>
                  </div>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {editingServer && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-50"
            onClick={() => setEditingServer(null)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
              className="bg-root border border-stroke/80 rounded-2xl max-w-sm w-full overflow-hidden shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-hairline flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Edit3 className="w-5 h-5 theme-text" />
                  <h3 className="text-large font-semibold text-ink">{t.editServer}</h3>
                </div>
                <button
                  onClick={() => setEditingServer(null)}
                  className="bg-surface hover:bg-hover border border-stroke p-2 rounded-xl text-ink-secondary hover:text-ink transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleSaveEdit} className="p-6 flex flex-col gap-4 text-left">
                <div className="flex flex-col gap-1.5">
                  <label className="text-micro font-medium text-ink-secondary uppercase tracking-label">{t.displayName}</label>
                  <input
                    type="text"
                    required
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full bg-surface/40 border border-stroke focus:theme-border rounded-xl py-2.5 px-4 text-regular text-ink outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
                  />
                  <span className="text-micro text-ink-tertiary">
                    {t.localRenameInfo}
                  </span>
                </div>

                <div className="flex flex-col gap-1.5 opacity-60">
                  <label className="text-micro font-medium text-ink-secondary uppercase tracking-label">Server IP Address</label>
                  <input
                    type="text"
                    disabled
                    value={editingServer.ip}
                    className="w-full bg-surface/20 border border-stroke rounded-xl py-2.5 px-4 text-regular text-ink-secondary outline-none cursor-not-allowed"
                  />
                </div>

                <div className="flex gap-2.5 mt-4 pt-4 border-t border-hairline">
                  <button
                    type="button"
                    onClick={handleDeleteServerFromEdit}
                    className="bg-danger/10 hover:bg-danger/20 text-danger border border-danger/20 py-3 px-4 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer flex items-center gap-1.5 shrink-0"
                    title="Remove Server"
                  >
                    <Trash2 className="w-4 h-4" />
                    {t.delete}
                  </button>

                  <button
                    type="button"
                    onClick={() => setEditingServer(null)}
                    className="flex-1 bg-surface hover:bg-hover border border-stroke text-ink py-3 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                  >
                    {t.cancel}
                  </button>
                  <button
                    type="submit"
                    className="flex-1 theme-bg hover:theme-bg-hover text-accent-contrast py-3 rounded-xl text-small font-medium theme-shadow-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                  >
                    {t.saveChanges}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {addModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-50"
            onClick={() => setAddModalOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
              className="bg-root border border-stroke/80 rounded-2xl max-w-md w-full overflow-hidden shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-hairline flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <PlusCircle className="w-5 h-5 theme-text" />
                  <h3 className="text-large font-semibold text-ink">{t.addServer}</h3>
                </div>
                <button
                  onClick={() => setAddModalOpen(false)}
                  className="bg-surface hover:bg-hover border border-stroke p-2 rounded-xl text-ink-secondary hover:text-ink transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleAddServer} className="p-6 flex flex-col gap-4 text-left">
                <div className="flex flex-col gap-1.5">
                  <label className="text-micro font-medium text-ink-secondary uppercase tracking-label">Server Name</label>
                  <input
                    type="text"
                    required
                    value={newServerName}
                    onChange={(e) => setNewServerName(e.target.value)}
                    placeholder="My Survival Server"
                    className="w-full bg-surface/40 border border-stroke focus:theme-border rounded-xl py-2.5 px-4 text-regular text-ink placeholder:text-ink-tertiary outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-micro font-medium text-ink-secondary uppercase tracking-label">Server Address / IP</label>
                  <input
                    type="text"
                    required
                    value={newServerIP}
                    onChange={(e) => setNewServerIP(e.target.value)}
                    placeholder="mc.myserver.com"
                    className="w-full bg-surface/40 border border-stroke focus:theme-border rounded-xl py-2.5 px-4 text-regular text-ink placeholder:text-ink-tertiary outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
                  />
                </div>

                <div className="flex gap-3 mt-4 pt-4 border-t border-hairline">
                  <button
                    type="button"
                    onClick={() => setAddModalOpen(false)}
                    className="flex-1 bg-surface hover:bg-hover border border-stroke text-ink py-3 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                  >
                    {t.cancel}
                  </button>
                  <button
                    type="submit"
                    className="flex-1 theme-bg hover:theme-bg-hover text-accent-contrast py-3 rounded-xl text-small font-medium theme-shadow-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                  >
                    {t.addServer}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {joinSheet}

      <Dialog
        open={!!inviteTarget}
        onClose={closeInvite}
        title={lang === "de" ? "Server-Einladung" : "Server invitation"}
        titleId="server-invite-dialog-title"
        closeLabel={lang === "de" ? "Schließen" : "Close"}
        icon={<ShieldCheck className="h-4 w-4" />}
        tone="info"
        footer={
          <button onClick={closeInvite} className={dialogButton.secondary}>
            {lang === "de" ? "Schließen" : "Close"}
          </button>
        }
      >
        <p className="m-0 text-small text-ink-secondary">
          {lang === "de"
            ? `Teile diesen Link für ${inviteServer}. Der Empfänger sieht Host, Port und Instanz vor dem Beitritt.`
            : `Share this link for ${inviteServer}. The recipient sees host, port and instance before joining.`}
        </p>
        <label className="mt-3 block text-micro font-medium uppercase tracking-label text-ink-secondary" htmlFor="server-invite-profile">
          {lang === "de" ? "Instanz" : "Instance"}
        </label>
        <select
          id="server-invite-profile"
          value={inviteProfileId}
          onChange={(event) => selectInviteProfile(event.target.value)}
          className="mt-1 w-full rounded-xl border border-stroke bg-root/40 px-3 py-2 text-small text-ink outline-none"
        >
          {instances.map(inst => (
            <option key={inst.id} value={inst.id}>
              {inst.name} · MC {inst.minecraftVersion}
            </option>
          ))}
        </select>
        {instances.length === 0 && (
          <p className="mt-2 mb-0 text-mini text-warning">
            {lang === "de"
              ? "Erstelle zuerst eine Instanz: der Link muss eine Instanz benennen, sonst kann der Empfänger nicht direkt beitreten."
              : "Create an instance first: the link must name one, otherwise the recipient cannot join directly."}
          </p>
        )}
        <input
          readOnly
          value={inviteLink ?? ""}
          onFocus={(event) => event.currentTarget.select()}
          className="mt-3 w-full rounded-xl border border-stroke bg-root/40 px-3 py-2 font-mono text-mini text-ink outline-none"
          aria-label={lang === "de" ? "Einladungslink" : "Invite link"}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={copyInvite} disabled={!inviteLink} className={dialogButton.accent}>
            <Copy className="mr-1 inline h-3 w-3" />
            {lang === "de" ? "Kopieren" : "Copy"}
          </button>
          <button type="button" onClick={shareInvite} disabled={!inviteLink} className={dialogButton.secondary}>
            <ExternalLink className="mr-1 inline h-3 w-3" />
            {lang === "de" ? "In Discord teilen" : "Share in Discord"}
          </button>
        </div>
      </Dialog>

    </div>
  );
};
