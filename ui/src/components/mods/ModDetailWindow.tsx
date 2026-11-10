import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Download, Check, RefreshCw, Package, AlertTriangle, Star, ExternalLink, Calendar } from "lucide-react";
import { LAUNCHER_VERSION } from "../../lib/version";
import { Instance } from "../InstancesView";
import { translations, formatMessage, formatCompactNumber, LanguageType } from "../../lib/translations";
import { toCurseForgeFailure, type CurseForgeFailure } from "../../lib/curseforge";
import { CurseForgeFailureNotice } from "./CurseForgeFailureNotice";
import { projectTypeToCategory, type ProjectType } from "../../lib/contentCategories";
import {
  isVersionCompatible,
  versionFileFor,
  type StoreVersion,
} from "../../lib/modVersions";
import { MOTION, EASE, motionSafe } from "../../lib/motionTokens";
import { renderDescription } from "../../lib/descriptionHtml";
import {
  cfLoaderNameToType,
  projectPageUrl,
  sanitizeDescription,
  type AccentClasses,
  type ModDetail,
  type ModDetailVersion,
  type ModrinthHit,
  type ModrinthVersion,
} from "./modDetailModel";

export interface ModDetailWindowProps {
  mod: ModrinthHit;
  source: "modrinth" | "curseforge";
  contextInstance: Instance | null;
  isGlobal: boolean;
  accent: AccentClasses;
  onClose: () => void;
  instances: Instance[];
  installModToInstance: (
    mod: ModrinthHit,
    inst: Instance,
    forcedVersion?: string,
    onProgress?: (percent: number) => void,
  ) => Promise<boolean>;
  fullWindow?: boolean;
  lang: LanguageType;
}

