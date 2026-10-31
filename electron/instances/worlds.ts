import { readFileSync, readdirSync, statSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { describeError, getDefaultLogger } from '../logger'

/**
 * Reads real world data from an instance's `saves` folder.
 *
 * - metadata comes from `level.dat` (gzipped NBT, parsed here; no extra dependency)
 * - playtime comes from the game's own player statistics (`players/stats/*.json`,
 *   key `minecraft:custom` -> `minecraft:play_time`, measured in ticks), and only
 *   falls back to the world age in `level.dat` (`Data.Time`, also ticks) when no
 *   statistics file exists. The fallback is reported as approximate.
 */

export const TICKS_PER_SECOND = 20

export type WorldGamemode = 'survival' | 'creative' | 'adventure' | 'spectator'

export type WorldPlaytimeSource = 'stats' | 'world-age' | 'none'

export interface WorldSummary {
  /** Folder name inside `saves` – unique per instance and used as the UI key. */
  folderName: string
  /** `Data.LevelName` from level.dat, falling back to the folder name. */
  name: string
  gamemode: WorldGamemode | null
  hardcore: boolean
  /** `Data.Version.Name`, e.g. "1.21.4". */
  version: string | null
  /** `Data.LastPlayed` (epoch ms) or the level.dat modification time. */
  lastPlayed: number | null
  playtimeMs: number | null
  playtimeSource: WorldPlaytimeSource
  /** True when the value is derived from world age instead of recorded playtime. */
  playtimeApproximate: boolean
  /** Number of player statistics files the playtime was read from. */
  playerCount: number
  /** World `icon.png` as a data URL, when present and reasonably small. */
  iconDataUrl: string | null
  /** Set when level.dat could not be parsed; the folder is still listed. */
  error?: string
}

const GAMEMODES: WorldGamemode[] = ['survival', 'creative', 'adventure', 'spectator']

const MAX_ICON_BYTES = 512 * 1024

type NbtValue =
  | number
  | string
  | NbtValue[]
  | { [key: string]: NbtValue }

type NbtCompound = { [key: string]: NbtValue }

class NbtReader {
  private offset = 0

  constructor(private readonly buffer: Buffer) {}

  private ensure(bytes: number): void {
    if (this.offset + bytes > this.buffer.length) {
      throw new Error('Unexpected end of NBT data')
    }
  }

  private skip(bytes: number): void {
    this.ensure(bytes)
    this.offset += bytes
  }

  readByte(): number {
    this.ensure(1)
    const value = this.buffer.readInt8(this.offset)
    this.offset += 1
    return value
  }

  private readShort(): number {
    this.ensure(2)
    const value = this.buffer.readInt16BE(this.offset)
    this.offset += 2
    return value
  }

  private readUShort(): number {
    this.ensure(2)
    const value = this.buffer.readUInt16BE(this.offset)
    this.offset += 2
    return value
  }

  private readInt(): number {
    this.ensure(4)
    const value = this.buffer.readInt32BE(this.offset)
    this.offset += 4
    return value
  }

  private readLong(): number {
    this.ensure(8)
    const value = this.buffer.readBigInt64BE(this.offset)
    this.offset += 8
    return Number(value)
  }

  private readFloat(): number {
    this.ensure(4)
    const value = this.buffer.readFloatBE(this.offset)
    this.offset += 4
    return value
  }

  private readDouble(): number {
    this.ensure(8)
    const value = this.buffer.readDoubleBE(this.offset)
    this.offset += 8
    return value
  }

  readString(): string {
    const length = this.readUShort()
    this.ensure(length)
    const value = this.buffer.toString('utf8', this.offset, this.offset + length)
    this.offset += length
    return value
  }

  readCompound(): NbtCompound {
    const result: NbtCompound = {}
    for (;;) {
      const type = this.readByte()
      if (type === 0) return result
      const name = this.readString()
      if (!name) {
        // An unnamed tag would silently overwrite entries; treat it as corrupt.
        throw new Error('Unnamed NBT tag in compound')
      }
      result[name] = this.readPayload(type)
    }
  }

  private readPayload(type: number): NbtValue {
    switch (type) {
      case 1:
        return this.readByte()
      case 2:
        return this.readShort()
      case 3:
        return this.readInt()
      case 4:
        return this.readLong()
      case 5:
        return this.readFloat()
      case 6:
        return this.readDouble()
      case 7: {
        const length = this.readInt()
        if (length < 0) throw new Error('Negative NBT byte array length')
        this.skip(length)
        return []
      }
      case 8:
        return this.readString()
      case 9: {
        const elementType = this.readByte()
        const length = this.readInt()
        if (length < 0) throw new Error('Negative NBT list length')
        const items: NbtValue[] = []
        for (let index = 0; index < length; index++) {
          items.push(this.readPayload(elementType))
        }
        return items
      }
      case 10:
        return this.readCompound()
      case 11: {
        const length = this.readInt()
        if (length < 0) throw new Error('Negative NBT int array length')
        this.skip(length * 4)
        return []
      }
      case 12: {
        const length = this.readInt()
        if (length < 0) throw new Error('Negative NBT long array length')
        this.skip(length * 8)
        return []
      }
      default:
        throw new Error(`Unsupported NBT tag type ${type}`)
    }
  }
}

/** Parses a `level.dat` payload (gzipped or plain NBT) into its root compound. */
export function parseLevelDat(buffer: Buffer): NbtCompound {
  let data = buffer
  try {
    data = gunzipSync(buffer)
  } catch (error) {
    // Already uncompressed NBT is the normal second format.
    getDefaultLogger().child('worlds').debug('level.dat is not gzipped; reading as plain NBT', {
      error: describeError(error),
    })
  }
  const reader = new NbtReader(data)
  const rootType = reader.readByte()
  if (rootType !== 10) throw new Error('level.dat does not start with a compound tag')
  reader.readString()
  return reader.readCompound()
}

function asNumber(value: NbtValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: NbtValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asCompound(value: NbtValue | undefined): NbtCompound | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as NbtCompound
}

interface StatsPlaytime {
  ms: number
  players: number
}

/**
 * Recorded playtime of the world's players, taken from the game's own statistics
 * (`minecraft:custom.minecraft:play_time`, in ticks). Modern worlds keep these in
 * `players/stats`, older ones directly in `stats`. The longest single player value
 * is used so multi-player worlds do not sum unrelated sessions.
 */
function readStatsPlaytime(worldDir: string): StatsPlaytime | null {
  for (const statsDir of [join(worldDir, 'players', 'stats'), join(worldDir, 'stats')]) {
    let entries: string[]
    try {
      entries = readdirSync(statsDir)
    } catch (error) {
      // Neither stats location existing is normal for a world that never ran.
      getDefaultLogger().child('worlds').debug('statistics folder unavailable', {
        statsDir,
        error: describeError(error),
      })
      continue
    }
    let players = 0
    let bestTicks = 0
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(statsDir, entry), 'utf8'))
        const stats = asCompound((parsed as NbtCompound | undefined)?.stats as NbtValue | undefined)
        const custom = asCompound(stats?.['minecraft:custom'])
        const ticks = asNumber(custom?.['minecraft:play_time'])
        players += 1
        if (ticks !== undefined && ticks > bestTicks) bestTicks = ticks
      } catch (error) {
        // Unreadable or partial stat file: count the player but keep the value we have.
        getDefaultLogger().child('worlds').debug('player statistics file unreadable', {
          file: join(statsDir, entry),
          error: describeError(error),
        })
        players += 1
      }
    }
    if (players > 0) {
      return { ms: Math.round((bestTicks / TICKS_PER_SECOND) * 1000), players }
    }
  }
  return null
}

