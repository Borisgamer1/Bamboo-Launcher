/**
 * Version switch and repair handlers live in
 * electron/legacy/instance-version-ipc. A switch must update the visible list,
 * the modpack index the launch path reads, and reject bad input with a code.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const ROOT = path.join(__dirname, '..')
const modulePath = path.join(ROOT, 'dist-electron', 'legacy', 'instance-version-ipc.js')
const silent = { debug() {}, info() {}, warn() {}, error() {} }

function loadHandlers({ installLoader } = {}) {
  const handlers = new Map()
  const ipc = { handle: (channel, listener) => handlers.set(channel, listener) }
  const { registerInstanceVersionIpc } = require(modulePath)
  registerInstanceVersionIpc(ipc, {
    logger: silent,
    resolveGameRoot: async () => root,
    getCore: async () => null,
    installLoader:
      installLoader ??
      (async (loader, minecraftVersion, loaderVersion) => ({
        versionId: `${minecraftVersion}-${loader}`,
        loaderVersion,
      })),
  })
  return handlers
}

let root = ''

function tempRoot() {
  root = path.join(os.tmpdir(), `bamboo-version-${process.pid}-${Date.now()}`)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  return root
}

function writeProfiles(entries) {
  const { profileRegistry } = require(path.join(ROOT, 'dist-electron', 'instances', 'profile-registry.js'))
  profileRegistry(root).write(entries)
}

function readProfiles() {
  return JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8'))
}

test('a version switch updates list and modpack index', async (context) => {
  tempRoot()
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const instanceDir = path.join(root, 'profiles', 'pack')
  fs.mkdirSync(instanceDir, { recursive: true })
  fs.writeFileSync(
    path.join(instanceDir, 'modrinth.index.json'),
    JSON.stringify({ dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' } }),
  )
  writeProfiles([
    { id: 'a', name: 'Pack', folderName: 'pack', version: '1.20.1', loader: 'Fabric', loaderVersion: '0.15.0' },
  ])

  const handler = loadHandlers().get('change-instance-version')
  const result = await handler(
    { sender: { send() {} } },
    { folderName: 'pack', mcVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.10' },
  )

  assert.equal(result.success, true)
  assert.equal(result.mcVersion, '1.21.1')

  const updated = readProfiles()[0]
  assert.equal(updated.version, '1.21.1')
  assert.equal(updated.loader, 'Fabric')
  assert.equal(updated.loaderVersion, '0.16.10')

  const index = JSON.parse(fs.readFileSync(path.join(instanceDir, 'modrinth.index.json'), 'utf8'))
  assert.equal(index.dependencies.minecraft, '1.21.1')
  assert.equal(index.dependencies['fabric-loader'], '0.16.10')
})

test('bad folder, loader and missing version return stable codes', async () => {
  tempRoot()
  const handler = loadHandlers().get('change-instance-version')
  const event = { sender: { send() {} } }
  assert.deepEqual(
    await handler(event, { folderName: '..', mcVersion: '1.21.1', loader: 'fabric' }),
    { success: false, error: 'Ungültiger Instanzordner', code: 'invalid-folder' },
  )
  assert.deepEqual(
    await handler(event, { folderName: 'pack', mcVersion: '1.21.1', loader: 'liteloader' }),
    { success: false, error: 'Unbekannter Modloader', code: 'unknown-loader' },
  )
  assert.deepEqual(
    await handler(event, { folderName: 'pack', mcVersion: '', loader: 'fabric' }),
    { success: false, error: 'Minecraft-Version fehlt', code: 'missing-version' },
  )
})

test('repair runs the loader install for the requested loader', async (context) => {
  tempRoot()
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const calls = []
  const handlers = loadHandlers({
    installLoader: async (loader, minecraftVersion, loaderVersion) => {
      calls.push([loader, minecraftVersion, loaderVersion])
      return { versionId: 'x', loaderVersion }
    },
  })
  const result = await handlers.get('repair-profile')(
    { sender: { send() {} } },
    { loader: 'fabric', loaderVersion: '0.16.10', mcVersion: '1.21.1', folderName: 'pack' },
  )
  assert.deepEqual(result, { success: true })
  assert.deepEqual(calls, [['fabric', '1.21.1', '0.16.10']])
})
