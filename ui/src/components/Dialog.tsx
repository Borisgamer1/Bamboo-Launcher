import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { MOTION, EASE, motionSafe } from "../lib/motionTokens";
import { isTopDialog, lockBackground, unlockBackground } from "./dialogSupport";
import {
  captureReturnFocus,
  focusableElements,
  nextFocusIndex,
  resolveDialogKey,
  resolveReturnFocus,
  trackFocusOutsideDialogs,
} from "../lib/dialogFocus";

const PANEL =
  "max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] bg-surface border border-rim rounded-2xl shadow-[var(--shadow-menu)] flex flex-col overflow-hidden text-left outline-none";

const DEFAULT_PANEL_WIDTH = "w-[480px]";

const BODY = "flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 text-small text-ink-secondary";

const TONE: Record<NonNullable<DialogProps["tone"]>, string> = {
  accent: "text-accent",
  danger: "text-danger",
  info: "text-info",
};

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  titleId: string;
  closeLabel: string;
  icon?: React.ReactNode;
  tone: "accent" | "danger" | "info";
  children: React.ReactNode;
  footer?: React.ReactNode;
  bodyClassName?: string;
  widthClassName?: string;
  returnFocusFallback?: () => HTMLElement | null;
}

if (typeof document !== "undefined") trackFocusOutsideDialogs();

const HOST_ID = "dialog-layer";

function dialogHost(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    document.body.appendChild(host);
  }
  return host;
}

export const Dialog: React.FC<DialogProps> = ({
  open,
  onClose,
  title,
  titleId,
  closeLabel,
  icon,
  tone,
  children,
  footer,
  bodyClassName,
  widthClassName,
  returnFocusFallback,
}) => {
  const [host] = useState(dialogHost);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnTarget = useRef<HTMLElement | null>(null);
  const token = useRef(Symbol("dialog"));
  const closeRef = useRef(onClose);
  const fallbackRef = useRef(returnFocusFallback);

  useEffect(() => {
    closeRef.current = onClose;
    fallbackRef.current = returnFocusFallback;
  });

  useLayoutEffect(() => {
    if (!open) return;
    const lockToken = token.current;
    returnTarget.current = captureReturnFocus(document.activeElement);
    lockBackground(lockToken);

    const root = panelRef.current;
    if (root) {
      const preferred = root.querySelector<HTMLElement>("[data-autofocus]");
      (preferred ?? focusableElements(root)[0] ?? root).focus({ preventScroll: true });
    }

    return () => {
      unlockBackground(lockToken);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return () => {
      const target = resolveReturnFocus(returnTarget.current, fallbackRef.current);
      returnTarget.current = null;
      target?.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopDialog(token.current)) return;
      const decision = resolveDialogKey(event);
      if (decision === "none") return;
      if (decision === "close") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      const root = panelRef.current;
      if (!root) return;
      event.preventDefault();
      const items = focusableElements(root);
      if (items.length === 0) {
        root.focus({ preventScroll: true });
        return;
      }
      const current = items.indexOf(document.activeElement as HTMLElement);
      items[nextFocusIndex(current, items.length, event.shiftKey)]?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  if (!host) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-root/80 p-4 pointer-events-auto"
          onClick={() => closeRef.current()}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            transition={motionSafe({ duration: MOTION.base, ease: EASE.out })}
            className={`${PANEL} ${widthClassName ?? DEFAULT_PANEL_WIDTH}`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="h-11 shrink-0 px-2 pl-4 flex items-center justify-between gap-3 border-b border-hairline">
              <div className="flex min-w-0 items-center gap-2">
                {icon && (
                  <span className={`shrink-0 ${TONE[tone]}`} aria-hidden="true">
                    {icon}
                  </span>
                )}
                <h3 id={titleId} className="truncate text-small font-medium text-ink">
                  {title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => closeRef.current()}
                aria-label={closeLabel}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-tertiary hover:bg-selected hover:text-ink transition-[color,background-color] cursor-pointer"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </header>

            <div className={bodyClassName ?? BODY}>{children}</div>

            {footer && (
              <footer className="h-14 shrink-0 px-4 flex items-center justify-end gap-2 border-t border-hairline">
                {footer}
              </footer>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    host
  );
};

