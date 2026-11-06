import { join } from 'node:path'
import type { Logger } from './logger'
import { readJsonFile, writeJsonFile } from './atomic'
import { InstanceIndex, InstanceIndexSchema, LauncherInstance, parseWithDefaults } from './schemas'

const EMPTY: InstanceIndex = { version: 1, selectedInstance: '', instances: [] }
const LOADERS = new Set(['vanilla', 'forge', 'neoforge', 'fabric', 'quilt', 'optifine'])

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/**
 * The legacy UI stores its "use the matching runtime" choice as a display label,
 * while the launch core reads any non-empty javaPath as a concrete executable.
 * Keep that label out of the launch data; an empty path means automatic.
 */
export function normalizeJavaPath(value: unknown): string {
  const path = typeof value === 'string' ? value.trim() : ''
  return /^(automatisch|automatic|auto|default)$/i.test(path) ? '' : path
}

function normalizeLoader(value: unknown): LauncherInstance['loader'] {
  const loader = String(value ?? 'vanilla').toLowerCase()
  return (LOADERS.has(loader) ? loader : 'vanilla') as LauncherInstance['loader']
}

export class InstanceStore {
  #file: string
  #logger: Logger
  #data: InstanceIndex = { ...EMPTY, instances: [] }
  #loaded: Promise<void> | undefined

  constructor(file: string, logger: Logger) {
    this.#file = file
    this.#logger = logger
  }

  async load(): Promise<void> {
    if (!this.#loaded) this.#loaded = this.#load()
    return this.#loaded
  }

  async #load(): Promise<void> {
    const raw = await readJsonFile<Record<string, unknown>>(this.#file, this.#logger)
    if (raw === undefined) return
    this.#data = parseWithDefaults(InstanceIndexSchema, raw, EMPTY, (issues) =>
      this.#logger.warn('instances.json failed validation; invalid entries were dropped', { issues }),
    ) as InstanceIndex
  }

  async list(): Promise<LauncherInstance[]> {
    await this.load()
    return this.#data.instances.map((instance) => ({ ...instance }))
  }

  async get(id: string): Promise<LauncherInstance | undefined> {
    await this.load()
    return this.#data.instances.find((instance) => instance.id === id)
  }

  async selected(): Promise<LauncherInstance | undefined> {
    await this.load()
    return this.#data.instances.find((instance) => instance.id === this.#data.selectedInstance)
  }

  async select(id: string): Promise<void> {
    await this.load()
    if (id && !this.#data.instances.some((instance) => instance.id === id)) {
      throw new Error(`Unknown instance: ${id}`)
    }
    this.#data.selectedInstance = id
    await this.#persist()
  }

  async upsert(input: Record<string, unknown>): Promise<LauncherInstance> {
    await this.load()
    const now = Date.now()
    const folderName =
      typeof input.folderName === 'string' && input.folderName.length > 0
        ? input.folderName
        : slugify(String(input.name ?? input.id ?? 'instance'))
    const id =
      typeof input.id === 'string' && input.id.length > 0
        ? input.id
        : `instance-${slugify(folderName) || now.toString(36)}`
    const existing = this.#data.instances.find((instance) => instance.id === id)
    const next: LauncherInstance = {
      ...(existing ?? {
        id,
        name: 'Unnamed',
        folderName,
        path: '',
        version: '',
        loader: 'vanilla' as const,
        loaderVersion: '',
        javaPath: '',
        minMemory: 0,
        maxMemory: 0,
        createdAt: now,
        updatedAt: now,
      }),
      ...input,
      id,
      folderName,
      // A partial save (memory, cover, playtime) must not reset the loader to
      // vanilla: that silently removed the loader filter from every update.
      loader: normalizeLoader(input.loader ?? existing?.loader),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } as LauncherInstance

    const index = this.#data.instances.findIndex((instance) => instance.id === id)
    if (index === -1) this.#data.instances.push(next)
    else this.#data.instances[index] = next
    await this.#persist()
    return next
  }

  async remove(id: string): Promise<void> {
    await this.load()
    this.#data.instances = this.#data.instances.filter((instance) => instance.id !== id)
    if (this.#data.selectedInstance === id) {
      this.#data.selectedInstance = this.#data.instances[0]?.id ?? ''
    }
    await this.#persist()
  }

  async importLegacyProfiles(profiles: unknown[], gameRoot: string): Promise<number> {
    await this.load()
    if (this.#data.instances.length > 0) return 0
    let imported = 0
    for (const entry of profiles) {
      if (typeof entry !== 'object' || entry === null) continue
      const profile = entry as Record<string, unknown>
      const name = String(profile.name ?? profile.profileName ?? 'Profile')
      const folderName = String(profile.folderName ?? slugify(name))
      const ram = Number(profile.ram)
      await this.upsert({
        id: typeof profile.id === 'string' ? profile.id : `legacy-${slugify(folderName)}`,
        name,
        folderName,
        path: join(gameRoot, 'profiles', folderName),
        version: String(profile.version ?? ''),
        loader: normalizeLoader(profile.loader ?? profile.modLoader),
        loaderVersion: String(profile.loaderVersion ?? ''),
        javaPath: normalizeJavaPath(profile.javaPath),
        minMemory: Number.isFinite(ram) && ram > 0 ? Math.round(ram) : 0,
        maxMemory: Number.isFinite(ram) && ram > 0 ? Math.round(ram) : 0,
        legacy: true,
      })
      imported += 1
    }
    if (!this.#data.selectedInstance && this.#data.instances[0]) {
      this.#data.selectedInstance = this.#data.instances[0].id
      await this.#persist()
    }
    return imported
  }

  async #persist(): Promise<void> {
    await writeJsonFile(this.#file, this.#data, this.#logger)
  }
}
