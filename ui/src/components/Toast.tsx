import { createContext, useContext } from "react";

export interface ToastMessage {
  id: string;
  type: "success" | "error" | "info" | "warning";
  message: string;
  duration?: number;
}

export interface ToastContextType {
  addToast: (toast: Omit<ToastMessage, "id">) => void;
}

export const ToastContext = createContext<ToastContextType>({ addToast: () => {} });

export const useToast = () => useContext(ToastContext);
