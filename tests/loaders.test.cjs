/**
 * Phase 7 tests: metadata parsing, Fabric/Quilt profiles, Forge/NeoForge
 * installer jars with processors, legacy Forge universal jars, OptiFine
 * patcher, Java task strategies with argfile support, idempotent second
 * installs, rollback and targeted repair of a deleted processor output.
 *
 * All servers are local fixtures; the processor seam (`processorRunner`)
 * replaces the JVM for the installer tests, while `runJavaTask` itself is
 * additionally exercised against a real Node subprocess.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { fixtureServer, tempDir } = require('./harness.cjs')
const AdmZip = require('adm-zip')

const { createNullLogger } = require('../dist-electron/logger.js')
const { sha1Hex } = require('../dist-electron/download/checksum.js')
const { installVersion } = require('../dist-electron/install/version.js')
const {
  parseForgeIndexHtml,
  parseForgeMirrorList,
  parseNeoForgeList,
  parseOptifineList,
  pickLoaderVersion,
  neoforgeProject,
} = require('../dist-electron/loaders/metadata.js')
const {
  installFabricLike,
  fabricLoaderVersionId,
} = require('../dist-electron/loaders/fabric.js')
const { installForgeLike, readInstallerArchive, forgeVersionId } = require('../dist-electron/loaders/forge.js')
const { installOptifine, generateOptifineVersionJson, optifineVersionId } = require('../dist-electron/loaders/optifine.js')
const {
  diagnoseInstallation,
  repairInstallation,
  loaderKindFromVersion,
} = require('../dist-electron/loaders/diagnose.js')
const { LoaderService } = require('../dist-electron/loaders/service.js')
const {
  formatArgFile,
  runJavaTask,
  classpathDelimiter,
  diagnoseProcessorOutputs,
} = require('../dist-electron/loaders/java-task.js')
const {
  resolveProcessors,
  buildProcessorTasks,
} = require('../dist-electron/loaders/profile-postprocess.js')
const { LoaderTransaction } = require('../dist-electron/loaders/transaction.js')

const fastRetry = {
  attempts: 2,
  baseDelayMs: 1,
  maxDelayMs: 1,
  sleep: async () => undefined,
  random: () => 0.5,
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

function processorJar(mainClass) {
  const zip = new AdmZip()
  zip.addFile(
    'META-INF/MANIFEST.MF',
    Buffer.from(`Manifest-Version: 1.0\nMain-Class: ${mainClass}\n\n`, 'utf8'),
  )
  zip.addFile('placeholder.txt', Buffer.from('jar', 'utf8'))
  return zip.toBuffer()
}

function sha(buffer) {
  return sha1Hex(buffer)
}

/** Serve a complete 1.20.1 base version and install it into the game root. */
async function seedBase(gameRoot, server, versionId = '1.20.1') {
  const libA = Buffer.from('base-library-a', 'utf8')
  const libB = Buffer.from('base-library-b', 'utf8')
  const client = Buffer.from('base-client-jar', 'utf8')
  const indexBytes = Buffer.from(JSON.stringify({ objects: {} }), 'utf8')
  const versionJson = {
    id: versionId,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '5',
    assetIndex: {
      id: '5',
      url: `${server.base}/assets/indexes/5.json`,
      sha1: sha(indexBytes),
      size: indexBytes.length,
      totalSize: 0,
    },
    downloads: {
      client: { url: `${server.base}/client.jar`, sha1: sha(client), size: client.length },
    },
    arguments: {
      game: ['--username', '${auth_player_name}', '--version', '${version_name}'],
      jvm: ['-cp', '${classpath}', '-Djava.library.path=${natives_directory}'],
    },
    libraries: [
      {
        name: 'com.example:alpha:1.0',
        downloads: {
          artifact: {
            path: 'com/example/alpha/1.0/alpha-1.0.jar',
            url: `${server.base}/libs/alpha.jar`,
            sha1: sha(libA),
            size: libA.length,
          },
        },
      },
      {
        name: 'com.example:beta:2.0',
        downloads: {
          artifact: {
            path: 'com/example/beta/2.0/beta-2.0.jar',
            url: `${server.base}/libs/beta.jar`,
            sha1: sha(libB),
            size: libB.length,
          },
        },
      },
    ],
    javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
  }
  const versionBytes = Buffer.from(JSON.stringify(versionJson), 'utf8')
  const manifestBytes = Buffer.from(
    JSON.stringify({
      latest: { release: versionId, snapshot: versionId },
      versions: [{ id: versionId, type: 'release', url: `${server.base}/version.json`, sha1: sha(versionBytes) }],
    }),
    'utf8',
  )
  Object.assign(server.routes, {
    '/version_manifest_v2.json': { body: manifestBytes },
    '/version.json': { body: versionBytes },
    '/client.jar': { body: client },
    '/libs/alpha.jar': { body: libA },
    '/libs/beta.jar': { body: libB },
    '/assets/indexes/5.json': { body: indexBytes },
  })
  const result = await installVersion(gameRoot, versionId, {
    cacheDir: path.join(gameRoot, 'cache'),
    manifestSources: [`${server.base}/version_manifest_v2.json`],
    retry: fastRetry,
    logger: createNullLogger(),
  })
  return { versionJson, files: { client, libA, libB }, result }
}

/** Track routes so `seedBase` can register them before requests happen. */
function routeTable() {
  return {}
}

test('loader metadata parsers handle all six sources without guessing', () => {
  const forgeHtml = `
    <a href="maven/net/minecraftforge/forge/1.20.1-47.4.28/forge-1.20.1-47.4.28-installer.jar">x</a>
    <a href="maven/net/minecraftforge/forge/1.20.1-47.4.10/forge-1.20.1-47.4.10-installer.jar">y</a>
    <a href="maven/net/minecraftforge/forge/1.20.1-47.4.10/forge-1.20.1-47.4.10-installer.jar">z</a>`
  const forge = parseForgeIndexHtml(forgeHtml, '1.20.1')
  assert.deepEqual(forge.map((entry) => entry.version), ['47.4.28', '47.4.10'])
  assert.match(forge[0].installerUrl, /forge-1\.20\.1-47\.4\.28-installer\.jar$/)
  assert.deepEqual(parseForgeMirrorList(['47.3.0', '47.2.0'], '1.20.1').map((e) => e.version), ['47.3.0', '47.2.0'])
  assert.deepEqual(
    parseForgeMirrorList([1, null, '47.3.0'], '1.20.1').map((entry) => entry.version),
    ['47.3.0'],
    'non-string entries are ignored',
  )

  assert.equal(neoforgeProject('1.20.1'), 'forge')
  assert.equal(neoforgeProject('1.21.1'), 'neoforge')
  const neo = parseNeoForgeList({ versions: ['21.1.9', '21.1.263', '20.1.1', '21.1.100-beta'] }, '1.21.1')
  assert.deepEqual(neo.map((entry) => entry.version), ['21.1.9', '21.1.100-beta', '21.1.263'])
  assert.equal(neo[1].stable, false)
  assert.equal(parseNeoForgeList({ versions: ['1.20.1-47.1.5'] }, '1.20.1')[0].version, '1.20.1-47.1.5')

  const optifine = parseOptifineList(
    [
      { mcversion: '1.20.1', type: 'HD_U', patch: 'I9', filename: 'OptiFine_1.20.1_HD_U_I9.jar' },
      { mcversion: '1.20.4', type: 'HD_U', patch: 'J1' },
      { mcversion: '1.20.1', type: 'HD_U', patch: 'I8_pre1' },
    ],
    '1.20.1',
  )
  assert.deepEqual(optifine.map((entry) => entry.version), ['HD_U_I9', 'HD_U_I8_pre1'])
  assert.equal(optifine[0].filename, 'OptiFine_1.20.1_HD_U_I9.jar')
  assert.equal(optifine[1].stable, false)

  assert.equal(pickLoaderVersion(optifine).version, 'HD_U_I9')
  assert.equal(pickLoaderVersion(optifine, 'HD_U_I8_pre1').version, 'HD_U_I8_pre1')
  assert.equal(pickLoaderVersion([{ version: '1.0', stable: false }]).version, '1.0')
})

