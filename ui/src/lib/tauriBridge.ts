/**
 * Tauri end of the renderer bridge.
 *
 * The ported UI still talks to `window.electronAPI`; this module implements the
 * exact same surface on top of Tauri commands and events, so no component had
 * to be rewritten for the technology switch.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

type Unsubscribe = () => void

const hasTauri =
  typeof window !== 'undefined' &&
  typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ === 'object'

/** Commands the Rust core does not expose yet are logged once, not spammed. */
const missingCommands = new Set<string>()
const MISSING_COMMAND = /not found|not allowed|unknown command|not registered/i

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error ?? 'unbekannter Fehler')
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!hasTauri) return undefined
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    const message = errorText(error)
    if (MISSING_COMMAND.test(message)) {
      if (!missingCommands.has(command)) {
        missingCommands.add(command)
        console.info(`[bamboo] "${command}" wird vom Rust-Core noch nicht bedient`)
      }
      return undefined
    }
    throw new Error(message)
  }
}

function send(command: string, args?: Record<string, unknown>): void {
  void call(command, args)
}

function subscribe<T>(event: string, callback: (payload: T) => void): Unsubscribe {
  let unlisten: UnlistenFn | undefined
  let closed = false
  void listen<T>(event, (received) => callback(received.payload))
    .then((off) => {
      if (closed) off()
      else unlisten = off
    })
    .catch(() => {})
  return () => {
    closed = true
    unlisten?.()
  }
}

/** Clipboard without an extra plugin: the async API, then the legacy path. */
function copyText(text: string): void {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => legacyCopy(text))
    return
  }
  legacyCopy(text)
}

function legacyCopy(text: string): void {
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    document.body.removeChild(area)
  } catch {
    /* clipboard is best effort */
  }
}

