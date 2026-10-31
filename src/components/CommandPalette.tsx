import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Camera,
  Compass,
  Home,
  LogOut,
  PackagePlus,
  Puzzle,
  Search,
  Server,
  Sliders,
  UserCircle2,
  type LucideIcon,
} from "lucide-react";
import { TabType } from "./Sidebar";
import { translations, LanguageType } from "../lib/translations";
import { MOTION, EASE, motionSafe } from "../lib/motionTokens";
import { resolvePaletteKey, wrapIndex } from "../lib/paletteKeys";
import { requestSettingsTarget } from "../lib/settingsNavigation";

export interface PaletteInstance {
  instanceIdOrName?: string;
  name: string;
  minecraftVersion?: string;
  modloader?: string;
}

export type PaletteInstanceIntent = "create" | "import";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (tab: TabType) => void;
  onExit: () => void;
  lang: LanguageType;
  instances?: PaletteInstance[];
  recentInstance?: string;
  onOpenInstance?: (name: string) => void;
  onInstanceIntent?: (intent: PaletteInstanceIntent) => void;
}

type PaletteGroup = "recent" | "instances" | "actions" | "content";

interface PaletteAction {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  run: () => void;
}

interface PaletteItem {
  id: string;
  label: string;
  group: PaletteGroup;
  icon: LucideIcon;
  aliases: string[];
  meta?: string;
  run: () => void;
  secondary?: PaletteAction;
}

const Kbd = ({ children, tone = "primary" }: { children: React.ReactNode; tone?: "primary" | "hint" }) => (
  <kbd
    className={`inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded-[4px] border border-rim bg-hover text-micro ${
      tone === "hint" ? "text-ink-quaternary" : "text-ink-secondary"
    }`}
  >
    {children}
  </kbd>
);

