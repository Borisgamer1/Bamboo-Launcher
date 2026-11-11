import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Boxes,
  Loader2,
  Play,
  Plus,
  Server as ServerIcon,
  Square,
  Star,
} from "lucide-react";
import { TabType } from "./Sidebar";
import { Account } from "./TopBar";
import type { LanguageType } from "../lib/translations";
import { requestSettingsTarget } from "../lib/settingsNavigation";
import { instanceFolderKeyOf } from "../lib/instanceFolders";
import { formatPlaytime } from "../lib/launcherPreferences";
import { parseServerAddress, supportsQuickPlay } from "../lib/quickPlay";
import { usePinnedWorlds } from "../hooks/usePinnedWorlds";
import { useRecentWorlds, type RecentWorld } from "../hooks/useRecentWorlds";
import type { RunningInstance } from "../hooks/useLaunchController";
import type { Instance } from "./InstancesView";
import type { ServerItem } from "./multiplayer/types";
import type { ServerPingResult } from "../electron";

interface DashboardProps {
  setActiveTab: (tab: TabType) => void;
  activeAccount: Account;
  lang: LanguageType;
  instances: Instance[];
  servers: ServerItem[];
  runningInstances: RunningInstance[];
  launchingFolder?: string;
  onLaunch: (instanceId?: string, server?: { host: string; port: number }, world?: string) => boolean;
  onStopGame: (name: string, folderName?: string) => void;
  onOpenInstance: (name: string) => void;
  onServerJoined: (id: string) => void;
  onToggleServerPin: (id: string) => void;
}

type HeroTarget =
  | { kind: "world"; at: number; world: RecentWorld }
  | { kind: "server"; at: number; server: ServerItem }
  | { kind: "instance"; at: number; instance: Instance };

/** Quiet grove used where a save or profile has no picture yet. */
function GroveBackdrop({ className = "" }: { className?: string }) {
  const stalks = [
    { x: 430, width: 26 },
    { x: 492, width: 14 },
    { x: 548, width: 34 },
    { x: 616, width: 16 },
    { x: 676, width: 24 },
    { x: 736, width: 12 },
  ];
  return (
    <svg
      aria-hidden="true"
      className={`absolute inset-0 h-full w-full ${className}`}
      viewBox="0 0 800 400"
      preserveAspectRatio="xMidYMid slice"
    >
      <rect width="800" height="400" fill="#0b110d" />
      <g fill="#17251b">
        {stalks.map((stalk) => (
          <rect key={stalk.x} x={stalk.x} y="-20" width={stalk.width} height="380" />
        ))}
      </g>
      <g fill="#203327">
        {stalks.map((stalk) => (
          <rect key={stalk.x} x={stalk.x} y="-20" width="4" height="380" />
        ))}
      </g>
      <g fill="#09100b">
        {stalks.flatMap((stalk) =>
          [54, 142, 230, 318].map((y) => (
            <rect key={`${stalk.x}-${y}`} x={stalk.x} y={y} width={stalk.width} height="3" />
          )),
        )}
      </g>
      <g fill="#1e3225">
        <path d="M456 84 l70 -36 16 22 -64 36 z" />
        <path d="M548 176 l62 -24 10 20 -58 26 z" />
        <path d="M650 104 l60 -30 14 20 -56 30 z" />
        <path d="M604 260 l66 -20 8 20 -62 22 z" />
      </g>
      <rect y="332" width="800" height="68" fill="#080d09" />
      <rect y="332" width="800" height="1" fill="#2a3c2e" opacity="0.5" />
    </svg>
  );
}

function relativePlayed(ms: number | null | undefined, lang: LanguageType): string {
  if (!ms) return lang === "de" ? "Noch nicht gespielt" : "Not played yet";
  const diff = Math.max(0, Date.now() - ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return lang === "de" ? "gerade eben" : "just now";
  if (diff < hour) {
    const value = Math.floor(diff / minute);
    return lang === "de" ? `vor ${value} Min.` : `${value} min ago`;
  }
  if (diff < day) {
    const value = Math.floor(diff / hour);
    return lang === "de" ? `vor ${value} Std.` : `${value} h ago`;
  }
  if (diff < 7 * day) {
    const value = Math.floor(diff / day);
    return lang === "de" ? `vor ${value} ${value === 1 ? "Tag" : "Tagen"}` : `${value} d ago`;
  }
  return new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-US", {
    day: "2-digit",
    month: "short",
  }).format(new Date(ms));
}

