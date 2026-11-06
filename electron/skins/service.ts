/**
 * One owner for the skin the player wears.
 *
 * The renderer may keep a local library, but only this service stores the
 * active skin and talks to the Minecraft profile. Tokens never leave the main
 * process. Cape selection uses the same Minecraft profile and is stored by
 * Mojang, not by the launcher.
 */
import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from '../atomic'
import type { LauncherCore } from '../core'
import type { FetchLike } from '../download/http'
import { describeError } from '../logger'
import { isModernMsAccount } from '../launch/args'

const PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'
const SKIN_UPLOAD_URL = 'https://api.minecraftservices.com/minecraft/profile/skins'
const CAPE_URL = 'https://api.minecraftservices.com/minecraft/profile/capes/active'
const CAPE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i
const PROFILE_TIMEOUT_MS = 8_000
const PROFILE_CACHE_MS = 30_000
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/

export type SkinVariant = 'classic' | 'slim'

interface SkinState {
  version: 1
  variant: SkinVariant
  /** Active local skin as a PNG data URL; null means "use the profile skin". */
  skin: string | null
  appliedAccountId: string | null
  updatedAt: number | null
}

interface ProfileSkin {
  url: string
  variant: SkinVariant
}

interface MinecraftProfile {
  id?: string
  name?: string
  skins?: Array<{ url?: unknown; variant?: unknown; state?: unknown }>
  capes?: Array<{ id?: unknown; alias?: unknown; url?: unknown; state?: unknown }>
}

/** A cape Mojang already owns for the account; the launcher only displays it. */
export interface VanillaCapeSnapshot {
  id: string
  name: string
  url: string
  active: boolean
}

export interface SkinSnapshot {
  account: { id: string; name: string; uuid: string; online: boolean } | null
  capes: VanillaCapeSnapshot[]
  skin: {
    url: string | null
    source: 'local' | 'profile' | 'none'
    variant: SkinVariant
    applied: boolean
    updatedAt?: number
  }
  canApplySkin: boolean
}

const DEFAULT_STATE: SkinState = {
  version: 1,
  variant: 'classic',
  skin: null,
  appliedAccountId: null,
  updatedAt: null,
}

function normalizeVariant(value: unknown): SkinVariant {
  return value === 'slim' ? 'slim' : 'classic'
}

