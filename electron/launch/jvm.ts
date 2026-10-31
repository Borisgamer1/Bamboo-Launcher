import {
  JVM_PRESETS,
  JVM_PRESET_IDS,
  type JvmPresetId,
  type JvmPresetSelection,
} from './presets'

export type { JvmPresetId, JvmPresetSelection } from './presets'
export type JvmArchitecture = 'x64' | 'x86' | 'arm64'

export interface JvmPlanInput {
  memoryMode: 'auto' | 'explicit'
  minMemoryMb: number
  maxMemoryMb: number
  javaMajor?: number
  javaArch?: JvmArchitecture
  javaVendor?: string
  jvmPreset: JvmPresetSelection
  extraJvmArgs: readonly string[]
  modCount: number
  totalMemMb: number
  loader?: string
}

export const JVM_REASON_CODES = [
  'jvm.preset-auto',
  'jvm.preset-explicit',
  'jvm.downgrade-openj9',
  'jvm.downgrade-java',
  'jvm.downgrade-low-heap',
  'jvm.heap-auto',
  'jvm.heap-clamped',
  'jvm.heap-32bit',
  'jvm.arg-dropped',
] as const

export type JvmReasonCode = (typeof JVM_REASON_CODES)[number]

const JVM_REASON_RANK = new Map<string, number>(
  JVM_REASON_CODES.map((code, index) => [code, index]),
)

export function jvmReasonRank(code: JvmReasonCode | string): number {
  return JVM_REASON_RANK.get(code) ?? JVM_REASON_CODES.length
}

export interface JvmPlan {
  presetId: JvmPresetId
  args: readonly string[]
  heapMb: number
  xmsMb: number
  downgrades: JvmReasonCode[]
  dropped?: JvmDroppedArg[]
}

export type JvmArgSource = 'heap' | 'custom' | 'preset' | 'plan' | 'version-json'

export interface JvmArgLayer {
  args: readonly string[]
  source: JvmArgSource
}

export interface JvmDroppedArg {
  argument: string
  source: JvmArgSource
}

export interface MergedJvmArgs {
  args: string[]
  dropped: string[]
  droppedArgs: JvmDroppedArg[]
}

export interface JvmMergeOptions {
  keepHighPriorityCollector?: boolean
  dropLowXms?: boolean
}

export interface JvmPreferenceInput {
  memoryMode?: 'auto' | 'explicit'
  minMemoryMb?: number
  maxMemoryMb?: number
  jvmPreset?: JvmPresetSelection
  extraJvmArgs?: readonly string[]
  fallbackPreset?: JvmPresetSelection
}

export interface JvmPreferences {
  memoryMode: 'auto' | 'explicit'
  minMemoryMb: number
  maxMemoryMb: number
  jvmPreset: JvmPresetSelection
  extraJvmArgs: string[]
}

function memoryMb(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0
}

export function resolveJvmPreferences(input: JvmPreferenceInput): JvmPreferences {
  const maxMemoryMb = memoryMb(input.maxMemoryMb)
  return {
    memoryMode: input.memoryMode ?? (maxMemoryMb > 0 ? 'explicit' : 'auto'),
    minMemoryMb: memoryMb(input.minMemoryMb),
    maxMemoryMb,
    jvmPreset: input.jvmPreset ?? input.fallbackPreset ?? 'auto',
    extraJvmArgs: Array.isArray(input.extraJvmArgs) ? [...input.extraJvmArgs] : [],
  }
}

interface ArgUnit {
  key?: string
  args: string[]
  sortKey: string
  source: JvmArgSource
  layer: number
}

const CLASS_PATH_FLAGS = new Set(['-cp', '-classpath', '--class-path'])
const MULTI_VALUE_FLAGS = new Set(['--add-opens', '--add-exports'])
const COLLECTOR_FLAG = /^-XX:[+-]Use[A-Za-z0-9]*GC$/
const ZGENERATIONAL_FLAG = /^-XX:[+-]ZGenerational$/

