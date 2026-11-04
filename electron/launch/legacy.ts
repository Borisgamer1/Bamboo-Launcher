import type { InstanceFile, InstanceLoader, LaunchInstanceRequest } from '../schemas'
import { normalizeJavaPath, slugify } from '../instance-store'
import type { LaunchEvent, LaunchHandle, LaunchInstanceHooks } from './types'

export interface LegacyLaunchRequest {
  folderName: string
  directory: string
  name: string
  /** Minecraft version, e.g. 1.20.1. */
  minecraftVersion: string
  /** Installed loader profile to start, e.g. fabric-loader-0.15.11-1.20.1. */
  versionId: string
  loader: InstanceLoader
  loaderVersion: string
  javaPath?: string
  server?: { host: string; port?: number }
}

export interface LegacyLaunchCore {
  instanceManager: {
    findByFolder(folderName: string): Promise<{ instance: { id: string } } | undefined>
    readFile(instanceId: string): Promise<InstanceFile>
    updateFile(instanceId: string, patch: Partial<InstanceFile>): Promise<InstanceFile>
  }
  instances: {
    upsert(input: Record<string, unknown>): Promise<{ id: string }>
  }
  launchInstance(
    request: LaunchInstanceRequest,
    onEvent?: (event: LaunchEvent) => void,
    hooks?: LaunchInstanceHooks,
  ): Promise<LaunchHandle & { launchId?: string }>
}

export async function launchLegacyInstance(
  core: LegacyLaunchCore,
  request: LegacyLaunchRequest,
  onEvent?: (event: LaunchEvent) => void,
  hooks?: LaunchInstanceHooks,
): Promise<LaunchHandle & { launchId?: string }> {
  const minecraftVersion = String(request.minecraftVersion ?? '').trim()
  if (!minecraftVersion) {
    throw new Error('launchLegacyInstance requires the Minecraft version')
  }
  const found = await core.instanceManager.findByFolder(request.folderName)
  let instanceId: string

  if (found) {
    instanceId = found.instance.id
  } else {
    const record = await core.instances.upsert({
      id: `legacy-${slugify(request.folderName) || 'profile'}`,
      name: request.name,
      folderName: request.folderName,
      path: request.directory,
      managed: false,
      legacy: true,
      version: minecraftVersion,
      versionId: request.versionId,
      loader: request.loader,
      loaderVersion: request.loaderVersion,
      javaPath: normalizeJavaPath(request.javaPath),
    })
    instanceId = record.id
  }

  // A copied legacy profile can carry the source instance's `instance.json`,
  // which still names the old version and profile id. The launch request is the
  // authority, so repair the on-disk file on every start - not only when a store
  // record already existed (a copied folder had none until the first launch).
  const file = await core.instanceManager.readFile(instanceId)
  const javaPath = request.javaPath === undefined
    ? undefined
    : normalizeJavaPath(request.javaPath)
  const patch: Partial<InstanceFile> = {}
  if (
    (file.versionId || file.version) !== request.versionId ||
    file.version !== minecraftVersion ||
    file.loader !== request.loader ||
    file.loaderVersion !== request.loaderVersion
  ) {
    patch.version = minecraftVersion
    patch.versionId = request.versionId
    patch.loader = request.loader
    patch.loaderVersion = request.loaderVersion
  }
  // Migration used to copy the UI's "Automatisch" label into javaPath, where
  // the launch core treats it as an executable. The launch request owns this
  // choice, so an automatic start repairs an already-migrated instance.
  if (javaPath !== undefined && String(file.javaPath ?? '') !== javaPath) {
    patch.javaPath = javaPath
    patch.javaMode = javaPath ? 'pinned' : 'auto'
  }
  if (Object.keys(patch).length > 0) {
    await core.instanceManager.updateFile(instanceId, patch)
  }

  return core.launchInstance(
    {
      instanceId,
      ...(request.server ? { server: request.server } : {}),
    },
    onEvent,
    hooks,
  )
}
