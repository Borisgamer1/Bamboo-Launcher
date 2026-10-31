import { basename, join } from 'node:path'
import type { LauncherCore } from './core'
import { createIpcRegistrar, eventless } from './ipc-registry'
import type { IpcMainLike } from './ipc-registry'
import { toLegacyJavaVersion, toLegacyJavaVersions, usableJavaRecords } from './java/legacy'
import { readLanPort, readLogTail } from './logs/tail'
import { InstanceLaunchPatchSchema } from './schemas'
import type { InstanceFile } from './schemas'

export type { IpcMainLike } from './ipc-registry'

function javaRecordsReader(core: LauncherCore) {
  let scanned = false
  return async (forceScan: boolean) => {
    let records = await core.java.list()
    if (forceScan || (!scanned && records.length === 0)) {
      records = (await core.java.scan()).records
      scanned = true
    }
    return usableJavaRecords(records)
  }
}

async function instanceLogFile(core: LauncherCore, folderName: string): Promise<string> {
  const found = await core.instanceManager.findByFolder(folderName)
  if (found) return join(found.directory, 'logs', 'latest.log')
  return join(core.paths.gameRoot, 'profiles', basename(folderName), 'logs', 'latest.log')
}

export function registerIpc(ipcMain: IpcMainLike, core: LauncherCore): void {
  const ipc = createIpcRegistrar(ipcMain)
  const legacyJavaRecords = javaRecordsReader(core)
  ipc.handle('bamboo:core:status', eventless(() => core.status()))

  ipc.handle(
    'find-java',
    eventless(async () => (await legacyJavaRecords(false))[0]?.path ?? null),
  )
  ipc.handle(
    'get-java-versions',
    eventless(async (forceRescan: unknown) =>
      toLegacyJavaVersions(await legacyJavaRecords(forceRescan === true)),
    ),
  )
  ipc.handle(
    'get-recommended-java-for-mc',
    eventless(async (mcVersion: unknown) => {
      if (typeof mcVersion !== 'string' || mcVersion.trim().length === 0) {
        throw new Error('Invalid Minecraft version')
      }
      const records = await legacyJavaRecords(false)
      const selection = await core.java.select({ minecraftVersion: mcVersion.trim() })
      return {
        recommended: selection.preference.majorVersion,
        selected: selection.java ? toLegacyJavaVersion(selection.java) : null,
        available: records.map(toLegacyJavaVersion),
      }
    }),
  )
  ipc.handle(
    'find-best-java-for-mc',
    eventless(async (mcVersion: unknown) => {
      if (typeof mcVersion !== 'string' || mcVersion.trim().length === 0) {
        throw new Error('Invalid Minecraft version')
      }
      await legacyJavaRecords(false)
      const selection = await core.java.select({ minecraftVersion: mcVersion.trim() })
      return selection.java ? toLegacyJavaVersion(selection.java) : null
    }),
  )

  ipc.handle(
    'read-latest-log',
    eventless(async (folderName: unknown) => {
      if (typeof folderName !== 'string' || folderName.trim().length === 0) {
        throw new Error('Invalid profile folder')
      }
      const tail = await readLogTail(await instanceLogFile(core, folderName.trim()))
      return tail.lines.length > 0 ? tail.lines.join('\n') : 'Keine latest.log gefunden.'
    }),
  )

  const hostedServers = new Map<string, { port: number; address: string; discoveredAt: number }>()
  ipc.handle(
    'detect-lan-server',
    eventless(async (folderName: unknown) => {
      if (typeof folderName !== 'string' || folderName.trim().length === 0) return null
      const folder = folderName.trim()
      const port = await readLanPort(await instanceLogFile(core, folder))
      if (port === undefined) return null
      const info = { port, address: `0.0.0.0:${port}`, discoveredAt: Date.now() }
      hostedServers.set(folder, info)
      return { port: info.port, address: info.address }
    }),
  )
  ipc.handle('get-hosted-servers', eventless(() => Object.fromEntries(hostedServers)))

  ipc.handle(
    'bamboo:logs:analyze',
    eventless(async (instanceId: unknown, launchId?: unknown) => {
      if (typeof instanceId !== 'string' || instanceId.trim().length === 0) {
        throw new Error('Invalid instance id')
      }
      return core.analyze(
        instanceId.trim(),
        typeof launchId === 'string' && launchId.length > 0 ? launchId : undefined,
      )
    }),
  )
  ipc.handle(
    'bamboo:logs:apply-fix',
    eventless(async (analysisId: unknown, actionId: unknown) => {
      if (typeof analysisId !== 'string' || typeof actionId !== 'string') {
        throw new Error('Invalid fix ids')
      }
      return core.applyFix(analysisId, actionId)
    }),
  )
  ipc.handle(
    'bamboo:logs:undo',
    eventless(async (undoToken: unknown) => {
      if (typeof undoToken !== 'string') throw new Error('Invalid undo token')
      return core.undoFix(undoToken)
    }),
  )

  ipc.handle(
    'bamboo:core:set-game-root',
    eventless(async (nextRoot: unknown) => {
      if (typeof nextRoot !== 'string' || nextRoot.trim().length === 0) throw new Error('Invalid game root')
      return core.changeGameRoot(nextRoot.trim())
    }),
  )

  ipc.handle('bamboo:settings:get', eventless(() => core.getSettingsForRenderer()))
  ipc.handle('bamboo:settings:save', eventless((patch: unknown) => core.saveSettingsFromRenderer(patch)))
  ipc.handle('bamboo:telemetry:get', eventless(() => core.telemetry.snapshot()))
  ipc.handle(
    'bamboo:support:bundle',
    eventless(async (destination: unknown) => {
      if (typeof destination !== 'string' || destination.trim().length === 0) {
        throw new Error('Invalid support bundle destination')
      }
      return core.createSupportBundle(destination.trim())
    }),
  )

  ipc.handle('bamboo:auth:status', eventless(() => core.auth.status()))
  ipc.handle('bamboo:auth:login', eventless(() => core.auth.login()))
  ipc.handle('bamboo:auth:cancel', eventless(() => core.auth.cancel()))
  ipc.handle(
    'bamboo:auth:refresh',
    eventless(async (id: unknown) =>
      core.auth.refresh(typeof id === 'string' && id.length > 0 ? id : undefined),
    ),
  )
  ipc.handle(
    'bamboo:auth:sign-out',
    eventless(async (id: unknown) =>
      core.auth.signOut(typeof id === 'string' && id.length > 0 ? id : undefined),
    ),
  )

  ipc.handle('bamboo:accounts:list', eventless(() => core.accounts.list()))
  ipc.handle(
    'bamboo:accounts:set-active',
    eventless(async (id: unknown) => {
      if (typeof id !== 'string') throw new Error('Invalid account id')
      await core.accounts.setActive(id)
      return core.accounts.list()
    }),
  )
  ipc.handle(
    'bamboo:accounts:remove',
    eventless(async (id: unknown) => {
      if (typeof id !== 'string') throw new Error('Invalid account id')
      await core.accounts.remove(id)
      return core.accounts.list()
    }),
  )

  ipc.handle('bamboo:instances:list', eventless(() => core.instances.list()))
  ipc.handle(
    'bamboo:instances:update-launch',
    eventless(async (folderName: unknown, rawPatch: unknown) => {
      if (typeof folderName !== 'string' || folderName.trim().length === 0) {
        throw new Error('Invalid instance folder')
      }
      const found = await core.instanceManager.findByFolder(folderName.trim())
      if (!found) throw new Error('Unknown instance')
      const parsed = InstanceLaunchPatchSchema.parse(rawPatch)
      const { resolution, ...rest } = parsed
      const patch: Partial<InstanceFile> = {
        ...rest,
        ...(resolution === null ? { resolution: undefined } : resolution ? { resolution } : {}),
      }
      return core.instanceManager.updateFile(found.instance.id, patch)
    }),
  )
  ipc.handle(
    'bamboo:instances:select',
    eventless(async (id: unknown) => {
      if (typeof id !== 'string') throw new Error('Invalid instance id')
      await core.instances.select(id)
      return core.instances.list()
    }),
  )
  ipc.handle(
    'bamboo:instances:upsert',
    eventless(async (payload: unknown) => {
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new Error('Invalid instance payload')
      }
      return core.instances.upsert(payload as Record<string, unknown>)
    }),
  )
  ipc.handle(
    'bamboo:instances:remove',
    eventless(async (id: unknown) => {
      if (typeof id !== 'string') throw new Error('Invalid instance id')
      await core.instances.remove(id)
      return core.instances.list()
    }),
  )
}
