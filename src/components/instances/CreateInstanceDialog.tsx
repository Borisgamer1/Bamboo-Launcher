import React from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Dialog } from "../Dialog";
import { dialogButton } from "../dialogSupport";
import { type LanguageType, type TranslationCopy } from "../../lib/translations";
import { InstanceCoverPicker } from "./InstanceCoverPicker";
import type { Instance } from "./instanceModel";

export interface CreateInstanceDialogProps {
  open: boolean;
  lang: LanguageType;
  t: TranslationCopy;
  newInstanceName: string;
  setNewInstanceName: (value: string) => void;
  newInstanceVersion: string;
  setNewInstanceVersion: (value: string) => void;
  newInstanceModloader: Instance["modloader"];
  setNewInstanceModloader: (value: Instance["modloader"]) => void;
  setNewInstanceModloaderVersion: (value: string) => void;
  newInstanceImage: string;
  setNewInstanceImage: (value: string) => void;
  loadingVersions: boolean;
  minecraftVersions: string[];
  effectiveModloaderVersion: string;
  getModloaderVersions: (mcVer: string, loader: Instance["modloader"]) => string[];
  onClose: () => void;
  onCreate: (event: React.FormEvent) => void;
}

export const CreateInstanceDialog: React.FC<CreateInstanceDialogProps> = ({
  open,
  lang,
  t,
  newInstanceName,
  setNewInstanceName,
  newInstanceVersion,
  setNewInstanceVersion,
  newInstanceModloader,
  setNewInstanceModloader,
  setNewInstanceModloaderVersion,
  newInstanceImage,
  setNewInstanceImage,
  loadingVersions,
  minecraftVersions,
  effectiveModloaderVersion,
  getModloaderVersions,
  onClose,
  onCreate,
}) => {
  // Without a Minecraft version the instance cannot launch; the footer button
  // must not create one anyway when the version list failed to load.
  const canSubmit = !loadingVersions && minecraftVersions.length > 0 && Boolean(newInstanceVersion);
  return (
      <Dialog
        open={open}
        onClose={onClose}
        title={t.createInstance}
        titleId="create-dialog-title"
        closeLabel={lang === "de" ? "Schließen" : "Close"}
        icon={<Plus className="h-4 w-4" />}
        tone="accent"
        bodyClassName="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 text-small text-ink-secondary"
        footer={
          <>
            <button type="button" onClick={onClose} className={dialogButton.secondary}>
              {t.cancel}
            </button>
            <button
              type="submit"
              form="create-instance-form"
              data-tour="instance-create-confirm"
              disabled={!canSubmit}
              className={`${dialogButton.accent} disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {t.create}
            </button>
          </>
        }
      >
        <form id="create-instance-form" onSubmit={onCreate} className="flex flex-col gap-4 text-left">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="create-instance-name" className="text-micro font-medium text-ink-secondary uppercase tracking-label">
                    {lang === "de" ? "Instanz Name" : "Instance name"}
                  </label>
                  <input
                    id="create-instance-name"
                    data-autofocus
                    type="text"
                    required
                    value={newInstanceName}
                    onChange={(e) => setNewInstanceName(e.target.value)}
                    placeholder={t.instanceNamePlaceholder}
                    className="w-full bg-surface/40 border border-stroke focus:theme-border rounded-xl py-2.5 px-4 text-regular text-ink placeholder:text-ink-tertiary outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
                  />
                </div>

                {loadingVersions ? (
                  <div className="py-12 text-center flex flex-col items-center gap-3">
                    <RefreshCw className="w-10 h-10 theme-text animate-spin" />
                    <p className="text-small text-ink-secondary font-medium">{t.loadingVersions}</p>
                  </div>
                ) : minecraftVersions.length === 0 ? (
                  <div className="py-12 text-center flex flex-col items-center gap-3">
                    <p className="text-small text-ink-secondary font-medium">{t.noVersions}</p>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-micro font-medium text-ink-secondary uppercase tracking-label">Minecraft Version</label>
                      <select
                        value={newInstanceVersion}
                        onChange={(e) => setNewInstanceVersion(e.target.value)}
                        className="w-full bg-surface/40 border border-stroke focus:theme-border rounded-xl py-2.5 px-3 text-regular text-ink outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
                      >
                        {minecraftVersions.map(ver => (
                            <option key={ver} value={ver} className="bg-root">
                              {ver}
                            </option>
                          ))}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-micro font-medium text-ink-secondary uppercase tracking-label">Modloader</label>
                      <select
                        value={newInstanceModloader}
                        onChange={(e) => setNewInstanceModloader(e.target.value as Instance["modloader"])}
                        className="w-full bg-surface/40 border border-stroke focus:theme-border rounded-xl py-2.5 px-3 text-regular text-ink outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
                      >
                        <option value="Vanilla" className="bg-root">Vanilla</option>
                        <option value="Fabric" className="bg-root">Fabric</option>
                        <option value="Quilt" className="bg-root">Quilt</option>
                        <option value="Neoforge" className="bg-root">Neoforge</option>
                        <option value="Forge" className="bg-root">Forge</option>
                      </select>
                    </div>

                    {newInstanceModloader !== "Vanilla" && (
                      <div className="flex flex-col gap-1.5">
                        <label className="text-micro font-medium text-ink-secondary uppercase tracking-label">Modloader Version</label>
                        <select
                          value={effectiveModloaderVersion}
                          onChange={(e) => setNewInstanceModloaderVersion(e.target.value)}
                          className="w-full bg-surface/40 border border-stroke focus:theme-border rounded-xl py-2.5 px-3 text-regular text-ink outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
                        >
                          {getModloaderVersions(newInstanceVersion, newInstanceModloader).map(v => (
                            <option key={v} value={v} className="bg-root">{v}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    <InstanceCoverPicker
                      value={newInstanceImage}
                      onChange={setNewInstanceImage}
                      lang={lang}
                    />

                  </>
                )}
        </form>
      </Dialog>
  );
};
