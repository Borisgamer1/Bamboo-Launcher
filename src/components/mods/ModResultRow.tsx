import { Check, Download, ExternalLink, Plus, Puzzle, RefreshCw, Users } from 'lucide-react'
import { formatCompactNumber, formatMessage, translations, type LanguageType } from '../../lib/translations'
import type { AccentClasses, ModrinthHit } from './modDetailModel'

export interface ModResultRowProps {
  mod: ModrinthHit
  source: 'modrinth' | 'curseforge'
  lang: LanguageType
  t: (typeof translations)[LanguageType]
  accent: AccentClasses
  showInstallBtn: boolean
  isInstalling: boolean
  installProgress: number
  onOpen: () => void
  onInstall: () => void
  onOpenExternal: () => void
}

/** One search result: icon, author, counts and the install control. */
export function ModResultRow({
  mod,
  source,
  lang,
  t,
  accent,
  showInstallBtn,
  isInstalling,
  installProgress,
  onOpen,
  onInstall,
  onOpenExternal,
}: ModResultRowProps) {
  return (
    <div
      onClick={onOpen}
      className={`mod-result-row bg-surface border rounded-2xl px-5 py-2.5 flex items-center gap-4 group cursor-pointer transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-base)] ease-[var(--ease-out)] hover:shadow-xl text-left relative overflow-hidden min-h-[96px] shrink-0 ${accent.bgLight} ${accent.border}`}
    >
      <div className="w-14 h-14 rounded-2xl bg-surface border border-stroke flex items-center justify-center shrink-0 overflow-hidden relative shadow-md">
        {mod.icon_url ? (
          <img src={mod.icon_url} alt={mod.title} loading="lazy" decoding="async" className="w-full h-full object-cover group-hover:scale-103 transition-transform duration-[var(--t-out)] ease-[var(--ease-out)]" />
        ) : (
          <Puzzle className="w-6 h-6 text-ink-tertiary" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-ink/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      <div className="flex-1 min-w-0 flex flex-col justify-center h-full">
        <div className="flex items-center gap-2">
          <h3 className={`text-regular font-semibold text-ink ${accent.hoverText} transition-colors  truncate`}>
            {mod.title}
          </h3>
          <span className="text-micro text-ink-tertiary font-medium truncate">
            {formatMessage(t.byAuthor, { author: mod.author })}
          </span>
        </div>
        <p className="text-micro text-ink-secondary line-clamp-2 mt-0.5 font-medium">
          {mod.description}
        </p>
        <div className="flex items-center gap-3 text-micro text-ink-tertiary font-medium mt-1">
          <span className="flex items-center gap-0.5 shrink-0">
            <Download className="w-3 h-3 text-ink-tertiary" />
            {formatCompactNumber(mod.downloads, lang)}
          </span>
          {/* CurseForge has no follow count; its API only exposes a
              0-5 rating, so a person icon here was never meaningful. */}
          {source !== "curseforge" && (
            <span className="flex items-center gap-0.5 shrink-0">
              <Users className="w-3 h-3 text-ink-tertiary" />
              {formatCompactNumber(mod.follows, lang)}
            </span>
          )}
        </div>
      </div>

      <div className="shrink-0 pl-2 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onOpenExternal}
          className="h-8 w-8 rounded-lg border border-stroke text-ink-tertiary hover:text-ink hover:bg-hover transition-colors cursor-pointer flex items-center justify-center"
          title={lang === 'de' ? 'Im Browser öffnen' : 'Open in browser'}
          aria-label={lang === 'de' ? 'Im Browser öffnen' : 'Open in browser'}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
        {showInstallBtn ? (
          <button
            type="button"
            disabled={isInstalling}
            onClick={onInstall}
            className={`relative overflow-hidden px-3 py-1.5 rounded-lg text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] flex items-center gap-1 cursor-pointer ${
              isInstalling
                ? "bg-accent/10 text-accent border-[color:var(--accent)]/20"
                : `${accent.bg} text-accent-contrast shadow-lg ${accent.glow}`
            }`}
          >
            {isInstalling && (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-accent/20 transition-[width] duration-300 ease-[var(--ease-out)]"
                style={{ width: `${installProgress}%` }}
              />
            )}
            <span className="relative flex items-center gap-1 tabular-nums">
              {isInstalling ? (
                <>
                  <RefreshCw className="w-3 h-3 animate-spin" />
                  {installProgress}%
                </>
              ) : (
                <>
                  <Plus className="w-3 h-3 stroke-[3]" />
                  {t.install}
                </>
              )}
            </span>
          </button>
        ) : (
          <span className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-micro font-medium text-accent bg-[color:var(--accent)]/10 border border-[color:var(--accent)]/20">
            <Check className="w-3 h-3 stroke-[3]" />
            {t.installed}
          </span>
        )}
      </div>
    </div>
  )
}