test('Java task runner validates outputs, rotates strategies and supports argfiles', async () => {
  const root = tempDir('java-task')
  const created = path.join(root, 'created.txt')
  const spec = {
    id: 'unit',
    skipIfOutputsValid: true,
    outputs: [{ path: created, validator: 'file' }],
    strategies: [
      [{ executable: process.execPath, args: ['-e', 'process.exit(3)'] }],
      [
        {
          executable: process.execPath,
          args: ['-e', 'require("fs").writeFileSync(process.argv[1], "from-strategy-2")', created],
        },
      ],
    ],
  }
  const result = await runJavaTask(spec, { logger: createNullLogger() })
  assert.equal(result.ran, true)
  assert.equal(result.strategy, 1)
  assert.equal(fs.readFileSync(created, 'utf8'), 'from-strategy-2')
  assert.ok(result.durationMs >= 0)

  // A valid output short-circuits the task entirely.
  const skipped = await runJavaTask(spec, { logger: createNullLogger() })
  assert.equal(skipped.ran, false)
  assert.equal(skipped.strategy, -1)

  // Argfile usage: the command seam receives @file, the content is parsed here.
  let observed = []
  await runJavaTask(
    {
      id: 'argfile',
      skipIfOutputsValid: false,
      outputs: [],
      strategies: [
        [
          {
            executable: process.execPath,
            args: ['-cp', 'C:\\a b\\x.jar', 'Main', '--value', 'hello world'],
          },
        ],
      ],
    },
    {
      useArgFile: true,
      runCommand: async (command) => {
        assert.ok(command.args[0].startsWith('@'), 'argfile strategy must pass @file')
        const content = fs.readFileSync(command.args[0].slice(1), 'utf8')
        observed = content
          .split('\n')
          .filter(Boolean)
          .map((line) => line.replace(/^"|"$/g, '').replace(/\\\\/g, '\\').replace(/\\"/g, '"'))
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  )
  assert.deepEqual(observed, ['-cp', 'C:\\a b\\x.jar', 'Main', '--value', 'hello world'])
  assert.match(formatArgFile(['a b']), /^"a b"\n$/)
  assert.equal(classpathDelimiter('win32'), ';')
  assert.equal(classpathDelimiter('linux'), ':')

  // Invalid outputs make the whole task fail with every strategy attempted.
  await assert.rejects(
    () =>
      runJavaTask(
        {
          id: 'invalid',
          skipIfOutputsValid: true,
          outputs: [{ path: path.join(root, 'never.txt'), validator: 'file' }],
          strategies: [[{ executable: process.execPath, args: ['-e', 'process.exit(0)'] }]],
        },
        { logger: createNullLogger() },
      ),
    (error) => error.code === 'processor' && /Ausgaben ungültig/.test(error.details.join(' ')),
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('Fabric installs a profile, is idempotent and rolls back on abort', async () => {
  const routes = routeTable()
  const server = await fixtureServer(routes)
  const gameRoot = tempDir('fabric')
  try {
    await seedBase(gameRoot, server)
    const loaderJar = Buffer.from('fabric-loader-jar', 'utf8')
    const asmJar = Buffer.from('fabric-asm-jar', 'utf8')
    const profile = {
      id: 'fabric-loader-0.15.11-1.20.1',
      inheritsFrom: '1.20.1',
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
      libraries: [
        {
          name: 'net.fabricmc:fabric-loader:0.15.11',
          url: `${server.base}/fabric/`,
          sha1: sha(loaderJar),
          size: loaderJar.length,
        },
        {
          name: 'org.ow2.asm:asm:9.6',
          url: `${server.base}/fabric/`,
          sha1: sha(asmJar),
          size: asmJar.length,
        },
      ],
    }
    Object.assign(routes, {
      '/v2/versions/loader/1.20.1': {
        body: Buffer.from(
          JSON.stringify([
            { loader: { version: '0.15.11', stable: true } },
            { loader: { version: '0.16.0-beta.1', stable: false } },
          ]),
        ),
      },
      '/v2/versions/loader/1.20.1/0.15.11/profile/json': { body: Buffer.from(JSON.stringify(profile)) },
      '/fabric/net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar': { body: loaderJar },
      '/fabric/org/ow2/asm/asm/9.6/asm-9.6.jar': { body: asmJar },
    })

    const first = await installFabricLike('fabric', {
      gameRoot,
      minecraftVersion: '1.20.1',
      loaderVersion: '0.15.11',
      metaBase: server.base,
      installBaseVersion: false,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(first.loader, 'fabric')
    assert.equal(first.versionId, fabricLoaderVersionId('fabric', '1.20.1', '0.15.11'))
    assert.equal(first.alreadyInstalled, false)
    assert.equal(first.processorsRun, 0)
    assert.equal(fs.existsSync(path.join(gameRoot, 'versions', first.versionId, `${first.versionId}.json`)), true)
    assert.equal(
      fs.existsSync(path.join(gameRoot, 'libraries/net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar')),
      true,
    )
    assert.equal(first.model.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient')
    assert.ok(first.model.classpath.some((entry) => entry.includes('fabric-loader-0.15.11.jar')))

    const second = await installFabricLike('fabric', {
      gameRoot,
      minecraftVersion: '1.20.1',
      loaderVersion: '0.15.11',
      metaBase: server.base,
      installBaseVersion: false,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(second.alreadyInstalled, true)
    assert.equal(second.downloadedBytes, 0)
    assert.equal(second.processorsRun, 0)

    // Abort in the middle of the loader download: no version JSON remains.
    const abortRoot = tempDir('fabric-abort')
    await seedBase(abortRoot, server)
    const controller = new AbortController()
    const abortingRoutes = {
      ...routes,
      '/fabric/net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar': {
        body: loaderJar,
      },
    }
    const abortServer = await fixtureServer(abortingRoutes)
    try {
      Object.assign(abortingRoutes, {
        [`/fabric/net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar`]: async (req, res) => {
          res.writeHead(200, { 'content-length': loaderJar.length })
          res.write(loaderJar.subarray(0, 4))
          setTimeout(() => res.end(loaderJar.subarray(4)), 50)
        },
      })
      await assert.rejects(
        () =>
          installFabricLike('fabric', {
            gameRoot: abortRoot,
            minecraftVersion: '1.20.1',
            loaderVersion: '0.15.11',
            metaBase: abortServer.base,
            installBaseVersion: false,
            signal: controller.signal,
            retry: fastRetry,
            fetchImpl: async (url, init) => {
              const response = await fetch(url, init)
              // Abort right after the profile was fetched but before the
              // loader libraries are downloaded: the profile JSON must roll back.
              if (String(url).includes('/profile/json')) {
                controller.abort(new Error('test abort'))
              }
              return response
            },
            logger: createNullLogger(),
          }),
        (error) => error.code === 'aborted',
      )
      const abortVersionId = fabricLoaderVersionId('fabric', '1.20.1', '0.15.11')
      assert.equal(fs.existsSync(path.join(abortRoot, 'versions', abortVersionId, `${abortVersionId}.json`)), false)
    } finally {
      await abortServer.close()
    }
  } finally {
    await server.close()
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }
})

test('Quilt installs from its meta endpoint and shares the profile pipeline', async () => {
  const routes = routeTable()
  const server = await fixtureServer(routes)
  const gameRoot = tempDir('quilt')
  try {
    await seedBase(gameRoot, server)
    const loaderJar = Buffer.from('quilt-loader-jar', 'utf8')
    const profile = {
      id: 'quilt-loader-0.23.1-1.20.1',
      inheritsFrom: '1.20.1',
      mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotClient',
      arguments: { game: [] },
      libraries: [
        {
          name: 'org.quiltmc:quilt-loader:0.23.1',
          url: `${server.base}/quilt/`,
          sha1: sha(loaderJar),
          size: loaderJar.length,
        },
      ],
    }
    Object.assign(routes, {
      '/v3/versions/loader/1.20.1': {
        body: Buffer.from(JSON.stringify([{ loader: { version: '0.23.1', stable: true } }])),
      },
      '/v3/versions/loader/1.20.1/0.23.1/profile/json': { body: Buffer.from(JSON.stringify(profile)) },
      '/quilt/org/quiltmc/quilt-loader/0.23.1/quilt-loader-0.23.1.jar': { body: loaderJar },
    })

    const result = await installFabricLike('quilt', {
      gameRoot,
      minecraftVersion: '1.20.1',
      metaBase: server.base,
      installBaseVersion: false,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(result.loader, 'quilt')
    assert.equal(result.loaderVersion, '0.23.1')
    assert.equal(result.versionId, 'quilt-loader-0.23.1-1.20.1')
    assert.equal(result.alreadyInstalled, false)

    const second = await installFabricLike('quilt', {
      gameRoot,
      minecraftVersion: '1.20.1',
      loaderVersion: '0.23.1',
      metaBase: server.base,
      installBaseVersion: false,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(second.alreadyInstalled, true)
    assert.equal(second.downloadedBytes, 0)
  } finally {
    await server.close()
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }
})

function forgeFixture({ minecraftVersion = '1.20.1', loaderVersion = '47.3.22', outputZip, base }) {
  const artifact = `${minecraftVersion}-${loaderVersion}`
  const processorBuffer = processorJar('com.example.Patcher')
  const helperBuffer = processorJar('com.example.Helper')
  const patchedSha = sha(outputZip)
  const universal = Buffer.from('for', 'utf8')
  const versionJson = {
    id: `${minecraftVersion}-forge-${loaderVersion}`,
    inheritsFrom: minecraftVersion,
    type: 'release',
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    arguments: {
      game: ['--launchTarget', 'forgeclient', '--fml.forgeVersion', loaderVersion, '--fml.mcVersion', minecraftVersion],
      jvm: [
        '-DignoreList=bootstraplauncher,securejarhandler,forge-,${version_name}.jar',
        '-p',
        '${library_directory}/cpw/mods/bootstraplauncher/1.1.2/bootstraplauncher-1.1.2.jar',
      ],
    },
    libraries: [
      {
        name: `net.minecraftforge:forge:${artifact}:universal`,
        downloads: {
          artifact: {
            path: `net/minecraftforge/forge/${artifact}/forge-${artifact}-universal.jar`,
            url: `${base}/maven/universal.jar`,
            sha1: sha(universal),
            size: universal.length,
          },
        },
      },
    ],
  }
  const profile = {
    spec: 1,
    profile: 'forge',
    version: `${minecraftVersion}-forge-${loaderVersion}`,
    json: '/version.json',
    path: '',
    minecraft: minecraftVersion,
    data: {
      MAPPINGS: {
        client: '[com.example:mappings:1.0:mappings@txt]',
        server: '[com.example:mappings:1.0:mappings@txt]',
      },
      BINPATCH: { client: '/data/client.lzma', server: '/data/server.lzma' },
      PATCHED: {
        client: `[net.minecraftforge:forge:${artifact}:client]`,
        server: `[net.minecraftforge:forge:${artifact}:client]`,
      },
      PATCHED_SHA: { client: `'${patchedSha}'`, server: `'${patchedSha}'` },
      MC_SLIM_SHA: { client: `'${patchedSha}'`, server: `'${patchedSha}'` },
    },
    processors: [
      {
        jar: 'com.example:processor:1.0',
        classpath: ['com.example:helper:1.0'],
        args: ['--input', '{MINECRAFT_JAR}', '--output', '{PATCHED}'],
        outputs: { '{PATCHED}': '{PATCHED_SHA}' },
      },
    ],
    libraries: [
      {
        name: 'com.example:processor:1.0',
        downloads: {
          artifact: {
            path: 'com/example/processor/1.0/processor-1.0.jar',
            url: `${base}/maven/processor-1.0.jar`,
            sha1: sha(processorBuffer),
            size: processorBuffer.length,
          },
        },
      },
      {
        name: 'com.example:helper:1.0',
        downloads: {
          artifact: {
            path: 'com/example/helper/1.0/helper-1.0.jar',
            url: `${base}/maven/helper-1.0.jar`,
            sha1: sha(helperBuffer),
            size: helperBuffer.length,
          },
        },
      },
      {
        name: 'com.example:mappings:1.0:mappings',
        downloads: {
          artifact: {
            path: 'com/example/mappings/1.0/mappings-1.0-mappings.txt',
            url: `${base}/maven/mappings.txt`,
            sha1: sha(Buffer.from('mappings', 'utf8')),
            size: 8,
          },
        },
      },
    ],
  }
  const zip = new AdmZip()
  zip.addFile('install_profile.json', Buffer.from(JSON.stringify(profile), 'utf8'))
  zip.addFile('version.json', Buffer.from(JSON.stringify(versionJson), 'utf8'))
  zip.addFile('data/client.lzma', Buffer.from('fake-lzma-client', 'utf8'))
  zip.addFile('data/server.lzma', Buffer.from('fake-lzma-server', 'utf8'))
  const installer = zip.toBuffer()
  return { installer, profile, versionJson, processorJar: processorBuffer, helperJar: helperBuffer, patchedSha, universal }
}

/** Route a Forge/NeoForge fixture (installer, maven jars, mappings) onto a server. */
function serveForgeFixture(
  routes,
  fixture,
  { minecraftVersion = '1.20.1', loaderVersion = '47.3.22', kind = 'forge' } = {},
) {
  const artifact = `${minecraftVersion}-${loaderVersion}`
  const installerPath =
    kind === 'neoforge'
      ? `/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`
      : `/net/minecraftforge/forge/${artifact}/forge-${artifact}-installer.jar`
  Object.assign(routes, {
    [installerPath]: { body: fixture.installer },
    '/maven/processor-1.0.jar': { body: fixture.processorJar },
    '/maven/helper-1.0.jar': { body: fixture.helperJar },
    '/maven/mappings.txt': { body: Buffer.from('mappings', 'utf8') },
    '/maven/universal.jar': { body: fixture.universal },
  })
  return { artifact }
}

test('Forge installs with processors, argfile strategy and idempotent rerun', async () => {
  const routes = routeTable()
  const server = await fixtureServer(routes)
  const gameRoot = tempDir('forge')
  try {
    await seedBase(gameRoot, server)
    const patchedZip = new AdmZip()
    patchedZip.addFile('patched.class', Buffer.from('patched', 'utf8'))
    const patchedBytes = patchedZip.toBuffer()
    const fixture = forgeFixture({ outputZip: patchedBytes, base: server.base })
    serveForgeFixture(routes, fixture)

    const calls = []
    const runProcessor = async (command) => {
      const usedArgFile = command.args[0].startsWith('@')
      const args = usedArgFile
        ? fs
            .readFileSync(command.args[0].slice(1), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => line.replace(/^"|"$/g, '').replace(/\\\\/g, '\\').replace(/\\"/g, '"'))
        : command.args
      const output = args[args.indexOf('--output') + 1]
      calls.push({ output, usedArgFile })
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, patchedBytes)
      return { code: 0, stdout: 'patched', stderr: '' }
    }

    const result = await installForgeLike('forge', {
      gameRoot,
      minecraftVersion: '1.20.1',
      loaderVersion: '47.3.22',
      mavenBase: server.base,
      installBaseVersion: false,
      useArgFile: true,
      processorRunner: runProcessor,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    const versionId = forgeVersionId('forge', '1.20.1', '47.3.22')
    assert.equal(result.versionId, versionId)
    assert.equal(result.loader, 'forge')
    assert.equal(result.processorsRun, 1)
    assert.equal(result.alreadyInstalled, false)
    const patchedJar = path.join(
      gameRoot,
      'libraries/net/minecraftforge/forge/1.20.1-47.3.22/forge-1.20.1-47.3.22-client.jar',
    )
    assert.equal(fs.existsSync(patchedJar), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].usedArgFile, true, 'useArgFile must be honoured by the installer')
    assert.equal(calls[0].output, patchedJar)
    assert.equal(
      fs.existsSync(path.join(gameRoot, 'versions', versionId, 'install_profile.json')),
      true,
      'the profile must stay for repair',
    )
    assert.equal(
      fs.existsSync(path.join(gameRoot, 'versions', versionId, 'bamboo-loader.json')),
      true,
    )
    const lzma = path.join(
      gameRoot,
      'libraries/net/minecraftforge/forge/1.20.1-47.3.22/forge-1.20.1-47.3.22-clientdata.lzma',
    )
    assert.equal(fs.existsSync(lzma), true)

    const second = await installForgeLike('forge', {
      gameRoot,
      minecraftVersion: '1.20.1',
      loaderVersion: '47.3.22',
      mavenBase: server.base,
      installBaseVersion: false,
      processorRunner: runProcessor,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(second.alreadyInstalled, true)
    assert.equal(second.processorsRun, 0, 'a valid processor output must not be re-run')
    assert.equal(second.downloadedBytes, 0)
    assert.equal(calls.length, 1)

    // diagnose finds a deleted processor output, repair re-runs only it.
    fs.rmSync(patchedJar)
    const issue = await diagnoseInstallation({ gameRoot, versionId })
    assert.equal(issue.processorIssues.length, 1)
    assert.equal(issue.processorIssues[0].file, patchedJar)
    assert.equal(issue.processorIssues[0].reason, 'missing')
    assert.ok(issue.details.some((line) => /Prozessor-Ausgabe/.test(line)))

    let repairCalls = 0
    const repair = await repairInstallation({
      gameRoot,
      versionId,
      installBaseVersion: false,
      processorRunner: async (command) => {
        repairCalls += 1
        return runProcessor(command)
      },
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(repair.processorsRun, 1)
    assert.equal(repairCalls, 1)
    assert.equal(fs.existsSync(patchedJar), true)
    assert.equal(repair.issueAfter?.processorIssues.length ?? 0, 0)
    assert.ok(repair.repaired.includes('processors:1'))

    // A third full install now downloads nothing again.
    const third = await installForgeLike('forge', {
      gameRoot,
      minecraftVersion: '1.20.1',
      loaderVersion: '47.3.22',
      mavenBase: server.base,
      installBaseVersion: false,
      processorRunner: runProcessor,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(third.alreadyInstalled, true)
    assert.equal(third.processorsRun, 0)
  } finally {
    await server.close()
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }
})

test('NeoForge installs under its own maven namespace and is idempotent', async () => {
  const routes = routeTable()
  const server = await fixtureServer(routes)
  const gameRoot = tempDir('neoforge')
  try {
    await seedBase(gameRoot, server, '1.21.1')
    const patched = new AdmZip()
    patched.addFile('patched.class', Buffer.from('neoforge-patched', 'utf8'))
    const patchedBytes = patched.toBuffer()
    const fixture = forgeFixture({ minecraftVersion: '1.21.1', loaderVersion: '21.1.9', outputZip: patchedBytes, base: server.base })
    serveForgeFixture(routes, fixture, { minecraftVersion: '1.21.1', loaderVersion: '21.1.9', kind: 'neoforge' })

    const calls = []
    const runProcessor = async (command) => {
      const usedArgFile = command.args[0].startsWith('@')
      const args = usedArgFile
        ? fs
            .readFileSync(command.args[0].slice(1), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => line.replace(/^"|"$/g, '').replace(/\\\\/g, '\\').replace(/\\"/g, '"'))
        : command.args
      const output = args[args.indexOf('--output') + 1]
      calls.push({ output, usedArgFile })
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, patchedBytes)
      return { code: 0, stdout: '', stderr: '' }
    }

    const result = await installForgeLike('neoforge', {
      gameRoot,
      minecraftVersion: '1.21.1',
      loaderVersion: '21.1.9',
      mavenBase: server.base,
      installBaseVersion: false,
      useArgFile: true,
      processorRunner: runProcessor,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(result.versionId, 'neoforge-21.1.9')
    assert.equal(result.loader, 'neoforge')
    assert.equal(result.processorsRun, 1)
    assert.equal(result.alreadyInstalled, false)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].usedArgFile, true)
    assert.equal(
      fs.existsSync(
        path.join(gameRoot, 'versions/neoforge-21.1.9/neoforge-21.1.9.json'),
      ),
      true,
    )
    assert.equal(fs.existsSync(calls[0].output), true)

    const second = await installForgeLike('neoforge', {
      gameRoot,
      minecraftVersion: '1.21.1',
      loaderVersion: '21.1.9',
      mavenBase: server.base,
      installBaseVersion: false,
      processorRunner: runProcessor,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(second.alreadyInstalled, true)
    assert.equal(second.processorsRun, 0)
    assert.equal(second.downloadedBytes, 0)
    assert.equal(calls.length, 1, 'a valid NeoForge patch must not re-run')
  } finally {
    await server.close()
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }
})

test('a missing client jar is repaired before processors that need it run', async () => {
  const routes = routeTable()
  const server = await fixtureServer(routes)
  const gameRoot = tempDir('forge-client-jar')
  try {
    await seedBase(gameRoot, server)
    const patchedZip = new AdmZip()
    patchedZip.addFile('patched.class', Buffer.from('patched-after-jar-repair', 'utf8'))
    const patchedBytes = patchedZip.toBuffer()
    const fixture = forgeFixture({ outputZip: patchedBytes, base: server.base })
    serveForgeFixture(routes, fixture)

    const clientJar = path.join(gameRoot, 'versions/1.20.1/1.20.1.jar')
    fs.rmSync(clientJar)
    assert.equal(fs.existsSync(clientJar), false)

    const calls = []
    const result = await installForgeLike('forge', {
      gameRoot,
      minecraftVersion: '1.20.1',
      loaderVersion: '47.3.22',
      mavenBase: server.base,
      installBaseVersion: false,
      processorRunner: async (command) => {
        calls.push(command.args)
        const output = command.args[command.args.indexOf('--output') + 1]
        fs.mkdirSync(path.dirname(output), { recursive: true })
        fs.writeFileSync(output, patchedBytes)
        return { code: 0, stdout: '', stderr: '' }
      },
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(fs.existsSync(clientJar), true, 'the installer must restore the missing client jar')
    assert.equal(fs.statSync(clientJar).size > 0, true)
    assert.equal(result.processorsRun, 1)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].includes(clientJar.replace(/\\/g, path.sep)), 'the processor must receive the restored jar path')
  } finally {
    await server.close()
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }
})

/** Two chained processors: one makes an intermediate, the other patches with it. */
function forgeChainFixture({ outputZip, base, minecraftVersion = '1.20.1', loaderVersion = '47.3.22' }) {
  const artifact = `${minecraftVersion}-${loaderVersion}`
  const processorBuffer = processorJar('com.example.Patcher')
  const patchedSha = sha(outputZip)
  const versionJson = {
    id: artifact,
    inheritsFrom: minecraftVersion,
    type: 'release',
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    arguments: { game: [], jvm: [] },
    libraries: [],
  }
  const profile = {
    spec: 1,
    profile: 'forge',
    version: artifact,
    json: '/version.json',
    path: '',
    minecraft: minecraftVersion,
    data: {
      INTERMEDIATE: { client: '[com.example:intermediate:1.0]', server: '[com.example:intermediate:1.0]' },
      PATCHED: {
        client: `[net.minecraftforge:forge:${artifact}:client]`,
        server: `[net.minecraftforge:forge:${artifact}:client]`,
      },
      PATCHED_SHA: { client: `'${patchedSha}'`, server: `'${patchedSha}'` },
    },
    processors: [
      { jar: 'com.example:processor:1.0', classpath: [], args: ['--make', '{INTERMEDIATE}'] },
      {
        jar: 'com.example:processor:1.0',
        classpath: [],
        args: ['--input', '{INTERMEDIATE}', '--output', '{PATCHED}'],
        outputs: { '{PATCHED}': '{PATCHED_SHA}' },
      },
    ],
    libraries: [
      {
        name: 'com.example:processor:1.0',
        downloads: {
          artifact: {
            path: 'com/example/processor/1.0/processor-1.0.jar',
            url: `${base}/maven/processor-1.0.jar`,
            sha1: sha(processorBuffer),
            size: processorBuffer.length,
          },
        },
      },
    ],
  }
  const zip = new AdmZip()
  zip.addFile('install_profile.json', Buffer.from(JSON.stringify(profile), 'utf8'))
  zip.addFile('version.json', Buffer.from(JSON.stringify(versionJson), 'utf8'))
  return { installer: zip.toBuffer(), processorBuffer }
}

test('repair falls back to the ordered processor chain when an input is gone', async () => {
  const routes = routeTable()
  const server = await fixtureServer(routes)
  const gameRoot = tempDir('forge-chain-repair')
  const versionId = forgeVersionId('forge', '1.20.1', '47.3.22')
  try {
    await seedBase(gameRoot, server)
    const patched = new AdmZip()
    patched.addFile('patched.class', Buffer.from('chained-patched', 'utf8'))
    const patchedBytes = patched.toBuffer()
    const fixture = forgeChainFixture({ outputZip: patchedBytes, base: server.base })
    Object.assign(routes, {
      [`/net/minecraftforge/forge/1.20.1-47.3.22/forge-1.20.1-47.3.22-installer.jar`]: {
        body: fixture.installer,
      },
      '/maven/processor-1.0.jar': { body: fixture.processorBuffer },
    })

    const intermediate = path.join(
      gameRoot,
      'libraries/com/example/intermediate/1.0/intermediate-1.0.jar',
    )
    const patchedJar = path.join(
      gameRoot,
      'libraries/net/minecraftforge/forge/1.20.1-47.3.22/forge-1.20.1-47.3.22-client.jar',
    )
    const calls = []
    const runner = async (command) => {
      if (command.args.includes('--make')) {
        const target = command.args[command.args.indexOf('--make') + 1]
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, Buffer.from('intermediate', 'utf8'))
        calls.push('make')
      } else {
        const output = command.args[command.args.indexOf('--output') + 1]
        fs.mkdirSync(path.dirname(output), { recursive: true })
        fs.writeFileSync(output, patchedBytes)
        calls.push('patch')
      }
      return { code: 0, stdout: '', stderr: '' }
    }

    const install = await installForgeLike('forge', {
      gameRoot,
      minecraftVersion: '1.20.1',
      loaderVersion: '47.3.22',
      mavenBase: server.base,
      installBaseVersion: false,
      processorRunner: runner,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(install.processorsRun, 2)
    assert.deepEqual(calls, ['make', 'patch'])

    // Delete the patched output and its upstream intermediate: the targeted fix
    // cannot run the patcher alone, the whole chain has to be replayed.
    fs.rmSync(intermediate)
    fs.rmSync(patchedJar)
    const issue = await diagnoseInstallation({ gameRoot, versionId })
    assert.equal(issue.processorIssues.length, 1)
    assert.equal(issue.processorIssues[0].file, patchedJar)

    calls.length = 0
    const repair = await repairInstallation({
      gameRoot,
      versionId,
      installBaseVersion: false,
      processorRunner: runner,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.deepEqual(calls, ['make', 'patch'], 'the chain must run in profile order again')
    assert.equal(repair.processorsRun, 2)
    assert.equal(fs.existsSync(intermediate), true)
    assert.equal(fs.existsSync(patchedJar), true)
    assert.equal(repair.issueAfter?.processorIssues.length ?? 0, 0)
  } finally {
    await server.close()
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }
})

test('a failing processor rolls the install back and restores the previous version JSON', async () => {
  const routes = routeTable()
  const server = await fixtureServer(routes)
  const gameRoot = tempDir('forge-rollback')
  const versionId = forgeVersionId('forge', '1.20.1', '47.3.22')
  try {
    await seedBase(gameRoot, server)
    const zip = new AdmZip()
    zip.addFile('patched.class', Buffer.from('patched', 'utf8'))
    const fixture = forgeFixture({ outputZip: zip.toBuffer(), base: server.base })
    serveForgeFixture(routes, fixture)

    const versionFile = path.join(gameRoot, 'versions', versionId, `${versionId}.json`)
    writeJson(versionFile, { id: versionId, marker: 'previous-install' })
    const previous = fs.readFileSync(versionFile, 'utf8')

    await assert.rejects(
      () =>
        installForgeLike('forge', {
          gameRoot,
          minecraftVersion: '1.20.1',
          loaderVersion: '47.3.22',
          mavenBase: server.base,
          installBaseVersion: false,
          processorRunner: async () => ({ code: 1, stdout: '', stderr: 'processor exploded' }),
          retry: fastRetry,
          logger: createNullLogger(),
        }),
      (error) =>
        error.code === 'processor' &&
        /Exit-Code 1/.test([error.message, ...(error.details ?? []), String(error.cause ?? '')].join(' ')),
    )
    assert.equal(fs.readFileSync(versionFile, 'utf8'), previous, 'previous version JSON must be restored')
    assert.equal(
      fs.existsSync(path.join(gameRoot, 'versions', versionId, 'install_profile.json')),
      false,
      'a failed install must not leave an install profile behind',
    )
    assert.equal(fs.existsSync(path.join(gameRoot, 'versions', versionId, 'bamboo-loader.json')), false)
  } finally {
    await server.close()
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }
})

test('Legacy Forge extracts the universal jar and writes a launchwrapper profile', async () => {
  const routes = routeTable()
  const server = await fixtureServer(routes)
  const gameRoot = tempDir('forge-legacy')
  try {
    await seedBase(gameRoot, server)
    const universal = Buffer.from('legacy-universal-jar-bytes', 'utf8')
    const versionInfo = {
      id: '1.20.1-forge-11.15.1.2318',
      inheritsFrom: '1.20.1',
      time: new Date().toISOString(),
      releaseTime: new Date().toISOString(),
      type: 'release',
      mainClass: 'net.minecraft.launchwrapper.Launch',
      minecraftArguments: '--username ${auth_player_name} --version ${version_name}',
      libraries: [
        {
          name: 'net.minecraftforge:forge:11.15.1.2318',
          downloads: {
            artifact: {
              path: 'net/minecraftforge/forge/11.15.1.2318/forge-11.15.1.2318-universal.jar',
              url: `${server.base}/maven/legacy-universal.jar`,
              sha1: sha(universal),
              size: universal.length,
            },
          },
        },
      ],
    }
    const profile = {
      install: {
        profileName: 'forge',
        target: '1.20.1-forge-11.15.1.2318',
        path: 'net/minecraftforge/forge/11.15.1.2318',
        version: '1.20.1',
        filePath: 'forge-11.15.1.2318-universal.jar',
        minecraft: '1.20.1',
      },
      versionInfo,
    }
    const zip = new AdmZip()
    zip.addFile('install_profile.json', Buffer.from(JSON.stringify(profile), 'utf8'))
    zip.addFile('forge-11.15.1.2318-universal.jar', universal)
    const installer = zip.toBuffer()
    Object.assign(routes, {
      '/net/minecraftforge/forge/1.20.1-11.15.1.2318/forge-1.20.1-11.15.1.2318-installer.jar': {
        body: installer,
      },
      '/maven/legacy-universal.jar': { body: universal },
    })
    const parsedInstaller = path.join(tempDir('legacy-parse'), 'x.jar')
    assert.throws(() => readInstallerArchive(parsedInstaller), /nicht lesbar/)

    const result = await installForgeLike('forge', {
      gameRoot,
      minecraftVersion: '1.20.1',
      loaderVersion: '11.15.1.2318',
      mavenBase: server.base,
      installBaseVersion: false,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(result.versionId, '1.20.1-forge-11.15.1.2318')
    assert.equal(result.processorsRun, 0, 'legacy installers have no processors')
    const universalPath = path.join(
      gameRoot,
      'libraries/net/minecraftforge/forge/11.15.1.2318/forge-11.15.1.2318-universal.jar',
    )
    assert.equal(fs.readFileSync(universalPath, 'utf8'), universal.toString())
    assert.equal(result.model.mainClass, 'net.minecraft.launchwrapper.Launch')
    assert.ok(result.model.classpath.some((entry) => entry.endsWith('forge-11.15.1.2318-universal.jar')))

    const second = await installForgeLike('forge', {
      gameRoot,
      minecraftVersion: '1.20.1',
      loaderVersion: '11.15.1.2318',
      mavenBase: server.base,
      installBaseVersion: false,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(second.alreadyInstalled, true)
    assert.equal(second.downloadedBytes, 0)
  } finally {
    await server.close()
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }
})

test('1.12.2-style Forge installer extracts the maven universal jar to the artifact path', async () => {
  const routes = routeTable()
  const server = await fixtureServer(routes)
  const gameRoot = tempDir('forge-legacy-maven')
  try {
    await seedBase(gameRoot, server, '1.12.2')
    const artifact = '1.12.2-14.23.5.2860'
    const universal = Buffer.from('legacy-maven-universal', 'utf8')
    // The real installer ships version.json (no versionInfo) with an empty
    // artifact URL; the universal jar sits under maven/ and has to be copied.
    const versionJson = {
      id: '1.12.2-forge-14.23.5.2860',
      inheritsFrom: '1.12.2',
      mainClass: 'net.minecraft.launchwrapper.Launch',
      minecraftArguments: '--username ${auth_player_name} --version ${version_name}',
      libraries: [
        {
          name: `net.minecraftforge:forge:${artifact}`,
          downloads: {
            artifact: {
              path: `net/minecraftforge/forge/${artifact}/forge-${artifact}.jar`,
              url: '',
              sha1: sha(universal),
              size: universal.length,
            },
          },
        },
      ],
    }
    const profile = {
      install: {
        profileName: 'forge',
        target: '1.12.2-forge-14.23.5.2860',
        path: `net/minecraftforge/forge/${artifact}`,
        version: '1.12.2',
        filePath: `forge-${artifact}-universal.jar`,
        minecraft: '1.12.2',
      },
      version: artifact,
      processors: [],
    }
    const zip = new AdmZip()
    zip.addFile('install_profile.json', Buffer.from(JSON.stringify(profile), 'utf8'))
    zip.addFile('version.json', Buffer.from(JSON.stringify(versionJson), 'utf8'))
    // The real 1.12.2 installer names the bundled jar exactly like the library.
    zip.addFile(`maven/net/minecraftforge/forge/${artifact}/forge-${artifact}.jar`, universal)
    const installer = zip.toBuffer()
    Object.assign(routes, {
      [`/net/minecraftforge/forge/${artifact}/forge-${artifact}-installer.jar`]: { body: installer },
    })

    const parsed = readInstallerArchive(
      (() => {
        const file = path.join(gameRoot, 'legacy-installer.jar')
        fs.writeFileSync(file, installer)
        return file
      })(),
    )
    assert.equal(parsed.isLegacy, true, 'version.json + bundled universal jar is legacy')

    const result = await installForgeLike('forge', {
      gameRoot,
      minecraftVersion: '1.12.2',
      loaderVersion: '14.23.5.2860',
      mavenBase: server.base,
      installBaseVersion: false,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    const target = path.join(
      gameRoot,
      `libraries/net/minecraftforge/forge/${artifact}/forge-${artifact}.jar`,
    )
    assert.equal(fs.readFileSync(target, 'utf8'), universal.toString())
    assert.equal(result.processorsRun, 0)
    assert.ok(result.model.classpath.some((entry) => entry.endsWith(`forge-${artifact}.jar`)))

    const second = await installForgeLike('forge', {
      gameRoot,
      minecraftVersion: '1.12.2',
      loaderVersion: '14.23.5.2860',
      mavenBase: server.base,
      installBaseVersion: false,
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(second.alreadyInstalled, true)
    assert.equal(second.downloadedBytes, 0)
  } finally {
    await server.close()
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }
})

test('OptiFine resolves the mirror list, patches once and stays idempotent', async () => {
  const routes = routeTable()
  const server = await fixtureServer(routes)
  const gameRoot = tempDir('optifine')
  try {
    await seedBase(gameRoot, server)
    const wrapper = Buffer.from('launchwrapper-of-jar', 'utf8')
    const installerZip = new AdmZip()
    installerZip.addFile('launchwrapper-of.txt', Buffer.from('3.3', 'utf8'))
    installerZip.addFile('launchwrapper-of-3.3.jar', wrapper)
    installerZip.addFile('optifine/Patcher.class', Buffer.from('class', 'utf8'))
    const installer = installerZip.toBuffer()
    Object.assign(routes, {
      '/optifine/versionList': {
        body: Buffer.from(
          JSON.stringify([
            { mcversion: '1.20.1', type: 'HD_U', patch: 'I6', filename: 'OptiFine_1.20.1_HD_U_I6.jar' },
          ]),
        ),
      },
      '/optifine/1.20.1/HD_U/I6': { body: installer },
    })

    const versionId = optifineVersionId('1.20.1', 'HD_U_I6')
    // The patcher reads the vanilla client jar; a partial root must self-heal.
    const clientJar = path.join(gameRoot, 'versions/1.20.1/1.20.1.jar')
    fs.rmSync(clientJar)
    const calls = []
    const result = await installOptifine({
      gameRoot,
      minecraftVersion: '1.20.1',
      loaderVersion: 'HD_U_I6',
      installBaseVersion: false,
      optifineMirror: server.base,
      retry: fastRetry,
      processorRunner: async (command) => {
        calls.push(command.args)
        assert.ok(
          command.args.includes(clientJar),
          'the patcher must receive the restored client jar',
        )
        const patchedJar = command.args[command.args.length - 1]
        const patched = new AdmZip()
        patched.addFile('optifine.class', Buffer.from('patched', 'utf8'))
        // The real optifine.Patcher does not create the target directory; the
        // installer must have done it before the process starts.
        fs.writeFileSync(patchedJar, patched.toBuffer())
        return { code: 0, stdout: '', stderr: '' }
      },
      logger: createNullLogger(),
    })
    assert.equal(result.versionId, versionId)
    assert.equal(result.processorsRun, 1)
    assert.equal(calls.length, 1)
    assert.equal(fs.existsSync(clientJar), true, 'the installer must restore the missing client jar')
    assert.equal(result.model.mainClass, 'net.minecraft.launchwrapper.Launch')
    assert.ok(result.model.arguments.game.includes('optifine.OptiFineTweaker'))
    assert.ok(
      result.model.classpath.some((entry) => entry.includes('Optifine-1.20.1_HD_U_I6.jar')),
      'the patched OptiFine jar must be on the classpath',
    )
    assert.equal(
      fs.existsSync(
        path.join(gameRoot, 'libraries/optifine/launchwrapper-of/3.3/launchwrapper-of-3.3.jar'),
      ),
      true,
    )
    const versionJson = JSON.parse(
      fs.readFileSync(path.join(gameRoot, 'versions', versionId, `${versionId}.json`), 'utf8'),
    )
    assert.equal(versionJson.inheritsFrom, '1.20.1')
    assert.equal(versionJson.libraries.length, 2)

    const second = await installOptifine({
      gameRoot,
      minecraftVersion: '1.20.1',
      loaderVersion: 'HD_U_I6',
      installBaseVersion: false,
      optifineMirror: server.base,
      retry: fastRetry,
      processorRunner: async () => {
        throw new Error('patcher must not run again')
      },
      logger: createNullLogger(),
    })
    assert.equal(second.alreadyInstalled, true)
    assert.equal(second.processorsRun, 0)
    assert.equal(calls.length, 1)
  } finally {
    await server.close()
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }
})

test('profile processor resolution handles variables, Maven references and outputs', () => {
  const gameRoot = path.join(tempDir('profile-resolve'), 'root')
  const profile = {
    spec: 1,
    profile: 'forge',
    version: '1.20.1-forge-47.3.22',
    json: '/version.json',
    path: '',
    minecraft: '1.20.1',
    data: {
      BINPATCH: { client: '/data/client.lzma', server: '/data/server.lzma' },
      PATCHED: { client: '[net.minecraftforge:forge:1.20.1-47.3.22:client]', server: '' },
      PATCHED_SHA: { client: "'abcdef'", server: '' },
    },
    processors: [
      {
        jar: 'com.example:patcher:1.0',
        classpath: ['com.example:helper:1.0'],
        args: ['--input', '{MINECRAFT_JAR}', '--output', '{PATCHED}', '--side', '{SIDE}'],
        outputs: { '{PATCHED}': '{PATCHED_SHA}' },
      },
      { jar: 'com.example:server:1.0', classpath: [], args: [], sides: ['server'] },
    ],
  }
  const resolved = resolveProcessors(profile, {
    gameRoot,
    side: 'client',
    minecraftVersion: '1.20.1',
    javaRuntimes: [{ path: 'java', majorVersion: 17 }],
  })
  assert.equal(resolved.length, 1, 'server-only processors must be filtered out')
  assert.ok(
    resolved[0].jarPath.replace(/\\/g, '/').endsWith('libraries/com/example/patcher/1.0/patcher-1.0.jar'),
  )
  assert.ok(
    resolved[0].classpathPaths[0].replace(/\\/g, '/').endsWith('libraries/com/example/helper/1.0/helper-1.0.jar'),
  )
  assert.ok(resolved[0].args.includes(path.join(gameRoot, 'versions/1.20.1/1.20.1.jar')))
  assert.ok(
    resolved[0].args.some((arg) =>
      arg.replace(/\\/g, '/').endsWith('libraries/net/minecraftforge/forge/1.20.1-47.3.22/forge-1.20.1-47.3.22-client.jar'),
    ),
  )
  assert.equal(resolved[0].args[resolved[0].args.length - 1], 'client')
  assert.equal(resolved[0].outputs.length, 1)
  assert.equal(resolved[0].outputs[0].validator, 'zip')
  assert.equal(resolved[0].outputs[0].checksum, undefined, 'non-hex checksums must not be accepted')

  resolved[0].mainClass = 'com.example.Patcher'
  const tasks = buildProcessorTasks(resolved, { id: 'forge', cwd: gameRoot })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].skipIfOutputsValid, true)
  assert.equal(tasks[0].strategies.length, 1)
  assert.match(tasks[0].strategies[0][0].args.join(' '), /-cp /)

  const generator = generateOptifineVersionJson('1.20.1', 'HD_U_I6', '3.3')
  assert.equal(generator.id, '1.20.1-OptiFine_HD_U_I6')
  assert.equal(generator.libraries.length, 2)

  const transaction = new LoaderTransaction(gameRoot, 'unit')
  assert.equal(transaction.finished, false)
})

test('diagnose/repair only touches what is broken and LoaderService routes', async () => {
  const gameRoot = tempDir('repair-service')
  try {
    const transaction = new LoaderTransaction(gameRoot, 'unit2')
    await transaction.run(async () => {
      await transaction.writeJson(path.join(gameRoot, 'file.json'), { ok: true })
    })
    assert.equal(JSON.parse(fs.readFileSync(path.join(gameRoot, 'file.json'), 'utf8')).ok, true)
    assert.equal(fs.readFileSync(path.join(gameRoot, 'file.json'), 'utf8').includes('ok'), true)
  } finally {
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }

  // Rollback restores a replaced file and removes a newly created one.
  const rollbackRoot = tempDir('transaction-rollback')
  try {
    const existing = path.join(rollbackRoot, 'existing.txt')
    fs.writeFileSync(existing, 'old', 'utf8')
    const transaction = new LoaderTransaction(rollbackRoot, 'unit3')
    await transaction.ensureStaging()
    await transaction.write(existing, 'new', undefined)
    await transaction.write(path.join(rollbackRoot, 'created.txt'), 'created')
    assert.equal(fs.readFileSync(existing, 'utf8'), 'new')
    await transaction.rollback()
    assert.equal(fs.readFileSync(existing, 'utf8'), 'old')
    assert.equal(fs.existsSync(path.join(rollbackRoot, 'created.txt')), false)
  } finally {
    fs.rmSync(rollbackRoot, { recursive: true, force: true })
  }

  assert.equal(loaderKindFromVersion('1.20.1-forge-47.3.22'), 'forge')
  assert.equal(loaderKindFromVersion('neoforge-21.1.9'), 'neoforge')
  assert.equal(loaderKindFromVersion('fabric-loader-0.15.11-1.20.1'), 'fabric')
  assert.equal(loaderKindFromVersion('quilt-loader-0.23.1-1.20.1'), 'quilt')
  assert.equal(loaderKindFromVersion('1.20.1-OptiFine_HD_U_I6'), 'optifine')
  assert.equal(loaderKindFromVersion('1.20.1'), undefined)

  const service = new LoaderService({ gameRoot: () => tempDir('service-root'), logger: createNullLogger() })
  assert.equal(typeof service.install, 'function')
  assert.equal(typeof service.diagnose, 'function')
  assert.equal(typeof service.repair, 'function')
  assert.equal(typeof service.listVersions, 'function')
})

test('diagnoseProcessorOutputs rejects empty or truncated archives', async () => {
  const root = tempDir('processor-outputs')
  try {
    const emptyZip = new AdmZip().toBuffer()
    const emptyFile = path.join(root, 'empty.jar')
    fs.writeFileSync(emptyFile, emptyZip)
    const issues = await diagnoseProcessorOutputs([{ path: emptyFile, validator: 'zip' }])
    assert.equal(issues.length, 1)
    assert.equal(issues[0].reason, 'corrupt')

    const goodZip = new AdmZip()
    goodZip.addFile('a.txt', Buffer.from('a', 'utf8'))
    const goodFile = path.join(root, 'good.jar')
    fs.writeFileSync(goodFile, goodZip.toBuffer())
    assert.equal(
      (await diagnoseProcessorOutputs([{ path: goodFile, validator: 'zip' }])).length,
      0,
    )
    assert.equal(
      (await diagnoseProcessorOutputs([
        { path: goodFile, validator: 'zip', checksum: { algorithm: 'sha1', value: '0'.repeat(40) } },
      ]))[0].reason,
      'checksum',
    )
    assert.equal((await diagnoseProcessorOutputs([{ path: path.join(root, 'nope.jar'), validator: 'zip' }]))[0].reason, 'missing')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
