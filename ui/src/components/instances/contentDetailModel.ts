import { toCurseForgeFailure } from '../../lib/curseforge'
import {
  fromCurseForgeFile,
  fromModrinthVersion,
  type StoreVersion,
} from '../../lib/modVersions'
import { LAUNCHER_VERSION } from '../../lib/version'
import type { ContentItem } from '../InstancesView'

export interface FetchContentVersionsOptions {
  /**
   * Throw instead of returning an empty list when the provider cannot be
   * reached. The update check treats an empty list as "nothing available";
   * a version switch must not turn a network failure into a removal.
   */
  strict?: boolean;
}

/**
 * The store's version list for one content item, in the shared shape - the same
 * data the browser's selector uses, for both sources. Used by the update check,
 * the update run and the per-item version switcher.
 */
export async function fetchContentVersions(
  item: {
    projectId?: string;
    source?: "modrinth" | "curseforge";
  },
  options: FetchContentVersionsOptions = {},
): Promise<StoreVersion[]> {
  const fail = (message: string): StoreVersion[] => {
    if (options.strict) throw new Error(message);
    return [];
  };
  try {
    if (!item.projectId) return fail('Missing project id');
    if (item.source === 'curseforge') {
      const files = await window.electronAPI?.mods.curseforgeFiles?.(item.projectId, undefined, undefined);
      const failure = toCurseForgeFailure(files);
      if (failure) return fail(failure.detail || failure.code);
      if (!Array.isArray(files)) return fail('CurseForge returned no file list');
      return files.map(fromCurseForgeFile);
    }
    const res = await fetch(`https://api.modrinth.com/v2/project/${item.projectId}/version`, {
      headers: { 'User-Agent': `BambooLauncher/${LAUNCHER_VERSION}` },
    });
    if (!res.ok) return fail(`Modrinth HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) return fail('Modrinth returned no version list');
    return data.map((entry) => fromModrinthVersion(entry));
  } catch (error) {
    if (options.strict) throw error;
    return [];
  }
}

function modrinthProjectKind(type: ContentItem['type']): string {
  if (type === 'datapacks') return 'datapack';
  if (type === 'resourcepacks') return 'resourcepack';
  if (type === 'shaderpacks') return 'shader';
  return 'mod';
}

/** The project page for an installed item; CurseForge needs a slug when one is known. */
export function contentProjectUrl(item: ContentItem, slug?: string): string | null {
  if (!item.projectId || !item.source) return null;
  if (item.source === 'curseforge') {
    const kind = item.type === 'resourcepacks'
      ? 'texture-packs'
      : item.type === 'shaderpacks'
        ? 'shaders'
        : item.type === 'datapacks'
          ? 'data-packs'
          : 'mc-mods';
    const named = slug || (/^\d+$/.test(item.id) || item.id.startsWith('modpack:') ? '' : item.id);
    return named
      ? `https://www.curseforge.com/minecraft/${kind}/${named}`
      : `https://www.curseforge.com/projects/${item.projectId}`;
  }
  return `https://modrinth.com/${modrinthProjectKind(item.type)}/${slug || item.projectId}`;
}
