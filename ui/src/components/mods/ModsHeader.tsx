import React from "react";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import type { Instance } from "../InstancesView";
import { formatMessage, translations, type LanguageType } from "../../lib/translations";
import { instanceLoadsMods } from "../../lib/contentCategories";
import type { AccentClasses } from "./modDetailModel";

interface ModsHeaderProps {
  isGlobal: boolean;
  contextInstance: Instance | null;
  source: "modrinth" | "curseforge";
  accent: AccentClasses;
  lang: LanguageType;
  onBack: () => void;
  onSourceChange: (source: "modrinth" | "curseforge") => void;
}

export const ModsHeader: React.FC<ModsHeaderProps> = ({
  isGlobal,
  contextInstance,
  source,
  accent,
  lang,
  onBack,
  onSourceChange,
}) => {
  const t = translations[lang];
  return (
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-surface border border-hairline rounded-2xl p-5 shadow-2xl shrink-0">
      <div className="flex items-center gap-4">
        {!isGlobal && (
          <button
            onClick={onBack}
            className="p-2 bg-surface/60 hover:bg-selected border border-stroke/80 hover:border-[color:var(--accent)]/30 text-ink-secondary hover:text-ink rounded-xl transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
          >
            <ArrowLeft className="w-4.5 h-4.5" />
          </button>
        )}
        <div className="flex items-center gap-3">
          {!isGlobal && contextInstance && (
            <div className="w-10 h-10 rounded-xl overflow-hidden border border-stroke-strong shrink-0 bg-surface">
              {contextInstance.thumbnail ? (
                <img src={contextInstance.thumbnail} alt={contextInstance.name} className="w-full h-full object-cover" />
              ) : (
                <div className="h-full w-full bg-black" />
              )}
            </div>
          )}
          <div>
            <h2 className="text-title3 font-semibold text-ink flex items-center gap-2">
              {!isGlobal && contextInstance ? contextInstance.name : t.modBrowserTitle}
            </h2>
            {!isGlobal && contextInstance && (
              <p className="text-micro text-ink-secondary mt-0.5">
                {contextInstance.minecraftVersion} · {contextInstance.modloader}{contextInstance.modloaderVersion ? ` ${contextInstance.modloaderVersion}` : ""}
              </p>
            )}
            <p className="text-micro text-ink-secondary mt-0.5">
              {!isGlobal && contextInstance
                ? formatMessage(t.modBrowserInstanceDesc, { instance: contextInstance.name })
                : t.modBrowserDesc}
            </p>
            {!isGlobal && contextInstance && !instanceLoadsMods(contextInstance.modloader) && (
              <p className="text-micro text-warning mt-1 flex items-center gap-1.5 max-w-2xl">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {t.vanillaNoLoaderNotice}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="flex bg-surface/40 border border-stroke p-1 rounded-xl shrink-0">
        <button
          onClick={() => onSourceChange("modrinth")}
          className={`px-3 py-1.5 rounded-lg text-small font-semibold  flex items-center gap-1.5 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer ${
            source === "modrinth"
              ? `${accent.bgLight} ${accent.text} ${accent.border} shadow-inner`
              : "text-ink-secondary hover:text-ink"
          }`}
        >
          Modrinth
        </button>
        <button
          onClick={() => onSourceChange("curseforge")}
          className={`px-3 py-1.5 rounded-lg text-small font-semibold  flex items-center gap-1.5 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer ${
            source === "curseforge"
              ? `${accent.bgLight} ${accent.text} ${accent.border} shadow-inner`
              : "text-ink-secondary hover:text-ink"
          }`}
        >
          CurseForge
        </button>
      </div>
    </div>
  );
};
