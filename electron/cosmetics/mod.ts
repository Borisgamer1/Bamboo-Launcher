import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * The cosmetics mod belongs to the instance, not to the player's memory.
 *
 * <p>The launcher copies one build into `mods/` before every start, so a new
 * instance, a reinstall or a friend's fresh setup never needs a manual jar copy.
 * A different Bamboo build in the folder is removed first: two versions in
 * `mods/` break the game before it renders anything.
 *
 * <p>The build itself comes from the project's GitHub release when one is
 * reachable and newer than the six-hour cache, otherwise from the jar bundled
 * with the launcher. A mod fix therefore does not need a launcher release.
 */

const MOD_DIRECTORY = resolve(__dirname, '..', '..', 'resources', 'bamboo-mod')
const MOD_FILE = 'bamboo-cosmetics-26.3-fabric.jar'
const MOD_PREFIX = 'bamboo-cosmetics-'
const SUPPORTED_MINECRAFT = '26.3'
const RELEASE_URL = 'https://api.github.com/repos/Borisgamer1/Bamboo-Cosmetics/releases/latest'
const RELEASE_TTL_MS = 6 * 60 * 60 * 1000
const MAXIMUM_BYTES = 32 * 1024 * 1024

export type BambooModResult =
  | 'installed'
  | 'updated'
  | 'present'
  | 'wrong-loader'
  | 'wrong-version'
  | 'missing-jar'

interface ModSource {
  path: string
  name: string
}

interface ReleaseState {
  tag: string
  asset: string
  checkedAt: number
}

export interface EnsureBambooModOptions {
  /** Where the downloaded release build is kept. Without it only the bundled jar is used. */
  cacheDir?: string
}

/** One lookup per app run and per cache directory. */
const SOURCES = new Map<string, ModSource | null>()

/** Read and write, not copyFile: the shipped jar lives inside app.asar. */
async function copyJar(source: string, target: string): Promise<void> {
  await writeFile(target, await readFile(source))
}

async function sizeOf(target: string): Promise<number | null> {
  try {
    return (await stat(target)).size
  } catch {
    return null
  }
}

async function mtimeOf(target: string): Promise<number> {
  try {
    return (await stat(target)).mtimeMs
  } catch {
    return 0
  }
}

async function readState(file: string): Promise<ReleaseState | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<ReleaseState>
    if (typeof parsed.tag !== 'string' || typeof parsed.asset !== 'string') return null
    return { tag: parsed.tag, asset: parsed.asset, checkedAt: Number(parsed.checkedAt) || 0 }
  } catch {
    return null
  }
}

async function writeState(file: string, state: ReleaseState): Promise<void> {
  await writeFile(file, JSON.stringify(state)).catch(() => undefined)
}

/** The newest release build, the cached one, or null. Never throws. */
async function releaseSource(cacheDir: string): Promise<ModSource | null> {
  const directory = join(cacheDir, 'bamboo-mod')
  const stateFile = join(directory, 'state.json')
  const state = await readState(stateFile)
  const cached = state ? { path: join(directory, state.asset), name: state.asset } : null
  const cachedSize = cached ? await sizeOf(cached.path) : null
  if (cached && cachedSize !== null && Date.now() - state!.checkedAt < RELEASE_TTL_MS) return cached

  try {
    const response = await fetch(RELEASE_URL, {
      headers: { 'user-agent': 'BambooLauncher', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(4000),
    })
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
    const release = (await response.json()) as {
      tag_name?: string
      assets?: Array<{ name?: string; browser_download_url?: string }>
    }
    const assets = (release.assets ?? []).filter(
      (asset) => typeof asset.name === 'string' && /^bamboo-cosmetics-.*\.jar$/i.test(asset.name),
    )
    // A release for another Minecraft version must never land in a 26.3 instance.
    const asset = assets.find((entry) => entry.name!.includes(`-${SUPPORTED_MINECRAFT}-`))
    if (!release.tag_name || !asset?.browser_download_url) throw new Error(`release has no ${SUPPORTED_MINECRAFT} jar`)

    if (cached && state!.tag === release.tag_name && cachedSize !== null) {
      await writeState(stateFile, { ...state!, checkedAt: Date.now() })
      return cached
    }

    const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(20000) })
    if (download.status !== 200) throw new Error(`HTTP ${download.status}`)
    const bytes = Buffer.from(await download.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAXIMUM_BYTES) throw new Error('release jar size')

    await mkdir(directory, { recursive: true })
    const target = join(directory, asset.name!)
    await writeFile(target, bytes)
    for (const name of await readdir(directory)) {
      if (name !== asset.name && name.endsWith('.jar')) {
        await unlink(join(directory, name)).catch(() => undefined)
      }
    }
    await writeState(stateFile, { tag: release.tag_name, asset: asset.name!, checkedAt: Date.now() })
    return { path: target, name: asset.name! }
  } catch {
    return cached && cachedSize !== null ? cached : null
  }
}

async function modSource(cacheDir: string | undefined): Promise<ModSource | null> {
  const key = cacheDir ?? ''
  const known = SOURCES.get(key)
  if (known !== undefined) return known
  let source = cacheDir ? await releaseSource(cacheDir) : null
  if (!source) {
    const shipped = join(MOD_DIRECTORY, MOD_FILE)
    source = (await sizeOf(shipped)) === null ? null : { path: shipped, name: MOD_FILE }
  }
  SOURCES.set(key, source)
  return source
}

export async function ensureBambooMod(
  instanceDirectory: string,
  minecraftVersion: string,
  loader: string,
  options: EnsureBambooModOptions = {},
): Promise<BambooModResult> {
  if (loader !== 'fabric') return 'wrong-loader'
  if (!String(minecraftVersion).startsWith(SUPPORTED_MINECRAFT)) return 'wrong-version'

  const source = await modSource(options.cacheDir)
  if (!source) return 'missing-jar'
  const sourceSize = await sizeOf(source.path)
  if (sourceSize === null) return 'missing-jar'
  const sourceTime = await mtimeOf(source.path)

  const mods = join(instanceDirectory, 'mods')
  await mkdir(mods, { recursive: true })

  for (const name of await readdir(mods)) {
    if (!name.startsWith(MOD_PREFIX) || name === source.name) continue
    try {
      await unlink(join(mods, name))
    } catch {
      // A locked or foreign file stays; the game reports the duplicate itself.
    }
  }

  const target = join(mods, source.name)
  const targetSize = await sizeOf(target)
  if (targetSize === null) {
    await copyJar(source.path, target)
    return 'installed'
  }
  // A rebuild can keep the exact byte count, so the timestamp decides too.
  if (targetSize !== sourceSize || (await mtimeOf(target)) < sourceTime) {
    await copyJar(source.path, target)
    return 'updated'
  }
  return 'present'
}
