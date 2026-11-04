/**
 * Phase 6 tests: GameSettings-Service.
 *
 * The important regression is the DoD roundtrip: 500 keys, 40 unknown mod
 * keys and `§` names, saved 20 times, must stay byte-stable except for the
 * value that was actually changed.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { tempDir } = require('./harness.cjs')

const { createNullLogger } = require('../dist-electron/logger.js')
const {
  parseOptions,
  mergeOptions,
  encodeUnicodeEscapes,
  decodeUnicodeEscapes,
} = require('../dist-electron/gamesettings/options.js')
const {
  parseProperties,
  mergeProperties,
} = require('../dist-electron/gamesettings/properties.js')
const {
  localeToMinecraftLanguage,
  languagePatch,
} = require('../dist-electron/gamesettings/language.js')
const { GameSettingsService } = require('../dist-electron/gamesettings/service.js')
const { GameSettingsError } = require('../dist-electron/gamesettings/errors.js')

const CRLF = '\r\n'

function service() {
  return new GameSettingsService({ logger: createNullLogger() })
}

function line(text, key) {
  return text.split(/\r?\n/).find((entry) => entry.startsWith(`${key}:`))
}

function propLine(text, key, separator = '=') {
  return text.split(/\r?\n/).find((entry) => entry.startsWith(`${key}${separator}`))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(50)
  }
  return false
}

test('options parser infers types, keeps unknown keys and round-trips exactly', () => {
  const text = [
    'version:4671',
    'fov:0.25',
    'renderClouds:"true"',
    'graphicsPreset:"custom"',
    'resourcePacks:["vanilla","file/Unique Dark.zip"]',
    'incompatibleResourcePacks:[]',
    'mod.unknown:0.75',
    'mod.name:Hearts \\u00a7aGreen\\u00a7r',
    'mod.actual:§bWorld§r',
  ].join(CRLF) + CRLF

  const document = parseOptions(text)
  assert.equal(document.eol, CRLF)
  assert.equal(document.finalNewline, true)
  assert.equal(document.values.version, 4671)
  assert.equal(document.values.fov, 0.25)
  assert.equal(document.values.renderClouds, 'true', 'quoted values stay strings')
  assert.equal(document.values.graphicsPreset, 'custom')
  assert.deepEqual(document.values.resourcePacks, ['vanilla', 'file/Unique Dark.zip'])
  assert.deepEqual(document.values.incompatibleResourcePacks, [])
  assert.equal(document.values['mod.unknown'], 0.75)
  assert.equal(document.values['mod.name'], 'Hearts §aGreen§r')
  assert.equal(document.values['mod.actual'], '§bWorld§r')
  assert.equal(mergeOptions(text, {}).text, text)
  assert.equal(mergeOptions(text, {}).changed, false)
})

test('options merge changes only the requested line and preserves CRLF/order/comments', () => {
  const text = [
    '# Minecraft options',
    'version:4671',
    'fov:0.25',
    'mod.unknown:keep-me',
    'resourcePacks:["vanilla"]',
  ].join(CRLF) + CRLF

  const merged = mergeOptions(text, { fov: 0.5, newOption: 'hello' })
  assert.equal(merged.changed, true)
  assert.deepEqual({ ...merged.diff }, { fov: 0.5, newOption: 'hello' })
  assert.equal(line(merged.text, 'fov'), 'fov:0.5')
  assert.equal(line(merged.text, 'mod.unknown'), 'mod.unknown:keep-me')
  assert.equal(line(merged.text, 'resourcePacks'), 'resourcePacks:["vanilla"]')
  assert.equal(merged.text.split(CRLF)[0], '# Minecraft options')
  assert.equal(merged.text.split(CRLF).filter(Boolean).at(-1), 'newOption:hello')
  assert.equal(merged.text.endsWith(CRLF), true)
  assert.equal(mergeOptions(merged.text, { fov: 0.5 }).changed, false)
})

test('options parser tolerates MultiMC / truncated arrays and quoted strings with colons', () => {
  const text = [
    'resourcePacks:["vanilla","file/Broken.zip"',
    'incompatibleResourcePacks:[foo,bar]',
    'mod.quoted:"quoted:value"',
  ].join(CRLF) + CRLF
  const document = parseOptions(text)
  assert.deepEqual(document.values.resourcePacks, ['vanilla', 'file/Broken.zip'])
  assert.deepEqual(document.values.incompatibleResourcePacks, ['foo', 'bar'])
  assert.equal(document.values['mod.quoted'], 'quoted:value')

  const changed = mergeOptions(text, {
    resourcePacks: ['vanilla', 'file/§Pack.zip'],
    'mod.quoted': 'quoted:next',
  })
  assert.equal(
    line(changed.text, 'resourcePacks'),
    'resourcePacks:["vanilla","file/\\u00a7Pack.zip"]',
  )
  assert.equal(line(changed.text, 'mod.quoted'), 'mod.quoted:"quoted:next"')
  assert.equal(changed.text.includes('\\\\u00a7'), false, '§ must not be double-escaped')
  assert.deepEqual(parseOptions(changed.text).values.resourcePacks, [
    'vanilla',
    'file/§Pack.zip',
  ])
})

test('DoD: 500 keys, 40 unknown mod keys and § names survive 20 saves byte-stable', () => {
  const lines = [
    '# generated fixture',
    'version:4671',
    'fov:0.25',
    'renderDistance:12',
    'resourcePacks:["vanilla","file/Foo.zip"]',
    'mod.escaped:\\u00a7aHello\\u00a7r',
    'mod.actual:§bWorld§r',
    'mod.quoted:"quoted:value"',
    'mod.array:["a","b"]',
    'mod.bool:true',
    'mod.float:1.5',
    'mod.int:42',
  ]
  for (let index = 0; index < 40; index += 1) {
    lines.push(`mod.unknown.${index}:value-${index}-§-\\u00a7c`)
  }
  for (let index = 0; index < 449; index += 1) {
    const value = index % 3 === 0 ? String(index) : index % 3 === 1 ? `text-${index}` : 'true'
    lines.push(`option_${index}:${value}`)
  }
  const original = lines.join(CRLF) + CRLF
  const baseline = original.split(CRLF)

  const parsed = parseOptions(original)
  assert.equal(parsed.keys.length, 500)
  assert.equal(parsed.keys.filter((key) => key.startsWith('mod.unknown.')).length, 40)
  assert.equal(parsed.values['mod.escaped'], '§aHello§r')
  assert.equal(parsed.values['mod.actual'], '§bWorld§r')
  assert.equal(mergeOptions(original, {}).text, original)

  let current = original
  for (let index = 0; index < 20; index += 1) {
    const result = mergeOptions(current, { fov: 0.01 * (index + 1) })
    assert.equal(result.changed, true)
    const nextLines = result.text.split(CRLF)
    assert.equal(nextLines.length, baseline.length)
    for (let lineIndex = 0; lineIndex < baseline.length; lineIndex += 1) {
      if (!baseline[lineIndex].startsWith('fov:')) {
        assert.equal(nextLines[lineIndex], baseline[lineIndex])
      }
    }
    assert.equal(result.text.includes('\\\\u00a7'), false)
    assert.equal(line(result.text, 'mod.escaped'), 'mod.escaped:\\u00a7aHello\\u00a7r')
    assert.equal(line(result.text, 'mod.actual'), 'mod.actual:§bWorld§r')
    current = result.text
  }

  const restored = mergeOptions(current, { fov: 0.25 })
  assert.equal(restored.text, original)
  let stable = restored.text
  for (let index = 0; index < 20; index += 1) {
    const noop = mergeOptions(stable, { fov: 0.25 })
    assert.equal(noop.changed, false)
    assert.equal(noop.text, stable)
    stable = noop.text
  }
  assert.equal(stable, original)
})

test('unicode helpers escape § once and decode it again', () => {
  assert.equal(encodeUnicodeEscapes('§aGreen§r'), '\\u00a7aGreen\\u00a7r')
  assert.equal(decodeUnicodeEscapes('\\u00a7aGreen\\u00a7r'), '§aGreen§r')
  assert.equal(encodeUnicodeEscapes('plain'), 'plain')
})

test('options rejects invalid keys and values', () => {
  assert.throws(
    () => mergeOptions('', { 'bad:key': 1 }),
    (error) => error instanceof GameSettingsError && error.code === 'invalid-key',
  )
  assert.throws(
    () => mergeOptions('', { nested: { a: 1 } }),
    (error) => error instanceof GameSettingsError && error.code === 'invalid-value',
  )
  assert.throws(
    () => mergeOptions('', { nested: [['a']] }),
    (error) => error instanceof GameSettingsError && error.code === 'invalid-value',
  )
})

test('service editOptions writes deltas only and leaves no backup noise', async () => {
  const dir = tempDir('service')
  fs.writeFileSync(path.join(dir, 'options.txt'), `version:4671${CRLF}fov:0.25${CRLF}`, 'utf8')
  const api = service()

  const before = fs.statSync(path.join(dir, 'options.txt')).mtimeMs
  await sleep(20)
  const noop = await api.editOptions(dir, { fov: 0.25 })
  assert.equal(noop.changed, false)
  assert.equal(fs.statSync(path.join(dir, 'options.txt')).mtimeMs, before)
  assert.equal(fs.existsSync(path.join(dir, 'options.txt.bak')), false)

  const changed = await api.editOptions(dir, { fov: 0.5 })
  assert.equal(changed.changed, true)
  assert.equal(changed.writeMode, 'atomic')
  assert.equal(fs.readFileSync(path.join(dir, 'options.txt'), 'utf8'), `version:4671${CRLF}fov:0.5${CRLF}`)
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.bak') || name.includes('.tmp')), [])

  const read = await api.readOptions(dir)
  assert.equal(read.document.values.fov, 0.5)
})

test('hardlink sharing keeps root and instance on one inode and unlink breaks it', async () => {
  const base = tempDir('hardlink')
  const root = path.join(base, 'root')
  const instance = path.join(base, 'instance')
  fs.mkdirSync(root)
  fs.mkdirSync(instance)
  fs.writeFileSync(path.join(root, 'options.txt'), `fov:0.25${CRLF}`, 'utf8')

  const api = service()
  const linked = await api.linkOptions(root, instance)
  assert.equal(linked.linked, true)
  assert.equal(await api.isOptionsLinked(root, instance), true)
  assert.equal(fs.statSync(path.join(root, 'options.txt')).ino, fs.statSync(path.join(instance, 'options.txt')).ino)

  const edit = await api.editOptions(instance, { fov: 0.5 })
  assert.equal(edit.writeMode, 'in-place')
  assert.equal(parseOptions(fs.readFileSync(path.join(root, 'options.txt'), 'utf8')).values.fov, 0.5)

  assert.equal(await api.unlinkOptions(root, instance), true)
  assert.equal(await api.isOptionsLinked(root, instance), false)
  await api.editOptions(instance, { fov: 0.75 })
  assert.equal(parseOptions(fs.readFileSync(path.join(root, 'options.txt'), 'utf8')).values.fov, 0.5)
  assert.equal(parseOptions(fs.readFileSync(path.join(instance, 'options.txt'), 'utf8')).values.fov, 0.75)
})

test('hardlink conflict requires force and keeps a backup', async () => {
  const base = tempDir('hardlink-conflict')
  const root = path.join(base, 'root')
  const instance = path.join(base, 'instance')
  fs.mkdirSync(root)
  fs.mkdirSync(instance)
  fs.writeFileSync(path.join(root, 'options.txt'), `fov:0.25${CRLF}`, 'utf8')
  fs.writeFileSync(path.join(instance, 'options.txt'), `fov:1.0${CRLF}`, 'utf8')
  const api = service()
  assert.equal(
    await api.isOptionsLinked(root, instance),
    false,
    'distinct files must never count as linked',
  )

  await assert.rejects(
    () => api.linkOptions(root, instance),
    (error) => error instanceof GameSettingsError && error.code === 'hardlink-conflict',
  )
  const forced = await api.linkOptions(root, instance, { force: true })
  assert.equal(forced.linked, true)
  assert.ok(forced.backup)
  assert.equal(fs.existsSync(forced.backup), true)
  assert.equal(await api.isOptionsLinked(root, instance), true)
})

test('shader options support legacy optionsshaders and modern iris.properties', async () => {
  const base = tempDir('shader')
  const legacy = path.join(base, 'legacy')
  fs.mkdirSync(legacy)
  fs.writeFileSync(
    path.join(legacy, 'optionsshaders.txt'),
    `#legacy comment${CRLF}shaderPack:OFF${CRLF}enableShaders:false${CRLF}custom:keep${CRLF}`,
    'utf8',
  )
  const api = service()
  const legacyRead = await api.readShader(legacy)
  assert.equal(legacyRead.source, 'optionsshaders')
  assert.equal(legacyRead.shaderPack, 'OFF')
  assert.equal(legacyRead.enableShaders, false)
  const legacyWrite = await api.editShader(legacy, { shaderPack: 'BSL_v8.2.zip', enableShaders: true })
  assert.equal(legacyWrite.changed, true)
  const legacyText = fs.readFileSync(path.join(legacy, 'optionsshaders.txt'), 'utf8')
  assert.equal(legacyText.startsWith('#legacy comment\r\n'), true)
  assert.equal(line(legacyText, 'shaderPack'), 'shaderPack:BSL_v8.2.zip')
  assert.equal(line(legacyText, 'enableShaders'), 'enableShaders:true')
  assert.equal(line(legacyText, 'custom'), 'custom:keep')

  const modern = path.join(base, 'modern')
  fs.mkdirSync(path.join(modern, 'config'), { recursive: true })
  fs.writeFileSync(
    path.join(modern, 'config', 'iris.properties'),
    `#iris comment${CRLF}shaderPack=${CRLF}enableShaders=false${CRLF}colorSpace=SRGB${CRLF}`,
    'utf8',
  )
  const modernRead = await api.readShader(modern)
  assert.equal(modernRead.source, 'iris')
  await api.editShader(modern, { shaderPack: 'Complementary', enableShaders: true })
  const modernText = fs.readFileSync(path.join(modern, 'config', 'iris.properties'), 'utf8')
  assert.equal(propLine(modernText, 'shaderPack'), 'shaderPack=Complementary')
  assert.equal(propLine(modernText, 'enableShaders'), 'enableShaders=true')
  assert.equal(propLine(modernText, 'colorSpace'), 'colorSpace=SRGB')
  assert.equal(modernText.startsWith('#iris comment\r\n'), true)
  assert.deepEqual(await api.shaderState(modern), { shaderPack: 'Complementary', enableShaders: true })

  await assert.rejects(
    () => api.editShader(legacy, { mystery: 'x' }),
    (error) => error instanceof GameSettingsError && error.code === 'invalid-key',
  )
})

test('server.properties allowlist reads and writes only safe keys; eula round-trips', async () => {
  const server = path.join(tempDir('server'), 'server')
  fs.mkdirSync(server)
  fs.writeFileSync(
    path.join(server, 'server.properties'),
    `# server${CRLF}motd=Hello § World${CRLF}server-port=25565${CRLF}rcon.password=secret${CRLF}unknown.key=x${CRLF}`,
    'utf8',
  )
  const api = service()
  const read = await api.readServer(server)
  assert.equal(read.values.motd, 'Hello § World')
  assert.equal(read.values['server-port'], '25565')
  assert.equal(read.values['rcon.password'], undefined)
  assert.deepEqual(read.ignored.sort(), ['rcon.password', 'unknown.key'])

  const write = await api.writeServer(server, { motd: 'New MOTD', 'max-players': '8' })
  assert.equal(write.changed, true)
  const text = fs.readFileSync(path.join(server, 'server.properties'), 'utf8')
  assert.equal(propLine(text, 'motd'), 'motd=New MOTD')
  assert.equal(propLine(text, 'max-players'), 'max-players=8')
  assert.equal(propLine(text, 'rcon.password'), 'rcon.password=secret')
  assert.equal(propLine(text, 'unknown.key'), 'unknown.key=x')
  assert.equal(text.startsWith('# server\r\n'), true)

  await assert.rejects(
    () => api.writeServer(server, { 'rcon.password': 'changed' }),
    (error) => error instanceof GameSettingsError && error.code === 'server-allowlist',
  )
  assert.equal(propLine(fs.readFileSync(path.join(server, 'server.properties'), 'utf8'), 'rcon.password'), 'rcon.password=secret')

  fs.writeFileSync(path.join(server, 'eula.txt'), `# eula${CRLF}eula=false${CRLF}`, 'utf8')
  assert.equal(await api.readEula(server), false)
  await api.writeEula(server, true)
  assert.equal(await api.readEula(server), true)
  assert.equal(propLine(fs.readFileSync(path.join(server, 'eula.txt'), 'utf8'), 'eula'), 'eula=true')
})

test('ensureOptions respects mod-managed files and syncs the language', async () => {
  const base = tempDir('ensure')
  const api = service()

  const empty = path.join(base, 'empty')
  fs.mkdirSync(empty)
  const created = await api.ensureOptions(empty, { locale: 'de-DE', minecraftVersion: '1.20.1', eol: '\n' })
  assert.equal(created.created, true)
  assert.equal(created.language, 'de_de')
  assert.equal(fs.readFileSync(path.join(empty, 'options.txt'), 'utf8'), 'lang:de_de\n')

  const yosbr = path.join(base, 'yosbr')
  fs.mkdirSync(path.join(yosbr, 'config', 'yosbr'), { recursive: true })
  fs.writeFileSync(path.join(yosbr, 'config', 'yosbr', 'options.txt'), 'fov:0.5\n', 'utf8')
  const skipped = await api.ensureOptions(yosbr, { locale: 'de', eol: '\n' })
  assert.equal(skipped.created, false)
  assert.equal(skipped.reason, 'mod-managed')
  assert.equal(fs.existsSync(path.join(yosbr, 'options.txt')), false)

  const defaultOptions = path.join(base, 'defaultoptions')
  fs.mkdirSync(path.join(defaultOptions, 'config', 'defaultoptions'), { recursive: true })
  const skippedDirectory = await api.ensureOptions(defaultOptions, { locale: 'de', eol: '\n' })
  assert.equal(skippedDirectory.created, false)
  assert.equal(skippedDirectory.reason, 'mod-managed')

  fs.writeFileSync(path.join(empty, 'options.txt'), 'lang:en_us\n', 'utf8')
  const existing = await api.ensureOptions(empty, { locale: 'de', eol: '\n' })
  assert.equal(existing.created, false)
  assert.equal(existing.reason, 'already-exists')
})

test('language mapping handles regions and MC < 1.11 capitalization', () => {
  assert.equal(localeToMinecraftLanguage('de'), 'de_de')
  assert.equal(localeToMinecraftLanguage('de-DE', '1.20.1'), 'de_de')
  assert.equal(localeToMinecraftLanguage('de-DE', '1.8.9'), 'de_DE')
  assert.equal(localeToMinecraftLanguage('en-GB'), 'en_gb')
  assert.equal(localeToMinecraftLanguage('zh-Hant'), 'zh_tw')
  assert.equal(localeToMinecraftLanguage('zh-Hant', '1.8.9'), 'zh_TW')
  assert.equal(localeToMinecraftLanguage('pt-BR'), 'pt_br')
  assert.equal(localeToMinecraftLanguage(''), 'en_us')
  assert.deepEqual(languagePatch('de', '1.8.9'), { lang: 'de_DE' })
})

test('properties parser preserves comments and EOL', () => {
  const text = `# comment${CRLF}shaderPack:OFF${CRLF}enableShaders:false${CRLF}`
  const document = parseProperties(text, ':')
  assert.equal(document.values.shaderPack, 'OFF')
  assert.equal(document.eol, CRLF)
  assert.equal(mergeProperties(text, {}, ':').text, text)
})

test('watcher reports options, shader and eula changes', async () => {
  const dir = tempDir('watch')
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true })
  const api = service()
  const changes = []
  const watcher = api.watch(dir, (change) => changes.push(change))
  try {
    fs.writeFileSync(path.join(dir, 'options.txt'), 'fov:0.5\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'config', 'iris.properties'), 'shaderPack=OFF\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'server', 'eula.txt'), 'eula=true\n', 'utf8')
    const sawAll = await waitFor(() => {
      const kinds = new Set(changes.map((change) => change.kind))
      return kinds.has('options') && kinds.has('shader') && kinds.has('eula')
    })
    assert.equal(sawAll, true, `watcher events: ${JSON.stringify(changes)}`)
  } finally {
    watcher.close()
  }
})
