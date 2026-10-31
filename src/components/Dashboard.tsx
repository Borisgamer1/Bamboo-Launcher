import React, { useEffect, useRef, useState } from "react";
import {
  Compass,
  Server,
  Puzzle,
  Camera,
  Sliders,
  ArrowRight,
  User,
  Check,
  RefreshCw,
} from "lucide-react";
import { TabType } from "./Sidebar";
import { ThemeType } from "./ParticleBackground";
import { Account } from "./TopBar";
import { translations, LanguageType } from "../lib/translations";
import { requestSettingsTarget } from "../lib/settingsNavigation";
import { SkinViewer, WalkingAnimation } from "skinview3d";
import type { UpdateStatus } from "../electron";
import { LAUNCHER_VERSION } from "../lib/version";

interface DashboardProps {
  setActiveTab: (tab: TabType) => void;
  theme: ThemeType;
  activeAccount: Account;
  lang: LanguageType;
  updateStatus?: UpdateStatus | null;
  onCheckForUpdates?: () => void;
  onInstallUpdate?: () => void;
}

const cardClass =
  "rounded-[var(--r-xl)] border border-stroke bg-surface/65 transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)]";

export const Dashboard: React.FC<DashboardProps> = ({
  setActiveTab,
  activeAccount,
  lang,
  updateStatus,
  onCheckForUpdates,
  onInstallUpdate,
}) => {
  const t = translations[lang];
  const updateBusy = updateStatus?.state === "checking" || updateStatus?.state === "downloading";
  const updateReady = updateStatus?.state === "downloaded";
  const updateBadge = updateReady
    ? (lang === "de" ? "Update bereit" : "Update ready")
    : updateBusy
      ? (lang === "de" ? "Läuft" : "Running")
      : updateStatus?.state === "error"
        ? (lang === "de" ? "Fehler" : "Error")
        : updateStatus?.state === "disabled"
          ? "Dev"
          : updateStatus?.state === "not-available"
            ? t.upToDate
            : "Auto";
  const updateDescription = updateReady
    ? (lang === "de"
        ? `Version ${updateStatus?.version ?? ""} ist bereit. Ein Neustart schließt das Update ab.`
        : `Version ${updateStatus?.version ?? ""} is ready. A restart completes the update.`)
    : updateStatus?.state === "checking"
      ? (lang === "de" ? "Suche nach Updates …" : "Checking for updates …")
      : updateStatus?.state === "available"
        ? (lang === "de" ? `Version ${updateStatus.version ?? ""} ist verfügbar, Download startet …` : `Version ${updateStatus.version ?? ""} is available, download starting …`)
        : updateStatus?.state === "downloading"
          ? (lang === "de" ? `Version ${updateStatus.version ?? ""} wird geladen … ${updateStatus.percent ?? 0}%` : `Downloading version ${updateStatus.version ?? ""} … ${updateStatus.percent ?? 0}%`)
          : updateStatus?.state === "not-available"
            ? (lang === "de" ? "Du verwendest die neueste Version." : "You are on the latest version.")
            : updateStatus?.state === "error"
              ? (lang === "de" ? "Update-Prüfung fehlgeschlagen. Später erneut versuchen." : "Update check failed. Try again later.")
              : updateStatus?.state === "disabled"
                ? (lang === "de" ? "Updates werden nur in der installierten App geprüft." : "Updates are checked in the installed app only.")
                : (lang === "de" ? "Updates werden automatisch alle 6 Stunden geprüft." : "Updates are checked automatically every 6 hours.");
  const skinCanvasRef = useRef<HTMLCanvasElement>(null);
  const skinViewerRef = useRef<SkinViewer | null>(null);

  const [playerIdentity, setPlayerIdentity] = useState<{ uuid: string | null; username: string | null; type: string } | null>(null);

  useEffect(() => {
    const loadIdentity = async () => {
      try {
        const result = await window.electronAPI?.auth.identity?.();
        if (result) setPlayerIdentity(result);
      } catch {
        console.warn("[Dashboard] Failed to load player identity");
      }
    };
    loadIdentity();
  }, []);

  useEffect(() => {
    if (!skinCanvasRef.current) return;
    if (!activeAccount.id) return;

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

    const viewer = new SkinViewer({
      canvas: skinCanvasRef.current,
      width: 320,
      height: 420,
    });
    skinViewerRef.current = viewer;
    viewer.canvas.style.width = "auto";
    viewer.canvas.style.height = "100%";
    viewer.autoRotate = false;
    viewer.resetCameraPose();
    const walkAnim = new WalkingAnimation();
    walkAnim.speed = 0.3;
    viewer.animation = walkAnim;

    viewer.loadSkin(skinUrl).catch(() => {});

    return () => {
      viewer.dispose();
      skinViewerRef.current = null;
    };
  }, [activeAccount.id, activeAccount.uuid, activeAccount.username, activeAccount.type, playerIdentity?.uuid, playerIdentity?.username, playerIdentity?.type]);

  const quickActions = [
    {
      id: "singleplayer",
      title: t.instances,
      desc:
        lang === "de"
          ? "Verwalte, konfiguriere und starte isolierte Spielversionen oder eigene Modpacks."
          : "Manage, configure, and launch isolated game versions or custom modpacks.",
      count: lang === "de" ? "Modpacks & Profile" : "Modpacks & profiles",
      icon: Compass,
    },
    {
      id: "multiplayer",
      title: t.multiplayer,
      desc:
        lang === "de"
          ? "Verbinde dich mit Community-Netzwerken, Minispielen und eigenen Survival-Servern."
          : "Connect to community networks, mini-games, and custom survival servers.",
      count: lang === "de" ? "Live-Pings" : "Live pings",
      icon: Server,
    },
    {
      id: "mods",
      title: t.modBrowser,
      desc:
        lang === "de"
          ? "Durchsuche, filtere und installiere Tausende von Modifikationen direkt über CurseForge & Modrinth."
          : "Browse, query, and install thousands of modifications directly from CurseForge & Modrinth.",
      count: "CurseForge & Modrinth",
      icon: Puzzle,
    },
    {
      id: "screenshots",
      title: t.screenshots,
      desc:
        lang === "de"
          ? "Durchsuche, kopiere und teile hochauflösende Screenshots deiner Abenteuer."
          : "Browse, copy, and share high-resolution screenshots and memories.",
      count: "F2",
      icon: Camera,
    },
    {
      id: "settings",
      title: t.settings,
      desc:
        lang === "de"
          ? "Passe Starteigenschaften, Arbeitsspeicher-Zuweisung, visuelle und Audio-Optimierungen an."
          : "Customize startup behavior, memory allocation, visuals, and audio.",
      count: lang === "de" ? "Launcher-Konfiguration" : "Launcher config",
      icon: Sliders,
    },
  ];

  const badgeClass =
    "inline-flex h-5 items-center rounded-md border border-stroke bg-root/45 px-1.5 text-micro font-medium text-ink-secondary";

  return (
    <div className="flex-1 h-full flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 overflow-y-auto h-full px-6 py-4 flex flex-col gap-4 custom-scrollbar z-10 relative select-none">

          <section className={`${cardClass} shrink-0 overflow-hidden`}>
            <div className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:gap-5">
              <div className="relative flex h-36 w-full shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-lg)] border border-hairline bg-root/40 sm:w-[210px]">
                {activeAccount.id ? (
                  <canvas
                    ref={skinCanvasRef}
                    className="h-full w-auto object-contain pointer-events-none select-none outline-none"
                    style={{ imageRendering: "pixelated" }}
                  />
                ) : (
                  <div className="flex flex-col items-center gap-2 text-ink-tertiary">
                    <User className="h-9 w-9" />
                    <p className="m-0 text-mini font-medium">{lang === "de" ? "Kein Account" : "No account"}</p>
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <p className="m-0 text-micro font-medium uppercase tracking-label text-ink-tertiary">{t.activeProfile}</p>
                <h2 className="m-0 mt-1 truncate text-title3 font-semibold tracking-tight text-ink">
                  {activeAccount.id ? activeAccount.username : lang === "de" ? "Kein Account" : "No account"}
                </h2>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className={badgeClass}>
                    {activeAccount.id
                      ? playerIdentity?.type === "microsoft" || activeAccount.type === "Microsoft"
                        ? "Microsoft"
                        : "Offline"
                      : "—"}
                  </span>
                  {activeAccount.uuid && (
                    <span className="min-w-0 max-w-full truncate font-mono text-micro text-ink-tertiary" title={activeAccount.uuid}>
                      {activeAccount.uuid}
                    </span>
                  )}
                  {!activeAccount.id && (
                    <button
                      type="button"
                      onClick={() => {
                        requestSettingsTarget("accounts");
                        setActiveTab("settings");
                      }}
                      className="text-micro font-medium text-accent hover:underline underline-offset-2 cursor-pointer"
                    >
                      {lang === "de" ? "Account hinzufügen" : "Add account"}
                    </button>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2 self-start sm:self-center">
                <span className={`h-1.5 w-1.5 rounded-full ${activeAccount.id ? "bg-accent" : "bg-stroke-strong"}`} />
                <span className="text-micro text-ink-secondary">
                  {activeAccount.id ? (lang === "de" ? "Bereit" : "Ready") : (lang === "de" ? "Nicht verbunden" : "Not connected")}
                </span>
              </div>
            </div>
          </section>

          <div className="flex shrink-0 items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            <h3 className="m-0 text-micro font-medium uppercase tracking-label text-ink-secondary">{t.quickAccess}</h3>
          </div>

          <div className="grid shrink-0 grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {quickActions.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => setActiveTab(action.id === "singleplayer" ? "singleplayer" : (action.id as TabType))}
                  className={`${cardClass} group flex flex-col gap-4 p-4 text-left hover:border-rim hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 cursor-pointer`}
                >
                  <div className="flex w-full items-start justify-between gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-stroke bg-root/40 text-ink-secondary transition-colors group-hover:border-accent/30 group-hover:text-accent">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="text-micro text-ink-quaternary">{action.count}</span>
                  </div>

                  <div className="min-w-0">
                    <h4 className="m-0 text-regular font-medium text-ink">{action.title}</h4>
                    <p className="m-0 mt-1 text-mini leading-5 text-ink-secondary">{action.desc}</p>
                  </div>

                  <ArrowRight className="h-3.5 w-3.5 text-ink-quaternary transition-[color,translate] duration-[var(--t-quick)] ease-[var(--ease-out)] group-hover:translate-x-0.5 group-hover:text-accent" />
                </button>
              );
            })}
          </div>

          <section
            aria-label={lang === "de" ? "Launcher-Update" : "Launcher update"}
            className={`${cardClass} mt-1 flex shrink-0 flex-wrap items-center gap-3 px-4 py-2.5`}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-stroke bg-root/40">
              {updateBusy ? <RefreshCw className="h-4 w-4 animate-spin text-accent" /> : <Check className="h-4 w-4 text-accent" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="m-0 text-small font-medium text-ink">
                Bamboo Launcher <span className="font-normal text-ink-tertiary">v{LAUNCHER_VERSION}</span>
              </p>
              <p className="m-0 mt-0.5 text-mini leading-5 text-ink-secondary">
                {updateDescription}
              </p>
            </div>
            {updateReady ? (
              <button
                type="button"
                onClick={() => onInstallUpdate?.()}
                className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-mini font-medium text-accent transition-colors hover:bg-accent/20"
              >
                {lang === "de" ? "Neu starten" : "Restart now"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onCheckForUpdates?.()}
                disabled={updateBusy || !onCheckForUpdates}
                className="rounded-lg border border-stroke bg-root/40 px-3 py-1.5 text-mini font-medium text-ink-secondary transition-colors hover:border-rim hover:text-ink disabled:cursor-default disabled:opacity-50"
              >
                {lang === "de" ? "Prüfen" : "Check"}
              </button>
            )}
            <span className={badgeClass}>{updateBadge}</span>
          </section>
        </div>
      </div>
    </div>
  );
};
