// The core register (instances.json) is a projection of profiles.json for
// everything the legacy UI owns: the visible list is the truth, and launches,
// batched updates and cosmetic lookups read the derived copy. Every write to
// that part of the register lives here, so a handler can never write it on its
// own and drift from the list.
const path = require('node:path');
const { profileFolderOf } = require('../instances/profile-registry.js');
const { slugify: coreSlugify } = require('../instance-store.js');

const LOADERS = ['vanilla', 'forge', 'neoforge', 'fabric', 'quilt', 'optifine'];

function normalizedLoader(value) {
  const raw = String(value ?? 'vanilla').toLowerCase();
  return LOADERS.includes(raw) ? raw : 'vanilla';
}

function createCoreProjection({ logger, resolveGameRoot, getCore }) {
  async function upsertCoreInstance(profile, overrides = {}) {
    try {
      const core = await getCore();
      if (!core || !profile || typeof profile !== 'object') return;
      const folderName = profileFolderOf(profile);
      if (!folderName) return;
      const found = await core.instanceManager.findByFolder(folderName);
      const loader = normalizedLoader(overrides.loader ?? profile.loader);
      await core.instances.upsert({
        id: found?.instance.id ?? `legacy-${coreSlugify(folderName)}`,
        name: String(overrides.name ?? profile.name ?? folderName),
        folderName,
        path: path.join(await resolveGameRoot(), 'profiles', folderName),
        managed: false,
        legacy: true,
        version: String(overrides.version ?? profile.version ?? ''),
        loader,
        loaderVersion: String(overrides.loaderVersion ?? profile.loaderVersion ?? ''),
      });
    } catch (error) {
      logger.warn('core instance register not updated', {
        folderName: profile?.folderName,
        error: error.message,
      });
    }
  }

  async function removeCoreInstance(folderName) {
    try {
      const core = await getCore();
      if (!core || !folderName) return false;
      const found = await core.instanceManager.findByFolder(String(folderName));
      if (found) await core.instances.remove(found.instance.id);
      return true;
    } catch (error) {
      logger.warn('core instance register not updated', {
        folderName,
        error: error.message,
      });
      return false;
    }
  }

  async function renameCoreInstance(oldFolder, newFolder, newDir) {
    try {
      const core = await getCore();
      if (!core || !newFolder) return false;
      const found = await core.instanceManager.findByFolder(String(oldFolder));
      if (found) {
        await core.instances.upsert({
          id: found.instance.id,
          folderName: newFolder,
          path: newDir,
          updatedAt: Date.now(),
        });
      }
      return true;
    } catch (error) {
      logger.warn('core instance rename not mirrored', {
        folderName: newFolder,
        error: error.message,
      });
      return false;
    }
  }

  // get-profiles starts its reconcile without waiting, so a save can call this
  // while that run is still writing. Serializing keeps completion order equal to
  // call order: the newest list always lands last instead of being overwritten
  // by a stale snapshot that was still in flight.
  let syncQueue = Promise.resolve();
  function syncCoreInstances(profiles) {
    const run = syncQueue.then(() => syncCoreInstancesNow(profiles));
    syncQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function syncCoreInstancesNow(profiles) {
    try {
      const core = await getCore();
      if (!core || !Array.isArray(profiles)) return;
      const known = new Map(
        (await core.instances.list()).map((record) => [
          String(record.folderName || '').toLowerCase(),
          record,
        ]),
      );
      for (const profile of profiles) {
        if (!profile || typeof profile !== 'object') continue;
        const folder = profileFolderOf(profile);
        if (!folder) continue;
        const current = known.get(folder.toLowerCase());
        // A missing field means the renderer never had it; keep the core value
        // instead of overwriting it with an empty string.
        const merged = {
          ...profile,
          name: String(profile.name ?? folder),
          version: profile.version === undefined && current ? current.version : String(profile.version ?? ''),
          loader: profile.loader === undefined && current ? current.loader : normalizedLoader(profile.loader),
          loaderVersion:
            profile.loaderVersion === undefined && current
              ? current.loaderVersion
              : String(profile.loaderVersion ?? ''),
        };
        const unchanged =
          current &&
          current.name === merged.name &&
          current.version === merged.version &&
          current.loader === merged.loader &&
          current.loaderVersion === merged.loaderVersion;
        if (!unchanged) await upsertCoreInstance(merged);
      }
      // An empty list is a real state: the user removed every instance, so every
      // legacy record must go too. Managed (typed-IPC) records stay untouched.
      const visible = new Set(
        profiles.map((profile) => profileFolderOf(profile).toLowerCase()).filter(Boolean),
      );
      for (const [folder, record] of known) {
        if (record.legacy === true && !visible.has(folder)) {
          await core.instances.remove(record.id);
        }
      }
    } catch (error) {
      logger.warn('core instance register sync failed', { error: error.message });
    }
  }

  return {
    upsertCoreInstance,
    removeCoreInstance,
    renameCoreInstance,
    syncCoreInstances,
  };
}

module.exports = { createCoreProjection };
