import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Check, Package, Plus, X } from 'lucide-react'
import type { Instance } from '../InstancesView'
import type { ModrinthHit } from './modDetailModel'
import { EASE, MOTION, motionSafe } from '../../lib/motionTokens'
import type { LanguageType, translations } from '../../lib/translations'

type Translation = (typeof translations)[LanguageType]

/** Choose which instance a mod is installed into. */
export function InstancePickerDialog({
  open,
  mod,
  instances,
  t,
  isCompatible,
  isInstalled,
  onClose,
  onPick,
  onIncompatible,
}: {
  open: boolean
  mod: ModrinthHit | null
  instances: Instance[]
  t: Translation
  isCompatible: (mod: ModrinthHit, inst: Instance) => boolean
  isInstalled: (slug: string) => boolean
  onClose: () => void
  onPick: (inst: Instance) => void
  onIncompatible: (mod: ModrinthHit, inst: Instance) => void
}) {
  return (
    <AnimatePresence>
      {open && mod && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
          className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-50"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="bg-root border border-stroke/80 rounded-2xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-hairline flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Plus className="w-5 h-5 text-accent" />
                <h3 className="text-large font-semibold text-ink">{t.installModTitle}</h3>
              </div>
              <button
                onClick={onClose}
                className="bg-surface hover:bg-hover border border-stroke p-2 rounded-xl text-ink-secondary hover:text-ink transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 flex flex-col gap-3 max-h-[60vh] overflow-y-auto custom-scrollbar">
              <p className="text-small text-ink-secondary mb-2">
                {t.chooseInstanceForModPrefix} <strong className="text-ink">{mod.title}</strong>:
              </p>

              {instances.length === 0 ? (
                <div className="py-8 text-center flex flex-col items-center gap-2">
                  <Package className="w-10 h-10 text-ink-tertiary" />
                  <p className="text-regular text-ink-secondary">{t.noInstancesYet}</p>
                  <p className="text-small text-ink-tertiary">{t.createInstanceFirst}</p>
                </div>
              ) : (
                instances.map(inst => {
                  const compatible = isCompatible(mod, inst)
                  const alreadyInstalled = isInstalled(mod.slug)
                  return (
                    <div
                      key={inst.id}
                      onClick={() => {
                        if (alreadyInstalled) return
                        if (compatible) onPick(inst)
                        else onIncompatible(mod, inst)
                      }}
                      className={`p-4 rounded-2xl border flex items-center justify-between gap-4 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer ${
                        alreadyInstalled
                          ? "bg-accent/10 border-[color:var(--accent)]/20 opacity-60 cursor-default"
                          : compatible
                          ? "bg-surface/20 border-stroke hover:border-[color:var(--accent)]/30 hover:bg-hover"
                          : "bg-surface/10 border-hairline opacity-50 hover:opacity-80 hover:border-warning/30"
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-surface border border-stroke overflow-hidden shrink-0">
                          {inst.thumbnail ? (
                            <img src={inst.thumbnail} alt={inst.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="h-full w-full bg-black" />
                          )}
                        </div>
                        <div className="text-left min-w-0">
                          <span className="text-regular font-medium text-ink truncate block">{inst.name}</span>
                          <span className="text-micro text-ink-tertiary">{inst.minecraftVersion} · {inst.modloader}</span>
                        </div>
                      </div>

                      <div className="shrink-0">
                        {alreadyInstalled ? (
                          <span className="flex items-center gap-1 text-micro font-medium text-accent border border-[color:var(--accent)]/20 px-3 py-1.5 rounded-lg bg-accent/10">
                            <Check className="w-3 h-3" /> {t.installed}
                          </span>
                        ) : compatible ? (
                          <span className="bg-accent hover:opacity-80 text-accent-contrast px-4 py-1.5 rounded-lg text-micro font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] block" style={{ backgroundColor: 'var(--accent)' }}>
                            {t.install}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-micro font-medium text-warning bg-warning/10 border border-warning/20 px-3 py-1.5 rounded-lg">
                            <AlertTriangle className="w-3 h-3" /> {t.notCompatibleShort}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            <div className="p-4 bg-surface/40 border-t border-hairline flex justify-end">
              <button
                onClick={onClose}
                className="bg-surface hover:bg-hover border border-stroke text-ink px-5 py-2 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
              >
                {t.cancel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * Pick the Minecraft version of a modpack instance. Only shown when the pack
 * really offers more than one; one version installs without a question.
 */
export function ModpackVersionDialog({
  open,
  modTitle,
  versions,
  lang,
  onPick,
  onClose,
}: {
  open: boolean
  modTitle: string
  versions: string[]
  lang: LanguageType
  onPick: (version: string) => void
  onClose: () => void
}) {
  const de = lang === 'de'
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
          className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-50"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="bg-root border border-stroke/80 rounded-2xl max-w-md w-full overflow-hidden shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="p-6 border-b border-hairline flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Package className="w-5 h-5 text-accent" />
                <h3 className="text-large font-semibold text-ink">
                  {de ? 'Minecraft-Version wählen' : 'Choose a Minecraft version'}
                </h3>
              </div>
              <button
                onClick={onClose}
                aria-label={de ? 'Schließen' : 'Close'}
                className="bg-surface hover:bg-hover border border-stroke p-2 rounded-xl text-ink-secondary hover:text-ink transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 flex flex-col gap-4">
              <p className="text-small text-ink-secondary">
                {de ? (
                  <>
                    <strong className="text-ink">{modTitle}</strong> gibt es für mehrere Minecraft-Versionen.
                    Welche soll die neue Instanz nutzen?
                  </>
                ) : (
                  <>
                    <strong className="text-ink">{modTitle}</strong> supports several Minecraft versions.
                    Which one should the new instance use?
                  </>
                )}
              </p>
              <div className="flex flex-col gap-2 max-h-60 overflow-y-auto custom-scrollbar">
                {versions.map((version, index) => (
                  <button
                    key={version}
                    onClick={() => onPick(version)}
                    className="bg-surface/20 hover:bg-hover border border-stroke hover:border-[color:var(--accent)]/30 px-4 py-2.5 rounded-xl text-small font-medium text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] text-left flex items-center justify-between"
                  >
                    <span>{version}</span>
                    {index === 0 ? (
                      <span className="text-micro text-ink-tertiary">{de ? 'Neueste' : 'Newest'}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4 bg-surface/40 border-t border-hairline flex justify-end">
              <button
                onClick={onClose}
                className="bg-surface hover:bg-hover border border-stroke text-ink px-5 py-2 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
              >
                {de ? 'Abbrechen' : 'Cancel'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Pick a Minecraft version for one mod/instance pair. */
export function VersionPickerDialog({
  open,
  modTitle,
  instanceName,
  versions,
  t,
  onInstall,
  onClose,
}: {
  open: boolean
  modTitle: string
  instanceName: string
  versions: string[]
  t: Translation
  onInstall: (version: string) => void
  onClose: () => void
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
          className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-50"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="bg-root border border-stroke/80 rounded-2xl max-w-md w-full overflow-hidden shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-hairline flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-warning" />
                <h3 className="text-large font-semibold text-ink">{t.chooseVersionTitle}</h3>
              </div>
              <button
                onClick={onClose}
                className="bg-surface hover:bg-hover border border-stroke p-2 rounded-xl text-ink-secondary hover:text-ink transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 flex flex-col gap-4">
              <p className="text-small text-ink-secondary">
                {t.chooseMcVersionForPrefix} <strong className="text-ink">{modTitle}</strong> {t.inInstance} <strong className="text-ink">{instanceName}</strong>:
              </p>
              <div className="flex flex-col gap-2 max-h-60 overflow-y-auto custom-scrollbar">
                {versions.length === 0 ? (
                  <p className="text-small text-ink-tertiary py-4 text-center">{t.noVersions}</p>
                ) : (
                  versions.map(ver => (
                    <button
                      key={ver}
                      onClick={() => onInstall(ver)}
                      className="bg-surface/20 hover:bg-hover border border-stroke hover:border-[color:var(--accent)]/30 px-4 py-2.5 rounded-xl text-small font-medium text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] text-left"
                    >
                      {ver}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="p-4 bg-surface/40 border-t border-hairline flex justify-end">
              <button
                onClick={onClose}
                className="bg-surface hover:bg-hover border border-stroke text-ink px-5 py-2 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
              >
                {t.cancel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