function normalizeArgKey(argument: string): string | undefined {
  if (argument.startsWith('-Xmx')) return 'Xmx'
  if (argument.startsWith('-Xms')) return 'Xms'
  if (argument.startsWith('-cp=') || argument.startsWith('-classpath=') || argument.startsWith('--class-path=')) {
    return 'classpath'
  }
  if (CLASS_PATH_FLAGS.has(argument)) return 'classpath'
  const xx = /^-XX:([+-]?)([^=]+)(?:=.*)?$/.exec(argument)
  if (xx) return `XX:${xx[2]}`
  if (argument.startsWith('-D') && argument.length > 2) {
    const value = argument.slice(2)
    const equals = value.indexOf('=')
    return `D:${equals === -1 ? value : value.slice(0, equals)}`
  }
  return undefined
}

function tokenizeArguments(
  input: readonly string[],
  source: JvmArgSource,
  layer: number,
): { units: ArgUnit[]; dropped: JvmDroppedArg[] } {
  const units: ArgUnit[] = []
  const dropped: JvmDroppedArg[] = []
  const drop = (argument: string): void => {
    dropped.push({ argument, source })
  }
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index]
    if (typeof argument !== 'string' || argument.length === 0) continue

    if (argument === '-Xmx' || argument === '-Xms') {
      drop(argument)
      const next = input[index + 1]
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) {
        drop(next)
        index += 1
      }
      continue
    }

    if (CLASS_PATH_FLAGS.has(argument)) {
      const next = input[index + 1]
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) {
        units.push({ key: 'classpath', args: [argument, next], sortKey: 'classpath', source, layer })
        index += 1
      } else {
        units.push({ key: 'classpath', args: [argument], sortKey: 'classpath', source, layer })
      }
      continue
    }

    if (MULTI_VALUE_FLAGS.has(argument)) {
      const next = input[index + 1]
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) {
        units.push({ args: [argument, next], sortKey: `${argument} ${next}`, source, layer })
        index += 1
      } else {
        units.push({ args: [argument], sortKey: argument, source, layer })
      }
      continue
    }

    const key = normalizeArgKey(argument)
    units.push({
      ...(key !== undefined ? { key } : {}),
      args: [argument],
      sortKey: key ?? argument,
      source,
      layer,
    })
  }
  return { units, dropped }
}

function compareUnits(left: ArgUnit, right: ArgUnit): number {
  const rank = (unit: ArgUnit): number =>
    unit.key === 'Xms' ? 0 : unit.key === 'Xmx' ? 1 : 2
  return rank(left) - rank(right)
}

function isEnabledCollector(unit: ArgUnit): boolean {
  return unit.args.some(
    (argument) => argument.startsWith('-XX:+') && COLLECTOR_FLAG.test(argument),
  )
}

function isCollectorRelated(unit: ArgUnit): boolean {
  return unit.args.some(
    (argument) => COLLECTOR_FLAG.test(argument) || ZGENERATIONAL_FLAG.test(argument),
  )
}

export function mergeJvmArgumentLayers(
  layers: readonly JvmArgLayer[],
  options: JvmMergeOptions = {},
): MergedJvmArgs {
  const units: ArgUnit[] = []
  const dropped: string[] = []
  const droppedArgs: JvmDroppedArg[] = []
  const addDrop = (unit: ArgUnit): void => {
    for (const argument of unit.args) {
      dropped.push(argument)
      droppedArgs.push({ argument, source: unit.source })
    }
  }

  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index]
    const tokenized = tokenizeArguments(layer.args, layer.source, index)
    units.push(...tokenized.units)
    for (const item of tokenized.dropped) {
      dropped.push(item.argument)
      droppedArgs.push(item)
    }
  }

  const highCollector =
    options.keepHighPriorityCollector === true &&
    units.some((unit) => unit.layer === 0 && isEnabledCollector(unit))

  const seen = new Set<string>()
  let unique: ArgUnit[] = []
  for (const unit of units) {
    if (unit.layer > 0 && highCollector && isCollectorRelated(unit)) {
      addDrop(unit)
      continue
    }
    if (unit.layer > 0 && options.dropLowXms === true && unit.key === 'Xms') {
      addDrop(unit)
      continue
    }
    if (unit.key !== undefined) {
      if (seen.has(unit.key)) {
        addDrop(unit)
        continue
      }
      seen.add(unit.key)
    }
    unique.push(unit)
  }

  if (unique.some((unit) => unit.args.some((argument) => argument === '-XX:+UseZGC'))) {
    const withoutG1: ArgUnit[] = []
    for (const unit of unique) {
      const key = unit.key
      const g1 =
        key === 'XX:UseG1GC' ||
        key === 'XX:MaxGCPauseMillis' ||
        (key !== undefined && key.startsWith('XX:G1'))
      if (g1) {
        addDrop(unit)
        continue
      }
      withoutG1.push(unit)
    }
    unique = withoutG1
  }

  unique.sort(compareUnits)
  return {
    args: unique.flatMap((unit) => unit.args),
    dropped,
    droppedArgs,
  }
}

