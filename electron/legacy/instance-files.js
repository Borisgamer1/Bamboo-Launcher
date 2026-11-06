// Legacy profiles live in <gameRoot>/profiles/<folderName>. Before 0.2.0 the
// folder was always derived from the display name, so two installs of the same
// modpack (or two versions of it) silently shared one directory. Every writer
// now reserves a free folder first, and existing collisions are repaired once
// at startup.
//
// profiles.json has one owner (instances/profile-registry); this module holds
// the folder rules. The core register (instances.json) is a projection of that
// list and lives in core-projection.js, because a launch, a batched update or a
// cosmetic lookup ignores an instance the core does not know.
const fs = require('node:fs');
const path = require('node:path');
const {
  profileRegistry,
  profileFolderOf,
  profileFolderSlug,
} = require('../instances/profile-registry.js');
const { createCoreProjection } = require('./core-projection.js');

function createInstanceFiles({ logger, resolveGameRoot, getCore }) {
  function readProfilesSync(rootPath) {
    return profileRegistry(rootPath).read();
  }

  function writeProfilesSync(rootPath, profiles) {
    profileRegistry(rootPath).write(profiles);
  }

  // One projection owns every core write for the legacy list.
  const projection = createCoreProjection({ logger, resolveGameRoot, getCore });

  // Directory containment with a separator, so "profiles-x" never counts as
  // inside "profiles".
  function isInsideDirectory(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  function nextFreeProfileFolder(rootPath, base, used) {
    const slug = profileFolderSlug(base);
    let candidate = slug;
    let index = 2;
    while (
      used.has(candidate.toLowerCase()) ||
      fs.existsSync(path.join(rootPath, 'profiles', candidate))
    ) {
      candidate = `${slug}-${index}`;
      index += 1;
    }
    return candidate;
  }

  // Every instance folder is a direct child of profiles/. ".." or a nested path
  // from the renderer would let a delete or write leave that folder.
  function profileDirOrNull(rootPath, folderName) {
    if (!folderName || typeof folderName !== 'string') return null;
    const profiles = path.join(rootPath, 'profiles');
    const target = path.resolve(profiles, folderName);
    return path.dirname(target) === profiles ? target : null;
  }

  function uniqueProfileFolder(rootPath, desiredBase, profiles, excludeFolder) {
    const base = profileFolderSlug(desiredBase);
    const excluded = String(excludeFolder || '').toLowerCase();
    const used = new Set(
      profiles
        .map(profileFolderOf)
        .map((folder) => folder.toLowerCase())
        .filter((folder) => folder && folder !== excluded),
    );
    let candidate = base;
    let index = 2;
    while (
      candidate.toLowerCase() !== excluded &&
      (used.has(candidate.toLowerCase()) || fs.existsSync(path.join(rootPath, 'profiles', candidate)))
    ) {
      candidate = `${base}-${index}`;
      index += 1;
    }
    return candidate;
  }

  function uniqueProfileName(profiles, baseName) {
    const base = String(baseName || '').trim() || 'Instanz';
    const used = new Set(
      profiles.map((profile) => String(profile?.name || '').toLowerCase()).filter(Boolean),
    );
    if (!used.has(base.toLowerCase())) return base;
    let index = 2;
    while (used.has(`${base} (${index})`.toLowerCase())) index += 1;
    return `${base} (${index})`;
  }

  /**
   * Gives every profile that shared a folder with another profile its own copy.
   * The first owner keeps the original directory; later profiles are copied so
   * worlds/config are not lost. Returns the changes so the core register can be
   * updated too: otherwise its stale folderName would overwrite the repair as
   * soon as the renderer saves the profile list again.
   */
  function repairProfileFolderCollisions(rootPath) {
    return profileRegistry(rootPath).update((profiles) => {
      if (profiles.length === 0) return { result: { repaired: 0, changes: [] } };
      const used = new Set();
      const changes = [];
      for (const profile of profiles) {
        if (!profile || typeof profile !== 'object') continue;
        const folder = profileFolderOf(profile);
        const key = folder.toLowerCase();
        if (profile.folderName !== folder) {
          profile.folderName = folder;
          changes.push({ id: profile.id, folderName: folder });
        }
        if (!used.has(key)) {
          used.add(key);
          continue;
        }
        const source = path.join(rootPath, 'profiles', folder);
        const targetFolder = nextFreeProfileFolder(rootPath, profile.name || folder, used);
        const target = path.join(rootPath, 'profiles', targetFolder);
        try {
          if (fs.existsSync(source)) {
            fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
          } else {
            fs.mkdirSync(target, { recursive: true });
          }
          profile.folderName = targetFolder;
          used.add(targetFolder.toLowerCase());
          changes.push({ id: profile.id, folderName: targetFolder });
          logger.info('instance folder collision repaired', {
            instance: profile.name,
            from: folder,
            to: targetFolder,
          });
        } catch (error) {
          logger.warn('instance folder collision could not be repaired', {
            instance: profile.name,
            from: folder,
            target: targetFolder,
            error: error.message,
          });
        }
      }
      return { next: changes.length > 0 ? profiles : undefined, result: { repaired: changes.length, changes } };
    });
  }

  return {
    readProfilesSync,
    writeProfilesSync,
    ...projection,
    isInsideDirectory,
    nextFreeProfileFolder,
    profileDirOrNull,
    uniqueProfileFolder,
    uniqueProfileName,
    repairProfileFolderCollisions,
  };
}

module.exports = { createInstanceFiles };
