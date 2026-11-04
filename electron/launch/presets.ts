export const JVM_PRESET_IDS = [
  'vanilla-balanced',
  'modded-aikar',
  'low-latency-zgc',
  'custom',
] as const

export type JvmPresetId = (typeof JVM_PRESET_IDS)[number]

export const JVM_PRESET_SELECTIONS = ['auto', ...JVM_PRESET_IDS] as const

export type JvmPresetSelection = (typeof JVM_PRESET_SELECTIONS)[number]

export interface JvmPresetLabel {
  de: string
  en: string
}

export interface JvmPresetRequires {
  javaMajor?: number
  minHeapMb?: number
  vendor?: 'hotspot'
}

export interface JvmPreset {
  id: JvmPresetId
  label: JvmPresetLabel
  args: readonly string[]
  requires: JvmPresetRequires
}

export const JVM_PRESETS: Record<JvmPresetId, JvmPreset> = {
  'vanilla-balanced': {
    id: 'vanilla-balanced',
    label: { de: 'Vanilla – ausgewogen', en: 'Vanilla – balanced' },
    args: [
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+UseG1GC',
      '-XX:MaxGCPauseMillis=50',
      '-XX:G1NewSizePercent=20',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapRegionSize=32M',
    ],
    requires: {},
  },
  'modded-aikar': {
    id: 'modded-aikar',
    label: { de: 'Modded – Aikar', en: 'Modded – Aikar' },
    args: [
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:G1NewSizePercent=30',
      '-XX:G1MaxNewSizePercent=40',
      '-XX:G1HeapRegionSize=8M',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5',
      '-XX:G1MixedGCCountTarget=4',
      '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90',
      '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32',
      '-XX:MaxTenuringThreshold=1',
    ],
    requires: { javaMajor: 17, minHeapMb: 4096, vendor: 'hotspot' },
  },
  'low-latency-zgc': {
    id: 'low-latency-zgc',
    label: { de: 'Niedrige Latenz – ZGC', en: 'Low latency – ZGC' },
    args: ['-XX:+UseZGC'],
    requires: { javaMajor: 21, minHeapMb: 8192, vendor: 'hotspot' },
  },
  custom: {
    id: 'custom',
    label: { de: 'Eigene Argumente', en: 'Custom arguments' },
    args: [],
    requires: {},
  },
}
