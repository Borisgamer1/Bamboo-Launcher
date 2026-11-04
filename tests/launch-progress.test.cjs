const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  LAUNCH_PROGRESS_CAP,
  launchDisplayPercent,
} = require('../dist-electron/shared/launchProgress.js')

test('the display spans exactly the real launch time', () => {
  assert.equal(launchDisplayPercent(0), 0)
  assert.equal(launchDisplayPercent(100), 100, 'the ready signal is the only way to reach 100')
  assert.ok(launchDisplayPercent(94) < 100, 'no step before ready shows 100')
  assert.ok(launchDisplayPercent(94) <= LAUNCH_PROGRESS_CAP)
  assert.equal(launchDisplayPercent(150), 100)
})

test('the display is monotonic and grows faster towards the end', () => {
  const points = [0, 3, 8, 15, 30, 45, 66, 80, 88, 94, 100].map(launchDisplayPercent)
  for (let index = 1; index < points.length; index += 1) {
    assert.ok(points[index] >= points[index - 1], 'progress must never go backwards')
  }

  const early = launchDisplayPercent(15) - launchDisplayPercent(8)
  const late = launchDisplayPercent(88) - launchDisplayPercent(80)
  assert.ok(late > early, 'the curve accelerates after the slow start')
  assert.ok(launchDisplayPercent(30) < 13, 'the first third stays visibly calm')
  assert.ok(launchDisplayPercent(80) > 60, 'the last third catches up')
  assert.ok(launchDisplayPercent(66) < 66, 'the shown value is not the raw percentage')
})

test('no percentage below the ready signal can ever show 100', () => {
  for (let percent = 0; percent < 100; percent += 1) {
    assert.ok(launchDisplayPercent(percent) < 100)
  }
})
