const host = import.meta.env.VITE_API_HOST || 'localhost';
const port = import.meta.env.VITE_API_PORT || '3005';
const protocol = import.meta.env.VITE_API_PROTOCOL || 'http';

export const API_BASE = `${protocol}://${host}:${port}/api`;

export function getLauncherHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Launcher-Key": import.meta.env.VITE_LAUNCHER_KEY || "",
  };
}
