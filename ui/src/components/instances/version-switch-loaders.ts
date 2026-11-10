import type { VersionMap } from '../../lib/versionApi'
import type { Instance } from '../InstancesView'

export type TargetLoader = Instance['modloader']

export const LOADERS: TargetLoader[] = ['Vanilla', 'Fabric', 'Quilt', 'Forge', 'Neoforge']

// Loader maps are the record entries; minecraftVersions is the version list and
// must never be indexed with a Minecraft version.
export type LoaderMapKey = Exclude<keyof VersionMap, 'minecraftVersions'>

export function loaderMapKey(loader: TargetLoader): LoaderMapKey | null {
  switch (loader) {
    case 'Fabric':
      return 'fabric'
    case 'Quilt':
      return 'quilt'
    case 'Forge':
      return 'forge'
    case 'Neoforge':
      return 'neoforge'
    default:
      return null
  }
}
