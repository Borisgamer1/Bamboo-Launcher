interface LoaderCore {
  loaders: {
    install(
      loader: string,
      options: Record<string, unknown>,
    ): Promise<{ versionId?: string; loaderVersion?: string }>
  }
}

/** One wrapper for every legacy path that installs a loader through the core. */
export async function installLoaderViaCore(
  getCore: () => Promise<LoaderCore | null>,
  loader: string,
  minecraftVersion: string,
  loaderVersion: string,
  onProgress?: (progress: { message?: string; phase?: string }) => void,
): Promise<{ versionId: string; loaderVersion: string }> {
  const kind = String(loader || '').toLowerCase()
  const version = String(minecraftVersion || '')
  if (!kind || kind === 'vanilla') return { versionId: version, loaderVersion: '' }
  const core = await getCore()
  if (!core) throw new Error('Launcher-Core (dist-electron) nicht verfügbar')
  const result = await core.loaders.install(kind, {
    minecraftVersion: version,
    ...(loaderVersion ? { loaderVersion: String(loaderVersion) } : {}),
    installBaseVersion: true,
    ...(onProgress ? { onProgress: (progress: { message?: string; phase?: string }) => { if (progress) onProgress(progress) } } : {}),
  })
  return {
    versionId: result.versionId || version,
    loaderVersion: result.loaderVersion || String(loaderVersion || ''),
  }
}
