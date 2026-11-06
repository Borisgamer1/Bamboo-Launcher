import { z } from 'zod'
import { describeError, getDefaultLogger } from './logger'

/**
 * Single owner of Electron IPC registration.
 *
 * Every channel, whether it belongs to the typed core or the legacy main.js
 * surface, is registered through this registrar. The registrar applies the
 * sender check universally and validates arguments for channels with a schema
 * before the handler sees them.
 */

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  on?(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  once?(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeListener?(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

interface SenderFrame {
  url?: string
}

export type IpcListener = (event: unknown, ...args: unknown[]) => unknown

export interface IpcRegistrar {
  handle(channel: string, listener: IpcListener): void
  on(channel: string, listener: IpcListener): void
  once(channel: string, listener: IpcListener): void
  removeListener(channel: string, listener: IpcListener): void
}

export function isTrustedSender(event: unknown): boolean {
  const frame = (event as { senderFrame?: SenderFrame } | undefined)?.senderFrame
  if (!frame || typeof frame.url !== 'string' || frame.url.length === 0) {
    return true
  }
  const url = frame.url
  if (url.startsWith('file://')) return true
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(url)) return true
  return false
}

/**
 * Adapter for handlers written without the Electron event parameter, like the
 * typed core handlers in ipc.ts. The registrar still owns the sender check.
 */
export function eventless<T extends unknown[]>(
  handler: (...args: T) => unknown,
): (event: unknown, ...args: T) => unknown {
  return (_event, ...args) => handler(...args)
}

const text = (max = 4096) => z.string().min(1).max(max)
const record = z.record(z.string(), z.unknown())
const objectArray = z.array(z.unknown())
const singleSegment = (value: string) =>
  !/[\\/]/.test(value) && value !== '.' && value !== '..'
const folderName = text(256).refine(singleSegment, {
  message: 'folderName must be a single path segment',
})
const fileName = text(255).refine(singleSegment, {
  message: 'fileName must be a single path segment',
})
const url = z.string().url().max(4096)

/**
 * The channel manifest: every channel any surface registers, with its argument
 * schema. `null` means the channel takes no arguments. Parsing is validation
 * only; the original arguments are passed through so payload shapes and
 * defaults stay exactly as the legacy handlers expect them.
 */
export const IPC_CHANNELS: Record<string, z.ZodType | null> = {
  'create-instance': z.tuple([
    z.object({
      folderName,
      options: record.optional(),
      name: z.string().max(80).optional(),
      version: z.string().max(64).optional(),
      loader: z.string().max(64).optional(),
      loaderVersion: z.string().max(64).optional(),
    }),
  ]),
  'open-profile-folder': z.tuple([folderName]),
  'open-instance-folder': z.tuple([folderName]),
  'delete-profile-files': z.tuple([folderName]),
  'repair-profile': z.tuple([
    z.object({
      loader: text(64),
      loaderVersion: z.string().max(64).optional(),
      mcVersion: text(64),
      folderName: folderName.optional(),
    }),
  ]),
  'change-instance-version': z.tuple([
    z.object({
      folderName,
      mcVersion: text(64),
      loader: z.enum(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']),
      loaderVersion: z.string().max(64).optional(),
    }),
  ]),
  'save-settings': z.tuple([record]),
  'curseforge-search': z.tuple([
    z.object({
      query: z.string().max(256).optional(),
      sortBy: z.string().max(64).optional(),
      modFilter: z.unknown().optional(),
      gameVersion: z.string().max(64).optional(),
      modLoaderType: z.number().int().optional(),
      index: z.number().int().min(0).optional(),
      pageSize: z.number().int().min(1).max(500).optional(),
    }),
  ]),
  'curseforge-project': z.tuple([
    z.union([z.string().min(1).max(64), z.number().int().nonnegative()]),
  ]),
  'curseforge-files': z.tuple([
    z.union([z.string().min(1).max(64), z.number().int().nonnegative()]),
    z.string().max(64).optional(),
    z.number().int().optional(),
  ]),
  'save-profiles': z.tuple([objectArray]),
  'show-open-dialog': z.tuple([record.optional()]),
  'show-save-dialog': z.tuple([record.optional()]),
  'ping-server': z.tuple([text(255)]),
  'show-item-in-folder': z.tuple([text(4096)]),
  'read-image-file': z.tuple([text(4096)]),
  'export-profile': z.tuple([record]),
  'import-preview': z.tuple([text(4096)]),
  'import-profile': z.tuple([record]),
  'install-modpack-mrpack': z.tuple([
    z.object({ folderName, mcVersion: text(64), loader: text(64), mrpackUrl: url }),
  ]),
  'download-mod': z.tuple([
    z.object({
      folderName,
      profileName: z.string().max(256).optional(),
      versionId: z.string().max(128).optional(),
      downloadUrl: url.optional(),
      filename: fileName,
      itemType: z.string().max(64).optional(),
      curseforgeFileId: z.number().int().positive().optional(),
      taskId: z.string().max(256).optional(),
      title: z.string().max(256).optional(),
    }).refine((value) => Boolean(value.downloadUrl) || value.curseforgeFileId !== undefined, {
      message: 'downloadUrl or curseforgeFileId is required',
      path: ['downloadUrl'],
    }),
  ]),
  'delete-screenshot-file': z.tuple([
    z.union([
      text(4096),
      z.object({ absolutePath: text(4096), sourceAbsolutePath: text(4096).optional() }),
    ]),
  ]),
  'copy-to-clipboard': z.tuple([z.string().max(1_000_000)]),
  'open-external-url': z.tuple([
    text(4096).refine((value) => /^(https?|mailto|discord):/i.test(value), {
      message: 'only http(s), mailto and discord URLs may be opened',
    }),
  ]),
  'launch-game': z.tuple([
    z.object({
      folderName,
      profileName: text(256),
      version: text(64),
      ram: z.number().optional(),
      modLoader: z.string().max(64).optional(),
      loaderVersion: z.string().max(64).optional(),
      javaPath: z.string().max(4096).optional(),
      authData: record.optional(),
      gameOptions: record.optional(),
      extraJvmArgs: z.array(z.string()).optional(),
      resolution: z
        .object({ width: z.number().int(), height: z.number().int() })
        .nullable()
        .optional(),
    }),
  ]),
  'kill-game': z.tuple([folderName]),
  'delete-content-file': z.tuple([
    z.object({ folderName, fileName, type: z.string().max(64).optional() }),
  ]),
  'list-instance-worlds': z.tuple([folderName]),
  'list-content-files': z.tuple([
    z.object({ folderName, type: z.string().max(64).optional() }),
  ]),
  'upload-local-mod': z.tuple([
    z.object({ folderName, filePath: text(4096), itemType: z.string().max(64).optional() }),
  ]),
  'rename-instance': z.tuple([z.object({ oldFolderName: folderName, newName: text(256) })]),
  'identify-content-files': z.tuple([
    z.object({
      folderName,
      files: z.array(
        z.object({
          fileName,
          type: z.string().max(64).optional(),
        }),
      ).max(100),
    }),
  ]),
  'hash-content-files': z.tuple([
    z.object({
      folderName,
      files: z.array(
        z.object({
          fileName,
          type: z.string().max(64).optional(),
        }),
      ).max(500),
    }),
  ]),
  'clone-instance': z.tuple([z.object({ folderName, newName: text(256).optional() })]),
  'create-desktop-shortcut': z.tuple([
    z.object({ folderName, instanceName: z.string().max(256).optional() }),
  ]),
  'renderer-log': z.tuple([
    z.object({
      level: z.enum(['debug', 'info', 'warn', 'error']),
      message: text(1024),
      data: z.unknown().optional(),
    }),
  ]),

  // Typed core surface (electron/ipc.ts). Optional arguments stay optional: the
  // preload bridge always passes the slot, sometimes as undefined.
  'find-java': null,
  'get-java-versions': z.tuple([z.boolean().optional()]),
  'get-recommended-java-for-mc': z.tuple([text(64)]),
  'find-best-java-for-mc': z.tuple([text(64)]),
  'read-latest-log': z.tuple([folderName]),
  'detect-lan-server': z.tuple([folderName]),
  'get-hosted-servers': null,
  'bamboo:core:status': null,
  'bamboo:core:set-game-root': z.tuple([text(4096)]),
  'bamboo:logs:analyze': z.tuple([text(256), text(256).optional()]),
  'bamboo:logs:apply-fix': z.tuple([text(256), text(256)]),
  'bamboo:logs:undo': z.tuple([text(256)]),
  'bamboo:settings:get': null,
  'bamboo:settings:save': z.tuple([record]),
  'bamboo:statistics:summary': null,
  'bamboo:telemetry:get': null,
  'bamboo:support:bundle': z.tuple([text(4096)]),
  'bamboo:auth:status': null,
  'bamboo:auth:login': null,
  'bamboo:auth:cancel': null,
  'bamboo:auth:refresh': z.tuple([text(256).optional()]),
  'bamboo:auth:sign-out': z.tuple([text(256).optional()]),
  'bamboo:accounts:list': null,
  'bamboo:accounts:set-active': z.tuple([text(256)]),
  'bamboo:accounts:remove': z.tuple([text(256)]),
  'bamboo:instances:list': null,
  'bamboo:instances:update-launch': z.tuple([folderName, record]),
  'bamboo:skins:snapshot': null,
  'bamboo:skins:save-skin': z.tuple([record]),
  'bamboo:skins:set-skin-variant': z.tuple([z.string().max(32)]),
  'bamboo:skins:reset-skin': null,
  'bamboo:skins:apply-skin': null,
  'bamboo:skins:select-cape': z.tuple([z.string().max(256).nullable()]),
  'bamboo:skins:refresh': null,
  'bamboo:cosmetics:list': null,
  'bamboo:cosmetics:preview': z.tuple([record]),
  'bamboo:cosmetics:remove': z.tuple([record]),
  'bamboo:cosmetics:shop': null,
  'bamboo:cosmetics:shop-preview': z.tuple([text(256)]),
  'bamboo:cosmetics:sync': null,
  'bamboo:cosmetics:install': z.tuple([record]),
  'bamboo:mods:check-updates': z.tuple([record]),

  // Updater surface (electron/updater.ts).
  'bamboo:updates:state': null,
  'bamboo:updates:check': null,
  'bamboo:updates:install': null,

  // Channels that take no arguments at all.
  'window-minimize': null,
  'window-maximize': null,
  'window-is-maximized': null,
  'window-focus': null,
  'window-close': null,
  'get-icons': null,
  'get-settings': null,
  'get-player-identity': null,
  'get-forge-versions': null,
  'get-neoforge-versions': null,
  'get-profiles': null,
  'get-active-launches': null,
  'bamboo:ui:ready': null,
  'app:flush-before-close-done': null,
  'collect-all-screenshots': null,
  'open-screenshots-folder': null,
}

function validateArgs(channel: string, args: unknown[]): unknown[] {
  const schema = IPC_CHANNELS[channel]
  if (!schema) return args
  const result = schema.safeParse(args)
  if (!result.success) {
    throw new Error(`Invalid IPC arguments for ${channel}`)
  }
  // Validation only: keep the original payload so legacy defaults and extra
  // fields behave exactly as before.
  return args
}

export function createIpcRegistrar(ipc: IpcMainLike): IpcRegistrar {
  const wrappers = new Map<IpcListener, Map<string, IpcListener>>()

  const remember = (channel: string, listener: IpcListener, wrapped: IpcListener) => {
    let channels = wrappers.get(listener)
    if (!channels) {
      channels = new Map()
      wrappers.set(listener, channels)
    }
    channels.set(channel, wrapped)
  }

  const forget = (channel: string, listener: IpcListener) => {
    const channels = wrappers.get(listener)
    channels?.delete(channel)
    if (channels && channels.size === 0) wrappers.delete(listener)
  }

  const guarded = (
    channel: string,
    listener: IpcListener,
    mode: 'handle' | 'event',
  ): IpcListener => {
    return (event, ...args) => {
      const execute = () => {
        if (!isTrustedSender(event)) {
          throw new Error('Rejected IPC call from untrusted frame')
        }
        return listener(event, ...validateArgs(channel, args))
      }
      if (mode === 'handle') {
        // Electron serializes a rejected promise; tests and callers already
        // expect the invoker to reject rather than throw synchronously.
        return Promise.resolve().then(execute)
      }
      try {
        return execute()
      } catch (error) {
        // Event-mode IPC has no reply path; the log is the only failure record.
        getDefaultLogger().child('ipc').warn('event handler failed', {
          channel,
          error: describeError(error),
        })
        return undefined
      }
    }
  }

  return {
    handle(channel, listener) {
      ipc.handle(channel, guarded(channel, listener, 'handle'))
    },
    on(channel, listener) {
      if (!ipc.on) return
      const wrapped = guarded(channel, listener, 'event')
      remember(channel, listener, wrapped)
      ipc.on(channel, wrapped)
    },
    once(channel, listener) {
      const register = ipc.once ?? ipc.on
      if (!register) return
      const wrapped: IpcListener = (event, ...args) => {
        try {
          return guarded(channel, listener, 'event')(event, ...args)
        } finally {
          forget(channel, listener)
        }
      }
      remember(channel, listener, wrapped)
      register.call(ipc, channel, wrapped)
    },
    removeListener(channel, listener) {
      const wrapped = wrappers.get(listener)?.get(channel)
      forget(channel, listener)
      ipc.removeListener?.(channel, wrapped ?? listener)
    },
  }
}
