import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { Instance } from '../components/InstancesView'
import { isLegacyInstanceCover, normalizeInstanceCover } from '../lib/instanceCovers'
import { instanceFolderKeyOf } from '../lib/instanceFolders'

export interface IpcProfile {
  id?: string
  name?: string
  folderName?: string
  version?: string
  loader?: string
  loaderVersion?: string
  lastPlayed?: string
  size?: string
  mods?: number
  desc?: string
  thumbnail?: string
  /** Older imports stored an HTML <img> snippet under this key. */
  icon?: string
  javaPath?: string
  installedMods?: string[]
  content?: Array<{ type: string; [key: string]: unknown }>
  ram?: number
  playTimeMs?: number
  sessionCount?: number
  lastPlayedAt?: number
  createdAt?: number
  jvmArgs?: string
  keybinds?: Record<string, string>
  fullscreen?: boolean
  windowMode?: 'default' | 'custom'
  windowWidth?: number
  windowHeight?: number
  isModpack?: boolean
  ownContentManagement?: boolean
  modpackProjectId?: string
  modpackSource?: string
  modpackVersion?: string
}

function profileCover(profile: IpcProfile): string {
  const stored = profile.thumbnail || profile.icon || ''
  const embedded = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(stored)
  const value = embedded ? embedded[1] : stored
  if (!value || value === '📦') return ''
  if (value.startsWith('data:image/')) return value
  if (/^(https?:|\.\/|\/|bamboo-file:)/i.test(value)) return value
  return ''
}

export function mapProfileToInstance(profile: IpcProfile, index: number): Instance {
  const thumbnail = normalizeInstanceCover(profileCover(profile), profile, index)
  return {
    id: profile.id || String(index),
    name: profile.name || '',
    folderName: profile.folderName,
    minecraftVersion: profile.version || '1.21',
    modloader: (profile.loader === 'vanilla' || profile.loader === 'Vanilla')
      ? 'Vanilla' as const
      : (profile.loader || 'Fabric') as Instance['modloader'],
    modloaderVersion: profile.loaderVersion || '',
    lastPlayed: profile.lastPlayed || 'Nie',
    size: profile.size || '0 MB',
    modCount: (profile.content || []).filter((entry) => entry.type === 'mods').length || profile.mods || 0,
    desc: profile.desc || '',
    thumbnail,
    javaVersion: profile.javaPath || 'Automatisch',
    installedMods: profile.installedMods || [],
    content: (profile.content || []) as unknown as Instance['content'],
    ram: profile.ram,
    playTimeMs: profile.playTimeMs || 0,
    sessionCount: profile.sessionCount || 0,
    lastPlayedAt: profile.lastPlayedAt || 0,
    createdAt: profile.createdAt || 0,
    jvmArgs: profile.jvmArgs || '',
    keybinds: profile.keybinds || {},
    fullscreen: profile.fullscreen,
    windowMode: profile.windowMode,
    windowWidth: profile.windowWidth,
    windowHeight: profile.windowHeight,
    isModpack: profile.isModpack || false,
    ownContentManagement: profile.ownContentManagement || false,
    modpackProjectId: profile.modpackProjectId || undefined,
    modpackSource: (profile.modpackSource as 'modrinth' | 'curseforge') || undefined,
    modpackVersion: profile.modpackVersion || undefined,
  }
}

export function profileFromInstance(instance: Instance): Record<string, unknown> {
  return {
    id: instance.id,
    name: instance.name,
    folderName: instanceFolderKeyOf(instance),
    version: instance.minecraftVersion,
    loader: instance.modloader,
    loaderVersion: instance.modloaderVersion || '',
    lastPlayed: instance.lastPlayed,
    size: instance.size,
    mods: (instance.content || []).filter((entry) => entry.type === 'mods').length || instance.modCount || 0,
    desc: instance.desc,
    thumbnail: normalizeInstanceCover(instance.thumbnail, instance),
    javaPath: instance.javaVersion || 'Automatisch',
    installedMods: instance.installedMods || [],
    content: instance.content || [],
    ram: instance.ram,
    isModpack: instance.isModpack || false,
    playTimeMs: instance.playTimeMs || 0,
    sessionCount: instance.sessionCount || 0,
    lastPlayedAt: instance.lastPlayedAt || 0,
    createdAt: instance.createdAt || 0,
    jvmArgs: instance.jvmArgs || '',
    keybinds: instance.keybinds || {},
    fullscreen: instance.fullscreen,
    windowMode: instance.windowMode,
    windowWidth: instance.windowWidth,
    windowHeight: instance.windowHeight,
    ownContentManagement: instance.ownContentManagement || false,
    modpackProjectId: instance.modpackProjectId || undefined,
    modpackSource: instance.modpackSource || undefined,
    modpackVersion: instance.modpackVersion || undefined,
  }
}

export interface InstancesState {
  instances: Instance[]
  setInstances: Dispatch<SetStateAction<Instance[]>>
  activeInstance: string
  setActiveInstance: Dispatch<SetStateAction<string>>
  profilesLoaded: boolean
  legacyCoversDetected: boolean
  totalPlaytime: number
}

export function useInstances(): InstancesState {
  const [instances, setInstances] = useState<Instance[]>([])
  const [activeInstance, setActiveInstance] = useState('')
  const [profilesLoaded, setProfilesLoaded] = useState(false)
  const [legacyCoversDetected, setLegacyCoversDetected] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (attempt = 0) => {
      try {
        const profiles = await window.electronAPI?.instances.getProfiles?.()
        if (cancelled) return
        if (Array.isArray(profiles)) {
          if (profiles.length > 0) {
            const mapped = (profiles as IpcProfile[]).map(mapProfileToInstance)
            setInstances(mapped)
            setActiveInstance(mapped[0]?.name || '')
            if ((profiles as IpcProfile[]).some((profile) => isLegacyInstanceCover(profile.thumbnail || ''))) {
              setLegacyCoversDetected(true)
            }
          }
          setProfilesLoaded(true)
          return
        }
      } catch {
        console.warn('[Bamboo] Failed to load profiles')
      }
      if (!cancelled && attempt < 60) {
        timer = setTimeout(() => { void load(attempt + 1) }, 250)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const totalPlaytime = instances.reduce((sum, instance) => sum + (instance.playTimeMs || 0), 0)

  return {
    instances,
    setInstances,
    activeInstance,
    setActiveInstance,
    profilesLoaded,
    legacyCoversDetected,
    totalPlaytime,
  }
}