const bridge = {
  icons: {
    get: (name: string) => call<string | null>('get_icon', { name }),
  },

  launch: {
    start: (payload: unknown) => send('launch_game', { payload }),
    stop: (data: { folderName?: string; profileName?: string }) =>
      call<boolean>('kill_game', { folderName: data.folderName ?? '', profileName: data.profileName ?? '' }),
    onStatus: (callback: (status: string) => void) => subscribe('launch-status', callback),
    onClosed: (callback: (data: unknown) => void) => subscribe('game-closed', callback),
    onReady: (callback: (profileName: string) => void) => subscribe('launch-ready', callback),
    onFailed: (callback: (data: unknown) => void) => subscribe('launch-failed', callback),
    onProgress: (callback: (data: unknown) => void) => subscribe('launch-progress', callback),
  },

  logs: {
    analyze: (instanceId: string) => call('logs_analyze', { instanceId }),
    applyFix: (analysisId: string, actionId: string) =>
      call('logs_apply_fix', { analysisId, actionId }),
    undoFix: (undoToken: string) => call('logs_undo_fix', { undoToken }),
    readLatest: (folderName: string) => call<string>('read_latest_log', { folderName }),
    createSupportBundle: (destination: string) =>
      call('logs_support_bundle', { destination }),
  },

  settings: {
    get: () => call<Record<string, unknown>>('get_settings'),
    save: (settings: unknown) => call<boolean>('save_settings', { settings }),
    onFlushBeforeClose: (callback: () => void) => subscribe('app:flush-before-close', callback),
    flushBeforeCloseComplete: () => send('flush_before_close_complete'),
  },

  statistics: {
    summary: () => call('statistics_summary'),
  },

  instances: {
    list: () => call<unknown[]>('list_instances'),
    create: (data: unknown) => call('create_instance', { data }),
    rename: (data: unknown) => call('rename_instance', { data }),
    clone: (data: unknown) => call('clone_instance', { data }),
    createShortcut: (data: unknown) => call('create_desktop_shortcut', { data }),
    deleteFiles: (folderName: string) => call('delete_instance_files', { folderName }),
    openFolder: (folderName: string) => call('open_instance_folder', { folderName }),
    openProfileFolder: (name: string) => call('open_instance_folder', { folderName: name }),
    preflight: (folderName: string) => call('preflight_check', { folderName }),
    preflightDisable: (folderName: string, files: string[]) =>
      call('preflight_disable', { folderName, files }),
    listWorlds: (folderName: string) => call<unknown[]>('list_instance_worlds', { folderName }),
    openWorld: (folderName: string, worldName: string) =>
      call('open_instance_world', { folderName, worldName }),
    exportWorld: (data: unknown) => call('export_instance_world', { data }),
    importWorld: (data: unknown) => call('import_instance_world', { data }),
    deleteWorld: (data: unknown) => call('delete_instance_world', { data }),
    listBackups: (folderName: string) => call('list_backups', { folderName }),
    createBackup: (data: unknown) => call('create_backup', { data }),
    restoreBackup: (data: unknown) => call('restore_backup', { data }),
    deleteBackup: (data: unknown) => call('delete_backup', { data }),
    openBackupsFolder: (folderName: string) => call('open_backups_folder', { folderName }),
    repair: (data: unknown) => call('repair_instance', { data }),
    changeVersion: (data: unknown) => call('change_instance_version', { data }),
    updateLaunchSettings: (folderName: string, patch: unknown) =>
      call('update_launch_settings', { folderName, patch }),
    getProfiles: () => call<unknown[]>('get_profiles'),
    saveProfiles: (profiles: unknown[]) => call<boolean>('save_profiles', { profiles }),
    onLaunchRequest: (callback: (folderName: string) => void) =>
      subscribe('bamboo:launch-instance-request', callback),
  },

  mods: {
    curseforgeSearch: (payload: unknown) => call('curseforge_search', { payload }),
    curseforgeProject: (modId: string | number) => call('curseforge_project', { modId: String(modId) }),
    curseforgeFiles: (
      modId: string | number,
      gameVersion?: string,
      modLoaderType?: number,
    ) => call('curseforge_files', {
      modId: String(modId),
      gameVersion: gameVersion ?? null,
      modLoaderType: modLoaderType ?? null,
    }),
    download: (data: unknown) => call('install_mod', { data }),
    checkUpdates: (data: unknown) => call('check_mod_updates', { data }),
    installModpack: (data: unknown) => call('install_modpack', { data }),
    uploadLocal: (data: unknown) => call('upload_local_mod', { data }),
    listContentFiles: (data: unknown) => call<string[]>('list_content_files', { data }),
    identifyContentFiles: (data: unknown) => call('identify_content_files', { data }),
    deleteContentFile: (data: unknown) => call<boolean>('delete_content_file', { data }),
    onModpackProgress: (callback: (data: unknown) => void) =>
      subscribe('modpack-install-progress', callback),
  },

  dialogs: {
    open: (options: unknown) => call('show_open_dialog', { options }),
    save: (options: unknown) => call('show_save_dialog', { options }),
    showItem: (filePath: string) => call('show_item_in_folder', { filePath }),
    readImage: (filePath: string) => call<string | null>('read_image_file', { filePath }),
  },

  profiles: {
    export: (data: unknown) => call('export_profile', { data }),
    importPreview: (filePath: string) => call('import_profile_preview', { filePath }),
    import: (data: unknown) => call('import_profile', { data }),
    externalPreview: (directory: string) =>
      call('external_instance_preview', { directory }),
    importExternal: (data: unknown) => call('import_external_instance', { data }),
    updateModpack: (data: unknown) => call('update_modpack', { data }),
  },

  accounts: {
    list: () => call<unknown[]>('list_accounts'),
    setActive: (id: string) => call('set_active_account', { id }),
    remove: (id: string) => call('remove_account', { id }),
  },

  auth: {
    status: () => call<unknown>('auth_status'),
    login: () => call<unknown>('auth_login'),
    cancel: () => call<boolean>('auth_cancel'),
    refresh: (accountId?: string) => call<unknown>('auth_refresh', { accountId }),
    signOut: (accountId?: string) => call<unknown>('auth_logout', { accountId: accountId ?? null }),
    identity: () => call('player_identity'),
    onStatus: (callback: (status: unknown) => void) => subscribe('bamboo:auth:changed', callback),
  },

  skins: {
    snapshot: () => call('skins_snapshot'),
    saveSkin: (payload: unknown) => call('skins_save', { payload }),
    setSkinVariant: (variant: string) => call('skins_variant', { payload: { variant } }),
    resetSkin: () => call('skins_reset'),
    applySkin: () => call('skins_apply'),
    selectCape: (capeId: string | null) => call('skins_cape', { payload: { capeId } }),
    refresh: () => call('skins_refresh'),
  },

  cosmetics: {
    list: () => call('cosmetics_list'),
    preview: (payload?: unknown) => call('cosmetics_preview', { data: payload }),
    remove: (payload?: unknown) => call('cosmetics_remove', { data: payload }),
    shop: () => call('cosmetics_shop'),
    shopPreview: (id: string) => call('cosmetics_shop_preview', { id }),
    install: (payload?: unknown) => call('cosmetics_install', { data: payload }),
  },

  window: {
    minimize: () => send('minimize_window'),
    maximize: () => send('maximize_window'),
    isMaximized: () => call<boolean>('is_maximized_window'),
    onMaximizedChange: (callback: (maximized: boolean) => void) =>
      subscribe('window-maximized-change', callback),
    focus: () => send('focus_window'),
    close: () => send('close_window'),
  },

  java: {
    versions: (forceRescan?: boolean) => call<unknown[]>('list_java', { forceRescan: !!forceRescan }),
  },

  loaders: {
    forgeVersions: () => call('forge_versions'),
    neoforgeVersions: () => call('neoforge_versions'),
  },

  servers: {
    ping: (serverIp: string) => call('ping_server', { serverIp }),
    syncDat: (data: unknown) => call('sync_servers_dat', { data }),
  },

  screenshots: {
    collect: () => call('collect_screenshots'),
    delete: (payload: unknown) => call('delete_screenshot', { payload }),
    openFolder: () => call('open_screenshots_folder'),
  },

  tasks: {
    onProgress: (callback: (data: unknown) => void) => subscribe('background-task-progress', callback),
  },

  updates: {
    state: () => call('updates_state'),
    check: () => call('updates_check'),
    install: () => call('updates_install'),
    onStatus: (callback: (status: unknown) => void) => subscribe('updater-status', callback),
  },

  system: {
    copy: (text: string) => copyText(text),
    openExternal: (url: string) => send('open_external', { url }),
  },
}

export function installTauriBridge(): void {
  ;(window as unknown as Record<string, unknown>).electronAPI = bridge
}
