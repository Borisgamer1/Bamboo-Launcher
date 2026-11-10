import React, { useEffect, useRef, useState } from "react";
import {
  Compass,
  Server,
  Puzzle,
  Camera,
  Sliders,
  ChevronRight,
  Plus,
  RefreshCw,
} from "lucide-react";
import { TabType } from "./Sidebar";
import { ThemeType } from "./ParticleBackground";
import { Account } from "./TopBar";
import { translations, LanguageType } from "../lib/translations";
import { requestSettingsTarget } from "../lib/settingsNavigation";
import { SkinViewer } from "skinview3d";
import type { UpdateStatus } from "../electron";
import { LAUNCHER_VERSION } from "../lib/version";
import { DEFAULT_KEYBINDS, formatKeyToken } from "../lib/keybinds";

interface DashboardProps {
  setActiveTab: (tab: TabType) => void;
  theme: ThemeType;
  activeAccount: Account;
  lang: LanguageType;
  updateStatus?: UpdateStatus | null;
  onCheckForUpdates?: () => void;
  onInstallUpdate?: () => void;
  keybinds?: Record<string, string>;
}

const DESTINATIONS = [
  {
    id: "singleplayer" as TabType,
    key: "instances",
    icon: Compass,
    de: "Profile und Modpacks",
    en: "Profiles and modpacks",
    shortcutAction: null,
  },
  {
    id: "multiplayer" as TabType,
    key: "multiplayer",
    icon: Server,
    de: "Server und Live-Pings",
    en: "Servers and live pings",
    shortcutAction: null,
  },
  {
    id: "mods" as TabType,
    key: "modBrowser",
    icon: Puzzle,
    de: "CurseForge und Modrinth",
    en: "CurseForge and Modrinth",
    shortcutAction: null,
  },
  {
    id: "screenshots" as TabType,
    key: "screenshots",
    icon: Camera,
    de: "Aufgenommene Bilder",
    en: "Captured images",
    shortcutAction: "key.screenshot",
  },
  {
    id: "settings" as TabType,
    key: "settings",
    icon: Sliders,
    de: "Launcher und Spiel",
    en: "Launcher and game",
    shortcutAction: null,
  },
] as const;

/** Studio backdrop for the player: a bamboo clearing at dusk, drawn flat. */
function StageScene() {
  return (
    <svg
      aria-hidden="true"
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 720 640"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id="bamboo-stage-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0c1611" />
          <stop offset="0.55" stopColor="#142219" />
          <stop offset="1" stopColor="#1b2e20" />
        </linearGradient>
        <linearGradient id="bamboo-stage-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a2b1e" />
          <stop offset="0.45" stopColor="#131f17" />
          <stop offset="1" stopColor="#0c130e" />
        </linearGradient>
      </defs>

      <rect width="720" height="640" fill="url(#bamboo-stage-sky)" />

      <g fill="#1b2b20">
        <rect x="18" y="-40" width="26" height="520" />
        <rect x="70" y="-40" width="12" height="520" />
        <rect x="116" y="-40" width="18" height="520" />
        <rect x="376" y="-40" width="14" height="520" />
        <rect x="418" y="-40" width="7" height="520" />
        <rect x="612" y="-40" width="20" height="520" />
        <rect x="664" y="-40" width="32" height="520" />
      </g>
      <g fill="#2b4232" opacity="0.75">
        <rect x="18" y="-40" width="5" height="520" />
        <rect x="116" y="-40" width="4" height="520" />
        <rect x="376" y="-40" width="3" height="520" />
        <rect x="664" y="-40" width="6" height="520" />
      </g>
      <g fill="#0c1510">
        <rect x="18" y="110" width="26" height="4" />
        <rect x="18" y="238" width="26" height="4" />
        <rect x="18" y="366" width="26" height="4" />
        <rect x="70" y="166" width="12" height="3" />
        <rect x="70" y="294" width="12" height="3" />
        <rect x="116" y="64" width="18" height="3" />
        <rect x="116" y="192" width="18" height="3" />
        <rect x="116" y="320" width="18" height="3" />
        <rect x="376" y="146" width="14" height="3" />
        <rect x="376" y="274" width="14" height="3" />
        <rect x="376" y="402" width="14" height="3" />
        <rect x="418" y="202" width="7" height="3" />
        <rect x="418" y="330" width="7" height="3" />
        <rect x="612" y="88" width="20" height="4" />
        <rect x="612" y="216" width="20" height="4" />
        <rect x="612" y="344" width="20" height="4" />
        <rect x="664" y="140" width="32" height="4" />
        <rect x="664" y="268" width="32" height="4" />
        <rect x="664" y="396" width="32" height="4" />
      </g>
      <g fill="#24402d">
        <path d="M34 108 l52 -30 12 20 -48 34 z" />
        <path d="M44 236 l40 -12 6 20 -38 14 z" />
        <path d="M386 144 l32 -20 10 16 -30 20 z" />
        <path d="M622 86 l44 -26 12 18 -42 26 z" />
        <path d="M664 138 l56 -22 8 20 -54 22 z" />
        <path d="M596 214 l34 -12 6 18 -32 12 z" />
      </g>

      <path
        d="M0 438 H96 V418 H170 V402 H238 V422 H310 V438 H720 V640 H0 Z"
        fill="#13231a"
      />
      <rect y="438" width="720" height="202" fill="url(#bamboo-stage-floor)" />
      <rect y="438" width="720" height="1" fill="#2e4332" opacity="0.6" />

      <g stroke="#ffffff" strokeOpacity="0.055">
        <path d="M0 486 H720" />
        <path d="M0 548 H720" />
        <path d="M0 618 H720" />
        <path d="M232 438 L96 640" />
        <path d="M488 438 L664 640" />
      </g>

      <g stroke="#35503d" strokeWidth="1">
        <path d="M511 522 L641 548 L511 574 L381 548 Z" fill="#24372a" />
        <path d="M381 548 L511 574 L511 598 L381 572 Z" fill="#1a2a1f" />
        <path d="M511 574 L641 548 L641 572 L511 598 Z" fill="#142219" />
      </g>

      <g fill="#22362a" stroke="#314b39" strokeWidth="1">
        <path d="M96 520 h72 l24 16 h-72 z" />
        <path d="M70 560 h50 l18 14 h-50 z" />
        <path d="M642 604 h50 l16 13 h-50 z" />
      </g>
      <g fill="#253c2c">
        <path d="M64 502 l4 -22 4 22 z" />
        <path d="M76 504 l5 -16 3 16 z" />
        <path d="M610 566 l4 -18 4 18 z" />
      </g>
    </svg>
  );
}

