import React from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, KeyRound, Puzzle, RefreshCw } from "lucide-react";
import { translations, formatNumber, type LanguageType } from "../../lib/translations";
import { canRetryCurseForge, type CurseForgeFailure } from "../../lib/curseforge";
import { CurseForgeFailureNotice } from "./CurseForgeFailureNotice";
import { ModResultRow } from "./ModResultRow";
import { projectPageUrl, type AccentClasses, type ModrinthHit } from "./modDetailModel";

const MOD_SKELETON_ROWS = 5;

const ModCardSkeleton: React.FC = () => (
  <div
    aria-hidden="true"
    className="bg-surface border border-stroke rounded-2xl px-5 py-2.5 flex items-center gap-4 min-h-[96px] shrink-0 pointer-events-none select-none"
  >
    <div className="w-14 h-14 rounded-2xl bg-hover animate-pulse shrink-0" />
    <div className="flex-1 min-w-0 flex flex-col justify-center gap-2">
      <div className="flex items-center gap-2">
        <div className="h-3.5 w-1/3 rounded bg-hover animate-pulse" />
        <div className="h-2.5 w-20 rounded bg-hover animate-pulse" />
      </div>
      <div className="h-2.5 w-4/5 rounded bg-hover animate-pulse" />
      <div className="h-2.5 w-3/5 rounded bg-hover animate-pulse" />
      <div className="h-2 w-24 rounded bg-hover animate-pulse" />
    </div>
    <div className="h-8 w-20 rounded-lg bg-hover animate-pulse shrink-0" />
  </div>
);

const ModSkeletonList: React.FC<{ count: number; label: string }> = ({ count, label }) => (
  <div
    role="status"
    aria-busy="true"
    aria-live="polite"
    className="flex flex-col gap-2 pointer-events-none select-none"
  >
    <span className="sr-only">{label}</span>
    {Array.from({ length: count }, (_, index) => (
      <ModCardSkeleton key={index} />
    ))}
  </div>
);

type ModsCopy = (typeof translations)[LanguageType];

interface ModsResultListProps {
  t: ModsCopy;
  lang: LanguageType;
  isGlobal: boolean;
  source: "modrinth" | "curseforge";
  accent: AccentClasses;
  hits: ModrinthHit[];
  totalHits: number;
  page: number;
  finitePageSize: number;
  totalPages: number;
  isInfinite: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  searchError: CurseForgeFailure | null;
  installingModId: string | null;
  installProgress: number;
  sortIndex: "relevance" | "downloads" | "follows" | "newest" | "updated";
  resultsRef: React.RefObject<HTMLDivElement | null>;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  onScrollTop: (top: number) => void;
  onSortChange: (sort: "relevance" | "downloads" | "follows" | "newest" | "updated") => void;
  onPageChange: (page: number) => void;
  onRetry: () => void;
  onOpenSettings?: () => void;
  isInstalledInContext: (slug: string) => boolean;
  onOpenDetail: (mod: ModrinthHit) => void;
  onInstall: (mod: ModrinthHit) => void;
}

