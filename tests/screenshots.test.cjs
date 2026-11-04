/**
 * Screenshot deletion uses the real filesystem and the same roots the IPC
 * handler passes in: the central copy plus the instance/world original.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const { deleteScreenshotFile } = require('../dist-electron/screenshots.js')
const { tempDir } = require('./harness.cjs')

function screenshotFixture(label) {
  const root = tempDir(label)
  const globalDir = path.join(root, 'screenshots')
  const sourceDir = path.join(root, 'profiles', 'demo', 'screenshots')
  fs.mkdirSync(globalDir, { recursive: true })
  fs.mkdirSync(sourceDir, { recursive: true })
  const globalFile = path.join(globalDir, 'demo__world__shot__1.png')
  const sourceFile = path.join(sourceDir, 'shot.png')
  fs.writeFileSync(globalFile, 'global')
  fs.writeFileSync(sourceFile, 'source')
  return { root, globalDir, sourceDir, globalFile, sourceFile }
}

test('deletes the central screenshot and its instance original', () => {
  const fixture = screenshotFixture('screenshot-delete')
  try {
    assert.equal(
      deleteScreenshotFile({
        rootPath: fixture.root,
        absolutePath: fixture.globalFile,
        sourceAbsolutePath: fixture.sourceFile,
      }),
      true,
    )
    assert.equal(fs.existsSync(fixture.globalFile), false)
    assert.equal(fs.existsSync(fixture.sourceFile), false)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('deletes a source original when the central copy is already gone', () => {
  const fixture = screenshotFixture('screenshot-source-only')
  fs.rmSync(fixture.globalFile)
  try {
    assert.equal(
      deleteScreenshotFile({
        rootPath: fixture.root,
        absolutePath: fixture.globalFile,
        sourceAbsolutePath: fixture.sourceFile,
      }),
      true,
    )
    assert.equal(fs.existsSync(fixture.sourceFile), false)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('refuses paths outside the screenshot root without touching the source', () => {
  const fixture = screenshotFixture('screenshot-outside')
  const outside = path.join(fixture.root, 'outside.png')
  fs.writeFileSync(outside, 'outside')
  try {
    assert.equal(
      deleteScreenshotFile({
        rootPath: fixture.root,
        absolutePath: outside,
        sourceAbsolutePath: fixture.sourceFile,
      }),
      false,
    )
    assert.equal(fs.existsSync(outside), true)
    assert.equal(fs.existsSync(fixture.sourceFile), true)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('deletes the central copy but never a source outside profiles', () => {
  const fixture = screenshotFixture('screenshot-source-outside')
  const outsideSource = path.join(fixture.root, 'elsewhere.png')
  fs.writeFileSync(outsideSource, 'elsewhere')
  try {
    assert.equal(
      deleteScreenshotFile({
        rootPath: fixture.root,
        absolutePath: fixture.globalFile,
        sourceAbsolutePath: outsideSource,
      }),
      true,
    )
    assert.equal(fs.existsSync(fixture.globalFile), false)
    assert.equal(fs.existsSync(outsideSource), true)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})
