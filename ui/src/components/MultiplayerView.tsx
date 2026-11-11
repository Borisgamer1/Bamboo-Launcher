import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play,
  Edit3,
  Plus,
  Search,
  Globe,
  X,
  PlusCircle,
  RefreshCw,
  Trash2,
  LogIn,
  Settings as SettingsIcon,
  Save,
  Check
} from "lucide-react";
import { TabType } from "./Sidebar";
import { translations, LanguageType } from "../lib/translations";
import { requestSettingsTarget } from "../lib/settingsNavigation";
import { useToast } from "./Toast";
import { Account } from "./TopBar";
import { Instance } from "./InstancesView";
import { MOTION, EASE, motionSafe } from "../lib/motionTokens";
import { ServerRow } from "./multiplayer/ServerRow";
import { formatMotd } from "./multiplayer/motd";
import type { ServerItem } from "./multiplayer/types";

interface MultiplayerViewProps {
  setActiveTab: (tab: TabType) => void;
  searchQuery: string;
  lang: LanguageType;
  instances: Instance[];
  servers: ServerItem[];
  setServers: React.Dispatch<React.SetStateAction<ServerItem[]>>;
  onLaunchServer?: (instanceId: string, server: { host: string; port: number }) => boolean;
  onServerJoined?: (id: string) => void;
  /** True while the pre-launch check holds the start for a decision. */
  preflightOpen?: boolean;
  activeAccount?: Account;
}

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
  onLaunchServer,
  onServerJoined,
  preflightOpen,
  activeAccount,
}) => {
  const t = translations[lang];
  const { addToast } = useToast();
  const [syncingServers, setSyncingServers] = useState(false);
  const orderedInstances = React.useMemo(
    () => [...instances].sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0)),
    [instances],
  );
  const [search, setSearch] = useState(initialSearch);
  const [addModalOpen, setAddModalOpen] = useState(() => {
    try {
      if (sessionStorage.getItem("bamboo-multiplayer-intent") !== "add") return false;
      sessionStorage.removeItem("bamboo-multiplayer-intent");
      return true;
    } catch {
      return false;
    }
  });

  const [editingServer, setEditingServer] = useState<ServerItem | null>(null);
  const [editName, setEditName] = useState("");

  const [joiningServer, setJoiningServer] = useState<ServerItem | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>("");
  const [launchStep, setLaunchStep] = useState<"idle" | "launching" | "connecting">("idle");

  // Die Startprüfung liegt über dem Join-Dialog. Wird sie geschlossen (oder
  // abgebrochen), darf der Dialog nicht im „launching“-Schritt ohne Ausweg
  // hängen bleiben. Bestätigt der Nutzer, startet das Spiel und `onReady`
  // schließt den Dialog wie bisher.
  const preflightWasOpen = React.useRef(false);
  React.useEffect(() => {
    if (preflightOpen) {
      preflightWasOpen.current = true;
      return;
    }
    if (!preflightWasOpen.current) return;
    preflightWasOpen.current = false;
    setLaunchStep((step) => (step === "launching" ? "idle" : step));
  }, [preflightOpen]);

  const [searchedServerStatus, setSearchedServerStatus] = useState<ServerItem | null>(null);
  const [isSearchingIP, setIsSearchingIP] = useState(false);

  const serversRef = React.useRef(servers);
  const autoPingedRef = React.useRef(false);
  React.useEffect(() => {
    serversRef.current = servers;
  }, [servers]);

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

  // Opening the view refreshes every saved server exactly once. The ref guard
  // also absorbs React's development double-effect; nothing polls afterwards.
  React.useEffect(() => {
    if (autoPingedRef.current) return;
    autoPingedRef.current = true;
    void pingAllServers();
  }, [pingAllServers]);

  // Typing an address is an explicit one-off lookup, debounced rather than polled.
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
    if (!instances.some(i => i.id === selectedInstanceId)) return;

    const [host, rawPort] = joiningServer.ip.split(":");
    const port = parseInt(rawPort) || 25565;
    setLaunchStep("launching");
    // One launch owner: account check, progress, payload and running list live
    // in useLaunchController, not in this view.
    if (!onLaunchServer?.(selectedInstanceId, { host, port })) {
      setLaunchStep("idle");
    } else {
      onServerJoined?.(joiningServer.id);
    }
  };

  useEffect(() => {
    const unsubReady = window.electronAPI?.launch.onReady?.(() => {
      setLaunchStep("idle");
      setJoiningServer(null);
    });
    const unsubFailed = window.electronAPI?.launch.onFailed?.(() => setLaunchStep("idle"));
    return () => {
      unsubReady?.();
      unsubFailed?.();
    };
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

  const syncServersToGame = async () => {
    if (servers.length === 0) return;
    setSyncingServers(true);
    try {
      const result = await window.electronAPI?.servers.syncDat?.({
        servers: servers.map(({ name, ip }) => ({ name, ip })),
      });
      if (!result?.success) {
        addToast({
          type: "error",
          message:
            result?.error ||
            (lang === "de"
              ? "Serverliste konnte nicht geschrieben werden."
              : "Could not write the server list."),
        });
        return;
      }
      const skipped = result.skipped?.length ?? 0;
      addToast({
        type: skipped > 0 ? "warning" : "success",
        message:
          lang === "de"
            ? `Serverliste in ${result.instances?.length ?? 0} Instanz(en) geschrieben${
                skipped > 0 ? `, ${skipped} laufen und wurden übersprungen` : ""
              }.`
            : `Server list written to ${result.instances?.length ?? 0} instance(s)${
                skipped > 0 ? `, ${skipped} running and skipped` : ""
              }.`,
      });
    } catch (error) {
      addToast({ type: "error", message: String(error) });
    } finally {
      setSyncingServers(false);
    }
  };

  const filteredServers = servers.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.ip.toLowerCase().includes(search.toLowerCase())
  );
  const isPingingAny = servers.some(s => s.isPinging);

  const isOfflineUser = !activeAccount || activeAccount.type === "Offline" || activeAccount.username === "BambooPlayer";
  const hasMicrosoftAccount = activeAccount?.type === "Microsoft";

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
      </>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto h-full p-6 flex flex-col gap-6 custom-scrollbar z-10 relative select-none">

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-surface border border-hairline rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center gap-4">
          <h2 className="text-title2 font-semibold text-ink">{t.multiplayerServers}</h2>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => void syncServersToGame()}
            disabled={syncingServers || servers.length === 0}
            className="h-10 px-3 flex items-center gap-2 border border-stroke bg-surface/60 hover:bg-hover hover:border-rim text-ink-secondary hover:text-ink rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              lang === "de"
                ? "Serverliste in alle Instanzen schreiben (servers.dat)"
                : "Write the server list into every instance (servers.dat)"
            }
          >
            <Save className={`w-4 h-4 ${syncingServers ? "animate-pulse" : ""}`} />
            {lang === "de" ? "Ins Spiel" : "To game"}
          </button>
          <button
            onClick={pingAllServers}
            className="h-10 w-10 flex items-center justify-center border border-stroke bg-surface/60 hover:bg-hover hover:border-rim text-ink-secondary hover:text-ink rounded-xl transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
            title={t.refreshList}
            aria-label={t.refreshList}
          >
            <RefreshCw className={`w-4 h-4 ${isPingingAny ? "animate-spin" : ""}`} />
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
                  {formatMotd(searchedServerStatus.motd)}
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
            <ServerRow
              key={server.id}
              server={server}
              index={index}
              lang={lang}
              editLabel={t.editServer}
              onEdit={(target) => {
                setEditingServer(target);
                setEditName(target.name);
              }}
              onJoin={handleOpenJoinPopup}
            />
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

    </div>
  );
};
