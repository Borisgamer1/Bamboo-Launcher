#!/usr/bin/env node
/**
 * Phase 5 dry run: resolves the real installed versions, selects/ensures the
 * Java runtime and prints the complete, quoted start command.
 *
 * Read-only towards the game root: natives are NOT unpacked, legacy assets are
 * NOT linked and the game is NEVER started. The Java store lives in %TEMP%.
 *
 * Usage: node scripts/launch-dryrun.cjs [gameRoot] [versionId...]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createNullLogger } = require('../dist-electron/logger.js')
const { JavaManager } = require('../dist-electron/java/manager.js')
const { LaunchTracker } = require('../dist-electron/launch-tracker.js')
const { LaunchService } = require('../dist-electron/launch/service.js')
const { formatCommandLine } = require('../dist-electron/launch/args.js')
const { resolveJavaExecutable } = require('../dist-electron/launch/process.js')

const gameRoot =
  process.argv[2] || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft')

const DEFAULT_VERSIONS = ['1.8.9', '1.20.1', '1.20.1-forge-47.3.22', 'fabric-loader-0.18.4-1.21.11']

function loaderOf(versionId) {
  const id = versionId.toLowerCase()
  if (id.includes('neoforge')) return 'neoforge'
  if (id.includes('forge')) return 'forge'
  if (id.includes('fabric')) return 'fabric'
  return 'vanilla'
}

async function main() {
  if (!fs.existsSync(path.join(gameRoot, 'versions'))) {
    console.error(`No versions folder in: ${gameRoot}`)
    process.exitCode = 1
    return
  }
  const requested = process.argv.slice(3)
  const versions = requested.length > 0 ? requested : DEFAULT_VERSIONS

  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-p5-launch-'))
  const logger = createNullLogger()
  const java = new JavaManager({
    file: path.join(storeRoot, 'java.json'),
    gameRoot,
    logger,
    platform: process.platform,
    arch: process.arch,
  })
  const scan = await java.scan({ includeRegistry: false })
  console.log(`Game root (read-only): ${gameRoot}`)
  console.log(`JVMs discovered      : ${scan.records.length} (store: ${storeRoot})`)
  console.log('Natives/Assets werden im Dry-Run nicht geschrieben; das Spiel wird nicht gestartet.\n')

  const service = new LaunchService({
    gameRoot: () => gameRoot,
    cacheDir: path.join(storeRoot, 'cache'),
    java,
    launches: new LaunchTracker(logger),
    logger,
  })

  try {
    for (const versionId of versions) {
      const jsonFile = path.join(gameRoot, 'versions', versionId, `${versionId}.json`)
      if (!fs.existsSync(jsonFile)) {
        console.log(`=== ${versionId} ===\n  nicht installiert (${jsonFile})\n`)
        continue
      }
      console.log(`=== ${versionId} ===`)
      try {
        const prepared = await service.prepare({
          versionId,
          gameDirectory: path.join(gameRoot, 'profiles', `dryrun-${versionId.replace(/[^a-zA-Z0-9._-]/g, '_')}`),
          loader: loaderOf(versionId),
          loaderVersion: versionId,
          account: {
            name: 'Steve',
            uuid: '11112222333344445555666677778888',
            accessToken: '0',
            type: 'offline',
          },
          javaPath: undefined,
          dryRun: true,
          extractNatives: false,
          linkLegacyAssets: false,
        })
        const { plan, java: choice } = prepared
        console.log(`  Kette        : ${plan.model.chain.join(' -> ')}`)
        console.log(`  MainClass    : ${plan.model.mainClass}`)
        console.log(
          `  Java         : ${choice.path || '(java.ensure würde herunterladen)'}${
            choice.majorVersion ? ` [Java ${choice.majorVersion}]` : ''
          }`,
        )
        console.log(`  Java-Quelle  : ${choice.source} (Anforderung ${choice.requirement})`)
        const spawnCommand = [...plan.displayCommand]
        spawnCommand[0] = resolveJavaExecutable(plan.command[0], process.platform)
        console.log(`  Spawn        : ${spawnCommand[0]}`)
        console.log(
          `  Natives      : ${plan.natives.files} Archiv(e) → ${plan.natives.directory} (nicht entpackt)`,
        )
        if (plan.model.assets.legacyVirtual) {
          console.log(
            `  Legacy-Assets: ${plan.legacyAssets.candidates} Verknüpfungen → ${plan.legacyAssets.directory} ` +
              `(nicht angelegt, ${plan.legacyAssets.missing} Objekte fehlen)`,
          )
        }
        console.log(
          `  Precheck     : Client-JAR=${plan.precheck.clientJar} Bibliotheken=${plan.precheck.libraries} ` +
            `fehlend=${plan.precheck.librariesMissing.length} Asset-Index=${plan.precheck.assetIndex}`,
        )
        if (plan.warnings.length > 0) {
          for (const warning of plan.warnings) console.log(`  Warnung      : ${warning}`)
        }
        console.log('  Startbefehl  :')
        console.log(`    ${formatCommandLine(spawnCommand)}`)
      } catch (error) {
        console.log(`  FEHLER (${error.code ?? 'unknown'}): ${error.message}`)
      }
      console.log('')
    }
    console.log('Dry-Run beendet. Es wurde kein Prozess gestartet und nichts im Game-Root geschrieben.')
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
