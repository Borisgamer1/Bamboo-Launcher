import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Copy,
  FileArchive,
  FolderOpen,
  Image as ImageIcon,
  Monitor,
  PackagePlus,
  Package,
  Settings2,
  Trash2,
  Wrench,
} from "lucide-react";
import type { Instance } from "../InstancesView";
import { translations, type LanguageType } from "../../lib/translations";
import { EASE, MOTION, motionSafe } from "../../lib/motionTokens";
import { useOverlayLayer } from "../../lib/overlayLayers";

type MenuGroup = "instance" | "manage" | "share" | "danger";

interface ContextMenuAction {
  id: string;
  group: MenuGroup;
  label: string;
  description: string;
  icon: React.ElementType;
  danger?: boolean;
  run: (instance: Instance) => void;
}

export interface InstanceContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  instance: Instance | null;
  lang: LanguageType;
  confirmDelete: boolean;
  onClose: () => void;
  onDelete: (instance: Instance) => void;
  onOpenFolder: (instance: Instance) => void;
  onRepair: (instance: Instance) => void;
  onClone: (instance: Instance) => void;
  onAddContent: (instance: Instance) => void;
  onChangeImage: (instance: Instance) => void;
  onInstanceOptions: (instance: Instance) => void;
  onExport: (instance: Instance) => void;
  onCreateShortcut: (instance: Instance) => void;
}

const groupLabel: Record<MenuGroup, { de: string; en: string }> = {
  instance: { de: "Instanz", en: "Instance" },
  manage: { de: "Verwalten", en: "Manage" },
  share: { de: "Teilen", en: "Share" },
  danger: { de: "Gefahrenzone", en: "Danger zone" },
};

