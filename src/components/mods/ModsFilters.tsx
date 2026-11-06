import React from "react";
import { Check, Filter } from "lucide-react";
import { translations, type LanguageType } from "../../lib/translations";
import {
  GLOBAL_BROWSER_PROJECT_TYPES,
  INSTANCE_BROWSER_PROJECT_TYPES,
  type ProjectType,
} from "../../lib/contentCategories";
import {
  PAGE_SIZE_INFINITE,
  PAGE_SIZE_OPTIONS,
  type ModsPageSize,
} from "../../lib/modsBrowser";
import type { AccentClasses } from "./modDetailModel";

interface ModsFiltersProps {
  isGlobal: boolean;
  source: "modrinth" | "curseforge";
  lang: LanguageType;
  accent: AccentClasses;
  projectTypeLabel: Record<ProjectType, string>;
  selectedProjectType: string;
  onProjectType: (id: string) => void;
  categoriesList: Array<{ id: string; label: string }>;
  selectedCategory: string;
  onCategory: (id: string) => void;
  versionsList: Array<{ id: string; label: string }>;
  selectedVersion: string;
  onVersion: (id: string) => void;
  pageSize: ModsPageSize;
  onPageSize: (size: ModsPageSize) => void;
  children?: React.ReactNode;
}

export const ModsFilters: React.FC<ModsFiltersProps> = ({
  isGlobal,
  source,
  lang,
  accent,
  projectTypeLabel,
  selectedProjectType,
  onProjectType,
  categoriesList,
  selectedCategory,
  onCategory,
  versionsList,
  selectedVersion,
  onVersion,
  pageSize,
  onPageSize,
  children,
}) => {
  const t = translations[lang];
  return (
    <>
      <div className="flex shrink-0 gap-1.5 flex-wrap items-center">
        <span className="text-micro font-medium text-ink-tertiary uppercase mr-1 tracking-label">{t.projectType}:</span>
        {[
          { id: "all", label: t.projectTypeAll },
          ...(isGlobal ? GLOBAL_BROWSER_PROJECT_TYPES : INSTANCE_BROWSER_PROJECT_TYPES)
            // Worlds are a CurseForge-only project type with their own path (see #18/#22).
            .filter((type) => type !== "worlds" || source === "curseforge")
            .map((type) => ({ id: type, label: projectTypeLabel[type] })),
        ].map((pt) => {
          const isSelected = selectedProjectType === pt.id;
          return (
            <button
              key={pt.id}
              onClick={() => onProjectType(pt.id)}
              className={`px-3 py-1.5 rounded-lg text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer border ${
                isSelected
                  ? `${accent.bgLight} ${accent.text} ${accent.border}`
                  : "bg-surface/20 border-stroke text-ink-secondary hover:text-ink hover:border-rim"
              }`}
            >
              {pt.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col lg:flex-row gap-4 items-stretch flex-1 min-h-0 max-lg:overflow-y-auto max-lg:pr-1 custom-scrollbar">
        <div className={`w-full lg:w-64 shrink-0 flex flex-col gap-4 bg-surface border border-hairline rounded-2xl p-4 shadow-2xl h-fit max-h-[calc(100vh-16rem)] overflow-y-auto custom-scrollbar lg:max-h-full ${source === "modrinth" ? "lg:min-h-0 lg:overflow-hidden" : ""}`}>
          <div className="flex shrink-0 items-center gap-2 text-micro font-medium text-ink-secondary uppercase border-b border-hairline pb-2.5 tracking-label">
            <Filter className="w-3.5 h-3.5 text-accent"  />

            {source === "modrinth" ? t.filterModDatabase : t.curseforgeSearch}
          </div>

          {source === "modrinth" && (
          <div className="flex flex-col gap-1 lg:min-h-0">
            <label className="shrink-0 text-micro font-medium text-ink-tertiary uppercase mb-1.5 text-left block tracking-label">{t.categories}</label>
            <div className="flex flex-col gap-0.5">
              {categoriesList.map((cat) => {
                const isSelected = selectedCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    onClick={() => onCategory(cat.id)}
                    className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-small font-medium text-left transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer ${
                      isSelected
                        ? "bg-accent/10 text-accent border-accent/20"
                        : "text-ink-secondary hover:text-ink hover:bg-hover"
                    }`}
                  >
                    <span>{cat.label}</span>
                    {isSelected && <Check className="w-3 h-3 text-accent"  />}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {isGlobal && (
          <div className="flex shrink-0 flex-col gap-1.5 mt-1">
            <label className="text-micro font-medium text-ink-tertiary uppercase text-left block tracking-label">{t.minecraftVersionLabel}</label>
            <select
              value={selectedVersion}
              onChange={(e) => onVersion(e.target.value)}
              className="w-full bg-root border border-stroke rounded-lg px-2.5 py-1.5 text-small font-medium text-ink outline-none focus:border-[color:var(--accent)]/50"
            >
              {versionsList.map((ver) => (
                <option key={ver.id} value={ver.id}>{ver.label}</option>
              ))}
            </select>
          </div>
          )}

          <div className="flex shrink-0 flex-col gap-1.5 mt-1">
            <label className="text-micro font-medium text-ink-tertiary uppercase text-left block tracking-label">{t.itemsPerPage}</label>
            <select
              value={pageSize}
              onChange={(e) => {
                onPageSize(e.target.value === PAGE_SIZE_INFINITE ? PAGE_SIZE_INFINITE : Number(e.target.value) as ModsPageSize);
              }}
              className="w-full bg-root border border-stroke rounded-lg px-2.5 py-1.5 text-small font-medium text-ink outline-none focus:border-[color:var(--accent)]/50"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>{size} {t.perPage}</option>
              ))}
              <option value={PAGE_SIZE_INFINITE}>Infinite</option>
            </select>
          </div>
        </div>
        {children}
      </div>
    </>
  );
};
