import React, { useState } from "react";
import {
  ArrowLeft,
  Package,
  Image,
  Shirt,
  Globe,
  Layers,
  Lock,
  Unlock,
  AlertTriangle,
  Settings,
} from "lucide-react";
import { translations, type LanguageType, type TranslationCopy } from "../../lib/translations";
import { instanceLoadsMods, instanceLoadsShaders, categoryForTab, categoryToProjectType } from "../../lib/contentCategories";
import { ContentListView } from "./content-list-view";
import { InstanceSettingsView } from "../instance-settings/InstanceSettingsView";
import { PlayArea } from "./PlayArea";
import { ProfileExportModal } from "../ProfileExportModal";
import { instanceFolderKeyOf as instanceFolderKey } from "../../lib/instanceFolders";
import { type LauncherPreferences } from "../../lib/launcherPreferences";
import type { LaunchProgress } from "../../electron";
import type { Instance } from "./instanceModel";

export type DetailTab = "mods" | "resourcepacks" | "shader" | "worlds" | "datapacks" | "settings";

export interface InstanceDetailViewProps {
  inst: Instance;
  instances: Instance[];
  lang: LanguageType;
  t: TranslationCopy;
  running: boolean;
  launching?: boolean;
  launchingFolder?: string;
  launchProgress?: Record<string, LaunchProgress>;
  hasAccount?: boolean;
  detailTab: DetailTab;
  setDetailTab: (value: DetailTab) => void;
  preferences: LauncherPreferences;
  showExportModal: boolean;
  onBack: () => void;
  setSelectedInstanceId: React.Dispatch<React.SetStateAction<string | null>>;
  setInstances: React.Dispatch<React.SetStateAction<Instance[]>>;
  openModBrowserForInstance: (instanceId: string) => void;
  handleLaunchInstance: (id: string, e: React.MouseEvent) => void;
  onStopGame: (name: string, folderName?: string) => void;
  handleInstanceUpdate: (instance: Instance, patch: Partial<Instance>) => void;
  handleSelectImageForExistingInstance: (instanceId: string) => void;
  handleDeleteInstance: (id: string) => void;
  handleRepairInstance: (instance: Instance) => void;
  setRenameModal: (instance: Instance | null) => void;
  setRenameName: (name: string) => void;
  setShowExportModal: (open: boolean) => void;
  setVersionSwitchTarget: (instance: Instance | null) => void;
}

