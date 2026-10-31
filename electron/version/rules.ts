import { release } from 'node:os'
import { describeError, getDefaultLogger } from '../logger'

export type RuleOsName = 'windows' | 'osx' | 'linux'
export type RuleArch = 'x64' | 'ia32' | 'arm64'

export interface PlatformInfo {
  name: RuleOsName
  arch: RuleArch
  version: string
}

export interface Rule {
  action: 'allow' | 'disallow'
  os?: {
    name?: string
    arch?: string
    version?: string
  }
  features?: Record<string, boolean>
}

export type FeatureSet = Record<string, boolean>

export function currentPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  osRelease: string = release(),
): PlatformInfo {
  const name: RuleOsName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux'
  const normalizedArch: RuleArch = arch === 'ia32' ? 'ia32' : arch === 'arm64' ? 'arm64' : 'x64'
  return { name, arch: normalizedArch, version: osRelease }
}

function archMatches(ruleArch: string, actual: RuleArch): boolean {
  const normalized = ruleArch === 'x86' ? 'ia32' : ruleArch
  return normalized === actual
}

function osMatches(rule: NonNullable<Rule['os']>, platform: PlatformInfo): boolean {
  if (rule.name && rule.name !== platform.name) return false
  if (rule.arch && !archMatches(rule.arch, platform.arch)) return false
  if (rule.version) {
    try {
      if (!new RegExp(rule.version).test(platform.version)) return false
    } catch (error) {
      getDefaultLogger().child('version').debug('invalid OS rule version pattern; rule skipped', { pattern: rule.version, error: describeError(error) })
      return false
    }
  }
  return true
}

export function evaluateRules(
  rules: Rule[] | undefined,
  platform: PlatformInfo,
  features: FeatureSet = {},
): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    let applies = true
    if (rule.os) applies = osMatches(rule.os, platform)
    if (applies && rule.features) {
      applies = Object.entries(rule.features).every(([key, value]) => Boolean(features[key]) === value)
    }
    if (applies) allowed = rule.action === 'allow'
  }
  return allowed
}

export type LaunchArgument = string | { rules?: Rule[]; value: string | string[] }

export function resolveLaunchArguments(
  args: LaunchArgument[] | undefined,
  platform: PlatformInfo,
  features: FeatureSet = {},
): string[] {
  const result: string[] = []
  for (const arg of args ?? []) {
    if (typeof arg === 'string') {
      result.push(arg)
      continue
    }
    if (!evaluateRules(arg.rules, platform, features)) continue
    if (Array.isArray(arg.value)) result.push(...arg.value)
    else result.push(arg.value)
  }
  return result
}