export const Dashboard: React.FC<DashboardProps> = ({
  setActiveTab,
  activeAccount,
  lang,
  updateStatus,
  onCheckForUpdates,
  onInstallUpdate,
  keybinds,
}) => {
  const t = translations[lang];
  const de = lang === "de";

  const updateBusy = updateStatus?.state === "checking" || updateStatus?.state === "downloading" || updateStatus?.state === "available";
  const updateReady = updateStatus?.state === "downloaded";
  const updateDisabled = updateStatus?.state === "disabled";
  const updateActionLabel = updateBusy
    ? updateStatus?.state === "checking"
      ? de ? "Wird geprüft" : "Checking"
      : de ? "Wird geladen" : "Downloading"
    : updateReady
      ? de ? "Neu starten" : "Restart"
      : de ? "Nach Updates suchen" : "Check for updates";

  const updateLine = updateReady
    ? de
      ? `Version ${updateStatus?.version ?? ""} ist bereit`
      : `Version ${updateStatus?.version ?? ""} is ready`
    : updateStatus?.state === "checking"
      ? de ? "Suche nach Updates" : "Checking for updates"
      : updateStatus?.state === "available"
        ? de
          ? `Version ${updateStatus.version ?? ""} wird geladen`
          : `Downloading version ${updateStatus.version ?? ""}`
        : updateStatus?.state === "downloading"
          ? de
            ? `Version ${updateStatus.version ?? ""} wird geladen · ${updateStatus.percent ?? 0}%`
            : `Downloading version ${updateStatus.version ?? ""} · ${updateStatus.percent ?? 0}%`
          : updateStatus?.state === "not-available"
            ? t.upToDate
            : updateStatus?.state === "error"
              ? de ? "Prüfung fehlgeschlagen" : "Check failed"
              : updateStatus?.state === "disabled"
                ? de ? "Updates in der installierten App" : "Updates in the installed app"
                : de ? "Automatische Prüfung alle 6 Stunden" : "Automatic check every 6 hours";

  const skinCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewerHostRef = useRef<HTMLDivElement>(null);
  const [playerIdentity, setPlayerIdentity] = useState<{ uuid: string | null; username: string | null; type: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadIdentity = async () => {
      try {
        const result = await window.electronAPI?.auth.identity?.();
        if (!cancelled && result) setPlayerIdentity(result);
      } catch {
        console.warn("[Dashboard] Failed to load player identity");
      }
    };
    loadIdentity();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const host = viewerHostRef.current;
    const canvas = skinCanvasRef.current;
    if (!host || !canvas || !activeAccount.id) return;

    const identityName = playerIdentity?.username;
    const identityType = playerIdentity?.type;
    const identityUuid = playerIdentity?.uuid;
    const identityMatches = identityName === activeAccount.username;
    const isMicrosoft = activeAccount.type === "Microsoft" || (identityMatches && identityType === "microsoft");
    const mcUuid = activeAccount.uuid || (identityMatches ? identityUuid : undefined);
    const mcName = activeAccount.username || (identityMatches ? identityName : undefined);
    const skinUrl =
      isMicrosoft && mcUuid
        ? `https://minotar.net/skin/${mcUuid}`
        : isMicrosoft && mcName
          ? `https://minotar.net/skin/${mcName}`
          : "https://minotar.net/skin/MHF_Steve";

    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    const viewer = new SkinViewer({
      canvas,
      width,
      height,
      zoom: Math.min(0.72, (width / height) * 1.5),
      enableControls: false,
    });
    viewer.autoRotate = false;
    viewer.animation = null;
    viewer.resetCameraPose();
    viewer.playerObject.rotation.y = -0.34;
    viewer.playerObject.rotation.x = 0;

    let targetRotationY = -0.34;
    let targetRotationX = 0;
    let currentRotationY = -0.34;
    let currentRotationX = 0;

    const handleMouseMove = (event: MouseEvent) => {
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      const deltaX = (event.clientX - centerX) / centerX;
      const deltaY = (event.clientY - centerY) / centerY;
      targetRotationY = -0.34 + deltaX * 0.9;
      targetRotationX = deltaY * 0.3;
      targetRotationX = Math.max(-0.3, Math.min(0.2, targetRotationX));
    };

    const handleMouseLeave = () => {
      targetRotationY = -0.34;
      targetRotationX = 0;
    };

    window.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseleave", handleMouseLeave);

    let animationId: number;
    const animate = () => {
      currentRotationY += (targetRotationY - currentRotationY) * 0.15;
      currentRotationX += (targetRotationX - currentRotationX) * 0.15;
      viewer.playerObject.rotation.y = currentRotationY;
      viewer.playerObject.rotation.x = currentRotationX;
      animationId = requestAnimationFrame(animate);
    };
    animate();

    void viewer.loadSkin(skinUrl).catch(() => {});

    const observer = new ResizeObserver(() => {
      const nextWidth = host.clientWidth;
      const nextHeight = host.clientHeight;
      if (!nextWidth || !nextHeight) return;
      viewer.setSize(nextWidth, nextHeight);
      viewer.zoom = Math.min(0.72, (nextWidth / nextHeight) * 1.5);
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      window.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseleave", handleMouseLeave);
      cancelAnimationFrame(animationId);
      viewer.dispose();
    };
  }, [activeAccount.id, activeAccount.uuid, activeAccount.username, activeAccount.type, playerIdentity?.uuid, playerIdentity?.username, playerIdentity?.type]);

  const openAccounts = () => {
    requestSettingsTarget("accounts");
    setActiveTab("settings");
  };

  const displayName = activeAccount.id
    ? activeAccount.username
    : de ? "Kein Konto" : "No account";
  const accountKind = activeAccount.id
    ? playerIdentity?.type === "microsoft" || activeAccount.type === "Microsoft"
      ? de ? "Microsoft-Konto" : "Microsoft account"
      : de ? "Offline-Profil" : "Offline profile"
    : de ? "Nicht verbunden" : "Not connected";

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      <div className="custom-scrollbar h-full w-full overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[1440px] flex-col p-6 md:p-8">
          <div className="grid flex-1 grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_336px]">

            <section
              aria-label={de ? "Aktives Profil" : "Active profile"}
              className="relative flex min-h-[420px] flex-col overflow-hidden rounded-[var(--r-2xl)] border border-hairline bg-[#0a100c] md:min-h-[520px]"
            >
              <StageScene />
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  background: "linear-gradient(90deg, rgba(6,10,7,0.9) 0%, rgba(6,10,7,0.66) 42%, rgba(6,10,7,0.16) 68%, rgba(6,10,7,0) 100%)",
                  maskImage: "linear-gradient(to bottom, #000 0%, #000 70%, transparent 100%)",
                  WebkitMaskImage: "linear-gradient(to bottom, #000 0%, #000 70%, transparent 100%)",
                }}
              />

              <div className="relative z-10 flex w-full max-w-[340px] flex-1 flex-col justify-center px-6 py-8 md:w-[52%] md:px-7 md:py-10">
                <p className="m-0 mb-2 text-mini font-medium text-ink-tertiary">
                  {activeAccount.id ? t.activeProfile : de ? "Profil" : "Profile"}
                </p>
                <h1 className="m-0 truncate text-title3 font-medium tracking-[-0.01em] text-ink" title={displayName}>
                  {displayName}
                </h1>

                <div className="mt-2 flex min-w-0 items-center gap-2 text-mini text-ink-secondary">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeAccount.id ? "bg-accent" : "bg-stroke-strong"}`} />
                  <span className="truncate">{accountKind}</span>
                  {activeAccount.id && (
                    <>
                      <span className="text-ink-quaternary">·</span>
                      <span>{de ? "Bereit" : "Ready"}</span>
                    </>
                  )}
                </div>

                {!activeAccount.id && (
                  <p className="mt-4 text-small leading-5 text-ink-secondary">
                    {de
                      ? "Füge ein Microsoft- oder Offline-Konto hinzu, um zu spielen."
                      : "Add a Microsoft or offline account to start playing."}
                  </p>
                )}

                <div className="mt-6">
                  {activeAccount.id ? (
                    <button
                      type="button"
                      onClick={openAccounts}
                      className="inline-flex h-8 items-center rounded-[var(--r-md)] border border-hairline bg-white/[0.04] px-3 text-mini font-medium text-ink-secondary transition-colors hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset cursor-pointer"
                    >
                      {de ? "Konten verwalten" : "Manage accounts"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={openAccounts}
                      className="inline-flex h-9 items-center gap-2 rounded-[var(--r-md)] bg-accent px-4 text-small font-medium text-accent-contrast transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a100c] cursor-pointer"
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      {de ? "Konto hinzufügen" : "Add account"}
                    </button>
                  )}
                </div>
              </div>

              {activeAccount.id && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-[12%] right-[16%] z-[4] h-4 w-44 rounded-[50%] bg-black/40 blur-[6px]"
                />
              )}

              {activeAccount.id && (
                <div ref={viewerHostRef} className="absolute inset-y-0 right-0 z-[5] w-[58%] md:w-[54%]">
                  <canvas
                    ref={skinCanvasRef}
                    aria-label={de ? `Spielfigur von ${displayName}` : `${displayName}'s character`}
                    className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
                  />
                </div>
              )}
            </section>

            <aside className="flex min-h-0 flex-col gap-4">
              <nav
                aria-label={t.quickAccess}
                className="overflow-hidden rounded-[var(--r-xl)] border border-hairline bg-canvas"
              >
                  {DESTINATIONS.map((destination, index) => {
                    const Icon = destination.icon;
                    const label = t[destination.key];
                    const action = destination.shortcutAction;
                    const shortcut = action
                      ? formatKeyToken(keybinds?.[action] ?? DEFAULT_KEYBINDS[action], lang)
                      : null;
                    return (
                      <button
                        key={destination.id}
                        type="button"
                        onClick={() => setActiveTab(destination.id)}
                        className={`group flex h-[72px] w-full items-center gap-3 px-4 text-left transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset cursor-pointer ${index === 0 ? "" : "border-t border-hairline"}`}
                      >
                        <Icon className="h-[18px] w-[18px] shrink-0 text-ink-tertiary transition-colors group-hover:text-ink-secondary" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-small font-medium text-ink">{label}</span>
                          <span className="mt-0.5 block truncate text-micro text-ink-tertiary">{de ? destination.de : destination.en}</span>
                        </span>
                        {shortcut && (
                          <kbd
                            title={shortcut}
                            className="max-w-[8rem] shrink-0 truncate rounded-[4px] border border-hairline bg-root px-1.5 py-0.5 font-mono text-micro leading-4 text-ink-tertiary"
                          >
                            {shortcut}
                          </kbd>
                        )}
                        <ChevronRight className="h-4 w-4 shrink-0 text-ink-quaternary transition-colors group-hover:text-ink-tertiary" aria-hidden="true" />
                      </button>
                    );
                  })}
              </nav>

              <section
                aria-label={de ? "Launcher-Update" : "Launcher update"}
                className="mt-auto rounded-[var(--r-xl)] border border-hairline bg-canvas px-4 py-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-small font-medium text-ink">Bamboo Launcher</span>
                  <span className="font-mono text-micro tabular-nums text-ink-quaternary">v{LAUNCHER_VERSION}</span>
                </div>
                <p className="mt-1 text-mini leading-5 text-ink-secondary">{updateLine}</p>

                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => (updateReady ? onInstallUpdate?.() : onCheckForUpdates?.())}
                    disabled={updateBusy || updateDisabled || (updateReady ? !onInstallUpdate : !onCheckForUpdates)}
                    title={updateDisabled
                      ? de ? "Updates werden nur in der installierten App geprüft" : "Updates are checked in the installed app only"
                      : undefined}
                    className={`inline-flex h-8 w-full items-center justify-center gap-2 rounded-[var(--r-sm)] border px-3 text-mini font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer ${
                      updateReady
                        ? "border-transparent bg-accent text-accent-contrast hover:bg-accent-hover"
                        : "border-stroke text-ink-secondary hover:border-rim hover:text-ink"
                    }`}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${updateBusy ? "animate-spin" : ""}`} aria-hidden="true" />
                    {updateActionLabel}
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