const Hint = ({ keys, label }: { keys: string; label: string }) => (
  <span className="h-[26px] px-2 rounded-md border border-rim bg-hover flex items-center gap-1.5">
    <Kbd>{keys}</Kbd>
    <span>{label}</span>
  </span>
);

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  onNavigate,
  onExit,
  lang,
  instances = [],
  recentInstance = "",
  onOpenInstance,
  onInstanceIntent,
}) => {
  const de = lang === "de";
  const t = translations[lang];
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeObserver = useRef<MutationObserver | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelIndex, setPanelIndex] = useState(0);
  const reduceMotion = useReducedMotion();

  const groupLabel = (group: PaletteGroup) =>
    group === "recent"
      ? de
        ? "Zuletzt"
        : "Recent"
      : group === "instances"
      ? de
        ? "Instanzen"
        : "Instances"
      : group === "actions"
      ? de
        ? "Aktionen"
        : "Actions"
      : de
      ? "Inhalte"
      : "Content";

  const items = useMemo<PaletteItem[]>(() => {
    const openInstance = (name: string) => {
      onOpenInstance?.(name);
    };
    const instanceMeta = (instance: PaletteInstance) =>
      [instance.minecraftVersion, instance.modloader].filter(Boolean).join(" · ");

    const recents: PaletteItem[] = [];
    const recent = recentInstance
      ? instances.find((instance) => instance.name === recentInstance)
      : undefined;
    if (recent) {
      recents.push({
        id: `recent-${recent.name}`,
        label: recent.name,
        group: "recent",
        icon: Compass,
        aliases: [recent.name.toLowerCase(), "recent", "zuletzt", "last"],
        meta: instanceMeta(recent),
        run: () => openInstance(recent.name),
      });
    }

    const instanceRows: PaletteItem[] = instances
      .filter((instance) => instance.name !== recent?.name)
      .map((instance) => ({
        id: `instance-${instance.name}`,
        label: instance.name,
        group: "instances" as PaletteGroup,
        icon: Compass,
        aliases: [
          instance.name.toLowerCase(),
          String(instance.minecraftVersion ?? "").toLowerCase(),
          String(instance.modloader ?? "").toLowerCase(),
          "instanz",
          "instance",
          "starten",
          "launch",
        ].filter(Boolean),
        meta: instanceMeta(instance),
        run: () => openInstance(instance.name),
      }));

    const newInstance: PaletteItem = {
      id: "new-instance",
      label: de ? "Neue Instanz" : "New instance",
      group: "actions",
      icon: PackagePlus,
      aliases: ["new", "neu", "erstellen", "create", "instanz", "instance"],
      run: () => onInstanceIntent?.("create"),
      secondary: {
        id: "import-modpack",
        label: de ? "Modpack importieren" : "Import modpack",
        hint: "Ctrl+↵",
        icon: PackagePlus,
        run: () => onInstanceIntent?.("import"),
      },
    };

    const importModpack: PaletteItem = {
      id: "import-modpack",
      label: de ? "Modpack importieren" : "Import modpack",
      group: "actions",
      icon: PackagePlus,
      aliases: ["import", "importieren", "modpack", "zip", "mrpack"],
      run: () => onInstanceIntent?.("import"),
    };

    const settings: PaletteItem = {
      id: "settings",
      label: t.settings,
      group: "actions",
      icon: Sliders,
      aliases: ["settings", "einstellungen", "options", "config"],
      run: () => onNavigate("settings"),
      secondary: {
        id: "settings-accounts",
        label: de ? "Konten verwalten" : "Manage accounts",
        hint: "Ctrl+↵",
        icon: UserCircle2,
        run: () => {
          requestSettingsTarget("accounts");
          onNavigate("settings");
        },
      },
    };

    const actions: PaletteItem[] = [
      newInstance,
      importModpack,
      settings,
      {
        id: "home",
        label: t.home,
        group: "actions",
        icon: Home,
        aliases: ["home", "start", "dashboard", "startseite"],
        run: () => onNavigate("home"),
      },
      {
        id: "multiplayer",
        label: t.multiplayer,
        group: "actions",
        icon: Server,
        aliases: ["server", "multiplayer", "mehrspieler", "online"],
        run: () => onNavigate("multiplayer"),
      },
      {
        id: "accounts",
        label: de ? "Account verwalten" : "Manage accounts",
        group: "actions",
        icon: UserCircle2,
        aliases: ["account", "accounts", "konten", "login", "profil"],
        run: () => {
          requestSettingsTarget("accounts");
          onNavigate("settings");
        },
      },
      {
        id: "exit",
        label: de ? "Launcher beenden" : "Quit launcher",
        group: "actions",
        icon: LogOut,
        aliases: ["exit", "quit", "beenden", "schliessen", "close"],
        run: () => onExit(),
      },
    ];

    const content: PaletteItem[] = [
      {
        id: "mods",
        label: t.modBrowser,
        group: "content",
        icon: Puzzle,
        aliases: ["mod", "mods", "modpack", "mod-browser", "curseforge", "modrinth"],
        run: () => onNavigate("mods"),
      },
      {
        id: "screenshots",
        label: t.screenshots,
        group: "content",
        icon: Camera,
        aliases: ["screenshot", "screenshots", "bilder", "gallery"],
        run: () => onNavigate("screenshots"),
      },
    ];

    return [...recents, ...instanceRows, ...actions, ...content];
  }, [de, t, instances, recentInstance, onNavigate, onExit, onOpenInstance, onInstanceIntent]);

  const emptyMenu = useMemo(() => {
    const byId = new Map(items.map((item) => [item.id, item]));
    return [items.find((item) => item.group === "recent"), byId.get("new-instance"), byId.get("import-modpack"), byId.get("settings")].filter(
      (item): item is PaletteItem => Boolean(item)
    );
  }, [items]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return emptyMenu;
    const scored = items
      .map((item) => {
        const label = item.label.toLowerCase();
        if (label.startsWith(q)) return { item, score: 0 };
        if (label.includes(q)) return { item, score: 1 };
        if (item.aliases.some((alias) => alias.startsWith(q))) return { item, score: 2 };
        if (item.aliases.some((alias) => alias.includes(q))) return { item, score: 3 };
        return null;
      })
      .filter((entry): entry is { item: PaletteItem; score: number } => entry !== null);
    const sorted = scored.sort((a, b) => a.score - b.score);
    const order: PaletteGroup[] = ["recent", "instances", "actions", "content"];
    return order.flatMap((group) =>
      sorted.filter((entry) => entry.item.group === group).map((entry) => entry.item)
    );
  }, [items, emptyMenu, query]);

  const highlighted = results[selected];

  const panelActions = useMemo<PaletteAction[]>(() => {
    if (!highlighted) return [];
    const list: PaletteAction[] = [
      {
        id: "primary",
        label: highlighted.group === "recent" || highlighted.group === "instances"
          ? de ? "Instanz öffnen" : "Open instance"
          : de ? "Ausführen" : "Run",
        hint: "↵",
        icon: highlighted.icon,
        run: highlighted.run,
      },
    ];
    if (highlighted.secondary) list.push(highlighted.secondary);
    list.push({
      id: "close-palette",
      label: de ? "Palette schließen" : "Close palette",
      hint: "Esc",
      icon: LogOut,
      run: onClose,
    });
    return list;
  }, [highlighted, de, onClose]);

  useEffect(() => {
    if (!open) return;
    closeObserver.current?.disconnect();
    closeObserver.current = null;
    const root = document.documentElement;
    root.setAttribute("data-palette-open", "true");
    previousFocus.current = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => () => {
    closeObserver.current?.disconnect();
    document.documentElement.removeAttribute("data-palette-open");
  }, []);

  const finishClose = () => {
    if (open) return;
    const previous = previousFocus.current;
    if (previous && document.contains(previous)) previous.focus();
    closeObserver.current?.disconnect();
    const observer = new MutationObserver(() => {
      if (document.querySelector(".command-palette")) return;
      document.documentElement.removeAttribute("data-palette-open");
      observer.disconnect();
      if (closeObserver.current === observer) closeObserver.current = null;
    });
    closeObserver.current = observer;
    observer.observe(document.body, { childList: true, subtree: true });
    if (!document.querySelector(".command-palette")) {
      observer.disconnect();
      closeObserver.current = null;
      document.documentElement.removeAttribute("data-palette-open");
    }
  };

  useEffect(() => {
    if (!open) return;
    const id = panelOpen ? `palette-action-${panelIndex}` : `palette-row-${selected}`;
    document.getElementById(id)?.scrollIntoView({ block: "nearest" });
  }, [open, selected, panelOpen, panelIndex, results.length]);

  const activate = (item: PaletteItem | undefined) => {
    if (!item) return;
    item.run();
    onClose();
  };

  const runSecondary = (item: PaletteItem | undefined) => {
    if (!item?.secondary) return;
    item.secondary.run();
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const decision = resolvePaletteKey(event, {
      query,
      selected,
      count: results.length,
      panelOpen,
    });

    if (decision.type === "none") return;
    event.preventDefault();

    switch (decision.type) {
      case "close":
        onClose();
        return;
      case "close-panel":
        setPanelOpen(false);
        setPanelIndex(0);
        return;
      case "move":
        setSelected((index) => wrapIndex(index, decision.delta, results.length));
        return;
      case "move-panel":
        setPanelIndex((index) => wrapIndex(index, decision.delta, panelActions.length));
        return;
      case "open-panel":
        if (!highlighted) return;
        setPanelOpen(true);
        setPanelIndex(0);
        return;
      case "run":
        if (panelOpen) {
          panelActions[panelIndex]?.run();
          onClose();
          return;
        }
        activate(highlighted);
        return;
      case "run-secondary":
        runSecondary(highlighted);
        return;
      case "settings":
        onClose();
        onNavigate("settings");
        return;
      case "digit":
        activate(results[decision.index]);
        return;
    }
  };

  let lastGroup: PaletteGroup | null = null;

  return (
    <AnimatePresence onExitComplete={finishClose}>
      {open && (
    <motion.div
      key="palette-overlay"
      className="fixed inset-0 z-[80]"
      role="presentation"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: MOTION.base, ease: "linear" } }}
      exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: MOTION.instant, ease: EASE.out } }}
    >
      <div className="absolute inset-0 bg-[rgb(0_0_0/0.32)]" onMouseDown={onClose} aria-hidden="true" />
      <div className="absolute inset-x-0 top-[15vh] px-4 flex justify-center pointer-events-none">
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={de ? "Befehlspalette" : "Command palette"}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: MOTION.instant, ease: EASE.out } }}
          transition={motionSafe({ duration: MOTION.base, ease: EASE.expo })}
          className="command-palette pointer-events-auto w-[750px] max-w-full max-h-[480px] flex flex-col rounded-xl border overflow-hidden shadow-[var(--shadow-palette)] backdrop-blur-[24px] backdrop-saturate-[1.2]"
          style={{ background: "var(--bg-glass-blur)", borderColor: "var(--glass-rim)" }}
        >
          <div className="h-14 shrink-0 px-4 flex items-center gap-3 border-b border-rim">
            <Search className="w-[22px] h-[22px] text-ink-quaternary" aria-hidden="true" />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls={panelOpen ? "palette-actions" : "palette-list"}
              aria-autocomplete="list"
              aria-activedescendant={
                panelOpen
                  ? panelActions.length
                    ? `palette-action-${panelIndex}`
                    : undefined
                  : results.length
                  ? `palette-row-${selected}`
                  : undefined
              }
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
                setPanelOpen(false);
                setPanelIndex(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder={de ? "Befehl oder Ansicht suchen…" : "Search commands or views…"}
              className="flex-1 h-8 bg-transparent text-field text-ink placeholder:text-ink-tertiary outline-none"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          {panelOpen && highlighted ? (
            <div
              id="palette-actions"
              role="listbox"
              aria-label={de ? `Aktionen für ${highlighted.label}` : `Actions for ${highlighted.label}`}
              className="flex-1 min-h-0 overflow-y-auto py-1"
            >
              <div role="presentation" className="px-4 mt-6 mb-1 text-micro font-medium uppercase text-ink-tertiary tracking-label">
                {highlighted.label}
              </div>
              {panelActions.map((action, index) => {
                const Icon = action.icon;
                const isSelected = index === panelIndex;
                return (
                  <div
                    key={action.id}
                    id={`palette-action-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    onMouseMove={() => setPanelIndex(index)}
                    onClick={() => {
                      action.run();
                      onClose();
                    }}
                    className={`h-[38px] mx-2 px-2 rounded-md flex items-center gap-2 text-small cursor-pointer ${
                      isSelected ? "bg-selected text-ink" : "text-ink-secondary"
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span className="truncate flex-1">{action.label}</span>
                    <span aria-hidden="true" className="text-ink-quaternary">
                      <Kbd tone="hint">{action.hint}</Kbd>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div id="palette-list" role="listbox" aria-label={de ? "Ergebnisse" : "Results"} className="flex-1 min-h-0 overflow-y-auto py-1">
              {results.length === 0 && (
                <div className="px-4 py-8 text-center text-small text-ink-secondary">
                  {de ? `Keine Treffer für „${query}“` : `No matches for “${query}”`}
                </div>
              )}
              {results.map((item, index) => {
                const Icon = item.icon;
                const showGroup = item.group !== lastGroup;
                lastGroup = item.group;
                const isSelected = index === selected;
                return (
                  <React.Fragment key={item.id}>
                    {showGroup && (
                      <div role="presentation" className="px-4 mt-6 mb-1 text-micro font-medium uppercase text-ink-tertiary tracking-label">
                        {groupLabel(item.group)}
                      </div>
                    )}
                    <div
                      id={`palette-row-${index}`}
                      role="option"
                      aria-selected={isSelected}
                      onMouseMove={() => setSelected(index)}
                      onClick={() => activate(item)}
                      className={`h-[38px] mx-2 px-2 rounded-md flex items-center gap-2 text-small cursor-pointer ${
                        isSelected ? "bg-selected text-ink" : "text-ink-secondary"
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span className="truncate flex-1">{item.label}</span>
                      {item.meta && (
                        <span className="shrink-0 text-small text-ink-tertiary">{item.meta}</span>
                      )}
                      {index < 9 && (
                        <span aria-hidden="true" className="shrink-0 w-[18px] flex justify-end text-ink-quaternary">
                          <Kbd tone="hint">{index + 1}</Kbd>
                        </span>
                      )}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          )}

          <div className="h-10 shrink-0 px-4 border-t border-rim flex items-center justify-between text-mini text-ink-secondary">
            <div className="flex items-center gap-2">
              <Hint keys="↑↓" label={de ? "wählen" : "move"} />
              <Hint keys="↵" label={de ? "öffnen" : "open"} />
              <Hint keys="Tab" label={de ? "Aktionen" : "actions"} />
              <Hint keys="Esc" label={de ? "schließen" : "close"} />
            </div>
            <div className="flex items-center gap-1.5">
              <Kbd tone="hint">1–9</Kbd>
              <span className="ml-0.5">{de ? "springt" : "jump"}</span>
            </div>
          </div>

          <div aria-live="polite" className="sr-only">
            {results.length} {de ? (results.length === 1 ? "Ergebnis" : "Ergebnisse") : results.length === 1 ? "result" : "results"}
          </div>
        </motion.div>
      </div>
    </motion.div>
      )}
    </AnimatePresence>
  );
};
