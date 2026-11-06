/**
 * Instance folders are a stable on-disk identity. They must never depend on
 * display names alone: installing the same modpack twice (or a second version
 * of it) used to produce one shared `profiles/<slug>` directory.
 */

export interface FolderCarrier {
  name?: string;
  folderName?: string;
  id?: string;
}

export function instanceFolderKeyOf(instance: FolderCarrier): string {
  const stored = String(instance.folderName || "").trim();
  if (stored) return stored;
  return slugifyInstanceFolder(instance.name || instance.id || "instance");
}

// Must match profileFolderSlug in electron/instances/profile-registry.ts:
// both sides resolve a missing folderName, and a different rule makes the
// renderer address a folder the main process never created.
export function slugifyInstanceFolder(value: string): string {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "instance"
  );
}

/** Reserves `<base>`, `<base>-2`, `<base>-3`, ... against known instances. */
export function uniqueInstanceFolder(
  base: string,
  instances: FolderCarrier[],
  extraTaken: Iterable<string> = [],
): string {
  const used = new Set<string>();
  for (const instance of instances) used.add(instanceFolderKeyOf(instance).toLowerCase());
  for (const value of extraTaken) used.add(String(value).toLowerCase());

  const slug = slugifyInstanceFolder(base);
  let candidate = slug;
  let index = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${slug}-${index}`;
    index += 1;
  }
  return candidate;
}

/** A display name that stays distinct from existing instances. */
export function uniqueInstanceName(base: string, instances: FolderCarrier[]): string {
  const clean = String(base || "").trim() || "Instanz";
  const used = new Set(
    instances
      .map((instance) => String(instance.name || "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (!used.has(clean.toLowerCase())) return clean;
  let index = 2;
  while (used.has(`${clean} (${index})`.toLowerCase())) index += 1;
  return `${clean} (${index})`;
}