export function mergeJvmArguments(
  ...layers: readonly (readonly string[] | JvmArgLayer)[]
): MergedJvmArgs {
  return mergeJvmArgumentLayers(
    layers.map((layer) =>
      'source' in (layer as JvmArgLayer)
        ? (layer as JvmArgLayer)
        : { args: layer as readonly string[], source: 'plan' as const },
    ),
  )
}

function parseHeapArgument(argument: string, key: 'Xmx' | 'Xms'): number | undefined {
  if (!argument.startsWith(`-${key}`)) return undefined
  const match = /^-(Xmx|Xms)(\d+(?:\.\d+)?)([kmgt]?)$/i.exec(argument)
  if (!match) return undefined
  const value = Number(match[2])
  if (!Number.isFinite(value) || value <= 0) return undefined
  const unit = (match[3] || 'm').toLowerCase()
  const factor = unit === 'k' ? 1 / 1024 : unit === 'm' ? 1 : unit === 'g' ? 1024 : 1024 * 1024
  return Math.max(1, Math.floor(value * factor))
}

function withoutHeapMaximum(args: readonly string[]): string[] {
  const kept: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (typeof argument !== 'string') continue
    if (argument === '-Xmx') {
      kept.push(argument)
      const next = args[index + 1]
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) {
        kept.push(next)
        index += 1
      }
      continue
    }
    if (argument.startsWith('-Xmx')) continue
    kept.push(argument)
  }
  return kept
}

function findHeapArgument(args: readonly string[], key: 'Xmx' | 'Xms'): number | undefined {
  let found: number | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (typeof argument !== 'string') continue
    if (argument === `-${key}`) {
      index += 1
      continue
    }
    if (!argument.startsWith(`-${key}`)) continue
    const parsed = parseHeapArgument(argument, key)
    if (parsed !== undefined) found = parsed
  }
  return found
}

function normalizePreset(input: JvmPlanInput): JvmPresetId | 'auto' {
  return (JVM_PRESET_IDS as readonly string[]).includes(input.jvmPreset)
    ? (input.jvmPreset as JvmPresetId)
    : 'auto'
}

function isOpenJ9(vendor: string | undefined): boolean {
  const value = (vendor ?? '').toLowerCase()
  return value.includes('openj9') || value.includes('semeru') || value.includes('ibm')
}

function presetFailure(
  presetId: JvmPresetId,
  javaMajor: number | undefined,
  heapMb: number,
  openJ9: boolean,
): JvmReasonCode | undefined {
  const requires = JVM_PRESETS[presetId].requires
  if (requires.javaMajor !== undefined && (javaMajor ?? 0) < requires.javaMajor) {
    return 'jvm.downgrade-java'
  }
  if (requires.minHeapMb !== undefined && heapMb < requires.minHeapMb) {
    return 'jvm.downgrade-low-heap'
  }
  if (requires.vendor === 'hotspot' && openJ9) {
    return 'jvm.downgrade-openj9'
  }
  return undefined
}

