import DOMPurify from "dompurify";
import { createDescriptionSanitizer } from "../../lib/descriptionHtml";

/**
 * What a mod detail window needs from a project: the API shapes plus the two
 * small rules (loader id, project page) that only this screen uses.
 */

export interface ModrinthHit {
  project_id: string;
  slug: string;
  author: string;
  title: string;
  description: string;
  categories: string[];
  client_side: string;
  server_side: string;
  project_type: string;
  downloads: number;
  icon_url: string;
  versions: string[];
  follows: number;
  date_created: string;
  date_modified: string;
}

export interface ModDetail {
  title?: string;
  author?: string;
  body?: string;
  description?: string;
  icon_url?: string;
  downloads?: number;
  slug?: string;
}

export interface ModrinthVersionFile {
  url: string;
  filename: string;
  primary?: boolean;
}

export interface ModrinthDependency {
  dependency_type?: string;
  project_id?: string;
}

export interface ModrinthVersion {
  id?: string;
  version_number?: string;
  version_type?: string;
  date_published?: string;
  game_versions?: string[];
  loaders?: string[];
  files?: ModrinthVersionFile[];
  dependencies?: ModrinthDependency[];
}

export interface ModDetailVersion {
  version_number: string;
  date_published: string;
  game_versions: string[];
  loaders: string[];
  files: { url: string; filename: string; primary: boolean }[];
}


export type AccentClasses = {
  text: string;
  bg: string;
  bgLight: string;
  border: string;
  glow: string;
  hoverText: string;
  borderHover: string;
  cardHover: string;
};


export const sanitizeDescription = createDescriptionSanitizer(DOMPurify);

export function cfLoaderNameToType(loader: string): number | undefined {
  const map: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
  return map[loader.toLowerCase()];
}

export function projectPageUrl(mod: ModrinthHit, source: 'modrinth' | 'curseforge'): string {
  if (source === 'curseforge') {
    const kind = mod.project_type === 'modpack'
      ? 'modpacks'
      : mod.project_type === 'resourcepack'
        ? 'texture-packs'
        : mod.project_type === 'shader'
          ? 'shaders'
          : mod.project_type === 'datapack'
            ? 'data-packs'
            : 'mc-mods';
    return `https://www.curseforge.com/minecraft/${kind}/${mod.slug}`;
  }
  const kind = mod.project_type === 'modpack'
    ? 'modpack'
    : mod.project_type === 'resourcepack'
      ? 'resourcepack'
      : mod.project_type === 'shader'
        ? 'shader'
        : mod.project_type === 'datapack'
          ? 'datapack'
          : 'mod';
  return `https://modrinth.com/${kind}/${mod.slug}`;
}
