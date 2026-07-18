// ============================================================
// Asset Database v2.0.0
// Extended IndexedDB with per-file status tracking,
// timestamps, and retry information. Upgrades from
// BambooAssetCache v1 to v2 with new status store.
// ============================================================

import type { ManifestFile, AssetInfo, AssetStatus, DownloadErrorType } from "./assetManifest";
import { EMPTY_ASSET_INFO } from "./assetManifest";
import { computeHash } from "./assetCache";

// ===== IndexedDB Setup (v2 upgrade) =====

const DB_NAME = "BambooAssetCache";
const DB_VERSION = 2;           // Upgraded from v1
const STORE_ASSETS = "assets";  // Same store name as v1
const STORE_META = "meta";
const STORE_STATUS = "status";  // NEW: per-file status tracking

interface AssetDataEntry {
  path: string;
  data: ArrayBuffer;
}

interface MetaEntry {
  key: string;
  value: unknown;
}

interface StatusEntry {
  path: string;
  hash: string;
  size: number;
  version: number;
  mimeType: string;
  status: AssetStatus;
  installedAt: number;
  lastChecked: number;
  verifiedAt: number;
  retryCount: number;
  lastError: string;
  lastErrorType: DownloadErrorType | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;

      // v1 → v2 migration
      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains(STORE_ASSETS)) {
          const store = db.createObjectStore(STORE_ASSETS, { keyPath: "path" });
          store.createIndex("hash", "hash", { unique: false });
          store.createIndex("version", "version", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      }

      // v2: new status store
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains(STORE_STATUS)) {
          const statusStore = db.createObjectStore(STORE_STATUS, { keyPath: "path" });
          statusStore.createIndex("status", "status", { unique: false });
          statusStore.createIndex("installedAt", "installedAt", { unique: false });
          statusStore.createIndex("lastChecked", "lastChecked", { unique: false });
        }
      }
    };

    request.onsuccess = (event: Event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };

    request.onerror = () => {
      reject(request.error || new Error("Failed to open IndexedDB"));
    };

    request.onblocked = () => {
      console.warn("[AssetDB] IndexedDB upgrade blocked - close other tabs");
    };
  });

  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ===== Asset Data Operations (binary storage) =====

/** Store raw binary data for an asset */
export async function storeAssetData(path: string, data: ArrayBuffer): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_ASSETS, "readwrite");
  const store = tx.objectStore(STORE_ASSETS);
  await promisify(store.put({ path, data }));
}

/** Get raw binary data for an asset */
export async function getAssetData(path: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_ASSETS, "readonly");
    const store = tx.objectStore(STORE_ASSETS);
    const result = await promisify<AssetDataEntry | undefined>(store.get(path));
    return result?.data ?? null;
  } catch {
    return null;
  }
}

/** Check if binary data exists for an asset */
export async function hasAssetData(path: string): Promise<boolean> {
  const data = await getAssetData(path);
  return data !== null;
}

/** Delete raw binary data */
export async function deleteAssetData(path: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_ASSETS, "readwrite");
  const store = tx.objectStore(STORE_ASSETS);
  await promisify(store.delete(path));
}

// ===== Status Operations =====

/** Get status info for a single asset */
export async function getAssetStatus(path: string): Promise<StatusEntry | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_STATUS, "readonly");
    const store = tx.objectStore(STORE_STATUS);
    return await promisify<StatusEntry | undefined>(store.get(path)).then((r) => r ?? null);
  } catch {
    return null;
  }
}

