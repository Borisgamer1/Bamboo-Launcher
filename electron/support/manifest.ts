import { createHash } from 'node:crypto'

export interface SupportManifestMeta {
  createdAt: string
  app: string
  appVersion: string
  platform: string
}

export interface SupportManifestEntry {
  path: string
  bytes: number
  sha256: string
}

export interface SupportManifest extends SupportManifestMeta {
  entries: SupportManifestEntry[]
}

export function buildSupportManifest(
  files: Record<string, Buffer>,
  meta: SupportManifestMeta,
): SupportManifest {
  return {
    ...meta,
    entries: Object.entries(files).map(([path, buffer]) => ({
      path,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    })),
  }
}