function normalizeState(raw: Record<string, unknown> | undefined): SkinState {
  if (!raw) return { ...DEFAULT_STATE }
  return {
    version: 1,
    variant: normalizeVariant(raw.variant),
    skin: typeof raw.skin === 'string' && PNG_DATA_URL.test(raw.skin) ? raw.skin : null,
    appliedAccountId: typeof raw.appliedAccountId === 'string' ? raw.appliedAccountId : null,
    updatedAt:
      typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
  }
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 24 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new Error('Die Datei ist keine PNG-Datei.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  const supported =
    (width === 64 && (height === 64 || height === 32)) ||
    (width === 128 && (height === 128 || height === 64))
  if (!supported) {
    throw new Error('Skins müssen 64×64 oder 64×32 Pixel groß sein.')
  }
  return { width, height }
}

function bytesFromDataUrl(dataUrl: string): Uint8Array {
  return Uint8Array.from(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
}

function secureTextureUrl(url: string): string {
  return url.replace(/^http:\/\/textures\.minecraft\.net\//, 'https://textures.minecraft.net/')
}

function vanillaCapesOf(profile: MinecraftProfile | null): VanillaCapeSnapshot[] {
  const entries = profile?.capes
  if (!Array.isArray(entries)) return []
  const capes: VanillaCapeSnapshot[] = []
  for (const entry of entries) {
    if (!entry || typeof entry.url !== 'string') continue
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (!id) continue
    capes.push({
      id,
      name: typeof entry.alias === 'string' && entry.alias.length > 0 ? entry.alias : id,
      url: secureTextureUrl(entry.url),
      active: entry.state === 'ACTIVE',
    })
  }
  return capes
}

function profileSkinOf(profile: MinecraftProfile | null): ProfileSkin | null {
  const entry = profile?.skins?.find((skin) => typeof skin?.url === 'string')
  if (!entry || typeof entry.url !== 'string') return null
  return { url: secureTextureUrl(entry.url), variant: normalizeVariant(entry.variant) }
}

function isPngFile(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value)
}

export class SkinsService {
  readonly #core: LauncherCore
  readonly #stateFile: string
  readonly #fetch: FetchLike
  readonly #profiles = new Map<string, { profile: MinecraftProfile | null; checkedAt: number }>()

  constructor(core: LauncherCore) {
    this.#core = core
    this.#stateFile = join(core.paths.appData, 'skins', 'state.json')
    this.#fetch = core.fetchImpl ?? ((url, init) => fetch(url, init))
  }

  async snapshot(): Promise<SkinSnapshot> {
    const account = await this.#core.activeAccount()
    const state = await this.#readState()
    const online = Boolean(account && isModernMsAccount(account.type))
    const token = online && account ? await this.#core.auth.accessTokenFor(account) : undefined
    const profile = account && token
      ? await this.#profile(account.id, token)
      : account
        ? (this.#profiles.get(account.id)?.profile ?? null)
        : null
    const profileSkin = profileSkinOf(profile)

    const skin: SkinSnapshot['skin'] = state.skin
      ? {
          url: state.skin,
          source: 'local',
          variant: state.variant,
          applied: Boolean(account && state.appliedAccountId === account.id),
          ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
        }
      : profileSkin
        ? {
            url: profileSkin.url,
            source: 'profile',
            variant: profileSkin.variant,
            applied: true,
          }
        : { url: null, source: 'none', variant: 'classic', applied: false }

    return {
      account: account
        ? {
            id: account.id,
            name: String(account.name ?? ''),
            uuid: String(account.uuid ?? ''),
            online,
          }
        : null,
      capes: vanillaCapesOf(profile),
      skin,
      canApplySkin: Boolean(state.skin && token),
    }
  }

  async saveSkin(input: unknown): Promise<SkinSnapshot> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Ungültige Skin-Daten.')
    }
    const payload = input as { bytes?: unknown; variant?: unknown }
    const bytes =
      payload.bytes instanceof Uint8Array
        ? Uint8Array.from(payload.bytes)
        : payload.bytes instanceof ArrayBuffer
          ? new Uint8Array(payload.bytes)
          : null
    if (!bytes || !isPngFile(bytes)) throw new Error('Bitte wähle eine PNG-Datei.')
    pngSize(bytes)

    const state: SkinState = {
      version: 1,
      variant: normalizeVariant(payload.variant),
      skin: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
      appliedAccountId: null,
      updatedAt: Date.now(),
    }
    await this.#writeState(state)
    return this.snapshot()
  }

  async setSkinVariant(input: unknown): Promise<SkinSnapshot> {
    const state = await this.#readState()
    if (!state.skin) throw new Error('Wähle zuerst einen lokalen Skin.')
    await this.#writeState({
      ...state,
      variant: normalizeVariant(input),
      appliedAccountId: null,
      updatedAt: Date.now(),
    })
    return this.snapshot()
  }

  async resetSkin(): Promise<SkinSnapshot> {
    const state = await this.#readState()
    await this.#writeState({
      ...state,
      skin: null,
      appliedAccountId: null,
      updatedAt: Date.now(),
    })
    return this.snapshot()
  }

  async applySkin(): Promise<SkinSnapshot> {
    const state = await this.#readState()
    if (!state.skin) throw new Error('Wähle zuerst einen lokalen Skin.')
    const account = await this.#core.activeAccount()
    if (!account || !isModernMsAccount(account.type)) {
      throw new Error('Verbinde ein Microsoft-Konto, um den Skin anzuwenden.')
    }
    const token = await this.#core.auth.accessTokenFor(account)
    if (!token) throw new Error('Die Microsoft-Sitzung ist abgelaufen. Bitte melde dich neu an.')

    const form = new FormData()
    form.append('variant', state.variant)
    form.append('file', new Blob([bytesFromDataUrl(state.skin)], { type: 'image/png' }), 'skin.png')
    const response = await this.#fetch(SKIN_UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }).catch((error) => {
      throw new Error(`Minecraft konnte nicht erreicht werden: ${describeError(error)}`)
    })
    if (response.status === 401) {
      throw new Error('Die Microsoft-Sitzung ist abgelaufen. Bitte melde dich neu an.')
    }
    if (!response.ok) {
      throw new Error(`Minecraft hat den Skin abgelehnt (${response.status}).`)
    }

    await this.#writeState({
      ...state,
      appliedAccountId: account.id,
      updatedAt: Date.now(),
    })
    this.#profiles.delete(account.id)
    return this.snapshot()
  }

  /**
   * Sets the active Mojang cape. This is the same profile endpoint the game
   * reads, so the cape is really worn instead of only previewed. `null` hides
   * the cape again.
   */
  async selectCape(capeId: string | null): Promise<SkinSnapshot> {
    const account = await this.#core.activeAccount()
    if (!account || !isModernMsAccount(account.type)) {
      throw new Error('Verbinde ein Microsoft-Konto, um ein Cape zu wählen.')
    }
    const id = capeId === null ? null : String(capeId).trim()
    if (id !== null && !CAPE_ID.test(id)) throw new Error('Ungültige Cape-ID')
    const token = await this.#core.auth.accessTokenFor(account)
    if (!token) throw new Error('Die Microsoft-Sitzung ist abgelaufen. Bitte melde dich neu an.')

    const response = await this.#fetch(CAPE_URL, {
      method: id ? 'PUT' : 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(id ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(id ? { body: JSON.stringify({ capeId: id }) } : {}),
    }).catch((error) => {
      throw new Error(`Minecraft konnte nicht erreicht werden: ${describeError(error)}`)
    })
    if (response.status === 401) {
      throw new Error('Die Microsoft-Sitzung ist abgelaufen. Bitte melde dich neu an.')
    }
    if (!response.ok) {
      throw new Error(`Minecraft hat das Cape abgelehnt (${response.status}).`)
    }
    this.#profiles.delete(account.id)
    return this.snapshot()
  }

  async refresh(): Promise<SkinSnapshot> {
    this.#profiles.clear()
    return this.snapshot()
  }

  async #readState(): Promise<SkinState> {
    const raw = await readJsonFile<Record<string, unknown>>(this.#stateFile, this.#core.logger)
    return normalizeState(raw)
  }

  async #writeState(state: SkinState): Promise<void> {
    await writeJsonFile(this.#stateFile, state, this.#core.logger)
  }

  async #profile(accountId: string, token: string): Promise<MinecraftProfile | null> {
    const cached = this.#profiles.get(accountId)
    if (cached && Date.now() - cached.checkedAt < PROFILE_CACHE_MS) return cached.profile

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS)
    try {
      const response = await this.#fetch(PROFILE_URL, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      if (!response.ok) {
        this.#core.logger.warn('Minecraft-Profil konnte nicht gelesen werden', {
          status: response.status,
        })
        return null
      }
      const profile = (await response.json()) as MinecraftProfile
      this.#profiles.set(accountId, { profile, checkedAt: Date.now() })
      return profile
    } catch (error) {
      this.#core.logger.warn('Minecraft-Profil konnte nicht gelesen werden', {
        error: describeError(error),
      })
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

export function createSkinsService(core: LauncherCore): SkinsService {
  return new SkinsService(core)
}