/** Set or update status for an asset */
export async function setAssetStatus(
  path: string,
  updates: Partial<Omit<StatusEntry, "path">>
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_STATUS, "readwrite");
  const store = tx.objectStore(STORE_STATUS);

  const existing = await promisify<StatusEntry | undefined>(store.get(path));
  const entry: StatusEntry = existing
    ? { ...existing, ...updates }
    : {
        path,
        hash: updates.hash || "",
        size: updates.size || 0,
        version: updates.version || 0,
        mimeType: updates.mimeType || "application/octet-stream",
        status: updates.status || "missing",
        installedAt: updates.installedAt || Date.now(),
        lastChecked: updates.lastChecked || 0,
        verifiedAt: updates.verifiedAt || 0,
        retryCount: updates.retryCount || 0,
        lastError: updates.lastError || "",
        lastErrorType: updates.lastErrorType || null,
      };

  await promisify(store.put(entry));
}

/** Mark an asset as downloading */
export async function markDownloading(path: string): Promise<void> {
  await setAssetStatus(path, { status: "downloading" });
}

/** Mark an asset as successfully cached */
export async function markCached(
  path: string,
  hash: string,
  size: number,
  version: number,
  mimeType: string
): Promise<void> {
  await setAssetStatus(path, {
    status: "ok",
    hash,
    size,
    version,
    mimeType,
    installedAt: Date.now(),
    lastChecked: Date.now(),
    verifiedAt: Date.now(),
    retryCount: 0,
    lastError: "",
    lastErrorType: null,
  });
}

/** Mark an asset as damaged */
export async function markDamaged(path: string, error: string): Promise<void> {
  await setAssetStatus(path, {
    status: "damaged",
    lastChecked: Date.now(),
    lastError: error,
    lastErrorType: "hash_mismatch",
  });
}

/** Mark an asset as missing */
export async function markMissing(path: string): Promise<void> {
  await setAssetStatus(path, { status: "missing", lastChecked: Date.now() });
}

/** Record a download failure */
export async function recordDownloadFailure(
  path: string,
  error: string,
  errorType: DownloadErrorType
): Promise<void> {
  const existing = await getAssetStatus(path);
  const retryCount = (existing?.retryCount || 0) + 1;
  await setAssetStatus(path, {
    status: retryCount >= 4 ? "damaged" : "missing",
    retryCount,
    lastError: error,
    lastErrorType: errorType,
    lastChecked: Date.now(),
  });
}

/** Mark as verified (integrity check passed) */
export async function markVerified(path: string): Promise<void> {
  await setAssetStatus(path, {
    status: "ok",
    verifiedAt: Date.now(),
    lastChecked: Date.now(),
  });
}

/** Delete status entry */
export async function deleteAssetStatus(path: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_STATUS, "readwrite");
  const store = tx.objectStore(STORE_STATUS);
  await promisify(store.delete(path));
}

// ===== Query Operations =====

