import { AnimatePresence, motion } from 'framer-motion'
import { Package, Plus, RefreshCw, X, Zap } from 'lucide-react'
import { EASE, MOTION, motionSafe } from '../../lib/motionTokens'
import { translations, type LanguageType } from '../../lib/translations'
import type { ModpackUpdateVersion } from '../../hooks/useModpackUpdate'

interface ModpackUpdateDialogProps {
  lang: LanguageType
  open: boolean
  installing: boolean
  versions: ModpackUpdateVersion[]
  optionsOpen: boolean
  selectedVersion: string
  ownContentManagement: boolean
  onClose: () => void
  onOptionsOpenChange: (open: boolean) => void
  onSelectVersion: (version: string) => void
  onNewInstance: () => void
  onCleanUpdate: () => void
  onBetaCarryOver: () => void
}

/** Version picker for a modpack instance: new instance, clean update or beta carry-over. */
export function ModpackUpdateDialog({
  lang,
  open,
  installing,
  versions,
  optionsOpen,
  selectedVersion,
  ownContentManagement,
  onClose,
  onOptionsOpenChange,
  onSelectVersion,
  onNewInstance,
  onCleanUpdate,
  onBetaCarryOver,
}: ModpackUpdateDialogProps) {
  return (
    <AnimatePresence>
      {open && versions.length > 0 && !installing && (
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
                <Package className="w-5 h-5 text-warning" />
                <h3 className="text-large font-semibold text-ink">
                  {translations[lang].modpackUpdateAvailable}
                </h3>
              </div>
              <button
                onClick={onClose}
                className="bg-surface hover:bg-hover border border-stroke p-2 rounded-xl text-ink-secondary hover:text-ink transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 flex flex-col gap-4 text-left">
              {!optionsOpen ? (
                <>
                  <p className="text-small text-ink-secondary">
                    {translations[lang].modpackSelectVersion}
                  </p>
                  <div className="flex flex-col gap-2 max-h-60 overflow-y-auto custom-scrollbar">
                    {versions.map(ver => (
                      <button
                        key={ver.version_number}
                        onClick={() => {
                          onSelectVersion(ver.version_number)
                          if (ownContentManagement) {
                            onOptionsOpenChange(true)
                          } else {
                            onCleanUpdate()
                          }
                        }}
                        className={`bg-surface/20 hover:bg-hover border border-stroke hover:border-warning/30 px-4 py-3 rounded-xl text-left transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] ${
                          selectedVersion === ver.version_number ? 'border-warning/30 bg-warning/5' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-regular font-medium text-ink">{ver.version_number}</span>
                          <span className="text-micro text-ink-tertiary">
                            {new Date(ver.date_published).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-US')}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-micro text-ink-secondary bg-selected px-2 py-0.5 rounded">{ver.mcVersion}</span>
                          <span className="text-micro text-ink-secondary bg-selected px-2 py-0.5 rounded">{ver.loader}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <p className="text-small text-ink-secondary mb-1">
                    {translations[lang].updateOptionsFor} <strong className="text-ink">{selectedVersion}</strong>:
                  </p>
                  <div className="flex flex-col gap-3">
                    <button
                      onClick={onNewInstance}
                      className="bg-surface/20 hover:bg-hover border border-stroke hover:theme-border-md px-4 py-4 rounded-xl text-left transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl theme-bg-light theme-border-light flex items-center justify-center theme-text shrink-0">
                          <Plus className="w-5 h-5" />
                        </div>
                        <div className="flex-1">
                          <span className="text-regular font-medium text-ink group-hover:theme-text-bright transition-colors block">
                            {translations[lang].modpackNewInstance}
                          </span>
                          <span className="text-micro text-ink-secondary mt-1 block">
                            {translations[lang].modpackNewInstanceDesc}
                          </span>
                        </div>
                      </div>
                    </button>

                    <button
                      onClick={onCleanUpdate}
                      className="bg-surface/20 hover:bg-hover border border-stroke hover:border-info/30 px-4 py-4 rounded-xl text-left transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-info/10 border border-info/20 flex items-center justify-center text-info shrink-0">
                          <RefreshCw className="w-5 h-5" />
                        </div>
                        <div className="flex-1">
                          <span className="text-regular font-medium text-ink group-hover:text-info transition-colors block">
                            {translations[lang].modpackCleanUpdate}
                          </span>
                          <span className="text-micro text-ink-secondary mt-1 block">
                            {translations[lang].modpackCleanUpdateDesc}
                          </span>
                        </div>
                      </div>
                    </button>

                    <button
                      onClick={onBetaCarryOver}
                      className="bg-surface/20 hover:bg-hover border border-stroke hover:border-accent/30 px-4 py-4 rounded-xl text-left transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent shrink-0">
                          <Zap className="w-5 h-5" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-regular font-medium text-ink group-hover:text-accent transition-colors">
                              {translations[lang].modpackBetaCarryOver}
                            </span>
                            <span className="text-micro font-medium text-warning bg-warning/10 border border-warning/20 px-1.5 py-0.5 rounded uppercase tracking-label">BETA</span>
                          </div>
                          <span className="text-micro text-ink-secondary mt-1 block">
                            {translations[lang].modpackBetaCarryOverDesc}
                          </span>
                        </div>
                      </div>
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="p-4 bg-surface/40 border-t border-hairline flex justify-between items-center">
              <button
                onClick={() => {
                  if (optionsOpen) {
                    onOptionsOpenChange(false)
                  } else {
                    onClose()
                  }
                }}
                className="bg-surface hover:bg-hover border border-stroke text-ink px-4 py-2 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
              >
                {optionsOpen ? translations[lang].back : translations[lang].cancel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