function readWorldIcon(worldDir: string): string | null {
  try {
    const iconPath = join(worldDir, 'icon.png')
    const info = statSync(iconPath)
    if (!info.isFile() || info.size === 0 || info.size > MAX_ICON_BYTES) return null
    return `data:image/png;base64,${readFileSync(iconPath).toString('base64')}`
  } catch (error) {
    // A world without a usable icon is displayed without one.
    getDefaultLogger().child('worlds').debug('world icon unavailable', {
      worldDir,
      error: describeError(error),
    })
    return null
  }
}

function levelDatMtime(worldDir: string): number | null {
  try {
    return statSync(join(worldDir, 'level.dat')).mtimeMs
  } catch (error) {
    // The world is still listed; only its "last played" timestamp is missing.
    getDefaultLogger().child('worlds').debug('level.dat timestamp unavailable', {
      worldDir,
      error: describeError(error),
    })
    return null
  }
}

/** Reads one world folder. Never throws: unreadable worlds are reported as such. */
export function summarizeWorld(worldDir: string, folderName: string): WorldSummary {
  const base: WorldSummary = {
    folderName,
    name: folderName,
    gamemode: null,
    hardcore: false,
    version: null,
    lastPlayed: levelDatMtime(worldDir),
    playtimeMs: null,
    playtimeSource: 'none',
    playtimeApproximate: false,
    playerCount: 0,
    iconDataUrl: readWorldIcon(worldDir),
  }

  let data: NbtCompound
  try {
    const root = parseLevelDat(readFileSync(join(worldDir, 'level.dat')))
    // The root holds a single `Data` compound; older dumps nest it identically.
    data = asCompound(root.Data) ?? root
  } catch (error) {
    // The world stays listed with an explicit error instead of disappearing.
    getDefaultLogger().child('worlds').debug('world metadata unreadable; listing folder only', {
      worldDir,
      error: describeError(error),
    })
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const levelName = asString(data.LevelName)
  const hardcore = asNumber(data.hardcore) === 1
  const player = asCompound(data.Player)
  const gameType = asNumber(player?.playerGameType) ?? asNumber(data.GameType)
  const gamemode = gameType !== undefined ? GAMEMODES[gameType] ?? null : null
  const lastPlayed = asNumber(data.LastPlayed) ?? base.lastPlayed
  const versionName = asString(asCompound(data.Version)?.Name)

  const recorded = readStatsPlaytime(worldDir)
  const worldAgeTicks = asNumber(data.Time)
  let playtimeMs: number | null = null
  let playtimeSource: WorldPlaytimeSource = 'none'
  let playtimeApproximate = false
  if (recorded) {
    playtimeMs = recorded.ms
    playtimeSource = 'stats'
  } else if (worldAgeTicks !== undefined) {
    playtimeMs = Math.round((worldAgeTicks / TICKS_PER_SECOND) * 1000)
    playtimeSource = 'world-age'
    playtimeApproximate = true
  }

  return {
    ...base,
    name: levelName ?? folderName,
    gamemode,
    hardcore,
    version: versionName ?? null,
    lastPlayed: lastPlayed ?? null,
    playtimeMs,
    playtimeSource,
    playtimeApproximate,
    playerCount: recorded?.players ?? 0,
  }
}

/** Lists every world folder inside an instance's `saves` directory, newest first. */
export function listInstanceWorlds(savesDir: string): WorldSummary[] {
  let entries: { name: string; isDirectory: () => boolean }[]
  try {
    entries = readdirSync(savesDir, { withFileTypes: true })
  } catch (error) {
    // An instance without a saves folder simply has no worlds.
    getDefaultLogger().child('worlds').debug('saves folder unavailable', {
      savesDir,
      error: describeError(error),
    })
    return []
  }

  const worlds: WorldSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    worlds.push(summarizeWorld(join(savesDir, entry.name), entry.name))
  }

  worlds.sort((a, b) => {
    const left = a.lastPlayed ?? 0
    const right = b.lastPlayed ?? 0
    if (left !== right) return right - left
    return a.name.localeCompare(b.name)
  })

  return worlds
}
