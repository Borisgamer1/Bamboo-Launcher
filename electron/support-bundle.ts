/** Account files, token files, absolute paths and secret-like values are never included; the bundle is never sent anywhere. */
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Logger } from './logger'
import type { TelemetrySnapshot } from './telemetry'
import { writeSupportArchive } from './support/archive'
import { collectSupportData } from './support/collect'
import { buildSupportManifest } from './support/manifest'

export interface SupportBundleOptions {
  appData: string
  gameRoot: string
  destination: string
  logger?: Logger
  telemetry?: TelemetrySnapshot
  appVersion?: string
  now?: Date
}

export interface SupportBundleResult {
  file: string
  entries: string[]
  bytes: number
  sanitizedLogFiles: number
}

const README = [
  'Bamboo Launcher support bundle',
  '',
  'This archive contains sanitized diagnostics only:',
  '- summary.json (platform, counts, telemetry aggregates)',
  '- settings.json (theme/language/telemetry flag)',
  '- instances.json (versions and loaders, no names/paths)',
  '- java.json (versions, no paths)',
  '- versions.json (installed version IDs and loader markers, no paths)',
  '- manifest.json (name, size and SHA-256 of every other entry)',
  '- logs/*.log (absolute paths and tokens redacted)',
  '- game/latest.log (bounded tail, sanitized)',
  '- game/crash-report.txt (newest report, sanitized)',
  '',
  'Accounts, tokens, API keys and absolute paths are intentionally excluded.',
  '',
].join('\n')

async function resolveDestination(input: string, now: Date): Promise<string> {
  const info = await stat(input).catch(() => undefined)
  if (!info?.isDirectory()) return input
  return join(input, `bamboo-support-${now.toISOString().replace(/[:.]/g, '-')}.zip`)
}

export async function createSupportBundle(options: SupportBundleOptions): Promise<SupportBundleResult> {
  const roots = { appData: resolve(options.appData), gameRoot: resolve(options.gameRoot) }
  const now = options.now ?? new Date()
  const destination = await resolveDestination(resolve(options.destination), now)
  const data = await collectSupportData(roots)
  const telemetry = options.telemetry ?? { enabled: false, since: 0, updatedAt: 0, phases: {} }
  const appVersion = options.appVersion ?? process.env.npm_package_version ?? '0.2.5'

  const summary = {
    createdAt: now.toISOString(),
    app: 'bamboo-launcher',
    appVersion,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    roots: { appData: '<appData>', gameRoot: '<gameRoot>' },
    counts: {
      instances: data.instances.length,
      javaRuntimes: data.java.length,
      installedVersions: data.versions.length,
      logFiles: data.logs.count,
    },
    telemetry,
  }

  const files: Record<string, Buffer> = {
    'README.txt': Buffer.from(README, 'utf8'),
    'summary.json': Buffer.from(JSON.stringify(summary, null, 2), 'utf8'),
    'settings.json': Buffer.from(JSON.stringify(data.settings, null, 2), 'utf8'),
    'instances.json': Buffer.from(JSON.stringify(data.instances, null, 2), 'utf8'),
    'java.json': Buffer.from(JSON.stringify(data.java, null, 2), 'utf8'),
    'versions.json': Buffer.from(JSON.stringify(data.versions, null, 2), 'utf8'),
  }
  for (const [name, content] of Object.entries(data.logs.files)) {
    files[name] = Buffer.from(content, 'utf8')
  }
  files['manifest.json'] = Buffer.from(
    JSON.stringify(
      buildSupportManifest(files, {
        createdAt: now.toISOString(),
        app: 'bamboo-launcher',
        appVersion,
        platform: process.platform,
      }),
      null,
      2,
    ),
    'utf8',
  )

  const bytes = await writeSupportArchive(destination, files)
  const entries = Object.keys(files)
  options.logger?.info('Support bundle created', {
    file: destination,
    entries: entries.length,
    bytes,
  })
  return {
    file: destination,
    entries,
    bytes,
    sanitizedLogFiles: data.logs.count,
  }
}