/** Get all assets with a specific status */
export async function getAssetsByStatus(status: AssetStatus): Promise<StatusEntry[]> {
  const db = await openDB();
  const tx = db.transaction(STORE_STATUS, "readonly");
  const store = tx.objectStore(STORE_STATUS);
  const index = store.index("status");

  const results: StatusEntry[] = [];
  const cursor = index.openCursor(IDBKeyRange.only(status));

  await new Promise<void>((resolve, reject) => {
    const req = cursor;
    req.onsuccess = (event: Event) => {
      const c = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (c) {
        results.push(c.value as StatusEntry);
        c.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });

  return results;
}

/** Get all asset status entries */
export async function getAllAssetStatuses(): Promise<StatusEntry[]> {
  const db = await openDB();
  const tx = db.transaction(STORE_STATUS, "readonly");
  const store = tx.objectStore(STORE_STATUS);

  const results: StatusEntry[] = [];
  const cursor = store.openCursor();

  await new Promise<void>((resolve, reject) => {
    const req = cursor;
    req.onsuccess = (event: Event) => {
      const c = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (c) {
        results.push(c.value as StatusEntry);
        c.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });

  return results;
}

/** Get count of assets by status */
export async function getStatusCounts(): Promise<Record<AssetStatus, number>> {
  const counts: Record<AssetStatus, number> = {
    ok: 0,
    damaged: 0,
    missing: 0,
    downloading: 0,
    pending: 0,
    stale: 0,
  };

  const statuses = await getAllAssetStatuses();
  for (const s of statuses) {
    counts[s.status] = (counts[s.status] || 0) + 1;
  }
  return counts;
}

// ===== Full AssetInfo Builder =====

/** Build a complete AssetInfo from DB state */
export async function buildAssetInfo(path: string): Promise<AssetInfo> {
  const status = await getAssetStatus(path);
  if (!status) {
    return { ...EMPTY_ASSET_INFO, path };
  }

  return {
    path: status.path,
    status: status.status,
    hash: status.hash,
    size: status.size,
    version: status.version,
    installedAt: status.installedAt,
    lastChecked: status.lastChecked,
    verifiedAt: status.verifiedAt,
    retryCount: status.retryCount,
    lastError: status.lastError,
    lastErrorType: status.lastErrorType,
    mimeType: status.mimeType,
  };
}

// ===== Integrity Helper =====

/** Verify binary data matches expected hash, update status accordingly */
export async function verifyAndUpdateStatus(
  path: string,
  expectedHash: string,
  expectedSize: number
): Promise<boolean> {
  const data = await getAssetData(path);

  if (!data) {
    await markMissing(path);
    return false;
  }

  // Check size
  if (data.byteLength !== expectedSize) {
    await markDamaged(path, `Size mismatch: expected ${expectedSize}, got ${data.byteLength}`);
    return false;
  }

  // Check hash
  const actualHash = await computeHash(data);
  if (actualHash !== expectedHash) {
    await markDamaged(path, `Hash mismatch: expected ${expectedHash}, got ${actualHash}`);
    return false;
  }

  await markVerified(path);
  return true;
}

// ===== Meta Store (for global state) =====

const META_MANIFEST_VERSION = "manifestVersion";
const META_LAST_SYNC = "lastSyncAt";

/** Get the local manifest version */
export async function getLocalManifestVersion(): Promise<number> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_META, "readonly");
    const store = tx.objectStore(STORE_META);
    const result = await promisify<MetaEntry | undefined>(store.get(META_MANIFEST_VERSION));
    return (result?.value as number) || 0;
  } catch {
    return 0;
  }
}

/** Set the local manifest version */
export async function setLocalManifestVersion(version: number): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_META, "readwrite");
  const store = tx.objectStore(STORE_META);
  await promisify(store.put({ key: META_MANIFEST_VERSION, value: version }));
}

/** Get last sync timestamp */
export async function getLastSyncTime(): Promise<number> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_META, "readonly");
    const store = tx.objectStore(STORE_META);
    const result = await promisify<MetaEntry | undefined>(store.get(META_LAST_SYNC));
    return (result?.value as number) || 0;
  } catch {
    return 0;
  }
}

/** Set last sync timestamp */
export async function setLastSyncTime(timestamp: number): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_META, "readwrite");
  const store = tx.objectStore(STORE_META);
  await promisify(store.put({ key: META_LAST_SYNC, value: timestamp }));
}

// ===== Cache Management =====

/** Clear all asset data and status tracking */
export async function clearAll(): Promise<void> {
  const db = await openDB();
  await Promise.all([
    (async () => {
      const tx = db.transaction(STORE_ASSETS, "readwrite");
      await promisify(tx.objectStore(STORE_ASSETS).clear());
    })(),
    (async () => {
      const tx = db.transaction(STORE_STATUS, "readwrite");
      await promisify(tx.objectStore(STORE_STATUS).clear());
    })(),
  ]);
  console.log("[AssetDB] All data cleared");
}

/** Get total byte size of cached assets */
export async function getTotalDataSize(): Promise<number> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_ASSETS, "readonly");
    const store = tx.objectStore(STORE_ASSETS);

    let total = 0;
    await new Promise<void>((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = (event: Event) => {
        const c = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (c) {
          total += (c.value as AssetDataEntry).data?.byteLength || 0;
          c.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    });
    return total;
  } catch {
    return 0;
  }
}
