import React, { useEffect, useRef, useState } from "react";
import { Focus, Loader2, RotateCw, UserRound } from "lucide-react";
import { IdleAnimation, SkinViewer } from "skinview3d";
import type { SkinSnapshot } from "../../electron";
import type { LanguageType } from "../../lib/translations";

interface SkinStageProps {
  snapshot: SkinSnapshot | null;
  lang: LanguageType;
  onOpenAccounts: () => void;
  defaultRotation?: number;
}

const STAGE_BUTTON =
  "inline-flex h-7 w-7 items-center justify-center rounded-md border border-hairline bg-root/75 text-ink-secondary backdrop-blur-sm transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] hover:border-stroke-strong hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/**
 * The player is the product: this stage renders the chosen skin and nothing
 * else. Cosmetic meshes are intentionally not attached here; they get their
 * own renderer when the cosmetics system is rebuilt.
 */
export const SkinStage: React.FC<SkinStageProps> = ({
  snapshot,
  lang,
  onOpenAccounts,
  defaultRotation = 0.22,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  const [ready, setReady] = useState(0);
  const [texture, setTexture] = useState<{ key: string | null; status: "loading" | "ready" | "error" }>({
    key: null,
    status: "error",
  });
  const [autoRotate, setAutoRotate] = useState(false);
  const de = lang === "de";

  const skinUrl = snapshot?.skin.url ?? null;
  const variant = snapshot?.skin.variant ?? "classic";
  const textureKey = skinUrl ? `${skinUrl}|${variant}` : null;
  const loadState = skinUrl ? (texture.key === textureKey ? texture.status : "loading") : "idle";

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const viewer = new SkinViewer({
      canvas,
      width: Math.max(host.clientWidth, 240),
      height: Math.max(host.clientHeight, 200),
    });
    viewerRef.current = viewer;
    viewer.background = null;
    viewer.fov = 36;
    viewer.controls.enablePan = false;
    viewer.controls.minDistance = 36;
    viewer.controls.maxDistance = 170;
    viewer.controls.minPolarAngle = Math.PI * 0.2;
    viewer.controls.maxPolarAngle = Math.PI * 0.8;

    const idle = new IdleAnimation();
    idle.speed = 0.32;
    viewer.animation = idle;
    viewer.zoom = 0.78;
    viewer.resetCameraPose();
    viewer.playerWrapper.rotation.y = defaultRotation;

    setReady((value) => value + 1);

    const observer = new ResizeObserver(() => {
      if (viewer.disposed) return;
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width > 0 && height > 0) viewer.setSize(width, height);
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      viewer.dispose();
      if (viewerRef.current === viewer) viewerRef.current = null;
    };
  }, [defaultRotation]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !ready) return;
    if (!skinUrl) {
      viewer.loadSkin(null);
      return;
    }

    let cancelled = false;
    Promise.resolve()
      .then(() => viewer.loadSkin(skinUrl, { model: variant === "slim" ? "slim" : "default" }))
      .then(() => {
        if (!cancelled) setTexture({ key: textureKey, status: "ready" });
      })
      .catch((cause) => {
        if (cancelled) return;
        console.warn("[Skin] skin could not be loaded", cause);
        setTexture({ key: textureKey, status: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [ready, skinUrl, textureKey, variant]);

  useEffect(() => {
    if (!viewerRef.current) return;
    viewerRef.current.autoRotate = autoRotate;
  }, [autoRotate, ready]);

  const resetCamera = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.zoom = 0.78;
    viewer.resetCameraPose();
    viewer.playerWrapper.rotation.y = defaultRotation;
  };

  return (
    <div ref={hostRef} className="relative h-[228px] w-full overflow-hidden bg-root">
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-[linear-gradient(180deg,transparent,rgba(0,0,0,0.2))]"
        aria-hidden
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-10 block h-full w-full"
        aria-label={de ? "3D-Vorschau deines Skins" : "3D preview of your skin"}
      />

      {skinUrl ? null : (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full border border-stroke text-ink-tertiary">
            <UserRound className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <p className="m-0 text-small font-medium text-ink">
              {de ? "Noch kein Skin" : "No skin yet"}
            </p>
            <p className="m-0 mt-1 max-w-[200px] text-micro leading-4 text-ink-tertiary">
              {de
                ? "Lade einen Skin hoch oder verbinde dein Microsoft-Konto."
                : "Upload a skin or connect your Microsoft account."}
            </p>
          </div>
          {snapshot?.account ? null : (
            <button
              type="button"
              onClick={onOpenAccounts}
              className="text-micro font-medium text-accent hover:underline"
            >
              {de ? "Konto verbinden" : "Connect account"}
            </button>
          )}
        </div>
      )}

      {loadState === "loading" ? (
        <span className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 text-ink-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        </span>
      ) : null}

      {loadState === "error" ? (
        <p className="absolute inset-x-6 bottom-12 z-20 m-0 text-center text-micro leading-4 text-danger">
          {de ? "Der Skin konnte nicht geladen werden." : "The skin could not be loaded."}
        </p>
      ) : null}

      {skinUrl ? (
        <div className="absolute bottom-3 right-3 z-20 flex items-center gap-1.5">
          <button
            type="button"
            className={STAGE_BUTTON}
            onClick={() => setAutoRotate((value) => !value)}
            aria-label={de ? "Automatisch drehen" : "Auto-rotate"}
            title={de ? "Automatisch drehen" : "Auto-rotate"}
            aria-pressed={autoRotate}
          >
            <RotateCw className={`h-3.5 w-3.5 ${autoRotate ? "text-accent" : ""}`} aria-hidden />
          </button>
          <button
            type="button"
            className={STAGE_BUTTON}
            onClick={resetCamera}
            aria-label={de ? "Kamera zurücksetzen" : "Reset camera"}
            title={de ? "Kamera zurücksetzen" : "Reset camera"}
          >
            <Focus className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
};
