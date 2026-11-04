const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  parseInstanceCoverSource,
  shortcutCoverPlan,
  shortcutIconFileName,
  pngToIco,
} = require('../dist-electron/shared/shortcutIcon.js')

test('shortcut cover source recognizes data URLs, bundled covers, files and missing images', () => {
  assert.deepEqual(parseInstanceCoverSource('data:image/jpeg;base64,abc'), {
    kind: 'data-url',
    value: 'data:image/jpeg;base64,abc',
  })
  assert.deepEqual(parseInstanceCoverSource('./instance-covers/java-edition.jpg'), {
    kind: 'bundled',
    file: 'java-edition.jpg',
  })
  assert.deepEqual(parseInstanceCoverSource('/instance-covers/copper-age.jpg'), {
    kind: 'bundled',
    file: 'copper-age.jpg',
  })
  assert.deepEqual(parseInstanceCoverSource('bamboo-file://C%3A%5Ccover.png'), {
    kind: 'file',
    path: 'C:\\cover.png',
  })
  assert.deepEqual(parseInstanceCoverSource('<img src="data:image/png;base64,abc">'), {
    kind: 'data-url',
    value: 'data:image/png;base64,abc',
  })
  assert.deepEqual(parseInstanceCoverSource(''), { kind: 'default' })
  assert.deepEqual(parseInstanceCoverSource('📦'), { kind: 'default' })
  assert.deepEqual(parseInstanceCoverSource('https://example.com/x.jpg'), { kind: 'default' })
})

test('missing instance images fall back to a bundled cover, never the launcher logo', () => {
  assert.deepEqual(shortcutCoverPlan(''), { kind: 'bundled', file: 'java-edition.jpg' })
  assert.deepEqual(shortcutCoverPlan('📦'), { kind: 'bundled', file: 'java-edition.jpg' })
  assert.deepEqual(shortcutCoverPlan('data:image/png;base64,abc'), {
    kind: 'data-url',
    value: 'data:image/png;base64,abc',
  })
})

test('shortcut icon filenames are safe and stable', () => {
  assert.equal(shortcutIconFileName('My-Pack_2'), 'my-pack_2.ico')
  assert.equal(shortcutIconFileName('../Evil Name'), 'evil_name.ico')
  assert.equal(shortcutIconFileName('..'), 'instance.ico')
})

test('pngToIco wraps a PNG in a valid single-image ICO container', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const ico = pngToIco(png)

  assert.equal(ico.readUInt16LE(0), 0, 'reserved')
  assert.equal(ico.readUInt16LE(2), 1, 'type: icon')
  assert.equal(ico.readUInt16LE(4), 1, 'one image')
  assert.equal(ico.readUInt8(6), 0, 'width 256 encoded as 0')
  assert.equal(ico.readUInt8(7), 0, 'height 256 encoded as 0')
  assert.equal(ico.readUInt8(8), 0, 'no palette')
  assert.equal(ico.readUInt8(9), 0, 'reserved')
  assert.equal(ico.readUInt16LE(10), 1, 'color planes')
  assert.equal(ico.readUInt16LE(12), 32, '32-bit image')
  assert.equal(ico.readUInt32LE(14), png.length, 'image size')
  assert.equal(ico.readUInt32LE(18), 22, 'image offset')
  assert.deepEqual(ico.subarray(22), png)
})