export const InstanceContextMenu: React.FC<InstanceContextMenuProps> = ({
  open,
  x,
  y,
  instance,
  lang,
  confirmDelete,
  onClose,
  onDelete,
  onOpenFolder,
  onRepair,
  onClone,
  onAddContent,
  onChangeImage,
  onInstanceOptions,
  onExport,
  onCreateShortcut,
}) => {
  const de = lang === "de";
  const t = translations[lang];
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: x, top: y });

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useOverlayLayer("menu", open);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => menuRef.current?.focus(), 0);
    const close = (event: Event) => {
      if (event instanceof PointerEvent && menuRef.current?.contains(event.target as Node)) return;
      closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const element = menuRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin));
    setPosition({ left, top });
  }, [open, x, y, instance?.id]);

  if (!instance) return null;

  const actions: ContextMenuAction[] = [
    {
      id: "add-content",
      group: "instance",
      label: de ? "Inhalt hinzufügen" : "Add content",
      description: de ? "Mods, Packs und Welten hinzufügen" : "Add mods, packs and worlds",
      icon: PackagePlus,
      run: onAddContent,
    },
    {
      id: "options",
      group: "instance",
      label: de ? "Instanz-Optionen" : "Instance options",
      description: de ? "Einstellungen dieser Instanz öffnen" : "Open this instance's settings",
      icon: Settings2,
      run: onInstanceOptions,
    },
    {
      id: "image",
      group: "instance",
      label: de ? "Bild ändern" : "Change image",
      description: de ? "Titelbild der Instanz auswählen" : "Choose the instance cover",
      icon: ImageIcon,
      run: onChangeImage,
    },
    {
      id: "folder",
      group: "manage",
      label: de ? "Ordner öffnen" : "Open folder",
      description: de ? "Instanzordner im Explorer öffnen" : "Reveal the instance folder",
      icon: FolderOpen,
      run: onOpenFolder,
    },
    {
      id: "clone",
      group: "manage",
      label: de ? "Klonen / Kopieren" : "Clone / copy",
      description: de ? "Komplette Kopie inklusive Welten und Config" : "Full copy including worlds and config",
      icon: Copy,
      run: onClone,
    },
    {
      id: "repair",
      group: "manage",
      label: de ? "Reparieren" : "Repair",
      description: de ? "Version, Loader und Bibliotheken prüfen" : "Check version, loader and libraries",
      icon: Wrench,
      run: onRepair,
    },
    {
      id: "shortcut",
      group: "manage",
      label: de ? "Desktop-Verknüpfung erstellen" : "Create desktop shortcut",
      description: de ? "Startet diese Instanz direkt vom Desktop" : "Launches this instance from the desktop",
      icon: Monitor,
      run: onCreateShortcut,
    },
    {
      id: "export",
      group: "share",
      label: de ? "Exportieren" : "Export",
      description: de ? "Als Modrinth-Pack oder ZIP sichern" : "Save as a Modrinth pack or ZIP",
      icon: FileArchive,
      run: onExport,
    },
    {
      id: "delete",
      group: "danger",
      label: de ? "Instanz löschen" : "Delete instance",
      description: confirmDelete
        ? de ? "Mit Sicherheitsabfrage" : "Asks for confirmation"
        : de ? "Wird sofort gelöscht" : "Deletes immediately",
      icon: Trash2,
      danger: true,
      run: onDelete,
    },
  ];

  const runAction = (action: ContextMenuAction) => {
    if (!instance) return;
    onClose();
    action.run(instance);
  };

  const renderedGroups: MenuGroup[] = [];
  for (const action of actions) {
    if (!renderedGroups.includes(action.group)) renderedGroups.push(action.group);
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={menuRef}
          role="menu"
          aria-label={de ? `Aktionen für ${instance.name}` : `Actions for ${instance.name}`}
          tabIndex={-1}
          data-blur-tier="menu"
          initial={{ opacity: 0, scale: 0.96, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -2 }}
          transition={motionSafe({ duration: MOTION.quick, ease: EASE.out })}
          style={{ left: position.left, top: position.top }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((current) => (current + 1) % actions.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current) => (current - 1 + actions.length) % actions.length);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              runAction(actions[active]);
            }
          }}
          className="fixed z-[80] w-[314px] overflow-hidden rounded-[var(--r-lg)] border border-rim bg-glass backdrop-blur-[18px] backdrop-saturate-[1.25] p-1.5 shadow-[var(--shadow-menu)] outline-none"
        >
          <div className="mb-1 flex items-center gap-2.5 rounded-[var(--r-sm)] border border-hairline bg-surface/35 px-2 py-2">
            <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-rim bg-root">
              {instance.thumbnail ? (
                <img src={instance.thumbnail} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center">
                  <Package className="h-4 w-4 text-ink-tertiary" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-small font-semibold text-ink">{instance.name}</p>
              <p className="truncate text-micro text-ink-tertiary">
                {instance.minecraftVersion} · {instance.modloader}
                {instance.modloaderVersion ? ` ${instance.modloaderVersion}` : ""}
              </p>
            </div>
          </div>

          {renderedGroups.map((group) => {
            const groupActions = actions.filter((action) => action.group === group);
            const isDanger = group === "danger";
            return (
              <div
                key={group}
                className={isDanger ? "mt-1 border-t border-hairline pt-1" : group === "instance" ? "" : "mt-1 border-t border-hairline pt-1"}
              >
                <p className={`px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-label ${isDanger ? "text-danger/80" : "text-ink-quaternary"}`}>
                  {groupLabel[group][de ? "de" : "en"]}
                </p>
                {groupActions.map((action) => {
                  const index = actions.indexOf(action);
                  const Icon = action.icon;
                  const selected = index === active;
                  return (
                    <button
                      key={action.id}
                      type="button"
                      role="menuitem"
                      onMouseEnter={() => setActive(index)}
                      onClick={() => runAction(action)}
                      className={`group flex w-full cursor-pointer items-center gap-2.5 rounded-[var(--r-sm)] px-2 py-2 text-left transition-colors duration-75 ${
                        action.danger
                          ? selected ? "bg-danger/14" : "hover:bg-danger/10"
                          : selected ? "bg-hover" : "hover:bg-hover/70"
                      }`}
                    >
                      <span
                        className={`grid h-7 w-7 shrink-0 place-items-center rounded-md border ${
                          action.danger
                            ? "border-danger/20 bg-danger/8 text-danger"
                            : "border-hairline bg-hover text-ink-secondary group-hover:text-ink"
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-small font-medium ${action.danger ? "text-danger" : "text-ink"}`}>
                          {action.label}
                        </span>
                        <span className={`block truncate text-micro ${action.danger ? "text-danger/70" : "text-ink-tertiary"}`}>
                          {action.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}

          <div className="mt-1 flex items-center justify-between border-t border-hairline px-2 pt-1.5 text-[10px] font-medium text-ink-quaternary">
            <span>↑↓ {de ? "auswählen" : "navigate"}</span>
            <span>↵ {de ? "öffnen" : "open"}</span>
            <span>esc {t.close}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
};
