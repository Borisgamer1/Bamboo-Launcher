export interface SettingsLogger {
  debug(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

/** The slice of the core this module talks to. */
export interface SettingsCore {
  getSettingsForRenderer(): unknown
  getPlayerIdentity(): unknown
  saveSettingsFromRenderer(settings: unknown): unknown
}

export interface SettingsIpcOptions {
  getCore(): Promise<SettingsCore | null>
  logger: SettingsLogger
}

interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

const FORGE_MAVEN =
  'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml'
const NEOFORGE_MAVEN =
  'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'

const VERSION_TAG = /<version>([^<]+)<\/version>/g

/** Shared Maven metadata reader: both loader lists are the same document shape. */
async function readMavenVersions(url: string): Promise<string[]> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const xml = await response.text()
  const versions: string[] = []
  for (const match of xml.matchAll(VERSION_TAG)) versions.push(match[1])
  return versions
}

/** Launcher settings, player identity and loader versions. */
export function registerSettingsIpc(ipc: IpcRegistrar, options: SettingsIpcOptions): void {
  ipc.handle('get-settings', async () => {
    const core = await options.getCore()
    if (!core) return null
    try {
      return await core.getSettingsForRenderer()
    } catch (error) {
      options.logger.error('get-settings failed', { error: (error as Error).message })
      return null
    }
  })

  ipc.handle('get-player-identity', async () => {
    const core = await options.getCore()
    if (!core) return null
    try {
      return await core.getPlayerIdentity()
    } catch (error) {
      options.logger.error('get-player-identity failed', { error: (error as Error).message })
      return null
    }
  })

  ipc.handle('save-settings', async (_event, settings) => {
    const core = await options.getCore()
    if (!core) throw new Error('Launcher core unavailable')
    return core.saveSettingsFromRenderer(settings)
  })

  // Both feeds are slow and only change when a loader ships, so one success is
  // cached for the process lifetime.
  let forgeVersions: string[] | null = null
  let neoforgeVersions: string[] | null = null

  ipc.handle('get-forge-versions', async () => {
    if (forgeVersions) return forgeVersions
    try {
      forgeVersions = await readMavenVersions(FORGE_MAVEN)
      return forgeVersions
    } catch (error) {
      options.logger.error('forge versions could not be loaded', { error: (error as Error).message })
      return null
    }
  })

  ipc.handle('get-neoforge-versions', async () => {
    if (neoforgeVersions) return neoforgeVersions
    try {
      neoforgeVersions = await readMavenVersions(NEOFORGE_MAVEN)
      return neoforgeVersions
    } catch (error) {
      options.logger.error('neoforge versions could not be loaded', { error: (error as Error).message })
      return null
    }
  })

}
