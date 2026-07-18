import React, { useState, useEffect, useCallback, createContext, useContext } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle, AlertTriangle, X, Info, XCircle } from "lucide-react";

export interface ToastMessage {
  id: string;
  type: "success" | "error" | "info" | "warning";
  message: string;
  duration?: number;
}

interface ToastContextType {
  addToast: (toast: Omit<ToastMessage, "id">) => void;
}

const ToastContext = createContext<ToastContextType>({ addToast: () => {} });

export const useToast = () => useContext(ToastContext);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((toast: Omit<ToastMessage, "id">) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setToasts(prev => [...prev, { ...toast, id }]);
    
    const duration = toast.duration || 4000;
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, duration);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* Toast Container - Bottom Right Corner (Issue 25) */}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        <AnimatePresence>
          {toasts.map(toast => {
            const isError = toast.type === "error";
            const isSuccess = toast.type === "success";
            const isWarning = toast.type === "warning";
            
            let icon = <Info className="w-4 h-4" />;
            let borderColor = "border-sky-500/30";
            let bgColor = "bg-sky-500/10";
            let textColor = "text-sky-400";
            
            if (isError) {
              icon = <XCircle className="w-4 h-4" />;
              borderColor = "border-rose-500/30";
              bgColor = "bg-rose-500/10";
              textColor = "text-rose-400";
            } else if (isSuccess) {
              icon = <CheckCircle className="w-4 h-4" />;
              borderColor = "border-emerald-500/30";
              bgColor = "bg-emerald-500/10";
              textColor = "text-emerald-400";
            } else if (isWarning) {
              icon = <AlertTriangle className="w-4 h-4" />;
              borderColor = "border-amber-500/30";
              bgColor = "bg-amber-500/10";
              textColor = "text-amber-400";
            }

            return (
              <motion.div
                key={toast.id}
                initial={{ opacity: 0, x: 100, scale: 0.9 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 100, scale: 0.9 }}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
                className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl border shadow-2xl backdrop-blur-xl min-w-[280px] max-w-[400px] ${bgColor} ${borderColor} bg-slate-950/90`}
              >
                <div className={`${textColor} shrink-0`}>{icon}</div>
                <p className="text-xs font-bold text-slate-200 flex-1">{toast.message}</p>
                <button
                  onClick={() => removeToast(toast.id)}
                  className="p-1 rounded-lg hover:bg-slate-800/60 text-slate-500 hover:text-slate-300 transition-all cursor-pointer shrink-0"
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
