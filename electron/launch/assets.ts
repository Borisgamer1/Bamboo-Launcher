import { copyFile, link, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveInside } from '../download/paths'
import { describeError, getDefaultLogger } from '../logger'
import type { ResolvedVersionModel } from '../version/resolve'
import { LaunchError } from './errors'
import type { LegacyAssetsResult } from './types'

export interface LegacyAssetOptions {
  dryRun?: boolean
}

export async function linkLegacyAssets(
  model: ResolvedVersionModel,
  options: LegacyAssetOptions = {},
): Promise<LegacyAssetsResult> {
  const assets = model.assets
  if (!assets.legacyVirtual || !assets.virtualDir) {
    return { candidates: 0, linked: 0, skipped: 0, missing: 0 }
  }
  const candidates = assets.objects.filter((object) => Boolean(object.virtualPath))
  const base = dirname(dirname(model.assets.objectsFile))
  if (options.dryRun) {
    let missing = 0
    for (const object of candidates) {
      try {
        await stat(object.absolutePath)
      } catch (error) {
        // A dry run reports missing objects instead of failing.
        getDefaultLogger().child('launch:assets').debug('legacy asset object missing', {
          asset: object.name,
          error: describeError(error),
        })
        missing += 1
      }
    }
    return { directory: assets.virtualDir, candidates: candidates.length, linked: 0, skipped: 0, missing }
  }

  let linked = 0
  let skipped = 0
  let missing = 0
  for (const object of candidates) {
    const virtualPath = object.virtualPath
    if (!virtualPath) continue
    try {
      await stat(object.absolutePath)
    } catch (error) {
      // The launch fails later with the precheck result; count it here.
      getDefaultLogger().child('launch:assets').debug('legacy asset source missing', {
        asset: object.name,
        error: describeError(error),
      })
      missing += 1
      continue
    }
    const target = resolveInside(base, virtualPath)
    try {
      await stat(target)
      skipped += 1
      continue
    } catch (error) {
      // Target missing: link it below.
      getDefaultLogger().child('launch:assets').debug('legacy asset link target absent; creating it', {
        target,
        error: describeError(error),
      })
    }
    try {
      await mkdir(dirname(target), { recursive: true })
      try {
        await link(object.absolutePath, target)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EXDEV' || code === 'EPERM' || code === 'EACCES') {
          await copyFile(object.absolutePath, target)
        } else {
          throw error
        }
      }
      linked += 1
    } catch (error) {
      throw new LaunchError('assets', `Legacy-Asset konnte nicht verlinkt werden: ${object.name}`, [
        (error as Error).message,
      ])
    }
  }
  return { directory: assets.virtualDir, candidates: candidates.length, linked, skipped, missing }
}
