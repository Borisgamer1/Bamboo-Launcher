import React, { useCallback, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle, AlertTriangle, X, Info, XCircle } from "lucide-react";
import { useOverlayLayer } from "../lib/overlayLayers";
import { MOTION, EASE, motionSafe } from "../lib/motionTokens";
import { ToastContext, type ToastMessage } from "./Toast";

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  useOverlayLayer("toast", toasts.length > 0);

  const timers = useRef(new Map<string, number>());

  const schedule = useCallback((id: string, duration: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      window.setTimeout(() => {
        timers.current.delete(id);
        setToasts(prev => prev.filter(t => t.id !== id));
      }, duration),
    );
  }, []);

  const addToast = useCallback((toast: Omit<ToastMessage, "id">) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setToasts(prev => [...prev, { ...toast, id }].slice(-3));
    schedule(id, toast.duration || 3200);
  }, [schedule]);

  const removeToast = useCallback((id: string) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        <AnimatePresence>
          {toasts.map(toast => {
            const isError = toast.type === "error";
            const isSuccess = toast.type === "success";
            const isWarning = toast.type === "warning";

            let icon = <Info className="w-4 h-4" />;
            let textColor = "text-info";

            if (isError) {
              icon = <XCircle className="w-4 h-4" />;
              textColor = "text-danger";
            } else if (isSuccess) {
              icon = <CheckCircle className="w-4 h-4" />;
              textColor = "text-success";
            } else if (isWarning) {
              icon = <AlertTriangle className="w-4 h-4" />;
              textColor = "text-warning";
            }

            return (
              <motion.div
                key={toast.id}
                data-blur-tier="toast"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6, transition: motionSafe({ duration: MOTION.quick, ease: EASE.out }) }}
                transition={motionSafe({ duration: MOTION.base, ease: EASE.expo })}
                onMouseEnter={() => {
                  window.clearTimeout(timers.current.get(toast.id));
                }}
                onMouseLeave={() => schedule(toast.id, 1800)}
                className="group pointer-events-auto flex w-[22rem] items-start gap-2.5 px-3 py-2.5 rounded-[var(--r-lg)] border border-rim bg-glass shadow-[var(--shadow-menu)] backdrop-blur-[16px] backdrop-saturate-[1.2] transition-[width] duration-150 hover:w-[min(34rem,calc(100vw-2rem))]"
              >
                <div className={`${textColor} mt-0.5 shrink-0`} aria-hidden="true">{icon}</div>
                <p className="m-0 min-w-0 flex-1 whitespace-normal break-words text-small font-medium leading-5 text-ink line-clamp-2 group-hover:line-clamp-none">{toast.message}</p>
                <button
                  onClick={() => removeToast(toast.id)}
                  aria-label="Schließen"
                  className="p-1 rounded-md hover:bg-selected text-ink-tertiary hover:text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
};