function versionOf(value?: string | null): string | null {
  return /(\d+\.\d+(?:\.\d+)?)/.exec(value ?? "")?.[1] ?? null;
}

function bestInstanceForServer(server: ServerItem, instances: Instance[]): Instance | null {
  const version = versionOf(server.version);
  if (version) {
    const match = instances.find((instance) => versionOf(instance.minecraftVersion) === version);
    if (match) return match;
  }
  return [...instances].sort((left, right) => (right.lastPlayedAt ?? 0) - (left.lastPlayedAt ?? 0))[0] ?? null;
}

/** One request per visible server; no polling, no writes to the saved list. */
function useServerPings(servers: ServerItem[]): Record<string, ServerPingResult> {
  const [pings, setPings] = useState<Record<string, ServerPingResult>>({});
  const key = servers.slice(0, 4).map((server) => `${server.id}:${server.ip}`).join("|");

  useEffect(() => {
    let cancelled = false;
    const targets = servers.slice(0, 4);
    if (targets.length === 0) {
      setPings({});
      return;
    }
    void Promise.all(targets.map(async (server) => {
      try {
        const result = await window.electronAPI?.servers.ping?.(server.ip);
        return result ? ([server.id, result] as const) : null;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (cancelled) return;
      const next: Record<string, ServerPingResult> = {};
      for (const entry of entries) {
        if (entry) next[entry[0]] = entry[1];
      }
      setPings(next);
    });
    return () => {
      cancelled = true;
    };
  }, [key]); // servers via key; pinning must not trigger another ping

  return pings;
}

function SectionHeading({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-1 flex h-8 items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-field font-medium text-ink">{title}</h2>
        {typeof count === "number" && count > 0 ? (
          <span className="font-mono text-micro tabular-nums text-ink-quaternary">{count}</span>
        ) : null}
      </div>
      {action}
    </div>
  );
}

function PinButton({
  pinned,
  onClick,
  label,
  overlay = false,
  className = "",
}: {
  pinned: boolean;
  onClick: () => void;
  label: string;
  overlay?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-pressed={pinned}
      aria-label={label}
      title={label}
      className={`flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[var(--r-sm)] border transition-colors duration-[var(--t-quick)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        pinned
          ? "border-accent/30 bg-accent-soft text-accent"
          : overlay
            ? "border-white/10 bg-black/30 text-ink-secondary backdrop-blur-sm hover:bg-black/50 hover:text-ink"
            : "border-transparent bg-transparent text-ink-quaternary hover:bg-hover hover:text-ink"
      } ${className}`}
    >
      <Star className={`h-3.5 w-3.5 ${pinned ? "fill-current" : ""}`} aria-hidden="true" />
    </button>
  );
}

export const Dashboard: React.FC<DashboardProps> = ({
  setActiveTab,
  activeAccount,
  lang,
  instances,
  servers,
  runningInstances,
  launchingFolder,
  onLaunch,
  onStopGame,
  onOpenInstance,
  onServerJoined,
  onToggleServerPin,
}) => {
  const de = lang === "de";
  const { pinned, togglePinned } = usePinnedWorlds();
  const { worlds } = useRecentWorlds(instances, pinned);
  const pings = useServerPings(servers);

  const orderedWorlds = useMemo(() => [...worlds].sort((left, right) => {
    const leftPinned = pinned.includes(left.key) ? 1 : 0;
    const rightPinned = pinned.includes(right.key) ? 1 : 0;
    return rightPinned - leftPinned || (right.world.lastPlayed ?? 0) - (left.world.lastPlayed ?? 0);
  }), [worlds, pinned]);

  const orderedServers = useMemo(() => [...servers].sort((left, right) => {
    const leftPinned = left.pinned ? 1 : 0;
    const rightPinned = right.pinned ? 1 : 0;
    return rightPinned - leftPinned || (right.lastJoinedAt ?? 0) - (left.lastJoinedAt ?? 0);
  }), [servers]);

  const orderedInstances = useMemo(() => [...instances].sort(
    (left, right) => (right.lastPlayedAt ?? 0) - (left.lastPlayedAt ?? 0),
  ), [instances]);

  const totalPlaytime = useMemo(
    () => instances.reduce((sum, instance) => sum + (instance.playTimeMs ?? 0), 0),
    [instances],
  );

  const heroTargets = useMemo<HeroTarget[]>(() => {
    const targets: HeroTarget[] = [
      ...orderedWorlds.map((world) => ({ kind: "world" as const, at: world.world.lastPlayed ?? 0, world })),
      ...orderedServers.map((server) => ({ kind: "server" as const, at: server.lastJoinedAt ?? 0, server })),
      ...orderedInstances.map((instance) => ({ kind: "instance" as const, at: instance.lastPlayedAt ?? 0, instance })),
    ];
    return targets.sort((left, right) => {
      const leftPinned = left.kind === "world"
        ? pinned.includes(left.world.key)
        : left.kind === "server" ? !!left.server.pinned : false;
      const rightPinned = right.kind === "world"
        ? pinned.includes(right.world.key)
        : right.kind === "server" ? !!right.server.pinned : false;
      return Number(rightPinned) - Number(leftPinned) || right.at - left.at;
    });
  }, [orderedInstances, orderedServers, orderedWorlds, pinned]);

  const hero = heroTargets[0] ?? null;
  const heroServerStatus = hero?.kind === "server" ? pings[hero.server.id] : null;
  const heroServerInstance = hero?.kind === "server" ? bestInstanceForServer(hero.server, instances) : null;
  const heroFolder = hero
    ? hero.kind === "world"
      ? instanceFolderKeyOf(hero.world.instance)
      : hero.kind === "instance"
        ? instanceFolderKeyOf(hero.instance)
        : heroServerInstance ? instanceFolderKeyOf(heroServerInstance) : ""
    : "";
  const heroRunning = heroFolder
    ? runningInstances.find((entry) => entry.folderName === heroFolder) ?? null
    : null;
  const heroLaunching = !!heroFolder && launchingFolder === heroFolder;

  const openInstances = (intent?: "create") => {
    if (intent) {
      sessionStorage.setItem("bamboo-instances-intent", intent);
      window.dispatchEvent(new CustomEvent("bamboo-instances-intent", { detail: intent }));
    }
    setActiveTab("singleplayer");
  };

  const openAccounts = () => {
    requestSettingsTarget("accounts");
    setActiveTab("settings");
  };

  const openServers = (intent?: "add") => {
    if (intent) sessionStorage.setItem("bamboo-multiplayer-intent", intent);
    setActiveTab("multiplayer");
  };

  const launchWorld = (world: RecentWorld) => {
    if (!supportsQuickPlay(world.instance.minecraftVersion)) {
      onLaunch(world.instance.id);
      return;
    }
    onLaunch(world.instance.id, undefined, world.world.folderName);
  };

  const launchServer = (server: ServerItem) => {
    const target = bestInstanceForServer(server, instances);
    if (!target) return;
    const { host, port } = parseServerAddress(server.ip);
    if (onLaunch(target.id, { host, port })) onServerJoined(server.id);
  };

  const heroPlay = () => {
    if (!hero) return;
    if (heroRunning) {
      const name = hero.kind === "world"
        ? hero.world.instance.name
        : hero.kind === "instance" ? hero.instance.name : heroServerInstance?.name ?? "";
      if (name) onStopGame(name, heroRunning.folderName);
      return;
    }
    if (!activeAccount.id) {
      openAccounts();
      return;
    }
    if (hero.kind === "world") launchWorld(hero.world);
    else if (hero.kind === "server") launchServer(hero.server);
    else onLaunch(hero.instance.id);
  };

  const heroTitle = hero
    ? hero.kind === "world" ? hero.world.world.name : hero.kind === "server" ? hero.server.name : hero.instance.name
    : "";
  const heroEyebrow = hero
    ? hero.kind === "world"
      ? de ? "Letzte Welt" : "Last world"
      : hero.kind === "server"
        ? de ? "Letzter Server" : "Last server"
        : de ? "Letztes Profil" : "Last profile"
    : "";
  const heroMeta = hero
    ? hero.kind === "world"
      ? [
          hero.world.instance.name !== hero.world.world.name ? hero.world.instance.name : null,
          hero.world.instance.minecraftVersion,
          relativePlayed(hero.world.world.lastPlayed, lang),
        ].filter(Boolean).join(" · ")
      : hero.kind === "server"
        ? [
            heroServerInstance?.name,
            heroServerStatus
              ? heroServerStatus.online
                ? `${heroServerStatus.playersOnline}/${heroServerStatus.playersMax} · ${heroServerStatus.ping} ms`
                : de ? "Offline" : "Offline"
              : hero.server.ip,
            relativePlayed(hero.server.lastJoinedAt, lang),
          ].filter(Boolean).join(" · ")
        : [
            hero.instance.minecraftVersion,
            [hero.instance.modloader, hero.instance.modloaderVersion].filter(Boolean).join(" "),
            relativePlayed(hero.instance.lastPlayedAt, lang),
          ].filter(Boolean).join(" · ")
    : "";
  const heroImage = hero
    ? hero.kind === "world"
      ? hero.world.world.iconDataUrl || hero.world.instance.thumbnail || null
      : hero.kind === "server"
        ? heroServerStatus?.icon
          || (hero.server.icon && !hero.server.icon.includes("mineatar.io/face") ? hero.server.icon : null)
        : hero.instance.thumbnail || null
    : null;
  const heroPinned = hero
    ? hero.kind === "world"
      ? pinned.includes(hero.world.key)
      : hero.kind === "server" ? !!hero.server.pinned : false
    : false;
  const heroPlayLabel = heroLaunching
    ? de ? "Startet" : "Starting"
    : heroRunning
      ? de ? "Beenden" : "Stop"
      : !activeAccount.id
        ? de ? "Konto verbinden" : "Connect account"
        : hero?.kind === "world"
          ? supportsQuickPlay(hero.world.instance.minecraftVersion)
            ? de ? "Weiter spielen" : "Continue"
            : de ? "Profil starten" : "Start profile"
          : hero?.kind === "server" ? de ? "Beitreten" : "Join" : de ? "Starten" : "Play";
  const heroPlayDisabled = heroLaunching || (hero?.kind === "server" && !heroServerInstance);
  const heroSecondaryLabel = hero?.kind === "world"
    ? de ? "Profil" : "Profile"
    : hero?.kind === "server" ? de ? "Server" : "Servers" : de ? "Profile" : "Profiles";

  const headerStats = [
    totalPlaytime > 0 ? formatPlaytime(totalPlaytime, lang) : null,
    `${instances.length} ${de ? (instances.length === 1 ? "Profil" : "Profile") : instances.length === 1 ? "profile" : "profiles"}`,
    `${servers.length} ${de ? "Server" : servers.length === 1 ? "server" : "servers"}`,
  ].filter(Boolean).join(" · ");

  return (
    <div className="relative flex h-full flex-1 flex-col overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--bg-root) 68%, transparent) 0%, color-mix(in srgb, var(--bg-root) 34%, transparent) 24%, color-mix(in srgb, var(--bg-root) 44%, transparent) 72%, color-mix(in srgb, var(--bg-root) 66%, transparent) 100%)",
        }}
      />
      <div className="custom-scrollbar relative z-10 h-full w-full overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1320px] flex-col px-6 py-5 md:px-8">

          <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="m-0 text-[1.75rem] font-medium leading-9 tracking-[-0.02em] text-ink md:text-[2rem]">
                {de ? "Weiterspielen" : "Continue playing"}
              </h1>
              <p className="mt-1 truncate font-mono text-micro tabular-nums text-ink-tertiary" title={headerStats}>
                {headerStats}
              </p>
            </div>

            {!activeAccount.id ? (
              <button
                type="button"
                onClick={openAccounts}
                className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[var(--r-md)] bg-accent px-3.5 text-small font-medium text-accent-contrast transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {de ? "Konto verbinden" : "Connect account"}
              </button>
            ) : null}
          </header>

          <div className="grid grid-cols-1 gap-7 lg:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
            <div className="min-w-0">
              <section aria-label={de ? "Weiterspielen" : "Continue playing"} className="relative">
                <div className="relative h-[220px] overflow-hidden rounded-[var(--r-2xl)] border border-hairline bg-[#0b110d] md:h-[240px]">
                  {heroImage ? (
                    <img
                      src={heroImage}
                      alt=""
                      className="h-full w-full object-cover object-[center_55%]"
                      onError={(event) => { (event.currentTarget as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : (
                    <GroveBackdrop />
                  )}
                  <div
                    aria-hidden="true"
                    className="absolute inset-0"
                    style={{ background: "linear-gradient(180deg, rgba(7,10,8,0.24) 0%, rgba(7,10,8,0) 30%, rgba(7,10,8,0.4) 100%)" }}
                  />

                  {hero && (hero.kind === "world" || hero.kind === "server") ? (
                    <PinButton
                      pinned={heroPinned}
                      onClick={() => {
                        if (hero.kind === "world") togglePinned(hero.world.key);
                        else if (hero.kind === "server") onToggleServerPin(hero.server.id);
                      }}
                      label={de ? "Anpinnen" : "Pin"}
                      overlay
                      className="absolute right-4 top-4 z-10"
                    />
                  ) : null}
                </div>

                <div className="relative z-10 -mt-10 ml-4 mr-4 rounded-[var(--r-xl)] border border-stroke bg-canvas p-4 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.9)] md:ml-6 md:mr-auto md:w-[min(440px,calc(100%-48px))]">
                  {hero ? (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-micro font-medium text-ink-secondary">{heroEyebrow}</span>
                        </div>
                        {heroRunning && !heroLaunching ? (
                          <span className="inline-flex shrink-0 items-center gap-1.5 text-micro font-medium text-success">
                            <span className="h-1.5 w-1.5 rounded-full bg-success" />
                            {de ? "Läuft" : "Running"}
                          </span>
                        ) : null}
                      </div>

                      <h2 className="mt-2 line-clamp-2 text-[1.55rem] font-medium leading-8 tracking-[-0.02em] text-ink md:text-[1.7rem] md:leading-9">
                        {heroTitle}
                      </h2>
                      <p className="mt-1 truncate text-mini text-ink-secondary" title={heroMeta}>{heroMeta}</p>

                      <div className="mt-3.5 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={heroPlay}
                          disabled={heroPlayDisabled}
                          className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-[var(--r-md)] px-3.5 text-small font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-55 ${
                            heroRunning && !heroLaunching
                              ? "border border-rim bg-white/5 text-ink hover:bg-white/10"
                              : "bg-accent text-accent-contrast hover:bg-accent-hover"
                          }`}
                        >
                          {heroLaunching ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : heroRunning ? (
                            <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                          ) : (
                            <Play className="h-4 w-4 fill-current" aria-hidden="true" />
                          )}
                          {heroPlayLabel}
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            if (hero.kind === "world") setActiveTab("singleplayer");
                            else if (hero.kind === "server") setActiveTab("multiplayer");
                            else openInstances();
                          }}
                          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[var(--r-md)] border border-hairline px-3 text-small font-medium text-ink-secondary transition-colors hover:border-rim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        >
                          {heroSecondaryLabel}
                          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-micro font-medium text-ink-secondary">{de ? "Start" : "Start"}</span>
                      </div>
                      <h2 className="mt-2 text-title2 font-medium text-ink">
                        {de ? "Noch kein Profil" : "No profile yet"}
                      </h2>
                      <p className="mt-1 max-w-[360px] text-mini leading-5 text-ink-secondary">
                        {de
                          ? "Lege dein erstes Profil an, dann landet hier deine letzte Welt."
                          : "Create your first profile and your last world will wait here."}
                      </p>
                      <button
                        type="button"
                        onClick={() => openInstances("create")}
                        className="mt-4 inline-flex h-9 cursor-pointer items-center gap-2 rounded-[var(--r-md)] bg-accent px-3.5 text-small font-medium text-accent-contrast transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        {de ? "Profil anlegen" : "Create profile"}
                      </button>
                    </>
                  )}
                </div>
              </section>

              {orderedWorlds.length > 0 ? (
                <section aria-label={de ? "Welten" : "Worlds"} className="mt-5">
                  <SectionHeading
                    title={de ? "Welten" : "Worlds"}
                    count={orderedWorlds.length}
                    action={
                      <button
                        type="button"
                        onClick={() => setActiveTab("singleplayer")}
                        className="inline-flex cursor-pointer items-center gap-1 text-mini font-medium text-ink-tertiary transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        {de ? "Alle Welten" : "All worlds"}
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    }
                  />

                  <div className="divide-y divide-hairline">
                    {orderedWorlds.slice(0, 3).map((world) => {
                      const folder = instanceFolderKeyOf(world.instance);
                      const running = runningInstances.find((entry) => entry.folderName === folder);
                      const launching = launchingFolder === folder;
                      const isPinned = pinned.includes(world.key);
                      const image = world.world.iconDataUrl || world.instance.thumbnail || null;
                      const canQuickPlay = supportsQuickPlay(world.instance.minecraftVersion);
                      return (
                        <div
                          key={world.key}
                          className="group -mx-2 flex items-center gap-3 rounded-[var(--r-lg)] px-2 py-1.5 transition-colors hover:bg-hover"
                        >
                          <div className="relative h-12 w-20 shrink-0 overflow-hidden rounded-[var(--r-sm)] border border-hairline bg-[#0b110d]">
                            {image ? (
                              <img
                                src={image}
                                alt=""
                                loading="lazy"
                                className="h-full w-full object-cover"
                                onError={(event) => { (event.currentTarget as HTMLImageElement).style.display = "none"; }}
                              />
                            ) : (
                              <GroveBackdrop />
                            )}
                            {running && !launching ? (
                              <span className="absolute bottom-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-success ring-2 ring-[#0b110d]" />
                            ) : null}
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              if (launching) return;
                              if (running) onStopGame(world.instance.name, folder);
                              else launchWorld(world);
                            }}
                            className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-small font-medium text-ink">{world.world.name}</span>
                              {isPinned ? <Star className="h-3 w-3 shrink-0 fill-current text-accent" aria-hidden="true" /> : null}
                            </span>
                            <span className="mt-0.5 block truncate text-micro text-ink-tertiary">
                              {[
                                world.instance.name !== world.world.name ? world.instance.name : null,
                                world.instance.minecraftVersion,
                                launching
                                  ? de ? "Startet" : "Starting"
                                  : running ? (de ? "Läuft" : "Running") : relativePlayed(world.world.lastPlayed, lang),
                              ].filter(Boolean).join(" · ")}
                            </span>
                          </button>

                          <PinButton
                            pinned={isPinned}
                            onClick={() => togglePinned(world.key)}
                            label={de ? "Welt anpinnen" : "Pin world"}
                            className={isPinned ? "" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"}
                          />

                          <button
                            type="button"
                            disabled={launching}
                            onClick={() => {
                              if (running) onStopGame(world.instance.name, folder);
                              else launchWorld(world);
                            }}
                            aria-label={
                              launching
                                ? de ? "Startet" : "Starting"
                                : running
                                  ? de ? "Spiel beenden" : "Stop game"
                                  : canQuickPlay
                                    ? de ? "Welt starten" : "Start world"
                                    : de ? "Profil starten" : "Start profile"
                            }
                            className={`flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                              running && !launching
                                ? "border-rim bg-white/5 text-ink hover:bg-white/10"
                                : "border-hairline text-ink-secondary hover:border-accent hover:bg-accent hover:text-accent-contrast"
                            }`}
                          >
                            {launching ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            ) : running ? (
                              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                            ) : (
                              <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </div>

            <aside className="min-w-0">
              <section aria-label={de ? "Server" : "Servers"}>
                <SectionHeading
                  title={de ? "Server" : "Servers"}
                  count={orderedServers.length}
                  action={
                    <button
                      type="button"
                      onClick={() => openServers("add")}
                      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[var(--r-sm)] text-ink-tertiary transition-colors hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      aria-label={de ? "Server hinzufügen" : "Add server"}
                      title={de ? "Server hinzufügen" : "Add server"}
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                    </button>
                  }
                />

                {orderedServers.length === 0 ? (
                  <div className="rounded-[var(--r-lg)] border border-dashed border-stroke px-4 py-5">
                    <p className="text-small font-medium text-ink">{de ? "Noch kein Server" : "No server yet"}</p>
                    <p className="mt-1 text-mini leading-5 text-ink-secondary">
                      {de ? "Trag einen Server ein, um direkt von hier zu joinen." : "Add a server to join it right from here."}
                    </p>
                    <button
                      type="button"
                      onClick={() => openServers("add")}
                      className="mt-3 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[var(--r-sm)] border border-hairline px-2.5 text-mini font-medium text-ink-secondary transition-colors hover:border-rim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      {de ? "Server eintragen" : "Add server"}
                    </button>
                  </div>
                ) : (
                  <div className="divide-y divide-hairline">
                    {orderedServers.slice(0, 4).map((server) => {
                      const target = bestInstanceForServer(server, instances);
                      const folder = target ? instanceFolderKeyOf(target) : "";
                      const running = folder
                        ? runningInstances.find((entry) => entry.folderName === folder) ?? null
                        : null;
                      const launching = !!folder && launchingFolder === folder;
                      const status = pings[server.id];
                      const icon = status?.icon
                        || (server.icon && !server.icon.includes("mineatar.io/face") ? server.icon : null);
                      const online = status ? status.online : server.online;
                      const statusText = status
                        ? status.online
                          ? `${status.playersOnline}/${status.playersMax} · ${status.ping} ms`
                          : de ? "Offline" : "Offline"
                        : server.ip;
                      const meta = launching
                        ? de ? "Startet" : "Starting"
                        : running
                          ? `${de ? "Läuft" : "Running"}${status?.online ? ` · ${status.playersOnline}/${status.playersMax}` : ""}`
                          : statusText;
                      return (
                        <div
                          key={server.id}
                          className="group -mx-2 flex h-[52px] items-center gap-2.5 rounded-[var(--r-lg)] px-2 transition-colors hover:bg-hover"
                        >
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-[5px] border border-hairline bg-surface">
                            {icon ? (
                              <img src={icon} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <ServerIcon className="h-3.5 w-3.5 text-ink-tertiary" strokeWidth={1.5} aria-hidden="true" />
                            )}
                          </span>

                          <div className="min-w-0 flex-1">
                            <p className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-small font-medium text-ink">{server.name}</span>
                              <span
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                  online === true ? "bg-success" : online === false ? "bg-danger/70" : "bg-ink-quaternary/50"
                                }`}
                                aria-hidden="true"
                              />
                            </p>
                            <p className="truncate text-micro text-ink-tertiary" title={server.motd || server.ip}>{meta}</p>
                          </div>

                          <PinButton
                            pinned={!!server.pinned}
                            onClick={() => onToggleServerPin(server.id)}
                            label={de ? "Server anpinnen" : "Pin server"}
                            className={server.pinned ? "" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"}
                          />

                          <button
                            type="button"
                            disabled={!target || launching}
                            onClick={() => {
                              if (!target || launching) return;
                              if (running) onStopGame(target.name, folder);
                              else launchServer(server);
                            }}
                            aria-label={
                              launching
                                ? de ? "Startet" : "Starting"
                                : running
                                  ? de ? "Spiel beenden" : "Stop game"
                                  : de ? `${server.name} beitreten` : `Join ${server.name}`
                            }
                            title={
                              launching
                                ? de ? "Startet" : "Starting"
                                : running
                                  ? de ? "Spiel beenden" : "Stop game"
                                  : target ? (de ? `Auf ${target.name} starten` : `Start on ${target.name}`) : undefined
                            }
                            className={`flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40 ${
                              running && !launching
                                ? "border-rim bg-white/5 text-ink hover:bg-white/10"
                                : "border-hairline text-ink-secondary hover:border-accent hover:bg-accent hover:text-accent-contrast"
                            }`}
                          >
                            {launching ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            ) : running ? (
                              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                            ) : (
                              <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {orderedServers.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => openServers()}
                    className="mt-1 inline-flex cursor-pointer items-center gap-1 text-mini font-medium text-ink-tertiary transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    {de ? "Alle Server" : "All servers"}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </section>

              <section aria-label={de ? "Profile" : "Profiles"} className="mt-7">
                <SectionHeading
                  title={de ? "Profile" : "Profiles"}
                  count={instances.length}
                  action={
                    <button
                      type="button"
                      onClick={() => openInstances()}
                      className="inline-flex cursor-pointer items-center gap-1 text-mini font-medium text-ink-tertiary transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      {de ? "Alle Profile" : "All profiles"}
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  }
                />

                <div className="divide-y divide-hairline">
                  {orderedInstances.slice(0, 4).map((instance) => {
                    const folder = instanceFolderKeyOf(instance);
                    const running = runningInstances.find((entry) => entry.folderName === folder);
                    const launching = launchingFolder === folder;
                    return (
                      <div
                        key={instance.id}
                        className="group -mx-2 flex h-[54px] items-center gap-2.5 rounded-[var(--r-lg)] px-2 transition-colors hover:bg-hover"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-sm)] border border-hairline bg-[#0d130f]">
                          {instance.thumbnail ? (
                            <img
                              src={instance.thumbnail}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                              onError={(event) => { (event.currentTarget as HTMLImageElement).style.display = "none"; }}
                            />
                          ) : (
                            <Boxes className="h-3.5 w-3.5 text-ink-tertiary" strokeWidth={1.5} aria-hidden="true" />
                          )}
                        </span>

                        <button
                          type="button"
                          onClick={() => onOpenInstance(instance.name)}
                          className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        >
                          <span className="block truncate text-small font-medium text-ink">{instance.name}</span>
                          <span className="mt-0.5 block truncate text-micro text-ink-tertiary">
                            {instance.minecraftVersion} · {instance.modloader} · {launching
                              ? de ? "Startet" : "Starting"
                              : running ? (de ? "Läuft" : "Running") : relativePlayed(instance.lastPlayedAt, lang)}
                          </span>
                        </button>

                        <button
                          type="button"
                          disabled={launching}
                          onClick={() => {
                            if (running) onStopGame(instance.name, folder);
                            else onLaunch(instance.id);
                          }}
                          aria-label={
                            launching
                              ? de ? "Startet" : "Starting"
                              : running
                                ? de ? "Spiel beenden" : "Stop game"
                                : de ? `${instance.name} starten` : `Start ${instance.name}`
                          }
                          className={`flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                            running && !launching
                              ? "border-rim bg-white/5 text-ink hover:bg-white/10"
                              : "border-hairline text-ink-secondary hover:border-accent hover:bg-accent hover:text-accent-contrast"
                          }`}
                        >
                          {launching ? (
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          ) : running ? (
                            <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
                          ) : (
                            <Play className="h-3 w-3 fill-current" aria-hidden="true" />
                          )}
                        </button>
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() => openInstances("create")}
                    className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-[var(--r-lg)] px-2 text-mini font-medium text-ink-tertiary transition-colors hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {de ? "Neues Profil" : "New profile"}
                  </button>
                </div>
              </section>
            </aside>
          </div>

        </div>
      </div>
    </div>
  );
};
