import { resolveVersionModel } from '../version/resolve'
import { buildLaunchCommand, redactCommand } from './args'
import { linkLegacyAssets } from './assets'
import { prepareNatives } from './natives'
import { precheckLaunch } from './precheck'
import type { LaunchPlan, LaunchPreparation, NativesResult } from './types'

function plannedNatives(preparation: LaunchPreparation): NativesResult {
  const model = preparation.model
  return {
    directory: preparation.nativesDirectory ?? model?.nativeDirectory ?? '',
    extracted: 0,
    skipped: 0,
    files: model ? model.natives.length : 0,
    cacheHit: false,
    lockWaitMs: 0,
  }
}

export async function prepareLaunch(preparation: LaunchPreparation): Promise<LaunchPlan> {
  if (!preparation.jvm) {
    throw new Error('prepareLaunch requires the JVM plan resolved by LaunchService.prepare')
  }
  const model =
    preparation.model ??
    (await resolveVersionModel(preparation.gameRoot, preparation.versionId, {
      logger: preparation.logger,
    }))

  const natives =
    preparation.extractNatives === false
      ? plannedNatives({ ...preparation, model })
      : await prepareNatives(model, {
          directory: preparation.nativesDirectory,
          logger: preparation.logger,
        })

  const legacyAssets = await linkLegacyAssets(model, {
    dryRun: preparation.linkLegacyAssets === false,
  })

  const precheck = await precheckLaunch(model)
  const jvm = preparation.jvm
  const built = buildLaunchCommand({ ...preparation, model, jvm })
  const warnings: string[] = []
  if (!precheck.clientJar) warnings.push(`Client-JAR fehlt: ${model.clientJar}`)
  if (precheck.librariesMissing.length > 0) {
    warnings.push(`${precheck.librariesMissing.length} Bibliothek(en) fehlen`)
  }
  if (precheck.nativesMissing.length > 0) {
    warnings.push(`${precheck.nativesMissing.length} Native-Archiv(e) fehlen`)
  }
  if (!precheck.assetIndex) warnings.push(`Asset-Index fehlt: ${model.assets.objectsFile}`)
  if (model.assets.legacyVirtual && preparation.linkLegacyAssets === false) {
    warnings.push('Legacy-Asset-Baum wurde im Dry-Run nicht verlinkt')
  }

  return {
    versionId: model.id,
    model,
    javaPath: preparation.javaPath,
    ...(preparation.javaMajorVersion !== undefined
      ? { javaMajorVersion: preparation.javaMajorVersion }
      : {}),
    gameDirectory: preparation.gameDirectory,
    command: built.command,
    displayCommand: redactCommand(built.command),
    natives,
    legacyAssets,
    precheck,
    warnings,
    jvm,
  }
}