export const ModsResultList: React.FC<ModsResultListProps> = ({
  t,
  lang,
  isGlobal,
  source,
  accent,
  hits,
  totalHits,
  page,
  finitePageSize,
  totalPages,
  isInfinite,
  isLoading,
  isLoadingMore,
  searchError,
  installingModId,
  installProgress,
  sortIndex,
  resultsRef,
  sentinelRef,
  onScrollTop,
  onSortChange,
  onPageChange,
  onRetry,
  onOpenSettings,
  isInstalledInContext,
  onOpenDetail,
  onInstall,
}) => (
  <div className="flex-1 flex flex-col gap-3 min-h-0 max-lg:min-h-[360px]">

    <div className="flex flex-row items-center justify-between gap-4 bg-surface/20 border border-stroke p-2 rounded-xl shrink-0">
      <div className="flex items-center gap-2">
        <span className="text-micro text-ink-secondary font-medium">{t.sortBy}:</span>
        <select
          value={sortIndex}
          onChange={(e) => onSortChange(e.target.value as typeof sortIndex)}
          className="bg-root border border-stroke rounded-lg px-2.5 py-1 text-small font-medium text-ink outline-none focus:border-[color:var(--accent)]/50"
        >
          <option value="downloads">{t.mostDownloads}</option>
          <option value="relevance">{t.relevance}</option>
          {source !== "curseforge" && <option value="follows">{t.mostFollowed}</option>}
          <option value="newest">{t.newestReleased}</option>
          <option value="updated">{t.recentlyUpdated}</option>
        </select>
      </div>

      {hits.length > 0 && !isInfinite && !isLoading && (
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-micro text-ink-tertiary font-medium hidden sm:inline">
            {t.page} {page} {t.of} {totalPages}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              disabled={page === 1}
              onClick={() => onPageChange(Math.max(1, page - 1))}
              className="p-1 bg-root border border-stroke hover:border-rim text-ink-secondary hover:text-ink rounded-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <button
              disabled={page === totalPages}
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
              className="p-1 bg-root border border-stroke hover:border-rim text-ink-secondary hover:text-ink rounded-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>

    <div
      ref={resultsRef}
      onScroll={(event) => onScrollTop(event.currentTarget.scrollTop)}
      className="relative flex-1 min-h-0 overflow-y-auto pr-1 custom-scrollbar"
    >
      <div className="flex flex-col gap-2">
        {isLoading ? (
          <ModSkeletonList count={MOD_SKELETON_ROWS} label={t.queryingStore} />
        ) : (
          <>
        {hits.map((mod) => {
          const _installed = isInstalledInContext(mod.slug);
          const isInstalling = installingModId === mod.project_id;
          const showInstallBtn = isGlobal || !_installed;

          return (
            <ModResultRow
              key={mod.project_id}
              mod={mod}
              source={source}
              lang={lang}
              t={t}
              accent={accent}
              showInstallBtn={showInstallBtn}
              isInstalling={isInstalling}
              installProgress={installProgress}
              onOpen={() => onOpenDetail(mod)}
              onOpenExternal={() => window.electronAPI?.system.openExternal?.(projectPageUrl(mod, source))}
              onInstall={() => onInstall(mod)}
            />
          );
        })}

        {isLoadingMore && (
          <ModSkeletonList count={2} label={t.queryingStore} />
        )}

        {searchError && (
          <div className="flex flex-col items-center gap-3">
            {source === "modrinth" ? (
              <div className="text-center flex flex-col items-center justify-center gap-3 py-24">
                <div className="w-16 h-16 rounded-2xl bg-surface border border-stroke flex items-center justify-center text-ink-secondary">
                  <AlertTriangle className="w-8 h-8" />
                </div>
                <p className="text-regular font-medium text-ink">{t.mrNetworkTitle}</p>
                <p className="text-small text-ink-tertiary max-w-md">{t.mrNetworkBody}</p>
                <button
                  type="button"
                  onClick={onRetry}
                  className="px-3 py-1.5 rounded-lg bg-surface border border-stroke hover:border-rim text-small font-medium text-ink flex items-center gap-1.5 transition-[color,background-color,border-color,box-shadow,opacity] cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t.cfRetry}
                </button>
              </div>
            ) : (
              <CurseForgeFailureNotice
                failure={searchError}
                lang={lang}
                className="py-24"
                actions={
                  searchError.code === 'missing-key' && onOpenSettings ? (
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="px-3 py-1.5 rounded-lg bg-surface border border-stroke hover:border-rim text-small font-medium text-ink flex items-center gap-1.5 transition-[color,background-color,border-color,box-shadow,opacity] cursor-pointer"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      {t.cfAddKey}
                    </button>
                  ) : canRetryCurseForge(searchError) ? (
                    <button
                      type="button"
                      onClick={onRetry}
                      className="px-3 py-1.5 rounded-lg bg-surface border border-stroke hover:border-rim text-small font-medium text-ink flex items-center gap-1.5 transition-[color,background-color,border-color,box-shadow,opacity] cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      {t.cfRetry}
                    </button>
                  ) : undefined
                }
              />
            )}
          </div>
        )}

        {hits.length === 0 && !searchError && (
          <div className="py-24 text-center flex flex-col items-center justify-center gap-3">
            <div className="w-16 h-16 rounded-2xl bg-surface border border-stroke flex items-center justify-center text-ink-secondary">
              <Puzzle className="w-8 h-8" />
            </div>
            <p className="text-regular font-medium text-ink">{t.noModsFound}</p>
            <p className="text-small text-ink-tertiary">{t.noModsFoundHint}</p>
          </div>
        )}
          </>
        )}

        <div ref={sentinelRef} aria-hidden className="h-px w-full shrink-0" />
      </div>
    </div>

    {hits.length > 0 && !isLoading && (
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-surface/20 border border-stroke p-2 rounded-xl shrink-0 mt-2">
        <span className="text-micro text-ink-secondary font-medium">
          {isInfinite ? (
            <>
              <strong className="text-ink">{formatNumber(hits.length, lang)}</strong> {t.of} <strong className="text-ink">{formatNumber(totalHits, lang)}</strong> {t.mods}
            </>
          ) : (
            <>
              {t.showing} <strong className="text-ink">{formatNumber((page - 1) * finitePageSize + 1, lang)}</strong> - <strong className="text-ink">{formatNumber(Math.min(page * finitePageSize, totalHits), lang)}</strong> {t.of} <strong className="text-ink">{formatNumber(totalHits, lang)}</strong> {t.mods}
            </>
          )}
        </span>
        {!isInfinite && (
          <div className="flex items-center gap-1">
            <button
              disabled={page === 1}
              onClick={() => onPageChange(Math.max(1, page - 1))}
              className="p-1.5 bg-root border border-stroke hover:border-rim text-ink-secondary hover:text-ink rounded-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-micro font-medium text-ink px-3 py-1.5 bg-root/60 border border-stroke rounded-lg">
              {t.page} {page} / {totalPages}
            </span>
            <button
              disabled={page === totalPages}
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
              className="p-1.5 bg-root border border-stroke hover:border-rim text-ink-secondary hover:text-ink rounded-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    )}
  </div>
);
