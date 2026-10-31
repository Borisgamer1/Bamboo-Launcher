import { stat } from 'node:fs/promises'
import type { ResolvedVersionModel } from '../version/resolve'
import type { PrecheckResult } from './types'

const MAX_REPORTED = 10

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile()
  } catch {
    return false
  }
}

export async function precheckLaunch(model: ResolvedVersionModel): Promise<PrecheckResult> {
  const clientJar = await isFile(model.clientJar)

  let libraries = 0
  const librariesMissing: string[] = []
  for (const library of model.libraries) {
    if (library.isNative) continue
    if (await isFile(library.absolutePath)) libraries += 1
    else if (librariesMissing.length < MAX_REPORTED) librariesMissing.push(library.absolutePath)
  }

  let natives = 0
  const nativesMissing: string[] = []
  for (const native of model.natives) {
    if (await isFile(native.absolutePath)) natives += 1
    else if (nativesMissing.length < MAX_REPORTED) nativesMissing.push(native.absolutePath)
  }

  const assetIndex = model.assets.available && (await isFile(model.assets.objectsFile))
  const legacyAssetsReady = !model.assets.legacyVirtual || (await isFile(model.assets.objectsFile))
  const ok =
    clientJar &&
    assetIndex &&
    librariesMissing.length === 0 &&
    nativesMissing.length === 0 &&
    legacyAssetsReady

  return { ok, clientJar, libraries, librariesMissing, natives, nativesMissing, assetIndex, legacyAssetsReady }
}