export function resolveJvmPlan(input: JvmPlanInput): JvmPlan {
  const reasons: JvmReasonCode[] = []
  const addReason = (reason: JvmReasonCode): void => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  const totalMemMb = Number.isFinite(input.totalMemMb) && input.totalMemMb > 0
    ? input.totalMemMb
    : 0
  const javaMajor = Number.isFinite(input.javaMajor) ? input.javaMajor : undefined
  const openJ9 = isOpenJ9(input.javaVendor)
  const extraJvmArgs = Array.isArray(input.extraJvmArgs) ? input.extraJvmArgs : []
  const userXmx = findHeapArgument(extraJvmArgs, 'Xmx')
  const userXms = findHeapArgument(extraJvmArgs, 'Xms')
  const explicit = input.memoryMode === 'explicit' || userXmx !== undefined

  let heapMb: number
  if (explicit) {
    const cap = Math.max(1024, totalMemMb - 2048)
    const requested = Number.isFinite(userXmx ?? input.maxMemoryMb)
      ? Math.max(0, userXmx ?? input.maxMemoryMb)
      : 0
    heapMb = Math.min(Math.max(requested, 1024), cap)
    if (requested > cap) addReason('jvm.heap-clamped')
  } else {
    if (totalMemMb < 6144) heapMb = 1536
    else heapMb = Math.min(8192, Math.max(2048, Math.floor(totalMemMb * 0.5)))
    if (totalMemMb - heapMb < 3072) heapMb = Math.max(1536, totalMemMb - 3072)
    addReason('jvm.heap-auto')
  }

  heapMb = Math.max(1024, Math.floor(heapMb))
  if (input.javaArch === 'x86' && heapMb > 1400) {
    heapMb = 1400
    addReason('jvm.heap-32bit')
  }

  let presetId: JvmPresetId
  const requestedPreset = normalizePreset(input)
  if (requestedPreset === 'auto') {
    const loader = (input.loader ?? 'vanilla').toLowerCase()
    const modCount = Number.isFinite(input.modCount) ? Math.max(0, input.modCount) : 0
    presetId = modCount >= 20 || loader !== 'vanilla' ? 'modded-aikar' : 'vanilla-balanced'
    addReason('jvm.preset-auto')
  } else {
    presetId = requestedPreset
    if (presetId === 'custom') addReason('jvm.preset-explicit')
  }

  if (presetId !== 'custom' && openJ9) {
    presetId = 'custom'
    addReason('jvm.downgrade-openj9')
  } else if (presetId !== 'custom') {
    while (presetId !== 'vanilla-balanced') {
      const failure = presetFailure(presetId, javaMajor, heapMb, openJ9)
      if (!failure) break
      addReason(failure)
      presetId = presetId === 'low-latency-zgc' ? 'modded-aikar' : 'vanilla-balanced'
    }
  }

  const xmsMb =
    presetId === 'custom' && userXms !== undefined
      ? Math.max(0, Math.floor(userXms))
      : explicit
        ? input.minMemoryMb > 0
          ? Math.min(Math.max(0, Math.floor(input.minMemoryMb)), heapMb)
          : Math.min(2048, heapMb)
        : presetId === 'vanilla-balanced'
          ? Math.min(2048, heapMb)
          : presetId === 'custom'
            ? 0
            : heapMb

  const heapArgs: string[] = []
  if (xmsMb > 0) heapArgs.push(`-Xms${xmsMb}M`)
  heapArgs.push(`-Xmx${heapMb}M`)

  const presetArgs: string[] = []
  if (presetId !== 'custom') {
    presetArgs.push(...JVM_PRESETS[presetId].args)
    if (
      presetId === 'low-latency-zgc' &&
      javaMajor !== undefined &&
      javaMajor >= 21 &&
      javaMajor <= 22
    ) {
      presetArgs.push('-XX:+ZGenerational')
    }
  }

  const merged = mergeJvmArgumentLayers([
    { args: heapArgs, source: 'heap' },
    { args: withoutHeapMaximum(extraJvmArgs), source: 'custom' },
    { args: presetArgs, source: 'preset' },
  ])
  if (merged.dropped.length > 0) addReason('jvm.arg-dropped')

  reasons.sort((left, right) => jvmReasonRank(left) - jvmReasonRank(right))
  return {
    presetId,
    args: merged.args,
    heapMb,
    xmsMb,
    downgrades: reasons,
    dropped: merged.droppedArgs,
  }
}
