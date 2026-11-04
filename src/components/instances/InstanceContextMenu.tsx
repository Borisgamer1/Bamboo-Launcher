import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRightLeft,
  Copy,
  FileArchive,
  FolderOpen,
  Image as ImageIcon,
  Monitor,
  PackagePlus,
  Settings2,
  Trash2,
  Wrench,
} from "lucide-react";
import type { Instance } from "../InstancesView";
import type { LanguageType } from "../../lib/translations";
import { EASE, MOTION, motionSafe } from "../../lib/motionTokens";
import { useOverlayLayer } from "../../lib/overlayLayers";

interface ContextMenuAction {
  id: string;
  label: string;
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
  onClose: () => void;
  onDelete: (instance: Instance) => void;
  onOpenFolder: (instance: Instance) => void;
  onRepair: (instance: Instance) => void;
  onChangeVersion: (instance: Instance) => void;
  onClone: (instance: Instance) => void;
  onAddContent: (instance: Instance) => void;
  onChangeImage: (instance: Instance) => void;
  onInstanceOptions: (instance: Instance) => void;
  onExport: (instance: Instance) => void;
  onCreateShortcut: (instance: Instance) => void;
}

export const InstanceContextMenu: React.FC<InstanceContextMenuProps> = ({
  open,
  x,
  y,
  instance,
  lang,
  onClose,
  onDelete,
  onOpenFolder,
  onRepair,
  onChangeVersion,
  onClone,
  onAddContent,
  onChangeImage,
  onInstanceOptions,
  onExport,
  onCreateShortcut,
}) => {
  const de = lang === "de";
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
      label: de ? "Inhalt hinzufügen" : "Add content",
      icon: PackagePlus,
      run: onAddContent,
    },
    {
      id: "options",
      label: de ? "Instanz-Optionen" : "Instance options",
      icon: Settings2,
      run: onInstanceOptions,
    },
    {
      id: "image",
      label: de ? "Bild ändern" : "Change image",
      icon: ImageIcon,
      run: onChangeImage,
    },
    {
      id: "folder",
      label: de ? "Ordner öffnen" : "Open folder",
      icon: FolderOpen,
      run: onOpenFolder,
    },
    {
      id: "clone",
      label: de ? "Klonen / Kopieren" : "Clone / copy",
      icon: Copy,
      run: onClone,
    },
    {
      id: "change-version",
      label: de ? "Version wechseln" : "Switch version",
      icon: ArrowRightLeft,
      run: onChangeVersion,
    },
    {
      id: "repair",
      label: de ? "Reparieren" : "Repair",
      icon: Wrench,
      run: onRepair,
    },
    {
      id: "shortcut",
      label: de ? "Desktop-Verknüpfung erstellen" : "Create desktop shortcut",
      icon: Monitor,
      run: onCreateShortcut,
    },
    {
      id: "export",
      label: de ? "Exportieren" : "Export",
      icon: FileArchive,
      run: onExport,
    },
    {
      id: "delete",
      label: de ? "Instanz löschen" : "Delete instance",
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

  const renderAction = (action: ContextMenuAction) => {
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
        className={`group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-small font-medium transition-colors duration-75 ${
          action.danger
            ? selected
              ? "bg-danger/14 text-danger"
              : "text-danger hover:bg-danger/10"
            : selected
              ? "bg-hover text-ink"
              : "text-ink-secondary hover:bg-hover/70 hover:text-ink"
        }`}
      >
        <Icon
          className={`h-3.5 w-3.5 shrink-0 ${
            action.danger ? "text-danger/80" : "text-ink-tertiary group-hover:text-ink"
          }`}
        />
        <span className="truncate">{action.label}</span>
      </button>
    );
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={menuRef}
          role="menu"
          aria-label={de ? `Aktionen für ${instance.name}` : `Actions for ${instance.name}`}
          tabIndex={-1}
          data-blur-tier="menu"
          initial={{ opacity: 0, scale: 0.97, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: -2 }}
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
          className="fixed z-[80] w-[248px] overflow-hidden rounded-[var(--r-lg)] border border-rim bg-glass p-1 shadow-[var(--shadow-menu)] outline-none backdrop-blur-[18px] backdrop-saturate-[1.25]"
        >
          {actions.filter((action) => !action.danger).map(renderAction)}
          <div className="mt-1 border-t border-hairline pt-1">
            {actions.filter((action) => action.danger).map(renderAction)}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
};
