import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { commitRemovedFile } from '../content-state'
import { ModError } from '../errors'
import { removeInstalledContent } from '../installer'
import { legacyGameRoot } from '../../paths'
import {
  asRecord,
  downloadFolder,
  instanceIndex,
  legacyInstanceDir,
  type LegacyBridgeOptions,
  type LegacyPayload,
} from './shared'

async function pruneState(
  instanceDir: string,
  relativePath: string,
  index: ReturnType<typeof instanceIndex>,
  options: LegacyBridgeOptions,
): Promise<void> {
  await commitRemovedFile({
    instanceDir,
    path: relativePath,
    index,
    logger: options.logger,
  }).catch((error: Error) =>
    options.logger?.warn('Could not prune state for a missing file', {
      path: relativePath,
      error: error.message,
    }),
  )
}

export async function removeLegacyContent(
  payload: LegacyPayload | undefined,
  options: LegacyBridgeOptions = {},
): Promise<boolean> {
  const data = asRecord(payload)
  const rootPath = options.rootPath ?? legacyGameRoot()
  const folderName = typeof data.folderName === 'string' ? data.folderName : ''
  const fileName = typeof data.fileName === 'string' ? data.fileName : ''
  if (!folderName || !fileName) return false
  const instanceDir = legacyInstanceDir(rootPath, folderName)
  const relativePath = `${downloadFolder(data.type)}/${fileName.replace(/\\/g, '/')}`
  const index = instanceIndex(instanceDir, options.logger)
  try {
    await removeInstalledContent({
      instanceDir,
      path: relativePath,
      index,
      logger: options.logger,
    })
    return true
  } catch (error) {
    if (error instanceof ModError && error.code === 'unsafe-path') {
      options.logger?.warn('Content removal rejected: unsafe path', { path: relativePath })
      return false
    }
    if (error instanceof ModError && error.code === 'not-a-modpack') {
      await pruneState(instanceDir, relativePath, index, options)
      return true
    }
    options.logger?.error('Content removal failed', {
      path: relativePath,
      error: (error as Error).message,
    })
    const stillThere = await stat(join(instanceDir, ...relativePath.split('/'))).catch(
      () => undefined,
    )
    if (!stillThere) await pruneState(instanceDir, relativePath, index, options)
    return false
  }
}