/** Header, tabs and content of one opened instance. */
export const InstanceDetailView: React.FC<InstanceDetailViewProps> = ({
  inst,
  instances,
  lang,
  t,
  running,
  launching,
  launchingFolder,
  launchProgress,
  hasAccount,
  detailTab,
  setDetailTab,
  preferences,
  showExportModal,
  onBack,
  setSelectedInstanceId,
  setInstances,
  openModBrowserForInstance,
  handleLaunchInstance,
  onStopGame,
  handleInstanceUpdate,
  handleSelectImageForExistingInstance,
  handleDeleteInstance,
  handleRepairInstance,
  setRenameModal,
  setRenameName,
  setShowExportModal,
  setVersionSwitchTarget,
}) => {
  // The Worlds tab detects its own count on disk; the badge is fed from here.
  const [detectedWorldCounts, setDetectedWorldCounts] = useState<Record<string, number>>({});
  return (
      <div className="flex-1 h-full flex flex-col overflow-hidden p-0">
        <div className="relative h-48 shrink-0 bg-black border-b border-hairline overflow-hidden">
          {inst.thumbnail && (
            <img
              src={inst.thumbnail}
              alt={inst.name}
              className="w-full h-full object-cover opacity-40"
              onError={(event) => { (event.target as HTMLImageElement).style.display = "none"; }}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-root via-root/60 to-transparent" />

          <div className="absolute inset-0 p-6 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <button
                onClick={onBack}
                className="p-2 rounded-xl bg-root/60 hover:bg-hover border border-stroke/80 text-ink-secondary hover:text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-end gap-5">
              <div className="w-20 h-20 rounded-2xl overflow-hidden border-2 border-stroke/80 shadow-2xl shrink-0 bg-black">
                {inst.thumbnail && (
                  <img
                    src={inst.thumbnail}
                    alt={inst.name}
                    className="w-full h-full object-cover"
                    onError={(event) => { (event.target as HTMLImageElement).style.display = "none"; }}
                  />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="text-title2 font-semibold text-ink drop-shadow-lg">{inst.name}</h1>
                <div className="flex items-center gap-3 mt-1.5">
                  <span className="text-small font-medium theme-text theme-bg-light theme-border-md px-2.5 py-0.5 rounded-lg">{inst.minecraftVersion}</span>
                  <span className="text-small font-medium text-info bg-info/15 border border-info/25 px-2.5 py-0.5 rounded-lg">{inst.modloader}{inst.modloaderVersion ? ` ${inst.modloaderVersion}` : ""}</span>
                  <span className="text-small text-ink-secondary">
                    {inst.modloader === "Vanilla" && inst.size}
                    {inst.modloader !== "Vanilla" && (inst.content?.length ? `${inst.content.length} ${t.contentCountUnit}` : inst.size)}
                  </span>
                </div>
              </div>

              <div className="ml-auto shrink-0 pb-0.5">
                <PlayArea
                  running={running}
                  launching={!!launching && launchingFolder === instanceFolderKey(inst)}
                  progress={launchProgress?.[instanceFolderKey(inst)]}
                  hasAccount={!!hasAccount}
                  onPlay={() => handleLaunchInstance(inst.id, { stopPropagation() {} } as React.MouseEvent)}
                  onStop={() => onStopGame(inst.name, inst.folderName)}
                  lang={lang}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-0.5 px-6 bg-root/30 border-b border-hairline shrink-0 overflow-x-auto custom-scrollbar">
          {[
            { id: "mods" as const, label: "Mods", icon: Package, count: (inst.content || []).filter(c => c.type === "mods").length },
            { id: "resourcepacks" as const, label: "Resource Packs", icon: Image, count: (inst.content || []).filter(c => c.type === "resourcepacks").length },
            { id: "shader" as const, label: t.shader, icon: Shirt, count: (inst.content || []).filter(c => c.type === "shaderpacks").length },
            { id: "worlds" as const, label: t.worlds, icon: Globe, count: detectedWorldCounts[inst.id] ?? (inst.content || []).filter(c => c.type === "worlds").length },
            { id: "datapacks" as const, label: "Data Packs", icon: Layers, count: (inst.content || []).filter(c => c.type === "datapacks").length },
          ].map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setDetailTab(tab.id)}
                className={`px-4 py-3 text-small font-medium flex items-center gap-2 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer border-b-2 ${
                  detailTab === tab.id
                    ? "text-accent border-accent bg-accent/5"
                    : "text-ink-secondary hover:text-ink border-transparent hover:border-rim"
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
                <span className="text-micro font-medium bg-raised text-ink px-1.5 py-0.5 rounded-full">{tab.count}</span>
              </button>
            );
          })}

          <div className="flex-1" />

          {inst.isModpack && (
            <button
              onClick={() => setDetailTab("mods")}
              className={`shrink-0 px-3 py-3 text-small font-medium flex items-center gap-2 transition-colors cursor-pointer border-b-2 border-transparent ${
                inst.ownContentManagement ? "text-success hover:text-success" : "text-ink-secondary hover:text-ink"
              }`}
              title={lang === "de" ? "Eigene Mods und Datapacks verwalten" : "Manage custom mods and data packs"}
            >
              {inst.ownContentManagement ? <Unlock className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
              {lang === "de" ? "Eigene Mods" : "Custom mods"}
            </button>
          )}

          <button
            onClick={() => setDetailTab("settings")}
            className={`px-4 py-3 text-small font-medium flex items-center gap-2 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer border-b-2 ${
              detailTab === "settings"
                ? "theme-text theme-border theme-bg-subtle"
                : "text-ink-secondary hover:text-ink border-transparent hover:border-rim"
            }`}
          >
            <Settings className="w-4 h-4" />
            {t.tabSettings}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {((detailTab === "mods" && !instanceLoadsMods(inst.modloader)) ||
            (detailTab === "shader" && !instanceLoadsShaders(inst.modloader))) && (
            <div className="bg-warning/10 border border-warning/20 rounded-2xl p-4 flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-warning shrink-0" />
              <p className="text-small font-medium text-warning">
                {detailTab === "shader" ? t.vanillaNoShaderNotice : t.vanillaNoLoaderNotice}
              </p>
            </div>
          )}

          {["mods", "resourcepacks", "shader", "worlds", "datapacks"].includes(detailTab) && (
            <DetailViewBoundary key={detailTab} lang={lang}>
              <ContentListView
                key={`${inst.id}:${inst.name}:${inst.minecraftVersion}:${inst.modloader}:${inst.modloaderVersion || ""}:${inst.thumbnail}`}
                inst={inst}
                instances={instances}
                detailTab={detailTab}
                lang={lang}
                openModBrowserForInstance={(id) => {
                  setSelectedInstanceId(null);
                  sessionStorage.setItem('bamboo-project-type', categoryToProjectType(categoryForTab(detailTab)));
                  sessionStorage.setItem('bamboo-project-source', detailTab === 'worlds' ? 'curseforge' : 'modrinth');
                  openModBrowserForInstance(id);
                }}
                setInstances={setInstances}
                setSelectedInstance={(next) => setSelectedInstanceId(next?.id ?? null)}
                onWorldsDetected={(count) =>
                  setDetectedWorldCounts(prev => (prev[inst.id] === count ? prev : { ...prev, [inst.id]: count }))
                }
              />
            </DetailViewBoundary>
          )}

          {detailTab === "settings" && (
            <InstanceSettingsView
              instance={inst}
              lang={lang}
              preferences={preferences}
              onUpdate={(patch) => handleInstanceUpdate(inst, patch)}
              onRequestRename={() => { setRenameModal(inst); setRenameName(inst.name); }}
              onRequestDelete={() => handleDeleteInstance(inst.id)}
              onRequestImage={() => handleSelectImageForExistingInstance(inst.id)}
              onExport={() => setShowExportModal(true)}
              onOpenFolder={() => window.electronAPI?.instances.openFolder?.(inst.folderName || inst.name.toLowerCase().replace(/\s+/g, "-"))}
              onRepair={() => void handleRepairInstance(inst)}
              onChangeVersion={() => setVersionSwitchTarget(inst)}
            />
          )}
        </div>

        <ProfileExportModal
          key={showExportModal ? "profile-export-open" : "profile-export-closed"}
          isOpen={showExportModal}
          onClose={() => setShowExportModal(false)}
          instance={inst}
          lang={lang}
        />
      </div>
  );
};

export class DetailViewBoundary extends React.Component<{ children: React.ReactNode; fallback?: React.ReactNode; lang: LanguageType }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode; lang: LanguageType }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    console.error('[DetailViewBoundary] Error in instance detail view:', error);
  }
  render() {
    if (this.state.hasError) {
      const copy = translations[this.props.lang];
      return this.props.fallback || (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <AlertTriangle className="w-12 h-12 text-warning mx-auto mb-4" />
            <h3 className="text-large font-semibold text-ink mb-2">{copy.instanceDetailErrorTitle}</h3>
            <p className="text-regular text-ink-secondary mb-4">{copy.instanceDetailErrorBody}</p>
            <button onClick={() => this.setState({ hasError: false })}
              className="px-5 py-2.5 bg-raised hover:bg-selected rounded-xl text-small font-medium text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer">
              {copy.retry}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
