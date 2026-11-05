/**
 * Starts the two test clients through the real launcher core (same accounts,
 * same instances, same mod install) without opening the launcher window.
 *
 *   npx electron scripts/launch-pair.cjs
 */
const { app, safeStorage } = require('electron')
const path = require('node:path')
const { createCore } = require('../dist-electron/core.js')
const { legacyGameRoot } = require('../dist-electron/paths.js')

const MAIN_INSTANCE = 'legacy-26-3'
const SECOND_INSTANCE = 'legacy-mod-test'
const SECOND_ACCOUNT = 'offline-proof'

const log = (...parts) => console.log(new Date().toTimeString().slice(0, 8), ...parts)

// Without this Electron uses %APPDATA%/Electron and sees no accounts.
app.setPath('userData', path.join(app.getPath('appData'), 'bamboo-launcher'))

app.whenReady().then(async () => {
  const core = await createCore({
    appDataPath: app.getPath('userData'),
    legacyGameRoot: legacyGameRoot(),
    safeStorage,
  })
  log('core ready, accounts:', (await core.accounts.list()).map((a) => `${a.name}:${a.type}`).join(', '))

  const main = (await core.accounts.list()).find((a) => a.type.toLowerCase().includes('microsoft'))
  const second = (await core.accounts.list()).find((a) => a.id === SECOND_ACCOUNT || a.name === 'OfflineProof')
  if (!main) throw new Error('no Microsoft account')
  if (!second) throw new Error('no offline account')

  if (process.env.ONLY !== 'second') {
    await core.accounts.setActive(main.id)
    log('launching', MAIN_INSTANCE, 'as', main.name)
    const first = await core.launchInstance({ instanceId: MAIN_INSTANCE }, (event) => {
      if (event?.type === 'state' || event?.type === 'progress') return
      log('main event', JSON.stringify(event).slice(0, 200))
    })
    log('main pid', first.pid ?? 'n/a', 'launch', first.launchId ?? 'n/a')

    first.exit.then((exit) => log('main exited', JSON.stringify(exit).slice(0, 200)))
  }
  if (process.env.ONLY === 'main') {
    log('main only; keeping the launcher core alive')
    setInterval(() => {}, 1 << 30)
    return
  }

  await new Promise((resolve) => setTimeout(resolve, 20000))

  await core.accounts.setActive(second.id)
  log('launching', SECOND_INSTANCE, 'as', second.name)
  const two = await core.launchInstance({ instanceId: SECOND_INSTANCE }, (event) => {
    if (event?.type === 'state' || event?.type === 'progress') return
    log('second event', JSON.stringify(event).slice(0, 200))
  })
  log('second pid', two.pid ?? 'n/a', 'launch', two.launchId ?? 'n/a')

  two.exit.then((exit) => log('second exited', JSON.stringify(exit).slice(0, 200)))
  log('both started; keeping the launcher core alive')

  setInterval(() => {}, 1 << 30)
}).catch((error) => {
  console.error('launch pair failed:', error)
  app.exit(1)
})