/** One project in full: description, versions and the install button. */
export const ModDetailWindow: React.FC<ModDetailWindowProps> = ({
  mod, source, contextInstance, isGlobal, accent, onClose,
  instances, installModToInstance, fullWindow, lang,
}) => {
  const tr = translations[lang];
  const [tab, setTab] = useState<"description" | "versions">("description");
  const [project, setProject] = useState<ModDetail | null>(null);
  const [versions, setVersions] = useState<ModDetailVersion[]>([]);
  const [detailFailure, setDetailFailure] = useState<CurseForgeFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaderFilter, setLoaderFilter] = useState("");
  const [versionFilter, setVersionFilter] = useState("");

  const [showInstallPicker, setShowInstallPicker] = useState(false);
  const [installVer, setInstallVer] = useState<ModDetailVersion | null>(null);
  const [showIncompWarning, setShowIncompWarning] = useState(false);
  const [incompVer, setIncompVer] = useState<ModDetailVersion | null>(null);
  const [incompInst, setIncompInst] = useState<Instance | null>(null);
  const [versionProgress, setVersionProgress] = useState<{ version: string; percent: number } | null>(null);
  const [installedVersionNumber, setInstalledVersionNumber] = useState<string | null>(() => {
    const entry = contextInstance?.content?.find(
      (item) => item.projectId === mod.project_id || item.id === mod.slug,
    );
    return entry?.versionNumber ?? null;
  });

  const isCurseforge = source === "curseforge";
  const detailTypeLabel: Record<ProjectType, string> = {
    mod: tr.projectTypeMods,
    modpack: tr.projectTypeModpacks,
    resourcepack: tr.projectTypeResourcePacks,
    shader: tr.projectTypeShaders,
    datapack: tr.projectTypeDataPacks,
    worlds: tr.projectTypeWorlds,
    plugin: tr.projectTypePlugins,
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setDetailFailure(null);
      try {
        if (isCurseforge && window.electronAPI?.mods.curseforgeProject) {
          const projectData = await window.electronAPI?.mods.curseforgeProject(mod.project_id);
          const projectFailure = toCurseForgeFailure(projectData);
          if (projectFailure) setDetailFailure(projectFailure);
          if (!projectFailure && projectData && 'name' in projectData) {
            setProject({
              title: projectData.name,
              author: projectData.authors?.[0]?.name || "Unknown",
              body: projectData.fullDescription || projectData.description || projectData.summary || "",
              description: projectData.summary || "",
              icon_url: projectData.logo?.url || mod.icon_url,
              downloads: projectData.downloadCount,
              slug: projectData.slug || mod.slug,
            });
          }
          const cfLoaderType = contextInstance?.modloader ? cfLoaderNameToType(contextInstance.modloader) : undefined;
          const filesResult = await window.electronAPI?.mods.curseforgeFiles?.(mod.project_id, undefined, cfLoaderType);
          const filesFailure = toCurseForgeFailure(filesResult);
          if (filesFailure) setDetailFailure((current) => current ?? filesFailure);
          if (!filesFailure && Array.isArray(filesResult)) {
            setVersions(filesResult.map((f) => ({
              version_number: f.displayName || f.fileName || String(f.id),
              date_published: f.fileDate || "",
              game_versions: f.gameVersions || [],
              loaders: (() => {
                const num = f.modLoader;
                if (num == null) return [];
                const map: Record<number, string> = { 1: 'forge', 4: 'fabric', 5: 'quilt', 6: 'neoforge' };
                return map[num as number] ? [map[num as number]] : [String(num).toLowerCase()];
              })(),
              files: [{ url: f.downloadUrl || "", filename: f.fileName || `${mod.slug}.jar`, primary: true }],
            })));
          }
        } else {
          const [projectRes, versionsRes] = await Promise.all([
            fetch(`https://api.modrinth.com/v2/project/${mod.project_id}`, { headers: { 'User-Agent': `BambooLauncher/${LAUNCHER_VERSION}` } }),
            fetch(`https://api.modrinth.com/v2/project/${mod.project_id}/version`, { headers: { 'User-Agent': `BambooLauncher/${LAUNCHER_VERSION}` } }),
          ]);
          if (projectRes.ok) {
            const p = (await projectRes.json()) as ModDetail;
            setProject({
              title: p.title,
              author: p.author,
              body: p.body,
              description: p.description,
              icon_url: p.icon_url,
              downloads: p.downloads,
              slug: p.slug,
            });
          }
          if (versionsRes.ok) {
            const v = (await versionsRes.json()) as ModrinthVersion[];
            setVersions(v.map((ver) => ({
              version_number: ver.version_number || "",
              date_published: ver.date_published || "",
              game_versions: ver.game_versions || [],
              loaders: ver.loaders || [],
              files: (ver.files || []).map((f) => ({
                url: f.url,
                filename: f.filename,
                primary: f.primary || false,
              })),
            })));
          }
        }
      } catch (err) {
        console.error("Failed to load mod details:", err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [mod.project_id, mod.icon_url, mod.slug, contextInstance?.modloader, isCurseforge]);

    const desc = project?.body || project?.description || mod.description || (lang === "de" ? "Keine Beschreibung verfügbar." : "No description available.");
  const allLoaders = [...new Set(versions.flatMap(v => v.loaders))].sort();
  const allMcVersions = [...new Set(versions.flatMap(v => v.game_versions))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  let filteredVersions = versions;
  if (loaderFilter) filteredVersions = filteredVersions.filter(v => v.loaders.includes(loaderFilter));
  if (versionFilter) filteredVersions = filteredVersions.filter(v => v.game_versions.includes(versionFilter));

  const profileMc = contextInstance?.minecraftVersion || "";
  const detailCategory = projectTypeToCategory(mod.project_type) ?? "mods";

  const toStoreVersion = (ver: ModDetailVersion): StoreVersion => ({
    versionNumber: ver.version_number,
    published: ver.date_published,
    gameVersions: ver.game_versions,
    loaders: ver.loaders,
    files: ver.files,
  });

  // The version list is judged by the same selector the install uses, so a row
  // can never look installable here and be refused on install (or the reverse).
  const isVersionInstallable = (ver: ModDetailVersion): boolean => {
    const version = toStoreVersion(ver);
    if (!versionFileFor(version, detailCategory)) return false;
    return isVersionCompatible(version, {
      category: detailCategory,
      minecraftVersion: profileMc,
      modloader: contextInstance?.modloader,
    });
  };

  const handleInstallVersion = (ver: ModDetailVersion) => {
    if (versionProgress || installedVersionNumber === ver.version_number) return;
    const incompatible = !isVersionInstallable(ver);

    if (incompatible && contextInstance) {
      setIncompVer(ver);
      setIncompInst(contextInstance);
      setShowIncompWarning(true);
    } else if (isGlobal) {
      setInstallVer(ver);
      setShowInstallPicker(true);
    } else if (contextInstance) {
      void installVersionInto(contextInstance, ver);
    }
  };

  async function installVersionInto(inst: Instance, ver: ModDetailVersion): Promise<void> {
    setVersionProgress({ version: ver.version_number, percent: 2 });
    try {
      const ok = await installModToInstance(mod, inst, ver.version_number, (percent) =>
        setVersionProgress({ version: ver.version_number, percent }),
      );
      if (ok) setInstalledVersionNumber(ver.version_number);
    } finally {
      setVersionProgress(null);
    }
  }

  const handleInstallFromPicker = async (inst: Instance) => {
    if (installVer) {
      const version = installVer;
      setShowInstallPicker(false);
      setInstallVer(null);
      await installVersionInto(inst, version);
    }
  };

  const handleIncompConfirm = async () => {
    if (incompVer && incompInst) {
      const version = incompVer;
      const inst = incompInst;
      setShowIncompWarning(false);
      setIncompVer(null);
      setIncompInst(null);
      await installVersionInto(inst, version);
    }
  };

  const handleInstall = (ver: ModDetailVersion) => handleInstallVersion(ver);

  const detailContent = (
    <>
      <div className="px-6 pt-6 pb-5 border-b border-hairline shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4 min-w-0 flex-1">
            <div className="w-16 h-16 rounded-2xl bg-surface border border-stroke overflow-hidden shrink-0 shadow-lg">
              <img
                src={project?.icon_url || mod.icon_url}
                alt={project?.title || mod.title}
                className="w-full h-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              {(!project?.icon_url && !mod.icon_url) && (
                <div className="w-full h-full flex items-center justify-center">
                  <Package className="w-7 h-7 text-ink-tertiary" />
                </div>
              )}
            </div>
            <div className="text-left min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-title3 font-semibold text-ink truncate">
                  {project?.title || mod.title}
                </h2>
                <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-micro font-medium ${accent.border} ${accent.text} ${accent.bgLight}`}>
                  {detailTypeLabel[mod.project_type as ProjectType] || mod.project_type}
                </span>
                {installedVersionNumber && (
                  <span className="shrink-0 rounded-md border border-success/25 bg-success/10 px-1.5 py-0.5 text-micro font-medium text-success">
                    {tr.installed}
                  </span>
                )}
              </div>
              <p className="text-small text-ink-secondary mt-0.5">{formatMessage(tr.byAuthor, { author: project?.author || mod.author })}</p>
              <p className="mt-1.5 line-clamp-2 max-w-[70ch] text-micro leading-5 text-ink-secondary">
                {project?.description || mod.description}
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-micro text-ink-tertiary">
                <span className="flex items-center gap-1">
                  <Download className="w-3.5 h-3.5" />
                  {formatCompactNumber(project?.downloads ?? mod.downloads, lang)}
                </span>
                {/* CurseForge only exposes a 0-5 rating here, not a follower count. */}
                {!isCurseforge && (
                  <span className="flex items-center gap-1">
                    <Star className="w-3.5 h-3.5" />
                    {formatCompactNumber(mod.follows, lang)}
                  </span>
                )}
                {mod.date_modified && (
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5" />
                    {new Date(mod.date_modified).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-US')}
                  </span>
                )}
                <span>{source === 'modrinth' ? 'Modrinth' : 'CurseForge'}</span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => window.electronAPI?.system.openExternal?.(projectPageUrl(mod, source))}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-stroke bg-surface px-3 text-micro font-medium text-ink-secondary hover:border-rim hover:text-ink transition-colors cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              {lang === 'de' ? 'Im Browser öffnen' : 'Open in browser'}
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl bg-surface hover:bg-hover border border-stroke text-ink-secondary hover:text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {mod.categories.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 pl-20">
            {mod.categories.slice(0, 6).map((category) => (
              <span key={category} className="rounded-md border border-stroke bg-root/40 px-1.5 py-0.5 text-micro font-medium capitalize text-ink-secondary">
                {category.replace(/-/g, ' ')}
              </span>
            ))}
            {mod.client_side === 'required' && (
              <span className="rounded-md border border-hairline px-1.5 py-0.5 text-micro text-ink-tertiary">{lang === 'de' ? 'Client' : 'Client'}</span>
            )}
            {mod.server_side === 'required' && (
              <span className="rounded-md border border-hairline px-1.5 py-0.5 text-micro text-ink-tertiary">{lang === 'de' ? 'Server' : 'Server'}</span>
            )}
          </div>
        )}
      </div>

      <div className="flex border-b border-hairline shrink-0 px-6">
        <button
          onClick={() => setTab("description")}
          className={`px-5 py-3 text-small font-medium  transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] border-b-2 cursor-pointer ${
            tab === "description"
                ? `${accent.text} ${accent.border}`
                : "text-ink-secondary border-transparent hover:text-ink"
          }`}
        >
          {tr.descriptionTab}
        </button>
        <button
          onClick={() => setTab("versions")}
          className={`px-5 py-3 text-small font-medium  transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] border-b-2 cursor-pointer ${
            tab === "versions"
              ? `${accent.text} ${accent.border}`
              : "text-ink-secondary border-transparent hover:text-ink"
          }`}
        >
          {tr.versions} ({versions.length})
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {tab === "description" ? (
          <div className="p-6">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-6 h-6 text-ink-secondary animate-spin" />
              </div>
            ) : detailFailure ? (
              <CurseForgeFailureNotice
                failure={detailFailure}
                lang={lang}
                title={tr.cfDetailFailed}
                className="py-10"
              />
            ) : (
              <div
                className="mod-description"
                onClick={(event) => {
                  const anchor = (event.target as HTMLElement).closest("a");
                  if (!anchor) return;
                  event.preventDefault();
                  const href = anchor.getAttribute("href") ?? "";
                  if (/^https?:\/\//i.test(href)) window.electronAPI?.system.openExternal?.(href);
                }}
                dangerouslySetInnerHTML={{
                  __html: renderDescription(
                    desc,
                    isCurseforge ? "html" : "markdown",
                    sanitizeDescription,
                  ),
                }}
              />
            )}
          </div>
        ) : (
          <div className="p-6">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-6 h-6 text-ink-secondary animate-spin" />
              </div>
            ) : detailFailure && versions.length === 0 ? (
              <CurseForgeFailureNotice
                failure={detailFailure}
                lang={lang}
                title={tr.cfDetailFailed}
                className="py-10"
              />
            ) : versions.length === 0 ? (
              <p className="text-regular text-ink-secondary py-12 text-center">{tr.noVersionsFound}</p>
            ) : (
              <>
                <div className="flex gap-3 mb-4 flex-wrap">
                  <select
                    value={loaderFilter}
                    onChange={(e) => setLoaderFilter(e.target.value)}
                    className="bg-surface border border-stroke rounded-lg px-3 py-1.5 text-small font-medium text-ink outline-none"
                  >
                    <option value="">{tr.allLoaders}</option>
                    {allLoaders.map(l => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                  <select
                    value={versionFilter}
                    onChange={(e) => setVersionFilter(e.target.value)}
                    className="bg-surface border border-stroke rounded-lg px-3 py-1.5 text-small font-medium text-ink outline-none"
                  >
                    <option value="">{tr.allMcVersions}</option>
                    {allMcVersions.map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                  <span className="text-micro text-ink-tertiary self-center font-medium">
                    {formatMessage(tr.versionCount, { count: filteredVersions.length })}
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  {[...filteredVersions].sort((a, b) => {
                    const aCompatible = isVersionInstallable(a);
                    const bCompatible = isVersionInstallable(b);
                    if (aCompatible && !bCompatible) return -1;
                    if (!aCompatible && bCompatible) return 1;
                    return new Date(b.date_published).getTime() - new Date(a.date_published).getTime();
                  }).map(ver => {
                    const incompatible = !isVersionInstallable(ver);
                    const installed = installedVersionNumber === ver.version_number;
                    const installingThis = versionProgress?.version === ver.version_number;
                    const installBusy = versionProgress !== null;

                    return (
                      <div
                        key={ver.version_number}
                        className={`relative overflow-hidden bg-surface/30 border rounded-xl p-4 flex items-center justify-between gap-4 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] ${
                          installed
                            ? "border-success/35 bg-success/5"
                            : incompatible
                              ? "border-hairline opacity-60"
                              : `border-hairline ${accent.cardHover || 'hover:border-rim'}`
                        }`}
                      >
                        {installingThis && (
                          <span
                            aria-hidden
                            className="absolute inset-y-0 left-0 bg-accent/10 transition-[width] duration-300 ease-[var(--ease-out)]"
                            style={{ width: `${versionProgress?.percent ?? 0}%` }}
                          />
                        )}
                        <div className="relative flex-1 min-w-0 text-left">
                          <div className="flex items-center gap-2">
                            <span className="text-small font-medium text-ink">
                              {ver.version_number}
                            </span>
                            {incompatible && (
                              <AlertTriangle className="w-4 h-4 text-warning shrink-0" aria-label={tr.incompatibleWithInstance} />
                            )}
                            {installed && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-success/25 bg-success/10 px-1.5 py-0.5 text-[11px] font-semibold text-success">
                                <Check className="w-2.5 h-2.5 stroke-[3]" />
                                {tr.installed}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1 text-micro text-ink-tertiary">
                            <span>{new Date(ver.date_published).toLocaleDateString()}</span>
                            <span>·</span>
                            <span>{ver.loaders.join(', ') || tr.allLabel}</span>
                            <span>·</span>
                            <span>{ver.game_versions.slice(0, 3).join(', ')}{ver.game_versions.length > 3 ? ' ...' : ''}</span>
                          </div>
                        </div>
                        {installed ? (
                          <span className="relative shrink-0 rounded-xl border border-success/25 bg-success/10 px-4 py-2 text-micro font-semibold text-success">
                            {tr.installed}
                          </span>
                        ) : (
                          <button
                            onClick={() => handleInstall(ver)}
                            disabled={installBusy}
                            className={`relative shrink-0 px-4 py-2 rounded-xl text-micro font-semibold transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer shadow-lg tabular-nums disabled:cursor-not-allowed disabled:opacity-60 ${
                              incompatible
                                ? "bg-warning/10 text-warning border border-warning/20 hover:bg-warning/20"
                                : `${accent.bg} text-accent-contrast ${accent.glow}`
                            }`}
                          >
                            {installingThis
                              ? `${versionProgress?.percent ?? 0}%`
                              : incompatible
                                ? `⚠️ ${installedVersionNumber ? tr.changeVersion : tr.install}`
                                : installedVersionNumber
                                  ? tr.changeVersion
                                  : tr.install}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="p-4 bg-surface/40 border-t border-hairline flex justify-between items-center shrink-0">
        <span className="text-micro text-ink-tertiary font-medium">
          {tr.source}: {source === "modrinth" ? "Modrinth API v2" : "CurseForge API"}
        </span>
        <button
          onClick={onClose}
          className="bg-surface hover:bg-hover border border-stroke text-ink px-4 py-2 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
        >
          {tr.close}
        </button>
      </div>
    </>
  );

  return (
    <>
      {fullWindow ? (
        <div className="flex flex-col h-full w-full overflow-hidden bg-surface border border-hairline rounded-2xl shadow-2xl">
          {detailContent}
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
          className="fixed inset-0 bg-root/94 flex items-center justify-center p-4 z-50"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 10, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="bg-root border border-stroke/80 rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {detailContent}
          </motion.div>
        </motion.div>
      )}

      <AnimatePresence>
        {showInstallPicker && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-[60]"
            onClick={() => { setShowInstallPicker(false); setInstallVer(null); }}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
              className="bg-root border border-stroke/80 rounded-2xl max-w-md w-full p-6 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-large font-semibold text-ink mb-4">{tr.installInto}</h3>
              <div className="flex flex-col gap-2 max-h-60 overflow-y-auto">
                {instances.map(inst => (
                  <button
                    key={inst.id}
                    onClick={() => handleInstallFromPicker(inst)}
                    className="bg-surface/30 hover:bg-hover border border-hairline rounded-xl px-4 py-3 text-left text-small font-medium text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
                  >
                    {inst.name} · {inst.minecraftVersion}
                  </button>
                ))}
              </div>
              <button
                onClick={() => { setShowInstallPicker(false); setInstallVer(null); }}
                className="mt-4 bg-surface hover:bg-hover border border-stroke text-ink px-4 py-2 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
              >
                {tr.cancel}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showIncompWarning && incompVer && incompInst && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-[60]"
            onClick={() => { setShowIncompWarning(false); }}
          >
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
              className="bg-root border border-warning/30 rounded-2xl max-w-md w-full p-6 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-2xl bg-warning/10 border border-warning/20 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-warning" />
                </div>
                <div>
                  <h3 className="text-large font-semibold text-ink">{tr.incompatibleVersionTitle}</h3>
                  <p className="text-small text-ink-secondary mt-0.5">
                    {formatMessage(tr.incompatibleVersionBody, {
                      version: incompVer.version_number,
                      instance: incompInst.name,
                      mc: incompInst.minecraftVersion,
                      loader: incompInst.modloader,
                    })}
                  </p>
                </div>
              </div>
              <p className="text-small text-ink-tertiary mb-5">
                {tr.incompatibleVersionWarning}
              </p>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => { setShowIncompWarning(false); }}
                  className="bg-surface hover:bg-hover border border-stroke text-ink px-5 py-2.5 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                >
                  {tr.cancel}
                </button>
                <button
                  onClick={handleIncompConfirm}
                  className="bg-warning hover:bg-warning/90 text-accent-contrast px-5 py-2.5 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer shadow-lg shadow-warning/10"
                >
                  {tr.installAnyway}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
