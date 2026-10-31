import type { InstanceLocks } from '../instances/lock'
import type { InstanceFile, ResolvedJava } from '../schemas'

export type CrashRuleId =
  | 'java-too-old'
  | 'legacy-on-modern-jvm'
  | 'missing-dependency-forge'
  | 'missing-dependency-fabric'
  | 'duplicate-mod'
  | 'mod-resolution-failed'
  | 'mixin-apply-failed'
  | 'out-of-memory'
  | 'graphics-driver'
  | 'corrupt-jar'
  | 'no-class-def'

export type ReasonCode =
  | `crash.rule-${CrashRuleId}`
  | 'crash.no-signal'
  | 'crash.report-stale'
  | 'crash.report-only'
  | 'crash.confidence-low'

export type FixAction =
  | { id: string; kind: 'switch-java'; major: number; reason: ReasonCode }
  | { id: string; kind: 'raise-heap'; toMb: number }
  | { id: string; kind: 'disable-mod'; jar: string; targetDir: string }
  | {
      id: string
      kind: 'install-dependency'
      modId: string
      versionRange?: string
      projectHint?: string
    }
  | { id: string; kind: 'open-path'; path: string }
  | { id: string; kind: 'open-url'; url: string }

export interface Finding {
  ruleId: CrashRuleId
  confidence: 'certain' | 'likely' | 'possible'
  title: string
  detail: string
  evidence: string[]
  actions: FixAction[]
}

export interface AnalysisResult {
  id: string
  instanceId: string
  launchId?: string
  truncated: boolean
  findings: Finding[]
  reasons: ReasonCode[]
  anchorHits?: number
}

export interface AnalysisContext {
  instanceId: string
  instanceDir: string
  maxMemoryMb: number
  graphicsVendor?: 'nvidia' | 'amd' | 'intel'
  launchStartedAt?: number
  launchId?: string
  javaMode?: 'auto' | 'pinned'
  javaPath?: string
  memoryMode?: 'auto' | 'explicit'
  resolvedJava?: ResolvedJava
  stderrLines?: string[]
  logFile?: string
  crashReportFile?: string
}

export interface LogTail {
  lines: string[]
  truncated: boolean
  bytes: number
  anchorHits: number
  path?: string
}

export interface CrashReportSummary {
  path: string
  mtimeMs: number
  description?: string
  minecraftVersion?: string
  javaVersion?: string
  gpu?: string
  mods: string[]
  causes: string[]
  stacktrace?: string
  truncated: boolean
}

export interface CrashRule {
  id: CrashRuleId
  category: 'java' | 'dependency' | 'conflict' | 'memory' | 'graphics' | 'integrity' | 'unknown'
  pattern: RegExp
  confidence: 'certain' | 'likely' | 'possible'
  title: { de: string; en: string }
  detail: (match: RegExpExecArray, context: AnalysisContext) => string
  fix?: (match: RegExpExecArray, context: AnalysisContext) => FixAction | undefined
}

export interface FixDeps {
  updateFile(instanceId: string, patch: Partial<InstanceFile>): Promise<InstanceFile>
  locks: InstanceLocks
  findJava?: (major: number) => Promise<{ path: string } | undefined>
  installDependency?: (
    action: Extract<FixAction, { kind: 'install-dependency' }>,
    context: AnalysisContext,
  ) => Promise<{ files: string[] } | undefined>
  openPath?: (path: string) => Promise<string | void>
  openUrl?: (url: string) => Promise<void>
}

export type FixResult =
  | {
      ok: true
      changed: string[]
      undoToken?: string
      requiresRestart: boolean
    }
  | {
      ok: false
      code: 'EACCES' | 'ENOENT' | 'LOCKED' | 'INVALID'
      message: string
    }
