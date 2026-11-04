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

/** The distance stats Minecraft writes per player, in display order. */
export const DISTANCE_KEYS = [
  'walkCm',
  'sprintCm',
  'crouchCm',
  'swimCm',
  'flyCm',
  'climbCm',
  'fallCm',
  'walkOnWaterCm',
  'walkUnderWaterCm',
  'aviateCm',
  'minecartCm',
  'boatCm',
  'pigCm',
  'horseCm',
  'striderCm',
  'happyGhastCm',
] as const

export type DistanceKey = (typeof DISTANCE_KEYS)[number]
export type DistanceStats = Record<DistanceKey, number>

const DISTANCE_STAT_KEYS: Record<DistanceKey, string> = {
  walkCm: 'minecraft:walk_one_cm',
  sprintCm: 'minecraft:sprint_one_cm',
  crouchCm: 'minecraft:crouch_one_cm',
  swimCm: 'minecraft:swim_one_cm',
  flyCm: 'minecraft:fly_one_cm',
  climbCm: 'minecraft:climb_one_cm',
  fallCm: 'minecraft:fall_one_cm',
  walkOnWaterCm: 'minecraft:walk_on_water_one_cm',
  walkUnderWaterCm: 'minecraft:walk_under_water_one_cm',
  aviateCm: 'minecraft:aviate_one_cm',
  minecartCm: 'minecraft:minecart_one_cm',
  boatCm: 'minecraft:boat_one_cm',
  pigCm: 'minecraft:pig_one_cm',
  horseCm: 'minecraft:horse_one_cm',
  striderCm: 'minecraft:strider_one_cm',
  happyGhastCm: 'minecraft:happy_ghast_one_cm',
}

export function emptyDistanceStats(): DistanceStats {
  return {
    walkCm: 0,
    sprintCm: 0,
    crouchCm: 0,
    swimCm: 0,
    flyCm: 0,
    climbCm: 0,
    fallCm: 0,
    walkOnWaterCm: 0,
    walkUnderWaterCm: 0,
    aviateCm: 0,
    minecartCm: 0,
    boatCm: 0,
    pigCm: 0,
    horseCm: 0,
    striderCm: 0,
    happyGhastCm: 0,
  }
}

function readDistanceStats(custom: NbtCompound | undefined): DistanceStats {
  const distance = emptyDistanceStats()
  for (const key of DISTANCE_KEYS) {
    const amount = asNumber(custom?.[DISTANCE_STAT_KEYS[key]])
    distance[key] = amount !== undefined && amount > 0 ? amount : 0
  }
  return distance
}

function maxDistanceStats(left: DistanceStats, right: DistanceStats): DistanceStats {
  const distance = emptyDistanceStats()
  for (const key of DISTANCE_KEYS) distance[key] = Math.max(left[key], right[key])
  return distance
}

interface WorldStats {
  playtimeMs: number
  players: number
  distance: DistanceStats
  blocksMined: number
  blocksPlaced: number
  mobsKilled: number
  deaths: number
  jumps: number
}

export interface InstanceGameStats {
  distance: DistanceStats
  blocksMined: number
  blocksPlaced: number
  mobsKilled: number
  deaths: number
  jumps: number
  worlds: number
}

function sumCounts(value: NbtValue | undefined): number {
  const compound = asCompound(value)
  if (!compound) return 0
  let total = 0
  for (const entry of Object.values(compound)) {
    const amount = asNumber(entry)
    if (amount !== undefined && amount > 0) total += amount
  }
  return total
}

/**
 * Recorded statistics from the world's players. Modern worlds keep these in
 * `players/stats`, older ones directly in `stats`. For each value the longest
 * single-player entry is used, so multi-player worlds do not inflate the totals.
 *
 * `minecraft:used` is the vanilla counter that includes placed blocks (Minecraft
 * has no dedicated block-placed statistic); mined blocks come from
 * `minecraft:mined`.
 */
function readWorldStats(worldDir: string): WorldStats | null {
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
    let best: WorldStats = {
      playtimeMs: 0,
      players: 0,
      distance: emptyDistanceStats(),
      blocksMined: 0,
      blocksPlaced: 0,
      mobsKilled: 0,
      deaths: 0,
      jumps: 0,
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(statsDir, entry), 'utf8'))
        const stats = asCompound((parsed as NbtCompound | undefined)?.stats as NbtValue | undefined)
        const custom = asCompound(stats?.['minecraft:custom'])
        const ticks = asNumber(custom?.['minecraft:play_time'])
        const distance = readDistanceStats(custom)
        const blocksMined = sumCounts(stats?.['minecraft:mined'])
        const blocksPlaced = sumCounts(stats?.['minecraft:used'])
        const mobsKilled = sumCounts(stats?.['minecraft:killed'])
        const deaths = Math.max(0, Math.round(asNumber(custom?.['minecraft:deaths']) ?? 0))
        const jumps = Math.max(0, Math.round(asNumber(custom?.['minecraft:jump']) ?? 0))
        players += 1
        best = {
          playtimeMs: Math.max(best.playtimeMs, Math.round(((ticks ?? 0) / TICKS_PER_SECOND) * 1000)),
          players: 0,
          distance: maxDistanceStats(best.distance, distance),
          blocksMined: Math.max(best.blocksMined, blocksMined),
          blocksPlaced: Math.max(best.blocksPlaced, blocksPlaced),
          mobsKilled: Math.max(best.mobsKilled, mobsKilled),
          deaths: Math.max(best.deaths, deaths),
          jumps: Math.max(best.jumps, jumps),
        }
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
      return { ...best, players }
    }
  }
  return null
}

/** Sums the object statistics of every world in an instance's saves folder. */
export function collectInstanceGameStats(savesDir: string): InstanceGameStats {
  let entries: { name: string; isDirectory: () => boolean }[]
  try {
    entries = readdirSync(savesDir, { withFileTypes: true })
  } catch (error) {
    // An instance without a saves folder simply has no world statistics.
    getDefaultLogger().child('worlds').debug('saves folder unavailable for statistics', {
      savesDir,
      error: describeError(error),
    })
    return {
      distance: emptyDistanceStats(),
      blocksMined: 0,
      blocksPlaced: 0,
      mobsKilled: 0,
      deaths: 0,
      jumps: 0,
      worlds: 0,
    }
  }

  const totals: InstanceGameStats = {
    distance: emptyDistanceStats(),
    blocksMined: 0,
    blocksPlaced: 0,
    mobsKilled: 0,
    deaths: 0,
    jumps: 0,
    worlds: 0,
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const worldDir = join(savesDir, entry.name)
    const stats = readWorldStats(worldDir)
    if (!stats) continue
    for (const key of DISTANCE_KEYS) totals.distance[key] += stats.distance[key]
    totals.blocksMined += stats.blocksMined
    totals.blocksPlaced += stats.blocksPlaced
    totals.mobsKilled += stats.mobsKilled
    totals.deaths += stats.deaths
    totals.jumps += stats.jumps
    totals.worlds += 1
  }
  return totals
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

  const recorded = readWorldStats(worldDir)
  const worldAgeTicks = asNumber(data.Time)
  let playtimeMs: number | null = null
  let playtimeSource: WorldPlaytimeSource = 'none'
  let playtimeApproximate = false
  if (recorded) {
    playtimeMs = recorded.playtimeMs
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
