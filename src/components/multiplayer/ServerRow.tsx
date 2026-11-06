import React from 'react'
import { motion } from 'framer-motion'
import { Edit3, Play, Users, RefreshCw } from 'lucide-react'
import type { LanguageType } from '../../lib/translations'
import { MOTION, EASE, motionSafe, staggerDelay } from '../../lib/motionTokens'
import type { ServerItem } from './types'
import { formatMotd } from './motd'

interface ServerRowProps {
  server: ServerItem
  index: number
  lang: LanguageType
  editLabel: string
  onEdit: (server: ServerItem) => void
  onJoin: (server: ServerItem) => void
}

/** One saved server card: status, player count and the edit/join actions. */
export function ServerRow({ server, index, lang, editLabel, onEdit, onJoin }: ServerRowProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={motionSafe({ duration: MOTION.slow, delay: staggerDelay(index), ease: EASE.out })}
      className="bg-surface border border-hairline rounded-2xl p-5 flex flex-col md:flex-row items-center justify-between gap-5 group hover:theme-border-md hover:shadow-2xl transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-base)] ease-[var(--ease-out)] relative overflow-hidden"
    >
      <div className="flex items-center gap-5 w-full md:w-auto">
        <div className="w-16 h-16 rounded-2xl bg-surface/80 border border-stroke/80 group-hover:theme-border-light flex items-center justify-center shrink-0 overflow-hidden relative shadow-lg">
          {server.isPinging ? (
            <RefreshCw className="w-6 h-6 text-ink-tertiary animate-spin" />
          ) : (
            <img src={server.icon} alt={server.name} className="w-12 h-12 object-contain" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-ink/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>

        <div className="flex flex-col text-left min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h3 className="text-large font-semibold text-ink group-hover:theme-text-bright transition-colors">
              {server.name}
            </h3>
            <span className="text-micro text-ink-tertiary font-medium bg-surface/40 border border-stroke px-2 py-0.5 rounded">
              {server.ip}
            </span>
            {!server.isPinging && server.online === false && (
              <span className="text-micro font-medium text-danger bg-danger/10 border border-danger/20 px-2 py-0.5 rounded">
                {lang === 'de' ? 'Nicht erreichbar' : 'Unreachable'}
              </span>
            )}
          </div>

          <p className="text-small text-ink-secondary mt-2 whitespace-pre-line font-mono">
            {server.isPinging ? (
              <span className="text-ink-tertiary italic animate-pulse">Checking connection status...</span>
            ) : server.online === false ? (
              <span className="text-danger font-medium">
                {lang === 'de' ? 'Server ist offline oder nicht erreichbar.' : 'Server is offline or unreachable.'}
              </span>
            ) : server.online === true ? (
              formatMotd(server.motd)
            ) : (
              <span className="text-ink-tertiary italic">
                {lang === 'de' ? 'Status unbekannt – zum Aktualisieren …' : 'Status unknown – refresh to check …'}
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between md:justify-end gap-6 w-full md:w-auto border-t md:border-t-0 border-hairline pt-4 md:pt-0 shrink-0">
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="flex items-center gap-1.5 justify-end text-ink">
              <Users className="w-4 h-4 text-ink-secondary" />
              <span className="text-regular font-medium">
                {server.isPinging || server.online !== true ? '—' : server.onlinePlayers.toLocaleString()}
              </span>
              <span className="text-small text-ink-tertiary font-medium">
                / {server.isPinging || server.online !== true ? '—' : server.maxPlayers.toLocaleString()}
              </span>
            </div>
            <div className="w-28 h-1 bg-surface rounded-full overflow-hidden mt-1.5">
              <div
                className="h-full theme-bg rounded-full theme-glow transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-out)] ease-[var(--ease-out)]"
                style={{ width: server.isPinging || server.online !== true ? '0%' : `${(server.onlinePlayers / (server.maxPlayers || 100)) * 100}%` }}
              />
            </div>
          </div>

          <div className="flex items-center gap-1.5 px-2.5 py-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${
              server.isPinging || server.online === undefined
                ? 'bg-ink-quaternary'
                : server.online === false
                ? 'bg-danger'
                : 'bg-success'
            }`} />
            <span className={`text-micro font-medium ${server.online === false && !server.isPinging ? 'text-danger' : 'text-ink-secondary'}`}>
              {server.isPinging
                ? '…'
                : server.online === true
                  ? (lang === 'de' ? 'online' : 'online')
                  : server.online === false
                    ? (lang === 'de' ? 'offline' : 'offline')
                    : (lang === 'de' ? 'unbekannt' : 'unknown')}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onEdit(server)}
            className="p-3 bg-surface/40 hover:bg-selected border border-stroke hover:border-rim text-ink-secondary hover:text-ink rounded-xl transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
            title={editLabel}
          >
            <Edit3 className="w-4 h-4" />
          </button>
          <button
            onClick={() => onJoin(server)}
            className="p-3 theme-bg hover:theme-bg-hover text-accent-contrast rounded-xl transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-base)] ease-[var(--ease-out)] theme-shadow-lg hover:theme-shadow-lg hover:scale-105 cursor-pointer flex items-center justify-center"
          >
            <Play className="w-4.5 h-4.5 fill-root stroke-[2.5]" />
          </button>
        </div>
      </div>
    </motion.div>
  )
}
