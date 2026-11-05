/**
 * The IPC owner: every channel is registered through one registrar, every
 * handler sees the sender guard, and the legacy surface has a schema for every
 * channel that takes arguments.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const { createIpcRegistrar, IPC_CHANNELS } = require('../dist-electron/ipc-registry.js')

const TRUSTED = { senderFrame: { url: 'file:///app/index.html' } }
const UNTRUSTED = { senderFrame: { url: 'https://evil.example/' } }

function fakeIpc() {
  const handles = new Map()
  const listeners = new Map()
  const removed = []
  return {
    handles,
    listeners,
    removed,
    ipc: {
      handle: (channel, listener) => handles.set(channel, listener),
      on: (channel, listener) => listeners.set(channel, listener),
      once: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel, listener) => removed.push({ channel, listener }),
    },
  }
}

test('the registrar guards handle and event channels before the handler runs', async () => {
  const { ipc, handles, listeners } = fakeIpc()
  const registrar = createIpcRegistrar(ipc)
  let calls = 0
  registrar.handle('demo:handle', (_event, value) => {
    calls += 1
    return value
  })
  registrar.on('demo:event', () => {
    calls += 1
  })

  assert.equal(await handles.get('demo:handle')(TRUSTED, 'ok'), 'ok')
  assert.equal(calls, 1)
  await assert.rejects(
    () => handles.get('demo:handle')(UNTRUSTED, 'no'),
    /untrusted frame/,
  )
  assert.equal(calls, 1, 'an untrusted frame never reaches the handler')

  listeners.get('demo:event')(UNTRUSTED)
  assert.equal(calls, 1, 'an untrusted event channel never reaches the handler')
  listeners.get('demo:event')(TRUSTED)
  assert.equal(calls, 2)
})

test('the registrar validates arguments and keeps the original payload', async () => {
  const { ipc, handles } = fakeIpc()
  const registrar = createIpcRegistrar(ipc)
  let received
  registrar.handle('read-file-as-base64', (_event, filePath) => {
    received = filePath
    return 'ok'
  })

  assert.equal(await handles.get('read-file-as-base64')(TRUSTED, 'C:\\game\\icon.png'), 'ok')
  assert.equal(received, 'C:\\game\\icon.png')
  await assert.rejects(
    () => handles.get('read-file-as-base64')(TRUSTED, { path: 'C:\\game\\icon.png' }),
    /Invalid IPC arguments/,
  )

  const create = createIpcRegistrar(ipc)
  let payload
  create.handle('create-instance', (_event, data) => {
    payload = data
    return true
  })
  const original = { folderName: 'profile', options: { extra: 'kept' }, unknown: 1 }
  await handles.get('create-instance')(TRUSTED, original)
  assert.equal(payload, original, 'validation must not strip or rewrite fields')
  await assert.rejects(
    () => handles.get('create-instance')(TRUSTED, { folderName: '..\\escape', options: {} }),
    /Invalid IPC arguments/,
  )

  assert.equal(IPC_CHANNELS['open-external-url'].safeParse(['discord://invite']).success, true)
  assert.equal(IPC_CHANNELS['open-external-url'].safeParse(['file:///etc/passwd']).success, false)
})

test('the registrar maps removeListener to the wrapped listener', () => {
  const { ipc, listeners, removed } = fakeIpc()
  const registrar = createIpcRegistrar(ipc)
  const listener = () => undefined
  registrar.once('app:flush-before-close-done', listener)
  const wrapped = listeners.get('app:flush-before-close-done')
  assert.notEqual(wrapped, listener)
  registrar.removeListener('app:flush-before-close-done', listener)
  assert.equal(removed.length, 1)
  assert.equal(removed[0].listener, wrapped)
})

test('profile folder schemas reject dot segments but keep ordinary names', () => {
  const schema = IPC_CHANNELS['open-profile-folder']
  assert.ok(schema, 'the profile folder schema exists')
  for (const bad of ['.', '..', 'a/b', 'a\\b']) {
    assert.equal(schema.safeParse([bad]).success, false, `${JSON.stringify(bad)} must be rejected`)
  }
  for (const ok of ['demo', 'My..World']) {
    assert.equal(schema.safeParse([ok]).success, true, `${JSON.stringify(ok)} must be accepted`)
  }
})

test('clone-instance accepts the renderer payload when the name is generated in main', () => {
  const schema = IPC_CHANNELS['clone-instance']
  assert.equal(schema.safeParse([{ folderName: 'demo-pack' }]).success, true)
  assert.equal(schema.safeParse([{ folderName: 'demo-pack', newName: 'Copy' }]).success, true)
  assert.equal(schema.safeParse([{ folderName: '..' }]).success, false)
})

test('change-instance-version validates loader and target fields', () => {
  const schema = IPC_CHANNELS['change-instance-version']
  const valid = {
    folderName: 'demo-pack',
    mcVersion: '1.21.1',
    loader: 'fabric',
    loaderVersion: '0.16.10',
  }
  assert.equal(schema.safeParse([valid]).success, true)
  assert.equal(schema.safeParse([{ ...valid, loaderVersion: undefined }]).success, true)
  assert.equal(schema.safeParse([{ ...valid, loader: 'liteloader' }]).success, false)
  assert.equal(schema.safeParse([{ ...valid, mcVersion: '' }]).success, false)
  assert.equal(schema.safeParse([{ ...valid, folderName: '..' }]).success, false)
})

test('download-mod accepts a CurseForge-only payload without a download URL', () => {
  const schema = IPC_CHANNELS['download-mod']
  const base = { folderName: 'demo-pack', filename: 'mod.jar', itemType: 'mod' }
  assert.equal(schema.safeParse([{ ...base, curseforgeFileId: 123 }]).success, true)
  assert.equal(
    schema.safeParse([{ ...base, downloadUrl: 'https://cdn.modrinth.com/data/x/versions/y/mod.jar' }]).success,
    true,
  )
  assert.equal(schema.safeParse([base]).success, false)
})

test('the manifest covers every channel of every surface, and nothing else', () => {
  const surfaces = ['main.js', 'electron/ipc.ts', 'electron/updater.ts']
  const registered = []
  for (const file of surfaces) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    const channels = [...source.matchAll(/(?:ipc|ipcMain)\.(?:handle|on|once)\(\s*'([^']+)'/g)].map(
      (match) => match[1],
    )
    assert.ok(channels.length > 0, `${file} must be scanned by the contract`)
    registered.push(...channels)
  }
  const declared = Object.keys(IPC_CHANNELS)
  assert.deepEqual(
    [...new Set(registered)].sort(),
    [...declared].sort(),
    'every registered channel needs a manifest entry, and the manifest may not list a dead channel',
  )
  assert.ok(declared.length > 100, 'the manifest covers the whole surface')
})

test('no surface registers directly on ipcMain any more', () => {
  const surfaces = ['main.js', 'electron/ipc.ts', 'electron/updater.ts']
  for (const file of surfaces) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    assert.doesNotMatch(source, /ipcMain\.(handle|on|once)\(/, `${file} must use the registrar`)
  }
})

test('the manifest validates arguments on the typed core surface too', async () => {
  const { ipc, handles } = fakeIpc()
  const registrar = createIpcRegistrar(ipc)
  let calls = 0
  registrar.handle('bamboo:accounts:set-active', () => {
    calls += 1
    return 'ok'
  })
  assert.equal(await handles.get('bamboo:accounts:set-active')(TRUSTED, 'account-1'), 'ok')
  await assert.rejects(
    () => handles.get('bamboo:accounts:set-active')(TRUSTED, { id: 'account-1' }),
    /Invalid IPC arguments/,
  )
  assert.equal(calls, 1)

  const analyze = createIpcRegistrar(ipc)
  let got
  analyze.handle('bamboo:logs:analyze', (_event, instanceId, launchId) => {
    got = [instanceId, launchId]
    return null
  })
  await handles.get('bamboo:logs:analyze')(TRUSTED, 'instance-1', undefined)
  assert.deepEqual(got, ['instance-1', undefined])
  await assert.rejects(
    () => handles.get('bamboo:logs:analyze')(TRUSTED, '', undefined),
    /Invalid IPC arguments/,
  )
})
